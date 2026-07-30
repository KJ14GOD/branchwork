import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, type ModelAdapter, type ModelRequest } from "./model.ts";
import { AllowListApprovalGate } from "./policy.ts";
import type { AgentTool } from "./tools.ts";
import { buildReceipt } from "./receipt.ts";
import { projectSession } from "./projection.ts";

/**
 * A `read_file` stand-in whose `execute` requests a pause as a side effect —
 * the pause equivalent of `cancel.test.ts`'s `CancellingTool`, simulating a
 * human pausing *while this tool call is already in flight*.
 */
class PausingTool implements AgentTool {
  readonly name = "read_file" as const;
  private readonly eventStore: SessionEventStore;
  private readonly sessionId: string;

  constructor(eventStore: SessionEventStore, sessionId: string) {
    this.eventStore = eventStore;
    this.sessionId = sessionId;
  }

  async execute(call: Parameters<AgentTool["execute"]>[0]) {
    const started = this.eventStore
      .list(this.sessionId)
      .find((event) => event.type === "run.started");

    if (started?.type === "run.started") {
      this.eventStore.append({
        sessionId: this.sessionId,
        actorId: "teammate-1",
        type: "run.pause_requested",
        payload: { runId: started.payload.run.id },
      });
    }

    return {
      toolCallId: call.id,
      name: "read_file" as const,
      output: { path: "package.json", content: "{}" },
    };
  }
}

test("a pause requested mid-tool-call finishes that call, then stops before the next model call", async () => {
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      return asked === 1
        ? {
            type: "tool_call",
            call: { id: "c1", name: "read_file", input: { path: "package.json" } },
          }
        : { type: "final", summary: "Should never be reached." };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new PausingTool(eventStore, "pause-session")],
  );

  const result = await runner.run({
    sessionId: "pause-session",
    actorId: "agent-1",
    goal: "Read the manifest",
  });

  // Exactly one model call — the run stopped at the turn boundary.
  assert.equal(asked, 1);

  const types = result.events.map((event) => event.type);

  assert.ok(types.includes("tool.completed"), "the in-flight tool call did not finish");
  assert.equal(types.filter((type) => type === "tool.requested").length, 1);
  assert.ok(!types.includes("run.completed"));
  assert.ok(!types.includes("run.failed"));
  assert.ok(!types.includes("run.cancelled"));
  assert.ok(types.includes("run.paused"));
});

