import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { FixedModelRouter } from "./model.ts";
import { ReadFileTool } from "./tools.ts";

const modelSelection = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

const eventStore = new InMemorySessionEventStore();
const router = new FixedModelRouter(modelSelection);
const modelAdapter = new AnthropicModelAdapter(modelSelection);
const agentRunner = new AgentRunner(
  eventStore,
  router,
  [modelAdapter],
  [new ReadFileTool(process.cwd())],
);

const result = await agentRunner.run({
  sessionId: "session-1",
  actorId: "agent-1",
  goal:
    "Read package.json and explain the purpose of this package in two sentences.",
});

console.log(JSON.stringify(result.events, null, 2));
