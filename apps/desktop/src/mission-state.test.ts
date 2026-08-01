import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import type { AttemptComparison, Comparison } from "@novus/contracts/protocol";

import { composeMission, missionState } from "./mission-state.ts";

/**
 * The seven states the shell has to be able to tell apart.
 *
 * These are not cosmetic. Each one names a different screen, and two of them —
 * "changed but nothing verified it" and "verified" — are the distinction the
 * whole product turns on. A derivation that let the first read as the second
 * would have Novus telling somebody their migration is safe because an agent
 * stopped talking.
 */

let sequence = 0;

const event = (
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent =>
  ({
    eventId: `e${(sequence += 1)}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 1000).toISOString(),
    type,
    payload,
  }) as SessionEvent;

const started = (runId: string): SessionEvent =>
  event("run.started", {
    run: {
      id: runId,
      sessionId: "s1",
      goal: "Migrate auth to scoped tokens",
      status: "running",
      startedBy: "a1",
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      createdAt: new Date().toISOString(),
    },
  });

/** `filesChanged` carries counts, not bare paths — the shape the route returns. */
const changedFile = (path: string) => ({ path, additions: 3, deletions: 1 });

const attempt = (
  over: Partial<AttemptComparison> & { paths?: string[] } = {},
): AttemptComparison => {
  const { paths, ...rest } = over;

  return {
    runId: "r1",
    label: "Baseline",
    baseline: true,
    status: "completed",
    summary: null,
    failure: null,
    filesChanged: (paths ?? []).map(changedFile),
    additions: 0,
    deletions: 0,
    toolCalls: 0,
    testsRun: 0,
    testsPassed: 0,
    green: null,
    interventions: [],
    ...rest,
  };
};

const comparison = (attempts: AttemptComparison[]): Comparison => ({
  attempts,
  contestedPaths: [],
  uniquePaths: {},
  decision: null,
});

test("a repository with no run is the start canvas, not the working shell", () => {
  const state = missionState({
    events: [event("session.created", { session: {} })],
    comparison: null,
    filesChanged: 0,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "empty");
  assert.equal(composeMission(state, { agents: 0, changed: 0, verified: false })
    .showStartCanvas, true);
});

test("the start canvas carries no rail and no evidence at all", () => {
  // The regression this exists for: the empty screen used to render the
  // lifecycle, the approaches explanation, required checks and changed files,
  // every one of them empty.
  const composition = composeMission("empty", {
    agents: 0,
    changed: 0,
    verified: false,
  });

  assert.equal(composition.showWorkstreams, false);
  assert.equal(composition.showEvidence, false);
  assert.equal(composition.showRecovery, false);
});

test("a run in flight with nothing produced yet is starting, not working", () => {
  assert.equal(
    missionState({
      events: [started("r1")],
      comparison: null,
      filesChanged: 0,
      busy: true,
      awaitingPerson: false,
    }),
    "starting",
  );
});

test("changed files with no tests is never verified", () => {
  const state = missionState({
    events: [started("r1")],
    comparison: comparison([
      attempt({ paths: ["src/auth.ts"], testsRun: 0, green: null }),
    ]),
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "changed-unverified");
});

test("finishing is not verifying: a completed run with no tests still reads unverified", () => {
  const state = missionState({
    events: [started("r1"), event("run.completed", { runId: "r1", summary: "Done" })],
    comparison: comparison([
      attempt({ status: "completed", paths: ["a.ts"], testsRun: 0 }),
    ]),
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.notEqual(state, "verified");
});

test("green tests over changed files is the one state that may claim verified", () => {
  const state = missionState({
    events: [started("r1")],
    comparison: comparison([
      attempt({
        paths: ["a.ts"],
        testsRun: 4,
        testsPassed: 4,
        green: true,
      }),
    ]),
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "verified");
});

test("one failing attempt among green ones is not verified", () => {
  const state = missionState({
    events: [started("r1")],
    comparison: comparison([
      attempt({ runId: "r1", paths: ["a.ts"], testsRun: 2, testsPassed: 2, green: true }),
      attempt({
        runId: "r2",
        baseline: false,
        paths: ["b.ts"],
        testsRun: 2,
        testsPassed: 1,
        green: false,
      }),
    ]),
    filesChanged: 2,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "changed-unverified");
});

test("somebody waiting outranks the work in flight", () => {
  const state = missionState({
    events: [started("r1")],
    comparison: null,
    filesChanged: 0,
    busy: true,
    awaitingPerson: true,
  });

  assert.equal(state, "needs-direction");
});

test("a run that failed without touching anything is recovery, not decision", () => {
  const state = missionState({
    events: [started("r1"), event("run.failed", { runId: "r1", reason: "401" })],
    comparison: comparison([attempt({ status: "failed" })]),
    filesChanged: 0,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "failed");

  const composition = composeMission(state, {
    agents: 1,
    changed: 0,
    verified: false,
  });

  assert.equal(composition.showRecovery, true);
  // No evidence panel: there is nothing to inspect, and a column of empty
  // headings beside a failure is the placeholder habit this pass removes.
  assert.equal(composition.showEvidence, false);
});

test("a run that failed after changing files keeps its evidence", () => {
  // Not a recovery screen. The failure is on the record, and the files it
  // changed before dying are exactly what a person needs to look at.
  const state = missionState({
    events: [started("r1"), event("run.failed", { runId: "r1", reason: "timeout" })],
    comparison: comparison([
      attempt({ status: "failed", paths: ["a.ts"] }),
    ]),
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "changed-unverified");
});

test("evidence is mounted only where there is something to say", () => {
  const withNothing = composeMission("working", {
    agents: 1,
    changed: 0,
    verified: false,
  });
  const withChanges = composeMission("changed-unverified", {
    agents: 1,
    changed: 3,
    verified: false,
  });

  assert.equal(withNothing.showEvidence, false);
  assert.equal(withChanges.showEvidence, true);
  assert.match(withChanges.detail, /3 files changed/);
});

test("a run that failed reads as failed before /compare has answered", () => {
  // The regression this exists for, seen on screen: a mission whose only run
  // died on a 401 showed "Working" in its header while its own rail said
  // "Failed" directly beside it. The header was waiting on a fetch; the log
  // had known since the moment it happened.
  const state = missionState({
    events: [
      started("r1"),
      event("run.failed", { runId: "r1", reason: "401 invalid x-api-key" }),
    ],
    comparison: null,
    filesChanged: 0,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "failed");
});

test("one failed run beside one still going is not a failed mission", () => {
  const state = missionState({
    events: [
      started("r1"),
      event("run.failed", { runId: "r1", reason: "boom" }),
      started("r2"),
    ],
    comparison: null,
    filesChanged: 0,
    busy: true,
    awaitingPerson: false,
  });

  assert.notEqual(state, "failed");
});