test("a paused run produces no receipt — it has not ended", () => {
  const eventStore = new InMemorySessionEventStore();

  eventStore.append({
    sessionId: "receipt-session",
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-1",
        sessionId: "receipt-session",
        goal: "Do something",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

  eventStore.append({
    sessionId: "receipt-session",
    actorId: "agent-1",
    type: "run.paused",
    payload: { runId: "run-1" },
  });

  const receipt = buildReceipt(eventStore.list("receipt-session"), "run-1", {
    base: { revision: null, dirty: null },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 1,
      callsMissingUsage: 0,
      modelTimeMs: 0,
      costUsd: null,
      rates: null,
    },
  });

  assert.equal(receipt, null);
});

test("the projection reports a paused run as paused, then running again once resumed", () => {
  const eventStore = new InMemorySessionEventStore();

  eventStore.append({
    sessionId: "projection-session",
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-1",
        sessionId: "projection-session",
        goal: "Do something",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

  eventStore.append({
    sessionId: "projection-session",
    actorId: "agent-1",
    type: "run.paused",
    payload: { runId: "run-1" },
  });

  const paused = projectSession(
    "projection-session",
    eventStore.list("projection-session"),
  );

  assert.equal(paused.runs[0]?.status, "paused");

  eventStore.append({
    sessionId: "projection-session",
    actorId: "agent-1",
    type: "run.resumed",
    payload: { runId: "run-1" },
  });

  const resumed = projectSession(
    "projection-session",
    eventStore.list("projection-session"),
  );

  assert.equal(resumed.runs[0]?.status, "running");
});

test("resuming replays the paused turn's tool exchange back to the model, and the run can then complete", async () => {
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;
  let sawRebuiltExchange = false;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request: ModelRequest) {
      asked += 1;

      if (asked === 1) {
        return {
          type: "tool_call",
          call: { id: "c1", name: "read_file", input: { path: "package.json" } },
        };
      }

      // This call only happens after resume. If the tool exchange from
      // before the pause were lost, toolExchanges would be empty here.
      sawRebuiltExchange =
        request.toolExchanges.length === 1 &&
        request.toolExchanges[0]?.status === "ok";

      return { type: "final", summary: "Done after resuming." };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new PausingTool(eventStore, "resume-session")],
  );

  const paused = await runner.run({
    sessionId: "resume-session",
    actorId: "agent-1",
    goal: "Read the manifest",
  });

  assert.equal(asked, 1);
  assert.ok(paused.events.some((event) => event.type === "run.paused"));

  const started = paused.events.find((event) => event.type === "run.started");
  assert.equal(started?.type, "run.started");
  const runId = started?.type === "run.started" ? started.payload.run.id : "";

  const resumed = await runner.resume({
    sessionId: "resume-session",
    actorId: "agent-1",
    runId,
  });

  assert.equal(asked, 2);
  assert.ok(sawRebuiltExchange, "the model did not see the exchange from before the pause");

  const resumedTypes = resumed.events.map((event) => event.type);
  assert.ok(resumedTypes.includes("run.resumed"));
  assert.ok(resumedTypes.includes("run.completed"));
});

test("resuming does not re-emit run.started, and what the run did before the pause survives in the projection", async () => {
  // Reproduces the bug merge-guard found: execute() appended run.started
  // unconditionally, including on resume, and projection.ts resets a run's
  // entire state — filesChanged included — whenever it sees that event. A
  // run that had applied a patch before pausing showed zero files changed
  // after resuming, silently. The prior test's .find() masked this: it
  // returns the first match and never counts how many there were.
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      return asked === 1
        ? {
            type: "tool_call",
            call: { id: "c1", name: "apply_patch", input: { patchId: "p1" } },
          }
        : { type: "final", summary: "Done after resuming." };
    },
  };

  class ApplyingPausingTool implements AgentTool {
    readonly name = "apply_patch" as const;

    async execute(call: Parameters<AgentTool["execute"]>[0]) {
      const started = eventStore
        .list("resume-projection-session")
        .find((event) => event.type === "run.started");

      if (started?.type === "run.started") {
        eventStore.append({
          sessionId: "resume-projection-session",
          actorId: "teammate-1",
          type: "run.pause_requested",
          payload: { runId: started.payload.run.id },
        });
      }

      return {
        toolCallId: call.id,
        name: "apply_patch" as const,
        output: {
          patchId: "p1",
          path: "src/a.ts",
          status: "applied" as const,
          additions: 10,
          deletions: 2,
        },
      };
    }
  }

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [new ApplyingPausingTool()],
    new AllowListApprovalGate(["apply_patch"], "host"),
  );

  const paused = await runner.run({
    sessionId: "resume-projection-session",
    actorId: "agent-1",
    goal: "Apply a fix",
  });

  const beforeResume = projectSession(
    "resume-projection-session",
    eventStore.list("resume-projection-session"),
  );

  assert.deepEqual(beforeResume.runs[0]?.filesChanged, [
    { path: "src/a.ts", additions: 10, deletions: 2 },
  ]);

  const started = paused.events.find((event) => event.type === "run.started");
  assert.equal(started?.type, "run.started");
  const runId = started?.type === "run.started" ? started.payload.run.id : "";

  await runner.resume({
    sessionId: "resume-projection-session",
    actorId: "agent-1",
    runId,
  });

  const allEvents = eventStore.list("resume-projection-session");

  assert.equal(
    allEvents.filter((event) => event.type === "run.started").length,
    1,
    "run.started must appear exactly once per run id, resumed or not",
  );

  const afterResume = projectSession(
    "resume-projection-session",
    allEvents,
  );

  assert.deepEqual(
    afterResume.runs[0]?.filesChanged,
    [{ path: "src/a.ts", additions: 10, deletions: 2 }],
    "the file changed before the pause must still be reflected after resuming",
  );
});

test("resuming a run that was never paused is refused", async () => {
  const eventStore = new InMemorySessionEventStore();

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      return { type: "final", summary: "Finished normally." };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [],
  );

  const result = await runner.run({
    sessionId: "never-paused-session",
    actorId: "agent-1",
    goal: "Do something",
  });

  const started = result.events.find((event) => event.type === "run.started");
  assert.equal(started?.type, "run.started");
  const runId = started?.type === "run.started" ? started.payload.run.id : "";

  await assert.rejects(
    () =>
      runner.resume({ sessionId: "never-paused-session", actorId: "agent-1", runId }),
    /already ended/,
  );
});

test("resuming an unknown run is refused", async () => {
  const eventStore = new InMemorySessionEventStore();
  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      return { type: "final", summary: "unreachable" };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [],
  );

  await assert.rejects(
    () =>
      runner.resume({
        sessionId: "no-such-session",
        actorId: "agent-1",
        runId: "no-such-run",
      }),
    /No run .* exists to resume/,
  );
});
