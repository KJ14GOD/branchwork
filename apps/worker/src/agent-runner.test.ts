import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import {
  FixedModelRouter,
  ScriptedModelAdapter,
  TransientModelError,
  type ModelAdapter,
} from "./model.ts";
import { AllowListApprovalGate } from "./policy.ts";
import {
  ApplyPatchTool,
  ProposePatchTool,
  ReadFileTool,
  SearchRepositoryTool,
} from "./tools.ts";

test("records a complete run using the selected model", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-runner-"));
  await writeFile(
    join(repositoryPath, "package.json"),
    '{"name":"fixture"}\n',
    "utf8",
  );

  const modelSelection = {
    provider: "scripted",
    model: "scripted-v1",
  };
  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(modelSelection),
    [new ScriptedModelAdapter(modelSelection)],
    [new ReadFileTool(repositoryPath)],
  );

  try {
    const result = await runner.run({
      sessionId: "runner-test-session",
      actorId: "agent-1",
      goal: "Inspect the project configuration",
    });

    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        "run.started",
        "run.progress",
        "tool.requested",
        "tool.completed",
        "run.completed",
        // The receipt is emitted after the terminal event, so it can report how
        // the run actually ended rather than how it was expected to.
        "receipt.created",
      ],
    );
    assert.deepEqual(
      result.events.map((event) => event.sequence),
      [0, 1, 2, 3, 4, 5],
    );

    const startedEvent = result.events[0];
    assert.equal(startedEvent?.type, "run.started");
    if (startedEvent?.type === "run.started") {
      assert.deepEqual(startedEvent.payload.run.model, modelSelection);
    }

    const toolEvent = result.events[3];
    assert.equal(toolEvent?.type, "tool.completed");
    if (toolEvent?.type === "tool.completed") {
      assert.equal(toolEvent.payload.result.name, "read_file");
    }
    if (
      toolEvent?.type === "tool.completed" &&
      toolEvent.payload.result.name === "read_file"
    ) {
      assert.equal(toolEvent.payload.result.output.path, "package.json");
      assert.match(toolEvent.payload.result.output.content, /fixture/);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("read_file rejects paths outside the repository", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-tool-"));
  const tool = new ReadFileTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "outside-read",
        name: "read_file",
        input: {
          path: "../outside.txt",
        },
      }),
      /outside the repository/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("read_file rejects protected repository files", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-protected-"));
  await writeFile(
    join(repositoryPath, ".env"),
    "ANTHROPIC_API_KEY=secret\n",
    "utf8",
  );
  const tool = new ReadFileTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "protected-read",
        name: "read_file",
        input: {
          path: ".env",
        },
      }),
      /protected repository paths/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("search_repository returns structured repository matches", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-search-"));
  await mkdir(join(repositoryPath, "src"));
  await writeFile(
    join(repositoryPath, "src", "runner.ts"),
    "export class AgentRunner {}\n",
    "utf8",
  );
  await writeFile(
    join(repositoryPath, "src", "unrelated.ts"),
    "export const value = 1;\n",
    "utf8",
  );

  const tool = new SearchRepositoryTool(repositoryPath);

  try {
    const result = await tool.execute({
      id: "search-call",
      name: "search_repository",
      input: {
        query: "AgentRunner",
      },
    });

    assert.equal(result.name, "search_repository");
    if (result.name === "search_repository") {
      assert.deepEqual(result.output.matches, [
        {
          path: "src/runner.ts",
          line: 1,
          text: "export class AgentRunner {}",
        },
      ]);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

const originalSource = [
  "export const greet = (name: string): string => {",
  "  return `hello ${name}`;",
  "};",
].join("\n");

test("propose_patch previews a diff without touching the working tree", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const tool = new ProposePatchTool(repositoryPath);

  try {
    const result = await tool.execute({
      id: "patch-call",
      name: "propose_patch",
      input: {
        path: "greet.ts",
        intent: "Greet with an exclamation mark.",
        edits: [
          {
            oldText: "return `hello ${name}`;",
            newText: "return `hello ${name}!`;",
          },
        ],
      },
    });

    assert.equal(result.name, "propose_patch");

    if (result.name === "propose_patch") {
      assert.equal(result.output.status, "proposed");
      assert.equal(result.output.path, "greet.ts");
      assert.equal(result.output.additions, 1);
      assert.equal(result.output.deletions, 1);
      assert.match(result.output.diff, /^\+ {2}return `hello \$\{name\}!`;$/m);

      const proposal = tool.getProposal(result.output.patchId);
      assert.equal(proposal?.path, "greet.ts");
      assert.match(proposal?.proposedContent ?? "", /hello \$\{name\}!/);
    }

    // The proposal is a preview: the file on disk must be untouched.
    assert.equal(await readFile(filePath, "utf8"), `${originalSource}\n`);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a proposed patch reaches the session event log", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-events-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const selection = { provider: "scripted", model: "patch-proposer" };

  // A minimal adapter that proposes once, then summarises — enough to prove the
  // proposal crosses the runner and lands in the ordered event log.
  const adapter = {
    selection,
    async complete(request: { toolExchanges: readonly unknown[] }) {
      if (request.toolExchanges.length === 0) {
        return {
          type: "tool_call" as const,
          call: {
            id: "patch-call",
            name: "propose_patch" as const,
            input: {
              path: "greet.ts",
              intent: "Greet with an exclamation mark.",
              edits: [
                {
                  oldText: "return `hello ${name}`;",
                  newText: "return `hello ${name}!`;",
                },
              ],
            },
          },
        };
      }

      return { type: "final" as const, summary: "Proposed one patch." };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(selection),
    [adapter],
    [new ProposePatchTool(repositoryPath)],
  );

  try {
    const result = await runner.run({
      sessionId: "patch-session",
      actorId: "agent-1",
      goal: "Improve the greeting.",
    });

    const completed = result.events.find(
      (event) => event.type === "tool.completed",
    );

    assert.equal(completed?.type, "tool.completed");

    if (
      completed?.type === "tool.completed" &&
      completed.payload.result.name === "propose_patch"
    ) {
      assert.equal(completed.payload.result.output.status, "proposed");
      assert.match(completed.payload.result.output.diff, /^\+.*!`;$/m);
    }

    assert.equal(await readFile(filePath, "utf8"), `${originalSource}\n`);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

const failingSelection = { provider: "scripted", model: "retrying" };

// A tool that rejects the first N calls, then succeeds.
class FlakyTool {
  readonly name = "read_file" as const;
  calls = 0;
  readonly failures: number;

  constructor(failures: number) {
    this.failures = failures;
  }

  async execute(call: { id: string }) {
    this.calls += 1;

    if (this.calls <= this.failures) {
      throw new Error(`transient failure ${this.calls}`);
    }

    return {
      toolCallId: call.id,
      name: "read_file" as const,
      output: { path: "ok.txt", content: "recovered" },
    };
  }
}

const retryingAdapter = {
  selection: failingSelection,
  async complete(request: { toolExchanges: readonly { status: string }[] }) {
    const recovered = request.toolExchanges.some(
      (exchange) => exchange.status === "ok",
    );

    if (recovered) {
      return { type: "final" as const, summary: "Recovered after a failure." };
    }

    return {
      type: "tool_call" as const,
      call: {
        id: `call-${request.toolExchanges.length}`,
        name: "read_file" as const,
        input: { path: "ok.txt" },
      },
    };
  },
};

test("a tool error returns to the model instead of ending the run", async () => {
  const eventStore = new InMemorySessionEventStore();
  const tool = new FlakyTool(1);
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(failingSelection),
    [retryingAdapter],
    [tool],
  );

  const result = await runner.run({
    sessionId: "retry-session",
    actorId: "agent-1",
    goal: "Read the file.",
  });

  const failure = result.events.find((event) => event.type === "tool.failed");
  assert.equal(failure?.type, "tool.failed");

  if (failure?.type === "tool.failed") {
    assert.match(failure.payload.message, /transient failure 1/);
  }

  // The model was given the error and retried, so the run still completes.
  assert.equal(tool.calls, 2);
  assert.ok(result.events.some((event) => event.type === "tool.completed"));
  assert.ok(result.events.some((event) => event.type === "run.completed"));
  assert.ok(!result.events.some((event) => event.type === "run.failed"));
});

test("a run that cannot recover fails with an event rather than throwing", async () => {
  const eventStore = new InMemorySessionEventStore();
  const tool = new FlakyTool(Number.POSITIVE_INFINITY);
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(failingSelection),
    [retryingAdapter],
    [tool],
  );

  const result = await runner.run({
    sessionId: "stuck-session",
    actorId: "agent-1",
    goal: "Read the file.",
  });

  const failed = result.events.findLast((event) => event.type === "run.failed");
  assert.equal(failed?.type, "run.failed");

  if (failed?.type === "run.failed") {
    assert.match(failed.payload.reason, /3 tool calls in a row/);
  }

  // It gives up at the consecutive-failure cap, well before the step ceiling.
  assert.equal(tool.calls, 3);
});

const patchSelection = { provider: "scripted", model: "patch-applier" };

// Proposes a patch, then applies whatever patchId came back.
const applyingAdapter = {
  selection: patchSelection,
  async complete(request: {
    toolExchanges: readonly {
      status: string;
      result?: { name: string; output: Record<string, unknown> };
    }[];
  }) {
    const proposal = request.toolExchanges.find(
      (exchange) =>
        exchange.status === "ok" && exchange.result?.name === "propose_patch",
    );

    if (!proposal) {
      return {
        type: "tool_call" as const,
        call: {
          id: "propose-call",
          name: "propose_patch" as const,
          input: {
            path: "greet.ts",
            intent: "Greet with an exclamation mark.",
            edits: [
              {
                oldText: "return `hello ${name}`;",
                newText: "return `hello ${name}!`;",
              },
            ],
          },
        },
      };
    }

    const applied = request.toolExchanges.length > 1;

    if (applied) {
      return { type: "final" as const, summary: "Done." };
    }

    return {
      type: "tool_call" as const,
      call: {
        id: "apply-call",
        name: "apply_patch" as const,
        input: {
          patchId: proposal.result!.output.patchId as string,
        },
      },
    };
  },
};

const buildPatchRunner = (
  repositoryPath: string,
  eventStore: InMemorySessionEventStore,
  gate?: AllowListApprovalGate,
) => {
  const proposeTool = new ProposePatchTool(repositoryPath);

  return new AgentRunner(
    eventStore,
    new FixedModelRouter(patchSelection),
    [applyingAdapter],
    [proposeTool, new ApplyPatchTool(repositoryPath, proposeTool)],
    gate,
  );
};

test("apply_patch writes the file once approved", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-apply-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const eventStore = new InMemorySessionEventStore();
  const runner = buildPatchRunner(
    repositoryPath,
    eventStore,
    new AllowListApprovalGate(["apply_patch"], "host"),
  );

  try {
    const result = await runner.run({
      sessionId: "apply-session",
      actorId: "agent-1",
      goal: "Improve the greeting.",
    });

    const requested = result.events.find(
      (event) => event.type === "tool.approval_requested",
    );
    assert.equal(requested?.type, "tool.approval_requested");

    if (requested?.type === "tool.approval_requested") {
      assert.equal(requested.payload.toolClass, "write");
      assert.equal(requested.payload.call.name, "apply_patch");
    }

    const approved = result.events.find(
      (event) => event.type === "tool.approved",
    );
    assert.equal(approved?.type, "tool.approved");

    if (approved?.type === "tool.approved") {
      assert.equal(approved.payload.approvedBy, "host");
    }

    // The approval precedes the write in the ordered log.
    const approvalIndex = result.events.findIndex(
      (event) => event.type === "tool.approved",
    );
    const appliedIndex = result.events.findIndex(
      (event) =>
        event.type === "tool.completed" &&
        event.payload.result.name === "apply_patch",
    );
    assert.ok(approvalIndex >= 0 && approvalIndex < appliedIndex);

    assert.match(await readFile(filePath, "utf8"), /hello \$\{name\}!/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a denied apply_patch leaves the working tree untouched", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-denied-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const eventStore = new InMemorySessionEventStore();
  // No gate configured: writes must be denied, never silently allowed.
  const runner = buildPatchRunner(repositoryPath, eventStore);

  try {
    const result = await runner.run({
      sessionId: "denied-session",
      actorId: "agent-1",
      goal: "Improve the greeting.",
    });

    const denied = result.events.find((event) => event.type === "tool.denied");
    assert.equal(denied?.type, "tool.denied");

    if (denied?.type === "tool.denied") {
      assert.match(denied.payload.reason, /no approval gate is configured/);
    }

    assert.ok(!result.events.some((event) => event.type === "tool.approved"));
    assert.equal(await readFile(filePath, "utf8"), `${originalSource}\n`);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("apply_patch refuses a file that changed after the proposal", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-drift-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const proposeTool = new ProposePatchTool(repositoryPath);
  const applyTool = new ApplyPatchTool(repositoryPath, proposeTool);

  try {
    const proposed = await proposeTool.execute({
      id: "propose-call",
      name: "propose_patch",
      input: {
        path: "greet.ts",
        intent: "Greet with an exclamation mark.",
        edits: [
          {
            oldText: "return `hello ${name}`;",
            newText: "return `hello ${name}!`;",
          },
        ],
      },
    });

    assert.equal(proposed.name, "propose_patch");

    // Someone edits the file between proposal and application.
    await writeFile(filePath, "export const greet = () => {};\n", "utf8");

    if (proposed.name === "propose_patch") {
      await assert.rejects(
        applyTool.execute({
          id: "apply-call",
          name: "apply_patch",
          input: { patchId: proposed.output.patchId },
        }),
        /changed after this patch was proposed/,
      );
    }

    assert.equal(
      await readFile(filePath, "utf8"),
      "export const greet = () => {};\n",
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a second turn carries the first turn's conversation", async () => {
  const selection = { provider: "scripted", model: "conversational" };
  const seenHistories: number[] = [];
  const seenGoals: string[] = [];

  const adapter = {
    selection,
    async complete(request: {
      history: readonly { goal: string; summary: string }[];
      goal: string;
    }) {
      seenHistories.push(request.history.length);
      seenGoals.push(request.goal);

      return {
        type: "final" as const,
        summary: `answered: ${request.goal}`,
      };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(selection),
    [adapter],
    [],
  );

  await runner.run({ sessionId: "chat", actorId: "human", goal: "first" });
  await runner.run({ sessionId: "chat", actorId: "human", goal: "second" });
  const result = await runner.run({
    sessionId: "chat",
    actorId: "human",
    goal: "third",
  });

  // Each turn sees every earlier turn; the current goal is never in history.
  assert.deepEqual(seenHistories, [0, 1, 2]);
  assert.deepEqual(seenGoals, ["first", "second", "third"]);

  // Every turn is its own run in the ordered log.
  assert.equal(
    result.events.filter((event) => event.type === "run.started").length,
    3,
  );
  assert.equal(
    result.events.filter((event) => event.type === "run.completed").length,
    3,
  );
});

test("propose_patch rejects an ambiguous edit", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-ambiguous-"));
  const filePath = join(repositoryPath, "repeat.ts");
  await writeFile(filePath, "const a = 1;\nconst a = 1;\n", "utf8");

  const tool = new ProposePatchTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "ambiguous-call",
        name: "propose_patch",
        input: {
          path: "repeat.ts",
          intent: "Change the constant.",
          edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
        },
      }),
      /ambiguous: oldText matches 2 locations/,
    );

    assert.equal(await readFile(filePath, "utf8"), "const a = 1;\nconst a = 1;\n");
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("propose_patch rejects protected repository files", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-env-"));
  await writeFile(
    join(repositoryPath, ".env"),
    "ANTHROPIC_API_KEY=secret\n",
    "utf8",
  );

  const tool = new ProposePatchTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "protected-patch",
        name: "propose_patch",
        input: {
          path: ".env",
          intent: "Rotate the key.",
          edits: [
            { oldText: "ANTHROPIC_API_KEY=secret", newText: "ANTHROPIC_API_KEY=" },
          ],
        },
      }),
      /protected repository paths/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a malformed tool call is an observation, not the end of the run", async () => {
  // Found by a live benchmark: the model returned propose_patch with `edits` as
  // a string. ToolCallSchema.parse threw inside the adapter, the throw escaped
  // the run loop, and the run ended with no run.failed and no receipt — an
  // agent that simply stopped, with nothing in the log saying why.
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      if (asked === 1) {
        return {
          type: "invalid_tool_call",
          id: "call-1",
          name: "propose_patch",
          input: { path: "a.ts", intent: "fix", edits: "not an array" },
          message: "input.edits: expected array, received string",
        };
      }

      return { type: "final", summary: "Recovered and finished." };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [],
  );

  const result = await runner.run({
    sessionId: "malformed-session",
    actorId: "agent-1",
    goal: "Exercise a malformed tool call",
  });

  const types = result.events.map((event) => event.type);

  // The run finished, and the model got a turn back to correct itself.
  assert.ok(types.includes("run.completed"), "the run did not finish");
  assert.ok(!types.includes("run.failed"));
  assert.ok(types.includes("tool.failed"), "the malformed call was not recorded");
  assert.ok(types.includes("receipt.created"), "a finished run produced no receipt");
  assert.equal(asked, 2, "the model was not given another turn");
});

test("direction submitted mid-run reaches the model at the next turn", async () => {
  const eventStore = new InMemorySessionEventStore();
  const seen: string[] = [];
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request) {
      asked += 1;
      seen.push(request.goal);

      if (asked === 1) {
        // Arrives while the first turn is in flight, which is the case V1
        // cares about: a human typing while the agent is already working.
        eventStore.append({
          sessionId: "steered-session",
          actorId: "teammate-1",
          type: "direction.submitted",
          payload: {
            runId: "steered-session",
            direction: "Do not change the token schema",
          },
        });

        return { type: "tool_call", call: { id: "c1", name: "read_file", input: { path: "package.json" } } };
      }

      return { type: "final", summary: "Done." };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new ReadFileTool(process.cwd())],
  );

  const result = await runner.run({
    sessionId: "steered-session",
    actorId: "agent-1",
    goal: "Original goal",
  });

  // The first turn saw only the goal — direction never lands mid-call.
  assert.equal(seen[0], "Original goal");
  // The second saw it, once, and the log says so.
  assert.match(seen[1] ?? "", /Do not change the token schema/);
  assert.equal(
    result.events.filter((event) => event.type === "direction.applied").length,
    1,
  );
});

test("direction already applied is not applied again", async () => {
  const eventStore = new InMemorySessionEventStore();
  const goals: string[] = [];
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request) {
      asked += 1;
      goals.push(request.goal);

      return asked < 3
        ? { type: "tool_call", call: { id: `c${asked}`, name: "read_file", input: { path: "package.json" } } }
        : { type: "final", summary: "Done." };
    },
  };

  eventStore.append({
    sessionId: "once-session",
    actorId: "teammate-1",
    type: "direction.submitted",
    payload: { runId: "once-session", direction: "Keep the public API stable" },
  });

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new ReadFileTool(process.cwd())],
  );

  const result = await runner.run({
    sessionId: "once-session",
    actorId: "agent-1",
    goal: "Original goal",
  });

  // Reading pending direction out of the log is what makes this true: a queue
  // beside the log is how the same direction gets applied on every turn.
  assert.equal(
    result.events.filter((event) => event.type === "direction.applied").length,
    1,
  );
  assert.equal(
    goals.filter((goal) => goal.includes("Keep the public API stable")).length,
    1,
  );
});

test("a run re-reading the same file forever is stopped while it is cheap", async () => {
  // The livelock signature: 79 model calls, every one a successful read of
  // something already read, and nothing tripped — the failure counter needs
  // failures, and the token and wall-clock ceilings are sized for a hard
  // afternoon, so the run burned for half an hour before a resource ran out.
  // Identical reads with no write between them are zero information, and the
  // run should stop at a handful of them, not at two million tokens.
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-reread-"));
  await writeFile(join(repositoryPath, "package.json"), '{"name":"loop"}\n', "utf8");

  let asked = 0;
  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      return {
        type: "tool_call",
        call: { id: `c${asked}`, name: "read_file", input: { path: "package.json" } },
      };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new ReadFileTool(repositoryPath)],
  );

  try {
    const result = await runner.run({
      sessionId: "reread-session",
      actorId: "agent-1",
      goal: "Explain this repo",
    });

    const failed = result.events.findLast((event) => event.type === "run.failed");
    assert.equal(failed?.type, "run.failed");

    if (failed?.type === "run.failed") {
      // The reason names the exact call, because "the run stopped" is not
      // something a person can debug a loop from.
      assert.match(failed.payload.reason, /read_file/);
      assert.match(failed.payload.reason, /re-reading/);
    }

    // Eight identical reads, not five hundred model calls.
    assert.equal(asked, 8, "the loop was not stopped at the read ceiling");
    // The receipt still exists, because a stopped run is still a run someone
    // has to be able to account for.
    assert.ok(result.events.some((event) => event.type === "receipt.created"));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("re-reading after a write is recovery, not a loop", async () => {
  // The counter must reset when the repository can have changed, or the
  // detector punishes the exact behaviour the harness wants: read, patch,
  // read back what the patch did.
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-reread-reset-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  // Four identical reads, a propose+apply, four more identical reads: eight
  // reads of one path in one run, legal because a write sits between the
  // stretches and neither stretch reaches the ceiling on its own.
  let asked = 0;
  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request) {
      asked += 1;
      const step = request.toolExchanges.length;

      if (step < 4 || (step >= 6 && step < 10)) {
        return {
          type: "tool_call",
          call: { id: `read-${asked}`, name: "read_file", input: { path: "greet.ts" } },
        };
      }

      if (step === 4) {
        return {
          type: "tool_call",
          call: {
            id: "propose",
            name: "propose_patch",
            input: {
              path: "greet.ts",
              intent: "Greet with an exclamation mark.",
              edits: [
                { oldText: "return `hello ${name}`;", newText: "return `hello ${name}!`;" },
              ],
            },
          },
        };
      }

      if (step === 5) {
        const proposal = request.toolExchanges.find(
          (exchange) =>
            exchange.status === "ok" && exchange.result.name === "propose_patch",
        );

        if (proposal?.status === "ok" && proposal.result.name === "propose_patch") {
          return {
            type: "tool_call",
            call: {
              id: "apply",
              name: "apply_patch",
              input: { patchId: proposal.result.output.patchId },
            },
          };
        }
      }

      return { type: "final", summary: "Read, patched, and read back." };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const proposeTool = new ProposePatchTool(repositoryPath);
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [
      new ReadFileTool(repositoryPath),
      proposeTool,
      new ApplyPatchTool(repositoryPath, proposeTool),
    ],
    new AllowListApprovalGate(["apply_patch"], "host"),
  );

  try {
    const result = await runner.run({
      sessionId: "reread-reset-session",
      actorId: "agent-1",
      goal: "Improve the greeting and verify it.",
    });

    assert.ok(
      result.events.some((event) => event.type === "run.completed"),
      "eight reads split by a write should complete, not trip the loop detector",
    );
    assert.ok(!result.events.some((event) => event.type === "run.failed"));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a transient provider error is waited out instead of ending the run", async () => {
  // A live trace lost twenty-one tool calls of gathered context to one 529
  // that outlasted the SDK's own retries. Everything the run needed to
  // continue was still in memory; dying discarded it all. The overload is the
  // provider's weather — the run waits it out and finishes.
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-overload-"));
  await writeFile(join(repositoryPath, "package.json"), '{"name":"ok"}\n', "utf8");

  let asked = 0;
  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request) {
      asked += 1;

      // Two overloads mid-run, after work has already accumulated.
      if (asked === 2 || asked === 3) {
        throw new TransientModelError("529 Overloaded", new Error("overloaded"));
      }

      if (request.toolExchanges.length === 0) {
        return {
          type: "tool_call",
          call: { id: "c1", name: "read_file", input: { path: "package.json" } },
        };
      }

      return { type: "final", summary: "Finished despite the overload." };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new ReadFileTool(repositoryPath)],
    undefined,
    undefined,
    undefined,
    // Instant retries: the schedule is what is under test, not the clock.
    [0, 0, 0],
  );

  try {
    const result = await runner.run({
      sessionId: "overload-session",
      actorId: "agent-1",
      goal: "Survive an overloaded provider",
    });

    assert.ok(result.events.some((event) => event.type === "run.completed"));
    assert.ok(!result.events.some((event) => event.type === "run.failed"));

    // The waits are in the log, because a silent wait is indistinguishable
    // from a hung run to anyone watching the timeline.
    const retries = result.events.filter(
      (event) =>
        event.type === "run.progress" &&
        /retrying/.test(event.payload.message),
    );
    assert.equal(retries.length, 2);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a provider that stays down ends the run with the cause intact", async () => {
  // Retry is a bounded wait, not a promise to hold on forever: when every
  // wait is used up the original error escapes, so the caller can still say
  // exactly why the run died.
  let asked = 0;
  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;
      throw new TransientModelError("529 Overloaded", new Error("overloaded"));
    },
  };

  const runner = new AgentRunner(
    new InMemorySessionEventStore(),
    new FixedModelRouter(adapter.selection),
    [adapter],
    [],
    undefined,
    undefined,
    undefined,
    [0, 0],
  );

  await assert.rejects(
    runner.run({
      sessionId: "dead-provider-session",
      actorId: "agent-1",
      goal: "Meet a dead provider",
    }),
    /529 Overloaded/,
  );

  // One first attempt plus one per configured wait, then no more.
  assert.equal(asked, 3);
});
