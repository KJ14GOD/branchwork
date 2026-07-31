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

const attempt = (
  over: Partial<Comparison["attempts"][number]> = {},
): Comparison["attempts"][number] => ({
  runId: "fork-a",
  label: "locking",
  baseline: false,
  interventions: [],
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

test("the agent's summary comes last, under everything that was measured", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({
            summary: "Cleanly refactored the lock ordering.",
            interventions: [
              { kind: "denied", detail: "apply_patch", at: "2026-07-31T00:00:00.000Z" },
            ],
          }),
        ],
      })}
    />,
  );

  // Ordering is the argument. A summary is the approach's account of itself and
  // reads as authoritative because it is confident prose sitting beside numbers
  // somebody actually measured — so it goes under all of them.
  const summaryAt = html.indexOf("Cleanly refactored");
  assert.ok(summaryAt > html.indexOf("Tests run"), "summary precedes verification");
  assert.ok(summaryAt > html.indexOf("src/lock.ts"), "summary precedes files changed");
  assert.ok(summaryAt > html.indexOf("apply_patch"), "summary precedes interventions");
});

test("a summary from an approach that ran no tests is labelled a claim", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({
            testsRun: 0,
            testsPassed: 0,
            green: null,
            summary: "Everything works now.",
          }),
        ],
      })}
    />,
  );

  // The most dangerous sentence on the screen: confident prose from a run that
  // verified nothing. It is shown, and it is named for what it is.
  assert.match(html, /Unverified claim/);
  assert.match(html, /Everything works now/);
});

test("what a person had to do is shown, and a refusal is not styled as success", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({
            interventions: [
              { kind: "direction", detail: "keep the public API stable", at: "2026-07-31T00:00:00.000Z" },
              { kind: "denied", detail: "apply_patch", at: "2026-07-31T00:01:00.000Z" },
              { kind: "approved", detail: "run_command", at: "2026-07-31T00:02:00.000Z" },
            ],
          }),
        ],
      })}
    />,
  );

  assert.match(html, /Steered/);
  assert.match(html, /Refused/);
  assert.match(html, /Approved/);
  assert.match(html, /keep the public API stable/);
  assert.match(html, /compare__intervention-kind--denied/);
});

test("the diagram shows one shared checkpoint, not one per approach", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", label: "Baseline", baseline: true }),
          attempt({ runId: "fork-b", label: "retries" }),
        ],
      })}
    />,
  );

  // The whole point: both approaches branch from the *same* recorded point.
  // Two checkpoints would say they answered different questions.
  assert.equal(html.split("Shared checkpoint").length - 1, 1);
  assert.match(html, /Current work/);
  assert.match(html, /Alternative/);
});

test("a single approach draws a stem and no rail to nowhere", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [attempt({ runId: "turn-1", label: "Baseline", baseline: true })],
      })}
    />,
  );

  // Nothing has branched, so there is nothing to span. Drawing a horizontal
  // rail across one column would imply a fork that does not exist.
  assert.match(html, /branch__connector--only/);
  assert.match(html, /No alternative yet/);
});

test("the diagram asks for a decision only once nothing is still moving", () => {
  const running = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", baseline: true }),
          attempt({ runId: "fork-b", status: "running" }),
        ],
      })}
    />,
  );
  const settled = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", baseline: true }),
          attempt({ runId: "fork-b" }),
        ],
      })}
    />,
  );

  // Asking somebody to choose while an approach is still writing files is
  // asking them to decide on evidence that is still moving.
  assert.match(running, /Waiting for approaches to finish/);
  assert.doesNotMatch(running, /Decision required/);
  assert.match(settled, /Decision required/);
});

test("the diagram states what is required and never what is preferred", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", label: "Baseline", baseline: true, green: true }),
          attempt({ runId: "fork-b", label: "retries", green: false, testsPassed: 0 }),
        ],
      })}
    />,
  );

  // One approach here has passing tests and the other does not. The diagram
  // must not turn that into a recommendation — it is evidence for a person,
  // and the convergence node says what is needed, not what to pick.
  for (const forbidden of [/recommend/i, /winner/i, /\bbest\b/i, /preferred/i]) {
    assert.doesNotMatch(html, forbidden);
  }

  assert.doesNotMatch(html, /branch__path--winner|branch__path--leading/);
  assert.match(html, /Decision required/);
});

test("a recorded decision replaces the question rather than repeating it", () => {
  const html = renderToStaticMarkup(
    <CompareView
      comparison={comparison({
        attempts: [
          attempt({ runId: "turn-1", baseline: true }),
          attempt({ runId: "fork-b" }),
        ],
        decision: {
          runId: "fork-b",
          kind: "adopt",
          outcome: { applied: true, files: ["src/lock.ts"] },
        },
      })}
    />,
  );

  assert.match(html, /Adopted · applied/);
  assert.doesNotMatch(html, /Decision required/);
});
