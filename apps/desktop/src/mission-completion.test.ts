import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";

import { readCompletion } from "./mission-completion.ts";

/**
 * Whether a person has declared this mission over.
 *
 * The renderer folds the log rather than waiting on a projection fetch, for the
 * same reason the activity feed does — the events are already in this window,
 * and an ending that arrived a second ago must change the screen now. That
 * makes this a second fold of a fact the worker also folds, so these tests
 * pin the two rules that could drift: only a person's event counts, and
 * reopening clears rather than annotates.
 */

let sequence = 0;

const event = (type: SessionEvent["type"], payload: unknown): SessionEvent =>
  ({
    eventId: `e${(sequence += 1)}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 1000).toISOString(),
    type,
    payload,
  }) as SessionEvent;

const completed = (over: Record<string, unknown> = {}): SessionEvent =>
  event("mission.completed", {
    outcome: "resolved",
    summary: "The failing checkout test passes again.",
    verification: "verified",
    filesChanged: 3,
    actorId: "p-kartik",
    ...over,
  });

test("a mission nobody ended has no ending", () => {
  assert.equal(
    readCompletion([
      event("run.started", {
        run: {
          id: "r1",
          sessionId: "s1",
          goal: "Fix the checkout test",
          status: "running",
          startedBy: "a1",
          model: { provider: "anthropic", model: "claude-sonnet-5" },
          createdAt: new Date().toISOString(),
        },
      }),
      event("run.completed", { runId: "r1", summary: "Done" }),
    ]),
    null,
    "a run ending is the machine stopping, not a person calling it",
  );
});

test("the ending carries the words and the evidence frozen onto the event", () => {
  const completion = readCompletion([completed()]);

  assert.equal(completion?.outcome, "resolved");
  assert.match(completion?.summary ?? "", /checkout test/);
  assert.equal(completion?.verification, "verified");
  assert.equal(completion?.filesChanged, 3);
  assert.equal(completion?.completedBy, "p-kartik");
});

test("an abandoned mission whose checks were failing reports both, without blending them", () => {
  const completion = readCompletion([
    completed({ outcome: "abandoned", verification: "failing" }),
  ]);

  assert.equal(completion?.outcome, "abandoned");
  assert.equal(completion?.verification, "failing");
});

test("reopening clears the ending rather than annotating it", () => {
  // Null, not a completion with a flag on it. A reopened mission is live, and a
  // screen keeping the ending around with a badge would be showing somebody a
  // finished mission they are actively working in.
  assert.equal(
    readCompletion([
      completed(),
      event("mission.reopened", { actorId: "p-kartik", reason: "One more thing." }),
    ]),
    null,
  );
});

test("completing again after a reopen is the ending that stands", () => {
  const completion = readCompletion([
    completed({ outcome: "abandoned" }),
    event("mission.reopened", { actorId: "p-kartik", reason: "Picking this back up." }),
    completed({ outcome: "resolved", filesChanged: 9 }),
  ]);

  assert.equal(completion?.outcome, "resolved");
  assert.equal(completion?.filesChanged, 9);
});
