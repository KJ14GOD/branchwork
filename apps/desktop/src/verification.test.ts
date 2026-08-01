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
 */

let sequence = 0;

const tests = (passed: boolean): SessionEvent =>
  ({
    eventId: `e${(sequence += 1)}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 1000).toISOString(),
    type: "tool.completed",
    payload: {
      runId: "r1",
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
  assert.equal(verdict.testsRun, 0);
});

test("a mission with no comparison at all still reports its own test runs", () => {
  // The whole bug. One workstream, no fork, `/compare` carrying nothing — and
  // a suite that genuinely ran and genuinely passed.
  const verdict = readVerification([tests(true), tests(true)], null);

  assert.equal(verdict.verified, true);
  assert.equal(verdict.testsRun, 2);
  assert.equal(verdict.testsPassed, 2);
});

test("one failing run among passing ones is not verified", () => {
  const verdict = readVerification([tests(true), tests(false)], null);

  assert.equal(verdict.verified, false);
  assert.equal(verdict.testsPassed, 1);
});

test("the log and the comparison are not added together", () => {
  // Fork runs append to this same session log, so the comparison is describing
  // events the log already carries. Summing the two would report four test
  // runs where two happened, and "4 of 4 checks passed" about a mission that
  // ran two.
  const verdict = readVerification(
    [tests(true), tests(true)],
    comparison([attempt({ testsRun: 2, testsPassed: 2, green: true })]),
  );

  assert.equal(verdict.testsRun, 2);
  assert.equal(verdict.testsPassed, 2);
});

test("the comparison still wins where it knows more", () => {
  // A resumed window whose stream has not replayed the whole log yet, or a
  // future source of verification the renderer cannot fold for itself.
  const verdict = readVerification(
    [],
    comparison([attempt({ testsRun: 6, testsPassed: 5, green: false })]),
  );

  assert.equal(verdict.testsRun, 6);
  assert.equal(verdict.verified, false);
});

test("contested paths come from the comparison, which is the only thing that knows them", () => {
  assert.deepEqual(readVerification([], comparison([attempt()])).contested, [
    "src/checkout.ts",
  ]);
  assert.deepEqual(readVerification([], null).contested, []);
});
