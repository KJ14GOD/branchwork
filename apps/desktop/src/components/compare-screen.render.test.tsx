import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { AttemptComparison } from "@novus/contracts/protocol";

import type { ComparisonState } from "../use-comparison.ts";
import { CompareScreen } from "./compare-screen.tsx";

/**
 * The sentence at the top of the decision surface.
 *
 * It is the one line a person reads before deciding what happens to a change,
 * and it was counting something different from what the screen was showing:
 * it counted only the *alternatives* while the screen drew a card for the
 * baseline too, so a mission with one baseline and one fork announced
 * "1 approaches ran" directly beside a spine reading "2 approaches". Wrong
 * number, wrong plural, in the most important sentence on the screen.
 */

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
    filesChanged: (paths ?? ["src/a.ts"]).map((path) => ({
      path,
      additions: 3,
      deletions: 1,
    })),
    additions: 3,
    deletions: 1,
    toolCalls: 2,
    testsRun: 0,
    testsPassed: 0,
    green: null,
    interventions: [],
    ...rest,
  };
};

const screen = (attempts: AttemptComparison[]): string => {
  const state = {
    comparison: {
      attempts,
      contestedPaths: [],
      uniquePaths: {},
      decision: null,
    },
    loading: false,
    error: null,
    refresh: () => {},
    fork: async () => {},
    decision: null,
    choosing: false,
    choose: async () => {},
  } satisfies ComparisonState;

  return renderToStaticMarkup(
    <CompareScreen
      state={state}
      repositoryState="ready"
      endpoint="http://127.0.0.1:4319"
      sessionId="s1"
      onClose={() => {}}
    />,
  );
};

const baselineAndFork = [
  attempt(),
  attempt({ runId: "r2", label: "Keep the queue in process", baseline: false }),
];

test("the headline counts every approach the screen draws, baseline included", () => {
  const html = screen(baselineAndFork);

  assert.match(html, /2 approaches/);
  // The exact wrong string this test exists for.
  assert.doesNotMatch(html, /1 approaches/);
});

test("one approach is never written as '1 approaches'", () => {
  // Reachable whenever the counts and the plural come from different places.
  // Belt and braces: no rendering of this screen may contain that string.
  for (const attempts of [
    baselineAndFork,
    [attempt(), attempt({ runId: "r2", baseline: false, status: "failed" })],
    [
      attempt({ testsRun: 2, testsPassed: 2, green: true }),
      attempt({ runId: "r2", baseline: false, testsRun: 2, testsPassed: 2, green: true }),
    ],
  ]) {
    assert.doesNotMatch(screen(attempts), /\b1 approaches\b/);
  }
});

test("a decision is announced as required when an alternative is settled", () => {
  assert.match(screen(baselineAndFork), /Decision required/);
});

test("approaches that ran no tests are said to have verified nothing", () => {
  const html = screen(baselineAndFork);

  assert.match(html, /without running any tests/);
  // The claim this screen must never make about an untested approach.
  assert.doesNotMatch(html, /Verified · /);
});
