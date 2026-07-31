import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { compareAttempts } from "./compare.ts";

const SESSION = "compare-session";

const startRun = (store: InMemorySessionEventStore, runId: string, goal: string) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: runId,
        sessionId: SESSION,
        goal,
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

const applyPatch = (
  store: InMemorySessionEventStore,
  runId: string,
  path: string,
  additions: number,
  deletions: number,
) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `c-${runId}-${path}`,
        name: "apply_patch",
        output: { patchId: `p-${runId}-${path}`, path, status: "applied", additions, deletions },
      },
    },
  });

const runTests = (
  store: InMemorySessionEventStore,
  runId: string,
  passed: boolean,
) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `t-${runId}-${passed}`,
        name: "run_tests",
        output: {
          command: "npm test",
          exitCode: passed ? 0 : 1,
          timedOut: false,
          durationMs: 900,
          stdout: "",
          stderr: "",
          truncated: false,
          passed,
        },
      },
    },
  });

const finish = (store: InMemorySessionEventStore, runId: string, summary: string) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.completed",
    payload: { runId, summary },
  });

test("the work in flight is on the screen before anything has been forked", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "run-1", "Fix the locking");
  applyPatch(store, "run-1", "src/lock.ts", 12, 3);

  const comparison = compareAttempts(SESSION, store.list(SESSION), []);

  // One approach, not zero. The screen used to draw forks only, so a session
  // that had not branched yet was a decision surface with nothing on it — and
  // the first fork then appeared as an alternative to nothing.
  assert.equal(comparison.attempts.length, 1);
  assert.equal(comparison.attempts[0]?.runId, "run-1");
  assert.equal(comparison.attempts[0]?.baseline, true);
  assert.equal(comparison.attempts[0]?.additions, 12);
});

test("the baseline is the run the forks branched from, not the newest one", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "turn-1", "Fix the locking");
  applyPatch(store, "turn-1", "src/lock.ts", 5, 0);
  finish(store, "turn-1", "Fixed it one way.");

  startRun(store, "fork-a", "Fix the locking differently");
  applyPatch(store, "fork-a", "src/lock.ts", 9, 1);

  // The parent kept going after the fork was taken. Comparing the fork against
  // this run would line it up against work it branched before and never saw.
  startRun(store, "turn-2", "Something else entirely");
  applyPatch(store, "turn-2", "src/unrelated.ts", 80, 0);

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "differently", parentRunId: "turn-1" },
  ]);

  const baseline = comparison.attempts.find((attempt) => attempt.baseline);

  assert.equal(baseline?.runId, "turn-1");
  assert.equal(comparison.attempts.length, 2);
  assert.equal(
    comparison.attempts.some((attempt) => attempt.runId === "turn-2"),
    false,
  );

  // And the two of them genuinely disagree about the same file, which is the
  // comparison a reviewer is here to make.
  assert.deepEqual(comparison.contestedPaths, ["src/lock.ts"]);
});

test("exactly one attempt is the baseline, and being it is not a verdict", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "turn-1", "Original");
  applyPatch(store, "turn-1", "src/a.ts", 3, 0);
  startRun(store, "fork-a", "One way");
  startRun(store, "fork-b", "Another way");

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "turn-1" },
    { runId: "fork-b", label: "b", parentRunId: "turn-1" },
  ]);

  assert.equal(comparison.attempts.filter((attempt) => attempt.baseline).length, 1);

  // The baseline leads because it is the work already in flight, not because it
  // is winning. Nothing on it says it is preferred, and it carries no evidence
  // the alternatives do not carry in the same fields.
  const baseline = comparison.attempts[0];
  assert.equal(baseline?.baseline, true);
  assert.equal("recommended" in (baseline ?? {}), false);
  assert.equal("score" in (baseline ?? {}), false);
  assert.equal(comparison.decision, null);
});

test("a fork of a fork does not make its parent appear twice", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "turn-1", "Original");
  startRun(store, "fork-a", "One way");
  startRun(store, "fork-b", "A variation on the fork");

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "turn-1" },
    { runId: "fork-b", label: "b", parentRunId: "fork-a" },
  ]);

  const ids = comparison.attempts.map((attempt) => attempt.runId);

  assert.deepEqual([...new Set(ids)], ids);
  assert.equal(comparison.attempts.filter((attempt) => attempt.baseline).length, 0);
});

test("two attempts are lined up on the evidence, not ranked", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Fix the locking");
  applyPatch(store, "fork-a", "src/lock.ts", 12, 3);
  runTests(store, "fork-a", true);
  finish(store, "fork-a", "Fixed the lock ordering.");

  startRun(store, "fork-b", "Fix the retries");
  applyPatch(store, "fork-b", "src/retry.ts", 40, 1);
  runTests(store, "fork-b", false);
  finish(store, "fork-b", "Reworked the retry policy.");

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "locking", parentRunId: "parent" },
    { runId: "fork-b", label: "retries", parentRunId: "parent" },
  ]);

  const [a, b] = comparison.attempts;

  assert.equal(a?.label, "locking");
  assert.equal(a?.additions, 12);
  assert.equal(a?.green, true);
  assert.equal(b?.green, false);
  assert.equal(b?.additions, 40);

  // Nothing here says which is better. V1 puts that decision with a person, on
  // the evidence, and a compare screen that recommended one would be presenting
  // rather than showing.
  assert.equal("recommended" in (a ?? {}), false);
  assert.equal("score" in (a ?? {}), false);
});

