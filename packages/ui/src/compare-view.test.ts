import assert from "node:assert/strict";
import test from "node:test";

import { ComparisonSchema } from "@novus/contracts/protocol";

/**
 * The compare screen is the one place a decision is made from what it shows, so
 * what it may show is worth holding in place. These test the contract rather
 * than the JSX — `node --test` cannot parse a component, and the properties
 * worth defending are in the shape.
 */

const attempt = (over: Record<string, unknown> = {}) => ({
  runId: "fork-a",
  label: "locking",
  baseline: false,
  interventions: [],
  status: "completed",
  summary: "Fixed the lock ordering.",
  failure: null,
  filesChanged: [{ path: "src/lock.ts", additions: 12, deletions: 3 }],
  additions: 12,
  deletions: 3,
  toolCalls: 6,
  testsRun: 1,
  testsPassed: 1,
  green: true,
  ...over,
});

test("a comparison carries no score, rank, or recommendation", () => {
  const parsed = ComparisonSchema.parse({
    attempts: [attempt(), attempt({ runId: "fork-b", label: "retries" })],
    contestedPaths: [],
    uniquePaths: { "fork-a": [], "fork-b": [] },
    decision: null,
  });

  // V1 puts the choice with a human on the evidence. A shape carrying a verdict
  // would invite the screen to lead with it, and somebody would later "improve"
  // the UI by surfacing it. Zod strips unknown keys, so this asserts the schema
  // does not define them rather than that a caller omitted them.
  const shape = Object.keys(parsed.attempts[0] ?? {});

  for (const forbidden of ["score", "rank", "recommended", "winner", "best"]) {
    assert.ok(!shape.includes(forbidden), `attempts carry a ${forbidden}`);
  }
});

test("a comparison of one is valid: work that has not branched still shows", () => {
  const parsed = ComparisonSchema.parse({
    attempts: [attempt({ baseline: true, label: "Baseline" })],
    contestedPaths: [],
    uniquePaths: { "fork-a": [] },
    decision: null,
  });

  // The screen is not "empty until you fork". One approach is a real state, and
  // the schema has to admit it or the pre-fork view has nothing to render.
  assert.equal(parsed.attempts.length, 1);
  assert.equal(parsed.attempts[0]?.baseline, true);

  // And baseline is not a verdict wearing another name: it says which execution
  // the alternatives branched from, and carries no evidence of its own.
  assert.equal(parsed.decision, null);
});

test("green is nullable, because running no tests is not passing them", () => {
  const untested = ComparisonSchema.parse({
    attempts: [attempt({ testsRun: 0, testsPassed: 0, green: null })],
    contestedPaths: [],
    uniquePaths: { "fork-a": [] },
    decision: null,
  });

  assert.equal(untested.attempts[0]?.green, null);

  // And the schema must actually permit it — a non-nullable boolean here would
  // force a caller to pick true or false and one of those is a lie.
  assert.throws(() =>
    ComparisonSchema.parse({
      attempts: [attempt({ green: "unknown" })],
      contestedPaths: [],
      uniquePaths: {},
    }),
  );
});

test("a failure is part of the comparison rather than an absence", () => {
  const failed = ComparisonSchema.parse({
    attempts: [
      attempt({
        status: "failed",
        summary: null,
        failure: "The run stopped after 3 consecutive tool failures.",
        filesChanged: [],
        additions: 0,
        deletions: 0,
        testsRun: 0,
        testsPassed: 0,
        green: null,
      }),
    ],
    contestedPaths: [],
    uniquePaths: { "fork-a": [] },
    decision: null,
  });

  // A reviewer who asked for two attempts and sees one blank column learns
  // nothing about what happened to it.
  assert.match(failed.attempts[0]?.failure ?? "", /consecutive tool failures/);
  assert.equal(failed.attempts[0]?.status, "failed");
});

test("an empty comparison is valid, because a session starts with no attempts", () => {
  const empty = ComparisonSchema.parse({
    attempts: [],
    contestedPaths: [],
    uniquePaths: {},
    decision: null,
  });

  assert.deepEqual(empty.attempts, []);
});

test("a recorded decision carries the chosen run and what happened when it applied", () => {
  const applied = ComparisonSchema.parse({
    attempts: [attempt()],
    contestedPaths: [],
    uniquePaths: { "fork-a": [] },
    decision: { runId: "fork-a", outcome: { applied: true, files: ["src/lock.ts"] } },
  });

  assert.equal(applied.decision?.runId, "fork-a");
  assert.equal(applied.decision?.outcome.applied, true);

  const conflicted = ComparisonSchema.parse({
    attempts: [attempt()],
    contestedPaths: [],
    uniquePaths: { "fork-a": [] },
    decision: {
      runId: "fork-a",
      outcome: {
        applied: false,
        reason: "1 of 1 changed file no longer applies cleanly.",
        conflicts: [{ path: "src/lock.ts", reason: "changed in the parent since forking" }],
      },
    },
  });

  assert.equal(conflicted.decision?.outcome.applied, false);
});
