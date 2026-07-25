import { fileURLToPath } from "node:url";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter, type ModelRequest, type ModelResponse } from "./model.ts";
import {
  ApplyPatchTool,
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
  // Attempts the write. The fixture configures no approval gate, so this is
  // denied and the repository is left untouched.
  {
    type: "tool_call",
    call: {
      id: "call-5",
      name: "apply_patch",
      input: { patchId: "resolved-at-runtime" },
    },
  },
  {
    type: "final",
    summary:
      "Proposed a doc comment above AgentRunner in apps/worker/src/agent-runner.ts. The write was denied, so nothing reached the working tree.",
  },
];

const adapter = {
  selection,
  async complete(request: ModelRequest): Promise<ModelResponse> {
    await new Promise((resolve) => setTimeout(resolve, 450));

    const step = script[request.toolExchanges.length] ?? script.at(-1)!;

    // Substitute the patchId the real propose_patch tool actually returned.
    if (step.type === "tool_call" && step.call.name === "apply_patch") {
      const proposal = request.toolExchanges.find(
        (exchange) =>
          exchange.status === "ok" && exchange.result.name === "propose_patch",
      );

      if (proposal?.status === "ok" && proposal.result.name === "propose_patch") {
        return {
          type: "tool_call",
          call: {
            ...step.call,
            input: { patchId: proposal.result.output.patchId },
          },
        };
      }
    }

    return step;
  },
};

const eventStore = new InMemorySessionEventStore();
const eventServer = await startEventServer(eventStore);

console.log(`novus fixture · session ${sessionId}`);
console.log(`events ${eventServer.url}/events?session=${sessionId}\n`);

const proposePatchTool = new ProposePatchTool(repositoryPath);
// No approval gate: the fixture demonstrates the boundary denying a write, so
// running it never modifies the repository.
const runner = new AgentRunner(
  eventStore,
  new FixedModelRouter(selection),
  [adapter],
  [
    new SearchRepositoryTool(repositoryPath),
    new ReadFileTool(repositoryPath),
    proposePatchTool,
    new ApplyPatchTool(repositoryPath, proposePatchTool),
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
