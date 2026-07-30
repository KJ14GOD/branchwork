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
    { runId: "fork-a", label: "locking" },
    { runId: "fork-b", label: "retries" },
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
    { runId: "fork-a", label: "untested" },
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
    { runId: "fork-a", label: "a" },
    { runId: "fork-b", label: "b" },
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
    { runId: "fork-a", label: "failed one" },
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
    { runId: "fork-a", label: "proposed only" },
  ]);

  // A denial prevented this. Counting it would show a reviewer 30 lines that
  // are not in the tree.
  assert.deepEqual(comparison.attempts[0]?.filesChanged, []);
  assert.equal(comparison.attempts[0]?.additions, 0);
});
