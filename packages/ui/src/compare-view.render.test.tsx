import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { Comparison } from "@novus/contracts/protocol";

import { CompareView } from "./compare-view.tsx";

/**
 * What the compare screen actually draws.
 *
 * The sibling `compare-view.test.ts` defends the shape; this defends the
 * output, which is where the mistakes have actually been. Rendered to static
 * markup rather than into a DOM: this component has no state and no effects, so
 * a string is the whole of its behaviour and needs no jsdom to inspect.
 */

const attempt = (over: Partial<Comparison["attempts"][number]> = {}) => ({
  runId: "fork-a",
  label: "locking",
  baseline: false,
  status: "completed" as const,
  summary: "Fixed the lock ordering.",
  failure: null,
  filesChanged: [{ path: "src/lock.ts", additions: 12, deletions: 3 }],
  additions: 12,
  deletions: 3,
  toolCalls: 6,
  testsRun: 1,
  testsPassed: 1,
  green: true as boolean | null,
  ...over,
});

const comparison = (over: Partial<Comparison> = {}): Comparison => ({
  attempts: [attempt()],
  contestedPaths: [],
  uniquePaths: {},
  decision: null,
  ...over,
});

test("the baseline is drawn, and named as the current work", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [attempt({ runId: "turn-1", label: "Baseline", baseline: true })],
      })}
    />,
  );

  assert.match(html, /Current work/);
  assert.match(html, /compare__attempt--baseline/);

  // A comparison of one renders the approach, not the old "fork a run to make
  // two" empty state. Work in flight with no alternative beside it is a real
  // state with something on the screen.
  assert.doesNotMatch(html, /Nothing has run in this session yet/);
});

test("an approach that ran no tests is never drawn as passing", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [attempt({ testsRun: 0, testsPassed: 0, green: null })],
      })}
    />,
  );

  // The rule this screen exists to protect: completion is not verification.
  assert.match(html, /Tests not run/);
  assert.match(html, /Done · unverified/);
  assert.doesNotMatch(html, /compare__verdict--pass/);
  assert.doesNotMatch(html, /passed/);
});

test("a failed approach stays on the screen with its reason", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
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
      })}
    />,
  );

  // Why an approach failed is evidence too. A reviewer who asked for an
  // alternative and finds a blank column learns nothing.
  assert.match(html, /consecutive tool failures/);
  assert.match(html, /Failed/);
});

test("nothing in the markup ranks the approaches", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", label: "Baseline", baseline: true }),
          attempt({ runId: "fork-b", label: "retries", green: false, testsPassed: 0 }),
        ],
        contestedPaths: ["src/lock.ts"],
      })}
    />,
  );

  // The screen summarises evidence; the human decides. A word like these in
  // the output means somebody has started making the choice for them.
  for (const forbidden of [
    "recommend",
    "Recommend",
    "winner",
    "Winner",
    "best",
    "Best",
    "score",
    "Score",
  ]) {
    assert.doesNotMatch(html, new RegExp(forbidden), `markup says "${forbidden}"`);
  }

  // The baseline gets no accent of its own — it is marked, not promoted.
  assert.doesNotMatch(html, /compare__attempt--winner|--preferred|--leading/);

  // And the file both approaches touched is called out, because that is the
  // question the reviewer is here to answer.
  assert.match(html, /Changed by more than one approach/);
  assert.match(html, /compare__file--contested/);
});

test("a guest gets the same evidence and no controls", () => {
  const guest = renderToStaticMarkup(
    <CompareView comparison={comparison()} />,
  );
  const host = renderToStaticMarkup(
    <CompareView
      comparison={comparison()}
      footers={{ "fork-a": <button type="button">Adopt this approach</button> }}
    />,
  );

  // Read-only by construction: the guest passes no footers and therefore has
  // no way to render a control, rather than rendering one and disabling it.
  assert.doesNotMatch(guest, /<button/);
  assert.match(host, /<button/);
  assert.match(guest, /src\/lock\.ts/);
});
