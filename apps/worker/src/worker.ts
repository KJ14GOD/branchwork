import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  defaultDatabasePath,
  SessionEventStore,
} from "@novus/session-service";

import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { mintAccessToken } from "./access.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { publishToRelay } from "./relay-publisher.ts";
import { createRedactor } from "./redaction.ts";
import { killRunningCommands } from "./tools.ts";

const modelSelection = {
  provider: "anthropic",
  model: "claude-opus-5",
};

// Writes are denied unless the operator opts in.
const allowWrites = process.env.NOVUS_ALLOW_WRITES === "1";
const allowCommands = process.env.NOVUS_ALLOW_COMMANDS === "1";
// Minted per process unless the host pins one. A token that outlives the run it
// authorised is a token somebody still has, so the default is deliberately not
// durable — NOVUS_TOKEN exists for the case where a client must be configured
// ahead of time.
const pinnedToken = process.env.NOVUS_TOKEN?.trim();

if (pinnedToken !== undefined && pinnedToken.length < 32) {
  console.error(
    `NOVUS_TOKEN is ${pinnedToken.length} characters. A pinned token survives every restart, so a short one is a guessable one — use at least 32, or unset it and let the worker mint one.`,
  );
  process.exit(1);
}

const accessToken = pinnedToken || mintAccessToken();

// The host is a participant like anyone else, holding the token it already had.
// Making the owner explicit is what lets every other route ask a question about
// the caller rather than about mere possession of a secret.
const participants = new ParticipantRegistry();
const host = participants.add(
  {
    sessionId: HOST_SESSION,
    name: process.env.NOVUS_HOST_NAME?.trim() || "Host",
    kind: "human",
    role: "owner",
  },
  accessToken,
);
const guestPort = Number(process.env.NOVUS_GUEST_PORT ?? 5274);
const goal = process.argv.slice(2).join(" ").trim();

const databasePath = defaultDatabasePath();
const eventStore = new SessionEventStore({ databasePath });

eventStore.subscribe((event) => {
  if (event.type === "run.started") {
    console.log(`\n▸ ${event.payload.run.goal}`);
  }

  if (event.type === "run.progress") {
    console.log(`• ${event.payload.message}`);
  }

  if (event.type === "tool.requested") {
    console.log(
      `→ ${event.payload.call.name} ${JSON.stringify(event.payload.call.input)}`,
    );
  }

  if (event.type === "tool.approval_requested") {
    console.log(
      `? ${event.payload.call.name} requires ${event.payload.toolClass} approval`,
    );
  }

  if (event.type === "tool.approved") {
    console.log(`● approved by ${event.payload.approvedBy}`);
  }

  if (event.type === "tool.denied") {
    console.log(`⊘ denied: ${event.payload.reason}`);
  }

  if (event.type === "tool.failed") {
    console.log(`✗ ${event.payload.name}: ${event.payload.message}`);
  }

  if (event.type === "run.failed") {
    console.log(`✗ run failed: ${event.payload.reason}`);
  }

  if (event.type === "receipt.created") {
    const { receipt } = event.payload;
    const failing = receipt.tests.filter((test) => !test.passed).length;

    console.log(
      `▣ receipt · ${receipt.filesChanged.length} file(s) changed · ${
        receipt.tests.length === 0
          ? "tests not run"
          : failing > 0
            ? `${failing}/${receipt.tests.length} test runs failed`
            : receipt.testsFollowedFinalChange === false
              ? "tests passed before the last change"
              : "tests passed"
      } · ${receipt.usage.modelCalls} model call(s) · ${
        receipt.usage.callsMissingUsage > 0 ? "≥" : ""
      }${receipt.usage.inputTokens + receipt.usage.outputTokens} tokens · ${
        Math.round(receipt.elapsedMs / 100) / 10
      }s${
        receipt.base.revision
          ? ` · base ${receipt.base.revision.slice(0, 8)}${receipt.base.dirty === true ? " + uncommitted" : receipt.base.dirty === null ? " + unknown state" : ""}`
          : ""
      }`,
    );
  }

  if (event.type === "run.completed") {
    console.log(`\n${event.payload.summary}`);
  }

  if (event.type === "tool.completed") {
    const { result } = event.payload;

    if (result.name === "propose_patch") {
      console.log(
        `✓ propose_patch ${result.output.path} (+${result.output.additions}/-${result.output.deletions}, proposed only)`,
      );
      console.log(result.output.diff);
      return;
    }

    if (result.name === "apply_patch") {
      console.log(
        `✓ apply_patch ${result.output.path} (+${result.output.additions}/-${result.output.deletions}, written)`,
      );
      return;
    }

    console.log(`✓ ${result.name}`);
  }
});

