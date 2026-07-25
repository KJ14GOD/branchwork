import { fileURLToPath } from "node:url";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter, type ModelRequest, type ModelResponse } from "./model.ts";
import {
  ProposePatchTool,
  ReadFileTool,
  SearchRepositoryTool,
} from "./tools.ts";

/**
 * A scripted run for developing the renderer.
 *
 * Every tool result is produced by the real tools against the real repository —
 * only the model's decisions are fixed, so the event log has the exact shape a
 * live run produces without spending a provider call.
 */

const selection = { provider: "scripted", model: "renderer-fixture" };
const repositoryPath = fileURLToPath(new URL("../../..", import.meta.url));
const sessionId = process.env.NOVUS_SESSION ?? "session-1";

const script: ModelResponse[] = [
  {
    type: "tool_call",
    call: {
      id: "call-1",
      name: "search_repository",
      input: { query: "class AgentRunner", limit: 5 },
    },
  },
  {
    type: "tool_call",
    call: {
      id: "call-2",
      name: "read_file",
      input: { path: "apps/worker/src/agent-runner.ts" },
    },
  },
  {
    // A miss on exact text: the model gets the error back and corrects it.
    type: "tool_call",
    call: {
      id: "call-3",
      name: "propose_patch",
      input: {
        path: "apps/worker/src/agent-runner.ts",
        intent: "Document AgentRunner.",
        edits: [
          { oldText: "export class AgentRunnerz {", newText: "// nope" },
        ],
      },
    },
  },
  {
    type: "tool_call",
    call: {
      id: "call-4",
      name: "propose_patch",
      input: {
        path: "apps/worker/src/agent-runner.ts",
        intent:
          "Document AgentRunner as the bounded model and tool execution loop.",
        edits: [
          {
            oldText: "export class AgentRunner {",
            newText: [
              "/**",
              " * Drives one run: routes to a model adapter, validates each requested",
              " * tool call, executes it, and records every step as an ordered event.",
              " */",
              "export class AgentRunner {",
            ].join("\n"),
          },
        ],
      },
    },
  },
  {
    type: "final",
    summary:
      "Proposed a doc comment above AgentRunner in apps/worker/src/agent-runner.ts. The patch is a preview only — nothing was written to the working tree.",
  },
];

const adapter = {
  selection,
  async complete(request: ModelRequest): Promise<ModelResponse> {
    await new Promise((resolve) => setTimeout(resolve, 450));

    return script[request.toolExchanges.length] ?? script.at(-1)!;
  },
};

const eventStore = new InMemorySessionEventStore();
const eventServer = await startEventServer(eventStore);

console.log(`novus fixture · session ${sessionId}`);
console.log(`events ${eventServer.url}/events?session=${sessionId}\n`);

const runner = new AgentRunner(
  eventStore,
  new FixedModelRouter(selection),
  [adapter],
  [
    new SearchRepositoryTool(repositoryPath),
    new ReadFileTool(repositoryPath),
    new ProposePatchTool(repositoryPath),
  ],
);

try {
  await runner.run({
    sessionId,
    actorId: "agent-1",
    goal: "Document the AgentRunner class.",
  });
  console.log("run completed");
} catch (error) {
  console.error(`run failed: ${(error as Error).message}`);
}

console.log("serving the event log — press ctrl+c to stop");

process.on("SIGINT", () => {
  void eventServer.close().then(() => process.exit(0));
});
