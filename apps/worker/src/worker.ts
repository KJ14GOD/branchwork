import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  defaultDatabasePath,
  SessionEventStore,
} from "@novus/session-service";

import type { ModelAdapter } from "./model.ts";
import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { OpenAIModelAdapter } from "./openai-model.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter } from "./model.ts";
import {
  ANTHROPIC_ROUTING_TIERS,
  SignalModelRouter,
} from "./model-router.ts";
import { loadPricing } from "./pricing.ts";
import { DEFAULT_RUN_BUDGET } from "./budget.ts";
import { SessionRegistry } from "./session-registry.ts";
import { mintAccessToken } from "./access.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { publishToRelay } from "./relay-publisher.ts";
import { createRedactor } from "./redaction.ts";
import { killRunningCommands } from "./tools.ts";
import { stopAllDevServers } from "./dev-server.ts";

// Configurable rather than hardcoded, so "one model provider initially"
// (V1's scope) does not mean "the only provider this harness could ever
// speak to" (README: "Novus must never make a single model provider its
// architectural foundation"). Unset, this is exactly today's behaviour.
//
// Anthropic keeps a default model name because that was already the
// hardcoded value; a second provider gets no guessed default; naming one
// that no longer exists would fail in a way that looks like a bad key
// rather than a stale model id.
const modelProvider = process.env.NOVUS_MODEL_PROVIDER?.trim() || "anthropic";
const KNOWN_MODEL_PROVIDERS = ["anthropic", "openai"] as const;

if (!(KNOWN_MODEL_PROVIDERS as readonly string[]).includes(modelProvider)) {
  console.error(
    `NOVUS_MODEL_PROVIDER must be one of ${KNOWN_MODEL_PROVIDERS.join(", ")} — got "${modelProvider}". An unrecognised provider has no adapter, and a run started against one dies with nothing in the session log explaining why.`,
  );
  process.exit(1);
}

const defaultModel = modelProvider === "anthropic" ? "claude-opus-5" : undefined;
const modelName = process.env.NOVUS_MODEL?.trim() || defaultModel;

if (!modelName) {
  console.error(
    `NOVUS_MODEL is required when NOVUS_MODEL_PROVIDER=${modelProvider} — Novus does not guess a default model for this provider.`,
  );
  process.exit(1);
}

const modelSelection = {
  provider: modelProvider,
  model: modelName,
};

/**
 * Route, unless someone pinned a model.
 *
 * NOVUS_MODEL set is an explicit instruction to use one model, and it still
 * means exactly that. Unset, on Anthropic, the router picks a tier per turn
 * from what it can actually observe about the request — see model-router.ts.
 * OpenAI has no tier table, so it stays pinned either way.
 */
const pinnedModel = process.env.NOVUS_MODEL?.trim();
const routingEnabled = !pinnedModel && modelProvider === "anthropic";

const pricing = loadPricing();

/**
 * A dollar ceiling for a single run, off unless someone sets one.
 *
 * The other bounds in budget.ts — tokens, wall clock, model calls — are
 * proxies for this one, and none of them stopped a real overnight session
 * from spending $40. Off by default because a ceiling nobody chose is a run
 * that dies for a reason its operator did not pick.
 */
const costBudgetRaw = process.env.NOVUS_COST_BUDGET_USD?.trim();
const costBudgetUsd = costBudgetRaw ? Number(costBudgetRaw) : null;

if (costBudgetRaw && (!Number.isFinite(costBudgetUsd) || costBudgetUsd! <= 0)) {
  console.error(
    `NOVUS_COST_BUDGET_USD must be a positive number of dollars — got "${costBudgetRaw}".`,
  );
  process.exit(1);
}

const modelRouter = routingEnabled
  ? new SignalModelRouter(ANTHROPIC_ROUTING_TIERS, pricing)
  : new FixedModelRouter(modelSelection);

