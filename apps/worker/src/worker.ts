import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, ScriptedModelAdapter } from "./model.ts";
import { ReadFileTool } from "./tools.ts";

const modelSelection = {
  provider: "scripted",
  model: "scripted-v1",
};

const eventStore = new InMemorySessionEventStore();
const router = new FixedModelRouter(modelSelection);
const modelAdapter = new ScriptedModelAdapter(modelSelection);
const agentRunner = new AgentRunner(
  eventStore,
  router,
  [modelAdapter],
  [new ReadFileTool(process.cwd())],
);

const result = await agentRunner.run({
  sessionId: "session-1",
  actorId: "agent-1",
  goal: "Inspect the project configuration",
});

console.log(JSON.stringify(result.events, null, 2));
