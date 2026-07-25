import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter } from "./model.ts";
import {
  ProposePatchTool,
  ReadFileTool,
  SearchRepositoryTool,
} from "./tools.ts";

const DEFAULT_GOAL =
  "Find the AgentRunner class that orchestrates a Novus run, then propose a patch adding a short doc comment above the class describing its role. Search and read before proposing.";

const modelSelection = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

const sessionId = process.env.NOVUS_SESSION ?? "session-1";
const goal = process.argv.slice(2).join(" ").trim() || DEFAULT_GOAL;
const repositoryPath = process.env.NOVUS_REPO
  ? resolve(process.env.NOVUS_REPO)
  : fileURLToPath(new URL("../../..", import.meta.url));

const eventStore = new InMemorySessionEventStore();
eventStore.subscribe((event) => {
  if (event.type === "run.progress") {
    console.log(`• ${event.payload.message}`);
  }

  if (event.type === "tool.requested") {
    console.log(
      `→ ${event.payload.call.name} ${JSON.stringify(event.payload.call.input)}`,
    );
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

    console.log(`✓ ${result.name}`);
  }
});

const eventServer = await startEventServer(eventStore);

console.log(`novus worker · session ${sessionId}`);
console.log(`repository ${repositoryPath}`);
console.log(`events     ${eventServer.url}/events?session=${sessionId}\n`);

const agentRunner = new AgentRunner(
  eventStore,
  new FixedModelRouter(modelSelection),
  [new AnthropicModelAdapter(modelSelection)],
  [
    new SearchRepositoryTool(repositoryPath),
    new ReadFileTool(repositoryPath),
    new ProposePatchTool(repositoryPath),
  ],
);

try {
  const result = await agentRunner.run({ sessionId, actorId: "agent-1", goal });
  const completedEvent = result.events.findLast(
    (event) => event.type === "run.completed",
  );

  if (completedEvent?.type === "run.completed") {
    console.log(`\n${completedEvent.payload.summary}`);
  }
} catch (error) {
  // The run is over, but the event log it produced is still the evidence of
  // what happened. Keep serving it instead of exiting on the UI.
  console.error(`\nrun failed: ${(error as Error).message}`);
}

console.log("\nserving the event log — press ctrl+c to stop");

process.on("SIGINT", () => {
  void eventServer.close().then(() => process.exit(0));
});
