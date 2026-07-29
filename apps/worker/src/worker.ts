import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { killRunningCommands } from "./tools.ts";

const modelSelection = {
  provider: "anthropic",
  model: "claude-opus-5",
};

// Writes are denied unless the operator opts in.
const allowWrites = process.env.NOVUS_ALLOW_WRITES === "1";
const allowCommands = process.env.NOVUS_ALLOW_COMMANDS === "1";
const goal = process.argv.slice(2).join(" ").trim();

const eventStore = new InMemorySessionEventStore();

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
  eventServer = await startEventServer(eventStore, { sessions });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`novus worker · ${eventServer.url}`);
console.log(
  `writes ${allowWrites ? "approved (NOVUS_ALLOW_WRITES=1)" : "denied — set NOVUS_ALLOW_WRITES=1 to permit apply_patch"}`,
);
console.log(
  `commands ${allowCommands ? "approved (NOVUS_ALLOW_COMMANDS=1)" : "denied — set NOVUS_ALLOW_COMMANDS=1 to permit run_command and run_tests"}`,
);

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
  void eventServer.close().then(() => process.exit(code));
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(143));
