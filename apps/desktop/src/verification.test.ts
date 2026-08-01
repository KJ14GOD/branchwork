import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import type { AttemptComparison, Comparison } from "@novus/contracts/protocol";

import { readVerification } from "./verification.ts";

/**
 * What the screen may claim was proven.
 *
 * The failure this file exists for was on screen for weeks: the evidence
 * inspector read "Nothing has verified these changes" three inches from an
 * activity feed reading "Tests passed", on the same mission, at the same
 * moment. The verdict was computed from `comparison.attempts` only, and a
 * mission with one workstream — which is most missions — had nothing in that
 * array the moment `/compare` was slow, refused, or simply behind.
 *
 * The rule now lives in `@novus/contracts/verification` and is shared with the
 * receipt, the frozen mission record and the inbox. What this file pins is the
 * part that is still this module's own decision: which events the rule is
 * applied to, and how the answer is worded for the panel.
 */

let sequence = 0;

const at = () => {
  sequence += 1;

  return {
    eventId: `e${sequence}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 1000).toISOString(),
  };
};

const check = (passed: boolean, runId = "r1"): SessionEvent =>
  ({
    ...at(),
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `t${sequence}`,
        name: "run_tests",
        output: {
          command: "pnpm test",
          exitCode: passed ? 0 : 1,
          stdout: "",
          stderr: "",
          passed,
        },
      },
    },
  }) as SessionEvent;

const typecheck = (ok: boolean, runId = "r1"): SessionEvent =>
  ({
    ...at(),
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `t${sequence}`,
        name: "run_diagnostics",
        output: {
          kind: "typecheck",
          command: "pnpm typecheck",
          exitCode: ok ? 0 : 1,
          timedOut: false,
          durationMs: 1_200,
          ok,
          diagnostics: [],
          diagnosticsTruncated: false,
          raw: "",
          rawTruncated: false,
        },
      },
    },
  }) as SessionEvent;

const applied = (path: string, runId = "r1"): SessionEvent =>
  ({
    ...at(),
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `t${sequence}`,
        name: "apply_patch",
        output: { patchId: `p${sequence}`, path, additions: 1, deletions: 0 },
      },
    },
  }) as SessionEvent;

const attempt = (over: Partial<AttemptComparison> = {}): AttemptComparison => ({
  runId: "r1",
  label: "Baseline",
  baseline: true,
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
  interventions: [],
  ...over,
});

const comparison = (attempts: AttemptComparison[]): Comparison => ({
  attempts,
  contestedPaths: ["src/checkout.ts"],
  uniquePaths: {},
  decision: null,
});

test("nothing run is null, which is neither passing nor failing", () => {
  const verdict = readVerification([], null);

  assert.equal(verdict.verified, null);
  assert.equal(verdict.reason, "none-ran");
  assert.equal(verdict.checksRun, 0);
});

test("a mission with no comparison at all still reports its own checks", () => {
  // The original bug. One workstream, no fork, `/compare` carrying nothing —
  // and a suite that genuinely ran and genuinely passed.
  const verdict = readVerification([check(true), check(true)], null);

  assert.equal(verdict.verified, true);
  assert.equal(verdict.checksRun, 2);
  assert.equal(verdict.checksPassed, 2);
});

test("one failing check among passing ones is not verified", () => {
  const verdict = readVerification([check(true), check(false)], null);

  assert.equal(verdict.verified, false);
  assert.equal(verdict.checksPassed, 1);
});

test("a check that ran before the last edit does not verify it", () => {
  // Stale-and-green. The suite passed, then five more files were written and
  // nothing ran again — so the green describes a tree that no longer exists.
  // This screen reported `verified` for it, while the receipt for the same
  // session said `unverified`.
  const verdict = readVerification(
    [check(true), applied("src/checkout.ts")],
    null,
  );

  assert.equal(verdict.verified, null);
  assert.equal(verdict.reason, "stale");
  // The count survives, because "1 check ran, but before the last edit" is the
  // sentence a person can act on and "no checks have run" is not.
  assert.equal(verdict.checksRun, 1);
});

test("a check after the last edit does verify it", () => {
  const verdict = readVerification(
    [applied("src/checkout.ts"), check(true)],
    null,
  );

  assert.equal(verdict.verified, true);
  assert.equal(verdict.reason, null);
});

test("a clean typecheck verifies, even with no tests at all", () => {
  // Every checker counts. This screen counted only `run_tests`, so a mission
  // proven by a typecheck read as unverified here and verified on its receipt.
  const verdict = readVerification([applied("a.ts"), typecheck(true)], null);

  assert.equal(verdict.verified, true);
  assert.equal(verdict.checksRun, 1);
});

test("a fork's passing checks do not verify the parent's tree", () => {
  // An attempt runs in its own worktree against its own checkpoint. Summing
  // its green suite into the parent showed a verified banner on a mission
  // whose own tree was never tested and where no decision had been recorded.
  const verdict = readVerification(
    [applied("src/checkout.ts", "r1"), check(true, "fork-1")],
    comparison([
      attempt({ runId: "r1", baseline: true }),
      attempt({ runId: "fork-1", baseline: false, label: "Attempt B" }),
    ]),
  );

  assert.equal(verdict.verified, null);
  assert.equal(verdict.checksRun, 0);
});

test("a fork going red does not un-verify a green parent", () => {
  // The same error in the other direction, which is just as wrong: an
  // experimental attempt failing says nothing about the work in the parent.
  const verdict = readVerification(
    [applied("src/checkout.ts", "r1"), check(true, "r1"), check(false, "fork-1")],
    comparison([
      attempt({ runId: "r1", baseline: true }),
      attempt({ runId: "fork-1", baseline: false, label: "Attempt B" }),
    ]),
  );

  assert.equal(verdict.verified, true);
});

test("contested paths come from the comparison, which is the only thing that knows them", () => {
  assert.deepEqual(readVerification([], comparison([attempt()])).contested, [
    "src/checkout.ts",
  ]);
  assert.deepEqual(readVerification([], null).contested, []);
});
