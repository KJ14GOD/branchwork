import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventSchema, type SessionEvent } from "@novus/contracts";

import { projectSession } from "./projection.ts";

/**
 * A mission ending, as the worker's projection sees it.
 *
 * The other reader that has to agree is `summarise` in
 * `packages/session-client/src/timeline.ts` — the copy the guest and the joined
 * window render from — which is asserted against these same sequences in that
 * package's own `timeline.test.ts`. Deliberately not imported here: the worker
 * does not depend on the client and must not start. Two suites, one pair of
 * rules, named in each other's comments so neither drifts alone.
 */

const at = (sequence: number): Pick<
  SessionEvent,
  "eventId" | "sequence" | "occurredAt" | "sessionId" | "actorId"
> => ({
  eventId: `e-${sequence}`,
  sequence,
  occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, sequence)).toISOString(),
  sessionId: "s-1",
  actorId: "p-kartik",
});

const completed = (
  sequence: number,
  overrides: Partial<
    Extract<SessionEvent, { type: "mission.completed" }>["payload"]
  > = {},
): SessionEvent =>
  SessionEventSchema.parse({
    ...at(sequence),
    type: "mission.completed",
    payload: {
      outcome: "resolved",
      summary: "The failing checkout test passes again after the tax rounding fix.",
      verification: "verified",
      filesChanged: 2,
      actorId: "p-kartik",
      ...overrides,
    },
  });

const reopened = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...at(sequence),
    type: "mission.reopened",
    payload: {
      actorId: "p-maya",
      reason: "The fix regressed the refund path, so this is not finished after all.",
    },
  });

test("a completed mission is projected with the evidence it was completed on", () => {
  const projected = projectSession("s-1", [completed(0)]);

  assert.equal(projected.completion?.outcome, "resolved");
  assert.equal(projected.completion?.verification, "verified");
  assert.equal(projected.completion?.filesChanged, 2);
  assert.equal(projected.completion?.completedBy, "p-kartik");
});

test("reopening clears the completion rather than recording a second ending", () => {
  const projected = projectSession("s-1", [completed(0), reopened(1)]);

  // Null, not a completion with a flag on it. A reopened mission is live, and
  // every reader downstream asks "is this finished" as a null check.
  assert.equal(projected.completion, null);
});

test("a mission finished, reopened and finished again reports the newest ending", () => {
  const projected = projectSession("s-1", [
    completed(0),
    reopened(1),
    completed(2, {
      outcome: "abandoned",
      verification: "failing",
      filesChanged: 5,
      summary: "The rounding approach cannot work; starting again from the parser.",
    }),
  ]);

  assert.equal(projected.completion?.outcome, "abandoned");
  assert.equal(projected.completion?.verification, "failing");
  assert.equal(projected.completion?.filesChanged, 5);
});

test("an unverified ending is never reported as a verified one", () => {
  // The whole reason verification is frozen onto the event. A team may decide
  // a mission is resolved without ever running the suite, and the record has
  // to keep saying so however green the repository looks later.
  const projected = projectSession("s-1", [
    completed(0, { verification: "unverified", outcome: "resolved" }),
  ]);

  assert.equal(projected.completion?.outcome, "resolved");
  assert.notEqual(projected.completion?.verification, "verified");
});

test("finishing a mission does not rewrite what its runs did", () => {
  // A mission outcome is a person's verdict laid beside the run history, never
  // an edit to it. A resolved mission whose last run failed is an ordinary
  // ending — somebody finished the job by hand — and both facts must survive.
  // Built through the shared schema rather than cast into shape: a fixture the
  // worker could never emit would make this test agree with nothing.
  const events: SessionEvent[] = [
    SessionEventSchema.parse({
      ...at(0),
      type: "run.started",
      payload: {
        run: {
          id: "r-1",
          sessionId: "s-1",
          goal: "Fix the failing checkout test",
          status: "running",
          startedBy: "p-kartik",
          model: { provider: "anthropic", model: "claude-opus-5" },
          createdAt: at(0).occurredAt,
        },
      },
    }),
    SessionEventSchema.parse({
      ...at(1),
      type: "run.failed",
      payload: { runId: "r-1", reason: "The harness exited before finishing" },
    }),
    completed(2, { verification: "unverified", filesChanged: 0 }),
  ];

  const projected = projectSession("s-1", events);

  assert.equal(projected.completion?.outcome, "resolved");
  assert.equal(projected.runs[0]?.status, "failed");
});
