import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { SessionEvent } from "@novus/contracts";

import { FileChangesPanel } from "./file-changes-panel.tsx";
import { TimelineView } from "./timeline-view.tsx";

/**
 * What the timeline says when it is not expanded.
 *
 * The default view is what somebody reads to find out what happened, and it
 * used to be the contract's own vocabulary printed verbatim — `read_file ×3,
 * apply_patch`. That is accurate and tells you nothing: tool names are how the
 * harness talks to itself. STEERING asks the default to tell the mission story
 * and the machinery to sit under Technical details.
 */

const at = (sequence: number) => ({
  eventId: `e${sequence}`,
  sessionId: "s",
  sequence,
  occurredAt: "2026-07-31T00:00:00.000Z",
  actorId: "agent-1",
});

const requested = (
  sequence: number,
  name: string,
  input: Record<string, unknown>,
): SessionEvent =>
  ({
    ...at(sequence),
    type: "tool.requested",
    payload: { runId: "run-1", call: { id: `c${sequence}`, name, input } },
  }) as SessionEvent;

const render = (events: SessionEvent[]) =>
  renderToStaticMarkup(
    <TimelineView
      events={events}
      busy={false}
      raw={false}
      highlighted={null}
      groupOverrides={new Map()}
      onToggleGroup={() => undefined}
    />,
  );

test("the default line is what happened, not which tools ran", () => {
  const html = render([
    requested(1, "read_file", { path: "src/a.ts" }),
    requested(2, "read_file", { path: "src/b.ts" }),
    requested(3, "propose_patch", { path: "src/a.ts", intent: "fix", edits: [] }),
    requested(4, "run_tests", { command: "npm test" }),
  ]);

  assert.match(html, /Read 2 files/);
  assert.match(html, /Proposed changes to 1 file/);
  assert.match(html, /Ran the tests/);

  // The contract's own spelling must not be the headline.
  assert.doesNotMatch(html, /read_file ×2/);
  assert.doesNotMatch(html, /tool activity/);
});

test("re-reading one file is one file's worth of understanding", () => {
  const html = render([
    requested(1, "read_file", { path: "src/a.ts" }),
    requested(2, "read_file", { path: "src/a.ts" }),
    requested(3, "read_file", { path: "src/a.ts" }),
  ]);

  // Counted by file rather than by call. Counting calls made an agent stuck
  // re-reading the same thing look like it was doing the most work — which is
  // exactly the livelock this harness has already been bitten by once.
  assert.match(html, /Read 1 file/);
  assert.doesNotMatch(html, /Read 3 files/);
});

test("the call total is behind the fold, not the headline", () => {
  const html = render([
    requested(1, "read_file", { path: "src/a.ts" }),
    requested(2, "read_file", { path: "src/b.ts" }),
  ]);

  // Present and auditable, named for what it is. As a headline it invited
  // reading more calls as more work done, which is not true and is not a
  // reason to prefer anything.
  assert.match(html, /Technical details/);
});

test("a refusal is stated plainly and never dressed as an error", () => {
  const html = render([
    requested(1, "apply_patch", { patchId: "p1" }),
    {
      ...at(2),
      type: "tool.denied",
      payload: {
        runId: "run-1",
        toolCallId: "c1",
        deniedBy: "host",
        reason: "Not this file.",
      },
    } as SessionEvent,
  ]);

  // A denial is a fact about what a person decided, not something the
  // timeline should apologise for.
  assert.match(html, /1 refused/);
  assert.doesNotMatch(html, /error/i);
});

test("the evidence panel never draws a tick for a run that tested nothing", () => {

  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={{ tests: null, testsRun: 0, testsPassed: 0, contested: [] }}
    />,
  );

  // The third place this rule has to hold, after the compare screen and the
  // exported receipt. "Finished" must never be readable as "verified".
  assert.match(html, /Tests not run/);
  assert.doesNotMatch(html, /evidence__line--pass/);
});
