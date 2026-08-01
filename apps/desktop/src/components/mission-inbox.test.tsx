import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type {
  HostCapabilities,
  MissionAttention,
  RememberedSession,
} from "@novus/contracts/protocol";

import {
  ATTENTION_GROUPS,
  MissionInbox,
  groupMissions,
  resumeRequest,
} from "./mission-inbox.tsx";

/**
 * The Mission Inbox, after creation and navigation were separated.
 *
 * What is defended here is not layout. It is that the grouping stays keyed to
 * what each mission is *asking for* rather than to recency, that a group with
 * nothing in it never draws a heading, that resuming a mission resumes its
 * own id, and that a mission's own history never brings its old permissions
 * back with it.
 */

const mission = (over: Partial<RememberedSession> = {}): RememberedSession => ({
  id: "s-1",
  repositoryPath: "/Users/kj/code/novus",
  createdAt: "2026-07-31T10:00:00.000Z",
  events: 42,
  lastActivityAt: "2026-07-31T11:00:00.000Z",
  goal: "Make the gate green again",
  attention: "needs-direction",
  approaches: 1,
  evidence: "unverified",
  controller: null,
  participants: 1,
  ...over,
});

const capabilities = (over: Partial<HostCapabilities> = {}): HostCapabilities =>
  ({
    allowWrites: false,
    allowCommands: false,
    ...over,
  }) as HostCapabilities;

const inbox = (
  missions: RememberedSession[],
  props: { onClose?: () => void; error?: string | null } = {},
): string =>
  renderToStaticMarkup(
    <MissionInbox
      missions={missions}
      capabilities={capabilities()}
      opening={false}
      error={props.error ?? null}
      onResume={() => {}}
      onOpenRepository={() => {}}
      // Present only for the overlay: the first screen has nothing to close.
      {...(props.onClose ? { onClose: props.onClose } : {})}
    />,
  );

test("missions group by what they are asking for, most urgent first", () => {
  const groups = groupMissions([
    mission({ id: "a", attention: "settled" }),
    mission({ id: "b", attention: "needs-decision" }),
    mission({ id: "c", attention: "running" }),
    mission({ id: "d", attention: "needs-approval" }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.attention),
    ["needs-decision", "needs-approval", "running", "settled"],
  );
});

test("recency does not reorder the groups", () => {
  // The settled mission is by far the most recent. A mission waiting on a
  // decision has stopped moving by definition, so sorting by activity buries
  // exactly the rows that need somebody.
  const groups = groupMissions([
    mission({
      id: "fresh",
      attention: "settled",
      lastActivityAt: "2026-08-01T09:00:00.000Z",
    }),
    mission({
      id: "stale",
      attention: "needs-decision",
      lastActivityAt: "2026-07-01T09:00:00.000Z",
    }),
  ]);

  assert.equal(groups[0]?.attention, "needs-decision");
});

test("a group with nothing in it is not rendered at all", () => {
  const groups = groupMissions([mission({ attention: "running" })]);

  assert.equal(groups.length, 1);

  const markup = inbox([mission({ attention: "running" })]);

  for (const { label } of ATTENTION_GROUPS) {
    if (label === "Running") {
      continue;
    }

    assert.ok(
      !markup.includes(label),
      `"${label}" has no missions and must not appear as a heading`,
    );
  }
});

test("every attention state has a heading worded as a request", () => {
  const attentions: MissionAttention[] = [
    "needs-decision",
    "needs-approval",
    "waiting-on-someone",
    "running",
    "needs-direction",
    "settled",
  ];

  assert.deepEqual(
    ATTENTION_GROUPS.map((group) => group.attention),
    attentions,
  );
});

test("nothing is dropped from a group, however many there are", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    mission({ id: `s-${index}`, goal: `Mission number ${index}` }),
  );
  const groups = groupMissions(many);
  const markup = inbox(many);

  assert.equal(groups[0]?.missions.length, 40);
  assert.equal(markup.match(/inbox__row/g)?.length, 40);
});

test("a long collection lives inside the sheet's scrolling body", () => {
  // The page cannot grow with the list: the rows are inside `.sheet__body`,
  // which is the element that scrolls, and the head and foot sit outside it.
  const markup = inbox(
    Array.from({ length: 40 }, (_, index) => mission({ id: `s-${index}` })),
  );
  const body = markup.indexOf('class="sheet__body');
  const foot = markup.indexOf('class="sheet__foot"');

  assert.ok(body !== -1 && foot !== -1);
  assert.ok(
    markup.indexOf("inbox__row") > body,
    "the missions must be inside the scrolling body",
  );
  assert.ok(
    foot > markup.lastIndexOf("inbox__row"),
    "the primary action must be outside it, so it cannot be scrolled away",
  );
});

