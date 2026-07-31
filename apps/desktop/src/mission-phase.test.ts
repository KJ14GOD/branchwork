import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";

import { missionPhases, type PhaseStatus } from "./mission-phase.ts";

/**
 * The decision spine's derivation.
 *
 * The rail counted what had happened — events, tool calls, patches — and never
 * said where the work stood or what it was waiting for. This is the thing that
 * answers the second question, so the property worth defending is that exactly
 * the states a person must act on are the ones that say so.
 */

const at = (sequence: number) => ({
  eventId: `e${sequence}`,
  sessionId: "s",
  sequence,
  occurredAt: "2026-07-31T00:00:00.000Z",
  actorId: "agent-1",
});

const started = (runId: string, sequence: number): SessionEvent =>
  ({
    ...at(sequence),
    type: "run.started",
    payload: {
      run: {
        id: runId,
        sessionId: "s",
        goal: "Fix it",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: "2026-07-31T00:00:00.000Z",
      },
    },
  }) as SessionEvent;

const completed = (runId: string, sequence: number): SessionEvent =>
  ({
    ...at(sequence),
    type: "run.completed",
    payload: { runId, summary: "Done." },
  }) as SessionEvent;

const attempt = (over: Partial<Comparison["attempts"][number]> = {}) =>
  ({
    runId: "fork-a",
    label: "a",
    baseline: false,
    interventions: [],
    status: "completed",
    summary: null,
    failure: null,
    filesChanged: [],
    additions: 0,
    deletions: 0,
    toolCalls: 0,
    testsRun: 0,
    testsPassed: 0,
    green: null,
    ...over,
  }) as Comparison["attempts"][number];

const comparison = (over: Partial<Comparison> = {}): Comparison => ({
  attempts: [],
  contestedPaths: [],
  uniquePaths: {},
  decision: null,
  ...over,
});

const statusOf = (
  phases: ReturnType<typeof missionPhases>,
  key: string,
): PhaseStatus | undefined => phases.find((phase) => phase.key === key)?.status;

test("a mission nobody has asked anything of is waiting on a brief", () => {
  const phases = missionPhases([], null);

  assert.equal(statusOf(phases, "brief"), "active");
  assert.equal(statusOf(phases, "execution"), "not-started");
  assert.equal(statusOf(phases, "decision"), "not-started");
});

test("a run in flight makes execution active, and nothing else demands attention", () => {
  const phases = missionPhases([started("run-1", 1)], comparison());

  assert.equal(statusOf(phases, "brief"), "complete");
  assert.equal(statusOf(phases, "execution"), "active");

  // The one rule this ladder lives or dies by: if everything is highlighted
  // then nothing is, and the rail stops answering "what needs me".
  assert.equal(
    phases.filter((phase) => phase.status === "needs-attention").length,
    0,
  );
});

test("an unanswered approval is the thing execution is waiting on", () => {
  const events: SessionEvent[] = [
    started("run-1", 1),
    {
      ...at(2),
      type: "tool.approval_requested",
      payload: {
        runId: "run-1",
        call: { id: "c1", name: "apply_patch", input: { patchId: "p1" } },
        toolClass: "write",
      },
    } as SessionEvent,
  ];

  assert.equal(statusOf(missionPhases(events, comparison()), "execution"), "needs-attention");

  const answered: SessionEvent[] = [
    ...events,
    {
      ...at(3),
      type: "tool.approved",
      payload: { runId: "run-1", toolCallId: "c1", approvedBy: "host" },
    } as SessionEvent,
  ];

  // Answered, so it stops asking. A permanently lit badge is how a rail
  // teaches somebody to stop reading it.
  assert.equal(statusOf(missionPhases(answered, comparison()), "execution"), "active");
});

test("approaches that have all stopped with nothing decided is what needs a person", () => {
  const phases = missionPhases(
    [started("run-1", 1), completed("run-1", 2), started("fork-a", 3), completed("fork-a", 4)],
    comparison({
      attempts: [attempt({ runId: "run-1", baseline: true }), attempt()],
    }),
  );

  assert.equal(statusOf(phases, "approaches"), "complete");
  assert.equal(statusOf(phases, "decision"), "needs-attention");
});

test("an approach still working is not yet a decision anyone can make", () => {
  const phases = missionPhases(
    [started("run-1", 1), started("fork-a", 2)],
    comparison({
      attempts: [
        attempt({ runId: "run-1", baseline: true }),
        attempt({ status: "running" }),
      ],
    }),
  );

  assert.equal(statusOf(phases, "approaches"), "active");
  // Not "needs-attention": asking somebody to choose between a finished
  // approach and one that is still writing files is asking them to guess.
  assert.equal(statusOf(phases, "decision"), "not-started");
});

test("a decision recorded but blocked by conflicts does not read as landed", () => {
  const phases = missionPhases(
    [started("run-1", 1), started("fork-a", 2)],
    comparison({
      attempts: [attempt({ runId: "run-1", baseline: true }), attempt()],
      decision: {
        runId: "fork-a",
        kind: "adopt",
        outcome: {
          applied: false,
          reason: "src/a.ts changed after the proposal was made.",
          conflicts: [{ path: "src/a.ts", reason: "drifted" }],
        },
      },
    }),
  );

  assert.equal(statusOf(phases, "decision"), "complete");
  // The decision stands; the write did not happen. Showing the receipt
  // complete would tell somebody their change had landed when it had not.
  assert.equal(statusOf(phases, "receipt"), "blocked");
});

test("keeping exploring completes the decision without claiming anything was applied", () => {
  const phases = missionPhases(
    [started("run-1", 1), started("fork-a", 2)],
    comparison({
      attempts: [attempt({ runId: "run-1", baseline: true }), attempt()],
      decision: {
        runId: "fork-a",
        kind: "exploration",
        outcome: {
          applied: false,
          reason: "Further exploration requested — no approach was applied.",
          conflicts: [],
        },
      },
    }),
  );

  assert.equal(statusOf(phases, "decision"), "complete");
  assert.equal(statusOf(phases, "receipt"), "complete");
  assert.equal(
    phases.find((phase) => phase.key === "receipt")?.detail,
    "Nothing applied",
  );
});