test("an attempt that ran no tests is not green", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Change it");
  applyPatch(store, "fork-a", "src/a.ts", 5, 0);
  finish(store, "fork-a", "Changed it. Did not run the tests.");

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "untested", parentRunId: "parent" },
  ]);

  // Null, not true. A tick here would tell somebody an unverified attempt was
  // verified, which is the one thing a compare screen must never do.
  assert.equal(comparison.attempts[0]?.green, null);
  assert.equal(comparison.attempts[0]?.testsRun, 0);
});

test("files both attempts changed are named as contested", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "One way");
  applyPatch(store, "fork-a", "src/shared.ts", 4, 2);
  applyPatch(store, "fork-a", "src/only-a.ts", 1, 0);

  startRun(store, "fork-b", "Another way");
  applyPatch(store, "fork-b", "src/shared.ts", 9, 9);
  applyPatch(store, "fork-b", "src/only-b.ts", 2, 0);

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "parent" },
    { runId: "fork-b", label: "b", parentRunId: "parent" },
  ]);

  // The distinction that matters: two attempts touching different files are not
  // really competing, and two touching the same one have to be chosen between.
  assert.deepEqual(comparison.contestedPaths, ["src/shared.ts"]);
  assert.deepEqual(comparison.uniquePaths["fork-a"], ["src/only-a.ts"]);
  assert.deepEqual(comparison.uniquePaths["fork-b"], ["src/only-b.ts"]);
});

test("a failed attempt is compared rather than hidden", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Try it");
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.failed",
    payload: { runId: "fork-a", reason: "The run stopped after 3 consecutive tool failures." },
  });

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "failed one", parentRunId: "parent" },
  ]);

  // Why an attempt failed is evidence too. Dropping it would leave a reviewer
  // wondering what happened to the fork they asked for.
  assert.equal(comparison.attempts[0]?.status, "failed");
  assert.match(comparison.attempts[0]?.failure ?? "", /consecutive tool failures/);
});

test("only proposals that were applied count as changes", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Propose only");
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "fork-a",
      result: {
        toolCallId: "c1",
        name: "propose_patch",
        output: {
          patchId: "p1",
          path: "src/a.ts",
          intent: "change it",
          status: "proposed",
          diff: "--- a\n+++ b\n",
          additions: 30,
          deletions: 30,
        },
      },
    },
  });

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "proposed only", parentRunId: "parent" },
  ]);

  // A denial prevented this. Counting it would show a reviewer 30 lines that
  // are not in the tree.
  assert.deepEqual(comparison.attempts[0]?.filesChanged, []);
  assert.equal(comparison.attempts[0]?.additions, 0);
});

test("what a person did during an approach is evidence, and is carried", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Do it");
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.requested",
    payload: {
      runId: "fork-a",
      call: { id: "c1", name: "read_file", input: { path: "src/a.ts" } },
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "tool.denied",
    payload: {
      runId: "fork-a",
      toolCallId: "c1",
      deniedBy: "host",
      reason: "Reads outside the change under review.",
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "direction.queued",
    payload: {
      runId: "fork-a",
      directionEventId: "d1",
      direction: "keep the public API stable",
    },
  });

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "parent" },
  ]);

  const interventions = comparison.attempts[0]?.interventions ?? [];

  // An approach that only got there because somebody refused a bad patch is
  // not the same result as one that got there alone, and the agent's own
  // summary will never say so.
  assert.equal(interventions.length, 2);
  assert.equal(interventions[0]?.kind, "denied");
  assert.equal(interventions[0]?.detail, "read_file");
  assert.equal(interventions[1]?.kind, "direction");
  assert.match(interventions[1]?.detail ?? "", /public API/);
});

test("one approach's interventions do not leak into another's", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "One way");
  startRun(store, "fork-b", "Another way");
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "direction.queued",
    payload: { runId: "fork-a", directionEventId: "d1", direction: "only for a" },
  });

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "parent" },
    { runId: "fork-b", label: "b", parentRunId: "parent" },
  ]);

  assert.equal(comparison.attempts[0]?.interventions.length, 1);
  assert.equal(comparison.attempts[1]?.interventions.length, 0);
});

test("a decision carries what the human decided and why", () => {
  const store = new InMemorySessionEventStore();

  startRun(store, "fork-a", "Do it");
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "fork-a",
      checkpointId: "cp-1",
      kind: "exploration",
      rationale: "Neither approach covers the reconnect path yet.",
      outcome: {
        applied: false,
        reason: "Further exploration requested — no approach was applied.",
        conflicts: [],
      },
    },
  });

  const comparison = compareAttempts(SESSION, store.list(SESSION), [
    { runId: "fork-a", label: "a", parentRunId: "parent" },
  ]);

  // "Keep exploring" is a decision with a record, not the absence of one.
  assert.equal(comparison.decision?.kind, "exploration");
  assert.match(comparison.decision?.rationale ?? "", /reconnect path/);
  assert.equal(comparison.decision?.outcome.applied, false);
});
