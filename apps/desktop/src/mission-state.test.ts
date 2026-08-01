import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import type { AttemptComparison, Comparison } from "@novus/contracts/protocol";

import { composeMission, dominantAction, missionState } from "./mission-state.ts";

/**
 * The eight states the shell has to be able to tell apart.
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

/**
 * An applied patch and a check, on the log, in that order.
 *
 * Verification is read from the log now rather than from `comparison.attempts`,
 * because the rule it shares with the receipt turns on *order* — a check before
 * the last edit does not verify it — and an attempt summary carries counts with
 * no sequences in them. So a fixture that wants to be verified has to have
 * actually run something, after actually changing something, which is what
 * these two build.
 */
const appliedPatch = (path: string, runId = "r1"): SessionEvent =>
  event("tool.completed", {
    runId,
    result: {
      toolCallId: `t${sequence + 1}`,
      name: "apply_patch",
      output: { patchId: `p${sequence + 1}`, path, additions: 3, deletions: 1 },
    },
  });

const ranTests = (passed: boolean, runId = "r1"): SessionEvent =>
  event("tool.completed", {
    runId,
    result: {
      toolCallId: `t${sequence + 1}`,
      name: "run_tests",
      output: {
        command: "pnpm test",
        exitCode: passed ? 0 : 1,
        stdout: "",
        stderr: "",
        passed,
      },
    },
  });

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
    events: [started("r1"), appliedPatch("a.ts"), ranTests(true)],
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

test("a green suite that ran before the last edit does not claim verified", () => {
  // Stale-and-green, the failure the receipt has always refused and this
  // screen used to allow. The suite passed; then a file was written and
  // nothing ran again, so the green describes a tree that no longer exists.
  const state = missionState({
    events: [started("r1"), ranTests(true), appliedPatch("a.ts")],
    comparison: comparison([
      attempt({ paths: ["a.ts"], testsRun: 4, testsPassed: 4, green: true }),
    ]),
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "changed-unverified");
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

test("a mission somebody declared over reads as over, whatever its runs did", () => {
  // A run ending is the machine stopping; a mission ending is a person saying
  // so. Before `mission.completed` existed the product could not tell those
  // apart, and a finished mission with two approaches was reported as needing a
  // decision forever — the fake-decision-as-only-exit shape this removes.
  const state = missionState({
    events: [
      started("r1"),
      event("mission.completed", {
        outcome: "resolved",
        summary: "The checkout test passes again.",
        verification: "unverified",
        filesChanged: 2,
        actorId: "a1",
      }),
    ],
    comparison: comparison([attempt({ paths: ["a.ts"] })]),
    filesChanged: 2,
    busy: true,
    awaitingPerson: true,
  });

  assert.equal(state, "completed");
});

test("reopening a mission puts it back in flight rather than leaving an ending on it", () => {
  const state = missionState({
    events: [
      started("r1"),
      event("mission.completed", {
        outcome: "abandoned",
        summary: "Parking this until the migration lands.",
        verification: "unverified",
        filesChanged: 0,
        actorId: "a1",
      }),
      event("mission.reopened", { actorId: "a1", reason: "The migration landed." }),
    ],
    comparison: null,
    filesChanged: 0,
    busy: true,
    awaitingPerson: false,
  });

  assert.notEqual(state, "completed");
});

test("a completed mission shows the frozen ending, not a live evidence panel", () => {
  const composition = composeMission("completed", {
    agents: 1,
    changed: 4,
    verified: false,
    completion: {
      outcome: "abandoned",
      summary: "Not worth the blast radius.",
      verification: "failing",
      filesChanged: 4,
      completedBy: "p-1",
      completedAt: "2026-08-01T00:00:00.000Z",
    },
  });

  assert.equal(composition.showCompletion, true);
  assert.equal(composition.showEvidence, false);
  assert.equal(composition.headline, "Abandoned");
  // Never the resolved wording for an abandoned mission, and never green.
  assert.doesNotMatch(composition.detail, /finished\b/);
});

test("tests on the log count, even when the comparison knows nothing about them", () => {
  // The evidence lie this fixes: the verdict was computed from
  // `comparison.attempts` alone, so a one-workstream mission that ran its suite
  // reported "nothing has verified these changes" underneath its own feed
  // saying the tests passed.
  const state = missionState({
    events: [
      started("r1"),
      event("tool.completed", {
        runId: "r1",
        result: {
          toolCallId: "t1",
          name: "run_tests",
          output: { command: "pnpm test", exitCode: 0, stdout: "", stderr: "", passed: true },
        },
      }),
    ],
    comparison: null,
    filesChanged: 1,
    busy: false,
    awaitingPerson: false,
  });

  assert.equal(state, "verified");
});

test("one control on the screen is the inverted one, and obligation decides which", () => {
  // `.button--primary` is the app's only inversion. Three surfaces can each
  // honestly claim it, so the claim is settled once rather than by whichever
  // component renders first.
  assert.equal(
    dominantAction({ offeredToYou: true, decisionWaiting: true, focused: true }),
    "handoff",
    "a person waiting on your answer outranks everything",
  );
  assert.equal(
    dominantAction({ offeredToYou: false, decisionWaiting: true, focused: true }),
    "focus",
    "a surface you opened brings its own primary action",
  );
  assert.equal(
    dominantAction({ offeredToYou: false, decisionWaiting: true, focused: false }),
    "decision",
  );
  assert.equal(
    dominantAction({ offeredToYou: false, decisionWaiting: false, focused: false }),
    "direction",
  );
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