// Constructed for the selected provider only. Both SDKs throw at
// construction when they cannot resolve an API key — constructing an
// adapter nobody asked for would fail startup for an Anthropic session on a
// host that has never set OPENAI_API_KEY, and the reverse.
//
// When routing, every tier the router can choose needs an adapter standing
// by: the runner resolves an adapter by exact provider+model, so a routed
// turn whose tier had none would die with "No model adapter is configured"
// rather than falling back. They share one API key and construct lazily
// enough that three cost nothing until one is called.
const modelAdapters: ModelAdapter[] =
  modelSelection.provider === "openai"
    ? [new OpenAIModelAdapter(modelSelection)]
    : routingEnabled
      ? [
          ...new Set([
            ANTHROPIC_ROUTING_TIERS.fast.model,
            ANTHROPIC_ROUTING_TIERS.deep.model,
            ANTHROPIC_ROUTING_TIERS.max.model,
          ]),
        ].map(
          (model) =>
            new AnthropicModelAdapter({ provider: "anthropic", model }),
        )
      : [new AnthropicModelAdapter(modelSelection)];

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
      }${receipt.usage.inputTokens + receipt.usage.outputTokens} effective tokens · ${
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
  modelRouter,
  modelAdapters,
  { allowWrites, allowCommands },
  {
    pricing,
    ...(costBudgetUsd === null
      ? {}
      : { budget: { ...DEFAULT_RUN_BUDGET, costUsd: costBudgetUsd } }),
  },
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
console.log(
  routingEnabled
    ? `model   routing ${ANTHROPIC_ROUTING_TIERS.fast.model} · ${ANTHROPIC_ROUTING_TIERS.deep.model} · ${ANTHROPIC_ROUTING_TIERS.max.model} (pin one with NOVUS_MODEL)`
    : `model   ${modelSelection.provider}/${modelSelection.model} (override with NOVUS_MODEL_PROVIDER and NOVUS_MODEL)`,
);
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

if (relayUrl && relayToken) {
  // Attached when a session appears rather than configured with one. A session
  // id is a runtime UUID, so nobody can put it in the environment before the
  // session it names exists — asking them to was the reason this could not be
  // run at all.
  //
  // The first session gets the relay, because one token authorises one session.
  // A second one stays local and says so, rather than being published under a
  // token that does not describe it.
  let publisher: ReturnType<typeof publishToRelay> | null = null;

  sessions.onCreated((session) => {
    if (publisher !== null) {
      console.error(
        `relay   session ${session.id} is not being shared: this relay token is already carrying another. Start a second relay for it.`,
      );

      return;
    }

    publisher = publishToRelay(eventStore, {
      url: relayUrl,
      token: relayToken,
      sessionId: session.id,
    // Its own redaction, on its own path. Every outbound route does this rather
    // than trusting that some earlier one did.
      redactor: createRedactor({
        environment: process.env,
        knownSecrets: [accessToken, relayToken],
      }),
    });

    console.log(`relay   sharing session ${session.id} to ${relayUrl}`);
  });

  console.log(`relay   ready to share the first session with ${relayUrl}`);

  // The drop count is only useful if something can read it.
  process.on("exit", () => {
    if (publisher !== null && publisher.dropped() > 0) {
      console.error(
        `relay   ${publisher.dropped()} event(s) never reached the relay; the shared copy is short by that many`,
      );
    }
  });
  // Deliberately not an invite link. The worker does not know the relay's watch
  // token — only the relay mints that — so printing a URL with a placeholder
  // where the credential goes gave people something that looked usable and was
  // not. The relay prints the real one; this says so.
  console.log(
    "relay   the invite link is printed by the relay, which owns the watch token",
  );
} else if (relayUrl || relayToken) {
  console.error(
    "relay   NOVUS_RELAY_URL and NOVUS_RELAY_TOKEN must both be set; sharing is off",
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
  // Dev servers are detached for the same reason commands are, so a quit
  // would otherwise leave one listening invisibly on its port — the exact
  // leak the dev_server tool exists to prevent.
  stopAllDevServers();
  void eventServer.close().then(() => {
    eventStore.close();
    process.exit(code);
  });
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(143));

// Every other way this process can stop.
//
// The two signals above are the polite exits, and they were the only ones
// wired up — so an uncaught exception, an explicit process.exit from anywhere,
// or Electron's parent going away took the worker down while leaving its
// detached children alive. A dev server that outlives the worker holds its
// port against the next launch and answers requests from a run nobody is
// watching, which is worse than one that never started.
//
// An 'exit' handler may only do synchronous work, which is exactly what these
// two are: both are process.kill loops. Nothing here can await, and nothing
// here needs to. Both are idempotent, so the ordinary path — a signal handler
// that already ran them before calling process.exit — is harmless.
process.on("exit", () => {
  killRunningCommands();
  stopAllDevServers();
});
