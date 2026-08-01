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
      verdict={{ approaches: 1, tests: null, reason: null, checksRun: 0, checksPassed: 0, contested: [] }}
    />,
  );

  // The third place this rule has to hold, after the compare screen and the
  // exported receipt. "Finished" must never be readable as "verified".
  // Asserting the rule rather than the sentence: what must never happen is a
  // pass treatment on a run that verified nothing. The wording is allowed to
  // improve; the treatment is not.
  assert.match(html, /Verification incomplete/);
  assert.match(html, /without running any checks/);
  assert.doesNotMatch(html, /evidence__line--pass/);
});

test("a branch with no checks configured is never drawn as passing", () => {
  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={{ approaches: 1, tests: true, reason: null, checksRun: 3, checksPassed: 3, contested: [] }}
      github={{
        connected: true,
        repository: "acme/widget",
        pullRequest: null,
        checks: [],
        verdict: "none",
      }}
    />,
  );

  // Local tests passing says nothing about CI. Folding "no checks" into the
  // green above it would let one claim borrow the other's credibility.
  assert.match(html, /No checks configured/);
  assert.doesNotMatch(html, /checks\(s\) passed|check\(s\) passed/);
});

test("checks passing on a branch is not the same as anyone agreeing to merge", () => {
  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={{ approaches: 1, tests: null, reason: null, checksRun: 0, checksPassed: 0, contested: [] }}
      github={{
        connected: true,
        repository: "acme/widget",
        pullRequest: null,
        checks: [{ name: "CI", state: "SUCCESS" }],
        verdict: "passing",
      }}
    />,
  );

  assert.match(html, /check\(s\) passed on GitHub/);
  // Said out loud, so a green tick cannot be read as review approval.
  assert.match(html, /No pull request open/);
});

test("a repository with no GitHub remote shows no check section at all", () => {
  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={{ approaches: 1, tests: null, reason: null, checksRun: 0, checksPassed: 0, contested: [] }}
      github={{ connected: false, reason: "No GitHub connection." }}
    />,
  );

  // Most repositories this opens have no GitHub remote. An empty "Required
  // checks" heading for them is the placeholder row this app keeps deleting.
  assert.doesNotMatch(html, /Required checks/);
});

test("GitHub checks show before the agent has run anything", () => {
  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={null}
      github={{
        connected: true,
        repository: "acme/widget",
        pullRequest: null,
        checks: [{ name: "CI", state: "FAILURE" }],
        verdict: "failing",
      }}
    />,
  );

  // A branch's CI state is a fact about the branch, not about whether
  // anything has happened in this mission — gating it on the local verdict
  // hid it until the first run, which read as the feature not working.
  assert.match(html, /Required checks/);
  assert.match(html, /not passing/);
});

test("a stale check is never drawn as a failure or a pass", () => {
  const html = renderToStaticMarkup(
    <FileChangesPanel
      state={{ files: [], additions: 0, deletions: 0, error: null, loading: false }}
      diffs={new Map()}
      verdict={null}
      github={{
        connected: true,
        repository: "acme/widget",
        pullRequest: null,
        checks: [{ name: "CI", state: "FAILURE" }],
        verdict: "stale",
      }}
    />,
  );

  // The real case: a workflow deleted weeks ago whose last runs linger. Its
  // result belongs to a commit nobody is looking at, so it is an absence of
  // evidence — dim, never red and never green.
  assert.match(html, /different commit/);
  assert.doesNotMatch(html, /evidence__line--fail/);
  assert.doesNotMatch(html, /evidence__line--pass/);
});
