import { fileURLToPath } from "node:url";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { FixedModelRouter } from "./model.ts";
import { ReadFileTool, SearchRepositoryTool } from "./tools.ts";

const modelSelection = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

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
    console.log(`✓ ${event.payload.result.name}`);
  }
});

const router = new FixedModelRouter(modelSelection);
const modelAdapter = new AnthropicModelAdapter(modelSelection);
const repositoryPath = fileURLToPath(new URL("../../..", import.meta.url));
const agentRunner = new AgentRunner(
  eventStore,
  router,
  [modelAdapter],
  [
    new SearchRepositoryTool(repositoryPath),
    new ReadFileTool(repositoryPath),
  ],
);

const result = await agentRunner.run({
  sessionId: "session-1",
  actorId: "agent-1",
  goal:
    "Find where Novus orchestrates an agent run. Explain the execution flow and cite the relevant repository-relative files.",
});

const completedEvent = result.events.findLast(
  (event) => event.type === "run.completed",
);

if (completedEvent?.type !== "run.completed") {
  throw new Error("The run completed without a final summary.");
}

console.log(`\n${completedEvent.payload.summary}`);