const sessions = new SessionRegistry(
  eventStore,
  new FixedModelRouter(modelSelection),
  [new AnthropicModelAdapter(modelSelection)],
  { allowWrites, allowCommands },
);

let eventServer;

try {
  eventServer = await startEventServer(eventStore, {
    sessions,
    participants,
    token: accessToken,
    // Seeded explicitly. The redactor otherwise learns its literals from
    // process.env, which knows the token only when the host pinned NOVUS_TOKEN
    // — a minted one lives in this process alone, so without this it would be
    // the one secret the outgoing stream had never heard of.
    redactor: createRedactor({
      environment: process.env,
      knownSecrets: [accessToken],
    }),
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`novus worker · ${eventServer.url}`);
console.log(`events ${databasePath} (override with NOVUS_DB)`);
console.log(
  `writes ${allowWrites ? "approved (NOVUS_ALLOW_WRITES=1)" : "denied — set NOVUS_ALLOW_WRITES=1 to permit apply_patch"}`,
);
console.log(
  `commands ${allowCommands ? "approved (NOVUS_ALLOW_COMMANDS=1)" : "denied — set NOVUS_ALLOW_COMMANDS=1 to permit run_command and run_tests"}`,
);
// Printed on the host's own terminal, which is the one place the token is
// already trusted. Everything else — the event log, the shared stream, a
// guest's screen — must never see it.
console.log(
  `access  token required · guest invite: http://127.0.0.1:${guestPort}/?endpoint=${encodeURIComponent(eventServer.url)}&token=${accessToken}`,
);

// Opt-in, and outbound. Nothing dials in to the worker: it decides what leaves
// and pushes it somewhere a teammate can reach. Absent the variable, Novus is
// exactly the single-machine harness it was.
const relayUrl = process.env.NOVUS_RELAY_URL?.trim();
const relayToken = process.env.NOVUS_RELAY_TOKEN?.trim();

const relaySession = process.env.NOVUS_RELAY_SESSION?.trim();

if (relayUrl && relayToken && relaySession) {
  const publisher = publishToRelay(eventStore, {
    url: relayUrl,
    token: relayToken,
    // One session per publisher, because one token authorises one session. A
    // worker hosting several would otherwise send all of them under the same
    // token and the relay would file them under whichever one it names.
    sessionId: relaySession,
    // Its own redaction, on its own path. Every outbound route does this rather
    // than trusting that some earlier one did.
    redactor: createRedactor({
      environment: process.env,
      knownSecrets: [accessToken, relayToken],
    }),
  });

  console.log(`relay   publishing session ${relaySession} to ${relayUrl}`);

  // The drop count is only useful if something can read it.
  process.on("exit", () => {
    if (publisher.dropped() > 0) {
      console.error(
        `relay   ${publisher.dropped()} event(s) never reached the relay; the shared copy is short by that many`,
      );
    }
  });
  // The invite a teammate elsewhere can actually use. The loopback one below
  // only works for somebody sitting at this machine.
  console.log(
    `invite  http://127.0.0.1:${guestPort}/?relay=${encodeURIComponent(relayUrl)}&token=<their token from POST /sessions/:id/invite>`,
  );
} else if (relayUrl || relayToken || relaySession) {
  console.error(
    "relay   NOVUS_RELAY_URL, NOVUS_RELAY_TOKEN and NOVUS_RELAY_SESSION must all be set; publishing is off",
  );
}

// A goal on the command line opens a session immediately; otherwise the worker
// waits for a client to choose a repository.
if (goal) {
  const repositoryPath = process.env.NOVUS_REPO
    ? resolve(process.env.NOVUS_REPO)
    : fileURLToPath(new URL("../../..", import.meta.url));

  const session = await sessions.create({
    repositoryPath,
    allowWrites,
    allowCommands,
  });

  console.log(`repository ${session.repositoryPath}`);
  console.log(`events ${eventServer.url}/events?session=${session.id}`);

  await sessions.submitTurn(session, goal);
} else {
  console.log("waiting for a client to open a repository");
}

console.log("\nready — press ctrl+c to stop");

// Commands run in their own process group so a timeout can kill the whole tree.
// That also means Ctrl-C no longer reaches them, so a quit would otherwise
// leave a test suite running invisibly after the worker is gone.
const shutdown = (code: number) => {
  killRunningCommands();
  void eventServer.close().then(() => {
    eventStore.close();
    process.exit(code);
  });
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(143));