test("the goal leads the row and the repository is secondary", () => {
  const markup = inbox([
    mission({ goal: "Stop the dev-server tests racing the child's stdout" }),
  ]);
  const goal = markup.indexOf("Stop the dev-server tests");
  const repo = markup.indexOf("novus</span>");

  assert.ok(goal !== -1 && repo !== -1);
  assert.ok(goal < repo, "the path must never be what identifies a mission");
  assert.ok(
    !markup.includes("/Users/kj/code/novus<"),
    "the full path is a hover title, not the row's text",
  );
});

test("a mission that has run nothing says so rather than showing a path", () => {
  const markup = inbox([mission({ goal: null })]);

  assert.ok(markup.includes("Opened, nothing run yet"));
});

test("evidence is stated explicitly, and never green without a pass", () => {
  assert.ok(inbox([mission({ evidence: "verified" })]).includes("Verified"));
  assert.ok(inbox([mission({ evidence: "failing" })]).includes("Tests failing"));

  const untested = inbox([mission({ evidence: "unverified" })]);

  assert.ok(untested.includes("Unverified"));
  assert.ok(
    untested.includes("inbox__evidence--unverified"),
    "an absence of evidence is dim, not a result",
  );
});

test("controller and approach counts survive", () => {
  const markup = inbox([
    mission({ approaches: 3, controller: "Maya" }),
  ]);

  assert.ok(markup.includes("3 approaches"));
  assert.ok(markup.includes("Maya in control"));

  // One approach is not a count worth stating — it is just the current work.
  assert.ok(!inbox([mission({ approaches: 1 })]).includes("1 approaches"));
});

test("resuming a mission resumes its existing id", () => {
  const request = resumeRequest(
    mission({ id: "s-existing", repositoryPath: "/repos/thing" }),
    capabilities(),
  );

  assert.equal(request.resume, "s-existing");
  assert.equal(request.repositoryPath, "/repos/thing");
});

test("historical permissions are not silently restored", () => {
  // The host has writes off right now. Nothing about a mission that once ran
  // with them may turn them back on — the checkboxes decide, every time.
  const request = resumeRequest(
    mission({ id: "s-old" }),
    capabilities({ allowWrites: false, allowCommands: false }),
  );

  assert.equal(request.allowWrites, false);
  assert.equal(request.allowCommands, false);
});

test("a resumed mission takes the host's current defaults", () => {
  const request = resumeRequest(
    mission(),
    capabilities({ allowWrites: true, allowCommands: true }),
  );

  assert.equal(request.allowWrites, true);
  assert.equal(request.allowCommands, true);
});

test("permissions are off until the worker has answered", () => {
  const request = resumeRequest(mission(), null);

  assert.equal(request.allowWrites, false);
  assert.equal(request.allowCommands, false);
});

test("an empty inbox says what will appear, without a placeholder row", () => {
  const markup = inbox([]);

  assert.ok(markup.includes("No missions yet"));
  assert.ok(!markup.includes("inbox__row"));
  assert.ok(
    markup.includes("Open a repository"),
    "the one thing to do from here is still one click away",
  );
});

test("the overlay and the first screen are the same inbox", () => {
  const missions = [mission({ attention: "needs-decision" })];
  const page = inbox(missions);
  const overlay = inbox(missions, { onClose: () => {} });

  assert.ok(page.includes("Needs your decision"));
  assert.ok(overlay.includes("Needs your decision"));
  assert.ok(overlay.includes('role="dialog"'));
  assert.ok(!page.includes('role="dialog"'));
});

test("an error stays beside the primary action", () => {
  const markup = inbox([mission()], { error: "That repository has moved." });
  const error = markup.indexOf("That repository has moved.");
  const foot = markup.indexOf('class="sheet__foot"');

  assert.ok(error > foot, "in the foot, which does not scroll");
});

test("a repository nobody has asked anything of is not called unverified", () => {
  // `unverified` is a verdict, and there is nothing here to have a verdict
  // about — no run, no change, nothing that could have been checked. The row
  // read as though a mission had been run and found wanting.
  const untouched = inbox([mission({ goal: null, evidence: "unverified" })]);

  assert.ok(untouched.includes("Opened, nothing run yet"));
  assert.ok(
    !untouched.includes("Unverified"),
    "a session with no runs must not carry a verification verdict",
  );
});

test("a mission that did run still states its evidence", () => {
  const ran = inbox([mission({ goal: "Migrate auth", evidence: "unverified" })]);

  assert.ok(ran.includes("Unverified"));
});
