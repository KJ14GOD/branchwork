import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import type { AgentTool } from "./tools.ts";
import { buildReceipt } from "./receipt.ts";
import { projectSession } from "./projection.ts";

/**
 * A `read_file` stand-in whose `execute` requests a cancellation as a side
 * effect — simulating a human cancelling *while this tool call is already in
 * flight*, which is the boundary V1 actually specifies: the current atomic
 * tool action is allowed to finish, and only the run's next model call is
 * refused.
 */
class CancellingTool implements AgentTool {
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
        type: "run.cancel_requested",
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

test("a cancel requested mid-tool-call finishes that call, then stops before the next model call", async () => {
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      // If the boundary were wrong — cancelling mid-tool instead of after —
      // this would never be reached a second time regardless, so the count
      // assertion below is what actually proves the difference.
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
    [new CancellingTool(eventStore, "cancel-session")],
  );

  const result = await runner.run({
    sessionId: "cancel-session",
    actorId: "agent-1",
    goal: "Read the manifest",
  });

  // Exactly one model call — the run stopped at the turn boundary rather
  // than asking again.
  assert.equal(asked, 1);

  const types = result.events.map((event) => event.type);

  // The in-flight tool call was allowed to finish...
  assert.ok(types.includes("tool.completed"), "the in-flight tool call did not finish");
  // ...and the run stopped there, not with a second tool.requested, not
  // reported as a failure or a success it never reached.
  assert.equal(types.filter((type) => type === "tool.requested").length, 1);
  assert.ok(!types.includes("run.completed"));
  assert.ok(!types.includes("run.failed"));
  assert.ok(types.includes("run.cancelled"));

  const cancelled = result.events.find((event) => event.type === "run.cancelled");
  assert.equal(cancelled?.type, "run.cancelled");
});

test("a cancellation requested for a different run is ignored", async () => {
  const eventStore = new InMemorySessionEventStore();
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete() {
      asked += 1;

      if (asked === 1) {
        // Targets a run id that is not this one — a stale cancel, or one
        // meant for a sibling fork sharing the same session's event log.
        eventStore.append({
          sessionId: "other-run-session",
          actorId: "teammate-1",
          type: "run.cancel_requested",
          payload: { runId: "not-this-run" },
        });

        return { type: "final", summary: "Finished normally." };
      }

      return { type: "final", summary: "unreachable" };
    },
  };

  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [],
  );

  const result = await runner.run({
    sessionId: "other-run-session",
    actorId: "agent-1",
    goal: "Do something",
  });

  assert.ok(result.events.some((event) => event.type === "run.completed"));
  assert.ok(!result.events.some((event) => event.type === "run.cancelled"));
});

test("a cancelled run still produces a receipt, distinct from failure", () => {
  const eventStore = new InMemorySessionEventStore();

  const started = eventStore.append({
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
    type: "run.cancelled",
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

  assert.equal(receipt?.status, "cancelled");
  assert.equal(receipt?.summary, undefined);
  assert.equal(receipt?.failure, undefined);
  assert.ok(started.eventId);
});

test("the projection reports a cancelled run as cancelled, not running", () => {
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
    type: "run.cancelled",
    payload: { runId: "run-1" },
  });

  const projected = projectSession(
    "projection-session",
    eventStore.list("projection-session"),
  );

  assert.equal(projected.runs[0]?.status, "cancelled");
});
