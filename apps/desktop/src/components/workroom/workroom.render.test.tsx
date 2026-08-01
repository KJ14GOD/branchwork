import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { Authority } from "@novus/contracts/protocol";

import type { MissionCompletion } from "../../mission-completion.ts";
import { composeMission, type MissionState } from "../../mission-state.ts";
import type { PresenceEntry } from "../../use-presence.ts";
import type { Person, Workstream } from "../../workstreams.ts";
import type { ControlProps } from "../control-panel.tsx";
import type { Milestone } from "./activity-feed.tsx";
import { HarnessPicker } from "../harness-picker.tsx";
import { EmptyMission } from "./empty-mission.tsx";
import { Workroom, type Focus } from "./workroom.tsx";
import type { RunControl } from "./workstream-rail.tsx";

/**
 * Eight states, eight compositions — and one screen they all belong to.
 *
 * The failure this file is aimed at is the one the whole pass exists for: a
 * universal shell that rendered every region on every screen and changed only
 * the words inside them. So these assertions are almost all about what is
 * *absent*. A test that only checked the text would have passed against the
 * interface being replaced.
 *
 * The second half of the file holds what the *other* shell used to be
 * responsible for. There were two complete mission shells in `session-tab.tsx`
 * and a `mode` deciding which one a person got; the control lifecycle rendered
 * only in the one they were not looking at, and an effect could move them into
 * it without their acting. Both shells are this one now, so the properties the
 * removed shell's tests protected are restated here against the screen that
 * actually has to keep them.
 */

const stream = (over: Partial<Workstream> = {}): Workstream => ({
  runId: "r1",
  name: "Claude",
  model: "claude-sonnet-5",
  harness: "Claude Code",
  assignment: "Migrate authentication to scoped tokens",
  state: "running",
  signal: "--ws-1",
  primary: true,
  ...over,
});

const people: Person[] = [
  { id: "p1", name: "You", role: "owner", connected: true, inControl: true },
];

const milestone = (over: Partial<Milestone> = {}): Milestone => ({
  id: "m1",
  actor: "Claude",
  human: false,
  signal: "--ws-1",
  headline: "Read 6 files",
  detail: "src/auth.ts, src/session.ts",
  at: new Date(0).toISOString(),
  tone: "normal",
  ...over,
});

const HOST = "p-host";
const GUEST = "p-guest";

const roster: PresenceEntry[] = [
  { id: HOST, name: "Kartik", role: "owner", connected: true },
  { id: GUEST, name: "Maya", role: "editor", connected: true },
];

const authority = (over: Partial<Authority> = {}): Authority => ({
  you: HOST,
  controlHeldBy: HOST,
  controlOffer: null,
  controlRequests: [],
  pendingDirection: [],
  executingRunIds: [],
  ...over,
});

const noop = () => undefined;

/** The single-user default: no participant registry, so nothing to negotiate. */
const alone: ControlProps = {
  authority: authority({ you: null }),
  participants: [],
  onOffer: noop,
  onRequest: noop,
  onAnswer: noop,
};

const control = (over: Partial<Authority>): ControlProps => ({
  authority: authority(over),
  participants: roster,
  onOffer: noop,
  onRequest: noop,
  onAnswer: noop,
});

const meter = { spend: "$0.42", spendTitle: "3 model call(s)", elapsed: "12.0s" };

const workroom = (
  state: MissionState,
  over: {
    changed?: number;
    workstreams?: Workstream[];
    milestones?: Milestone[];
    failureReason?: string | null;
    verified?: boolean | null;
    control?: ControlProps;
    runControl?: RunControl;
    completion?: MissionCompletion;
    focus?: Focus;
    action?: { label: string; onClick: () => void; primary?: boolean };
    dominant?: "handoff" | "decision" | "focus" | "direction";
  } = {},
): string => {
  const changed = over.changed ?? 0;

  return renderToStaticMarkup(
    <Workroom
      composition={composeMission(state, {
        agents: 1,
        changed,
        verified: state === "verified",
        ...(over.completion ? { completion: over.completion } : {}),
      })}
      control={over.control ?? alone}
      {...(over.runControl ? { runControl: over.runControl } : {})}
      meter={meter}
      completion={over.completion ?? null}
      completedBy="Kartik"
      onReopen={() => {}}
      {...(over.focus ? { focus: over.focus } : {})}
      {...(over.action ? { action: over.action } : {})}
      {...(over.dominant ? { dominant: over.dominant } : {})}
      goal="Migrate authentication from session cookies to scoped tokens"
      state="Working"
      repository="novus"
      branch="main"
      workstreams={over.workstreams ?? [stream()]}
      people={people}
      selected="r1"
      onSelect={() => {}}
      onAdd={() => {}}
      onInvite={() => {}}
      milestones={over.milestones ?? [milestone()]}
      evidence={{
        verified: over.verified ?? null,
        testsRun: over.verified === null || over.verified === undefined ? 0 : 4,
        testsPassed: over.verified ? 4 : 2,
        files: Array.from({ length: changed }, (_, index) => ({
          path: `src/file-${index}.ts`,
          additions: 3,
          deletions: 1,
        })),
        contested: [],
        risks: [],
      }}
      github={null}
      failureReason={over.failureReason ?? null}
      onRetry={() => {}}
      target="r1"
      onTarget={() => {}}
      busy={false}
      onSend={() => {}}
    />,
  );
};

const startCanvas = (error: string | null = null): string =>
  renderToStaticMarkup(
    <EmptyMission
      repository="novus"
      branch="main"
      repositoryState="ready"
      allowWrites={false}
      harnesses={[]}
      harness={null}
      onHarness={() => {}}
      busy={false}
      error={error}
      onStart={() => {}}
      onInvite={() => {}}
    />,
  );

/* ---------- 1. repository opened, nothing requested ---------- */

test("the start canvas asks one question and renders no other region", () => {
  const html = startCanvas();

  assert.match(html, /What are we building\?/);
  // Every region the old empty screen drew against no data.
  assert.doesNotMatch(html, /rail--workroom/);
  assert.doesNotMatch(html, /class="evidence/);
  assert.doesNotMatch(html, /Required checks/);
  assert.doesNotMatch(html, /Changed files/);
  assert.doesNotMatch(html, /Approaches/);
  assert.doesNotMatch(html, /Decision/);
});

test("the start canvas never says 'Nothing asked yet'", () => {
  // Machine language for an absence, where an invitation belongs.
  assert.doesNotMatch(startCanvas(), /Nothing asked yet/);
});

test("the start canvas states permission rather than offering a control that changes nothing", () => {
  const html = startCanvas();

  assert.match(html, /Read-only/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("the start canvas has exactly one primary action", () => {
  const html = startCanvas();

  assert.equal((html.match(/button--primary/g) ?? []).length, 1);
  assert.match(html, /Start mission/);
});

test("a mission that fails to start says so on the screen that failed", () => {
  // The screen does not change when a start is refused — same question, same
  // text still in the field — so a message in the window's footer strip reads
  // as "nothing happened" rather than as "this failed, and here is why".
  const html = startCanvas("This worker has no adapter for anthropic/auto.");

  assert.match(html, /no adapter for anthropic\/auto/);
  assert.match(html, /start__error/);
  assert.match(html, /role="alert"/);
});

test("a start canvas with nothing wrong shows no error region", () => {
  assert.doesNotMatch(startCanvas(), /start__error/);
});

/* ---------- 2. mission submitted, agent starting ---------- */

test("starting shows the room but not an evidence panel", () => {
  const html = workroom("starting");

  assert.match(html, /rail--workroom/);
  assert.match(html, /Claude/);
  assert.doesNotMatch(html, /evidence--panel/);
  assert.match(html, /workroom--noevidence/);
});

/* ---------- 3. agent actively working ---------- */

test("working attributes activity to an agent, without sequence numbers or tool names", () => {
  const html = workroom("working");

  assert.match(html, /beat__actor/);
  assert.match(html, /Read 6 files/);
  // The vocabulary the feed replaced.
  assert.doesNotMatch(html, /event__seq/);
  assert.doesNotMatch(html, /tool\.requested/);
});

test("a live workstream says so in a word, not only in a colour", () => {
  const html = workroom("working", {
    workstreams: [stream({ state: "running" })],
  });

  assert.match(html, /Running/);
});

/* ---------- 4. agent needs direction ---------- */

test("needing a person is stated above the work, in amber and not in green", () => {
  const html = workroom("needs-direction");

  assert.match(html, /banner--attention/);
  assert.match(html, /Waiting on you/);
  assert.doesNotMatch(html, /banner--verified/);
});

/* ---------- 5. changed files, nothing verified ---------- */

test("changed and unverified says so plainly and mounts the inspector", () => {
  const html = workroom("changed-unverified", { changed: 3 });

  assert.match(html, /Changed, not verified/);
  assert.match(html, /evidence--panel/);
  assert.match(html, /Nothing has verified these changes/);
  // The state most easily misread as success must not borrow its colour.
  assert.doesNotMatch(html, /evidence__line--pass/);
  assert.doesNotMatch(html, /banner--verified/);
});

test("an unverified mission never renders a verified summary", () => {
  const html = workroom("changed-unverified", { changed: 1, verified: null });

  assert.doesNotMatch(html, /checks passed/);
});

/* ---------- 6. verified ---------- */

test("verified is the only state that renders the pass treatment", () => {
  const html = workroom("verified", { changed: 2, verified: true });

  assert.match(html, /banner--verified/);
  assert.match(html, /evidence__line--pass/);
  assert.match(html, /4 of 4 checks passed/);
});

/* ---------- 7. failed before producing changes ---------- */

test("a failure with nothing produced is a recovery screen, not a decision screen", () => {
  const html = workroom("failed", {
    failureReason: "The provider returned 401: invalid x-api-key",
  });

  assert.match(html, /recovery__reason/);
  assert.match(html, /invalid x-api-key/);
  assert.match(html, /Give it more to go on/);
  // Nothing to inspect and nothing to compare.
  assert.doesNotMatch(html, /evidence--panel/);
  assert.doesNotMatch(html, /feed/);
});

/* ---------- 8. a person declared it over ---------- */

const finished = (
  over: Partial<MissionCompletion> = {},
): MissionCompletion => ({
  outcome: "resolved",
  summary: "Checkout test passes again; the fix is in the cart reducer.",
  verification: "verified",
  filesChanged: 3,
  completedBy: HOST,
  completedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

test("a completed mission states its outcome, its frozen evidence and its way back", () => {
  const html = workroom("completed", { completion: finished() });

  assert.match(html, /This mission is resolved/);
  assert.match(html, /cart reducer/);
  assert.match(html, /3 files changed/);
  assert.match(html, /Reopen mission/);
  // Not an activity feed with a badge on it: an ending is a thing to read.
  assert.doesNotMatch(html, /class="feed"/);
});

test("completing a mission is not verifying it", () => {
  // The distinction the whole product turns on, at the one moment it is most
  // tempting to blur: somebody has just declared the work finished.
  const unverified = workroom("completed", {
    completion: finished({ verification: "unverified" }),
  });
  const failing = workroom("completed", {
    completion: finished({ verification: "failing" }),
  });

  assert.match(unverified, /Nothing verified these changes/);
  assert.doesNotMatch(unverified, /finished__proof--pass/);
  assert.doesNotMatch(unverified, /finished__proof--fail/);

  assert.match(failing, /finished__proof--fail/);
  assert.doesNotMatch(failing, /finished__proof--pass/);
});

test("an abandoned mission is not dressed as a resolved one", () => {
  const html = workroom("completed", {
    completion: finished({ outcome: "abandoned", verification: "verified" }),
  });

  assert.match(html, /This mission was abandoned/);
  // Its evidence is still reported honestly — green tests on work nobody kept
  // is an ordinary outcome, and hiding it would be editing the record.
  assert.match(html, /finished__proof--pass/);
});

test("a completed mission does not draw a live evidence inspector beside a frozen one", () => {
  // The inspector re-derives from the repository as it stands now, which can
  // contradict the evidence the ending was called on.
  const html = workroom("completed", { changed: 4, completion: finished() });

  assert.doesNotMatch(html, /evidence--panel/);
});

/* ---------- authority, on the screen a host actually looks at ---------- */

const OFFER = {
  offerEventId: "e-1",
  fromParticipantId: HOST,
  toParticipantId: GUEST,
  state: "offered" as const,
  offeredAt: "2026-08-01T00:00:00.000Z",
  acceptedAt: null,
};

test("a handoff offered to you can be answered on the default screen", () => {
  // The bug this slice exists for: ControlPanel rendered only in a shell
  // reachable by switching views, so an incoming offer showed a banner reading
  // "Waiting on you" with nothing on screen to accept or decline with.
  const html = workroom("needs-direction", {
    control: control({ you: GUEST, controlHeldBy: HOST, controlOffer: OFFER }),
  });

  assert.match(html, /Waiting on you/);
  assert.match(html, /Accept control/);
  assert.match(html, /Decline/);
});

test("only the participant an offer names can answer it, here too", () => {
  const offerer = workroom("working", { control: control({ controlOffer: OFFER }) });
  const bystander = workroom("working", {
    control: control({
      you: "p-third",
      controlHeldBy: HOST,
      controlOffer: OFFER,
    }),
  });

  assert.match(offerer, /Withdraw offer/);
  assert.doesNotMatch(offerer, /Accept control/);
  assert.doesNotMatch(bystander, /Accept control|Decline|Withdraw offer/);
});

test("somebody without control can ask for it from the default screen", () => {
  const html = workroom("working", {
    control: control({ you: GUEST, controlHeldBy: HOST }),
  });

  assert.match(html, /Request control/);
  // Absent, not disabled — the rule ControlPanel has always kept.
  assert.doesNotMatch(html, /Offer control|Offer to/);
});

test("a single-user mission renders no authority chrome at all", () => {
  // Every control here is about handing work to somebody who is not there.
  const html = workroom("working");

  assert.doesNotMatch(html, /Request control|Offer control|Accept control/);
  assert.doesNotMatch(html, />Control</);
});

test("direction that has been said and not yet acted on is visible without switching views", () => {
  const html = workroom("working", {
    control: control({
      pendingDirection: [
        {
          eventId: "d-1",
          direction: "prefer the smaller change",
          submittedAt: "2026-08-01T00:00:00.000Z",
          queuedForRunId: "run-1",
          queuedAt: "2026-08-01T00:00:01.000Z",
        },
      ],
    }),
  });

  assert.match(html, /prefer the smaller change/);
  assert.match(html, /Queued/);
});

/* ---------- run control and cost ---------- */

test("a running mission can be paused and cancelled without leaving the screen", () => {
  const live = workroom("working", {
    runControl: {
      paused: false,
      pausing: false,
      cancelling: false,
      onPause: noop,
      onCancel: noop,
    },
  });

  assert.match(live, /Pause/);
  assert.match(live, /Cancel/);
  // Absent when nothing is running: there is no run to stop.
  assert.doesNotMatch(workroom("working"), /Run control/);
});

test("what the mission has spent is on the screen, not only in a log line", () => {
  assert.match(workroom("working"), /\$0\.42/);
});

/* ---------- focus panes: opened only by asking ---------- */

const focused = (state: MissionState = "working"): string =>
  workroom(state, {
    focus: {
      label: "Approaches",
      onClose: noop,
      node: <div className="fake-compare">Two approaches</div>,
    },
    dominant: "focus",
  });

test("a focus pane swaps the centre column and nothing else", () => {
  // Retained from the removed decision-room.test.ts, which held this against a
  // shell that no longer exists: reaching a decision must not cost the ability
  // to say anything, and the room must not disappear underneath it.
  const html = focused();

  assert.match(html, /fake-compare/);
  assert.match(html, /class="dock"/, "the composer is still there");
  assert.match(html, /rail--workroom/, "the room is still there");
  assert.match(html, /class="mission"/, "the header is still there");
  // The activity feed is what it replaced.
  assert.doesNotMatch(html, /class="feed"/);
});

test("a focus pane says what it is and how to leave it", () => {
  const html = focused();

  assert.match(html, /Approaches/);
  assert.match(html, /Back to activity/);
});

test("opening a focus pane does not create a second primary action", () => {
  const html = focused("changed-unverified");

  assert.ok((html.match(/button--primary/g) ?? []).length <= 1);
});

test("the mission action is only inverted when it is the one the mission is waiting on", () => {
  const waiting = workroom("changed-unverified", {
    changed: 2,
    action: { label: "Review approaches", onClick: noop, primary: true },
    dominant: "decision",
  });
  const offered = workroom("changed-unverified", {
    changed: 2,
    action: { label: "Compare approaches", onClick: noop, primary: false },
  });

  assert.match(waiting, /Review approaches/);
  assert.ok((waiting.match(/button--primary/g) ?? []).length <= 1);

  // Still offered, still clickable, just not claiming the screen's one
  // inversion while the composer holds it.
  assert.match(offered, /Compare approaches/);
  assert.ok((offered.match(/button--primary/g) ?? []).length <= 1);
});

/* ---------- across every state ---------- */

test("every state keeps the composer, and no state renders two primary actions", () => {
  const states: MissionState[] = [
    "starting",
    "working",
    "needs-direction",
    "changed-unverified",
    "verified",
    "failed",
    "completed",
  ];

  for (const state of states) {
    const html = workroom(state, {
      changed: state === "changed-unverified" || state === "verified" ? 2 : 0,
      failureReason: state === "failed" ? "boom" : null,
      verified: state === "verified" ? true : null,
      ...(state === "completed" ? { completion: finished() } : {}),
    });

    assert.match(html, /class="dock"/, `${state} lost the composer`);
    assert.ok(
      (html.match(/button--primary/g) ?? []).length <= 1,
      `${state} rendered more than one primary action`,
    );
  }
});

test("the recipient selector appears only when there is more than one agent", () => {
  const one = workroom("working");
  const two = workroom("working", {
    workstreams: [stream(), stream({ runId: "r2", signal: "--ws-2", primary: false })],
  });

  assert.doesNotMatch(one, /dock__select/);
  assert.match(two, /dock__select/);
});

test("a workstream says which harness runs it, not only which model", () => {
  // The rail named the model alone, so real Claude Code and Novus's own loop
  // against a Claude model read identically — while differing in who enforces
  // permissions, whether Novus sees typed tool calls, and whose account pays.
  const html = workroom("working", {
    workstreams: [stream({ harness: "Claude Code", model: "claude-opus-5" })],
  });

  assert.match(html, /Claude Code/);
  assert.match(html, /claude-opus-5/);
});

test("the agent picker appears only when there is a choice to make", () => {
  // One option is not a choice, and a picker with a single entry teaches
  // people to ignore pickers.
  const one = renderToStaticMarkup(
    <HarnessPicker
      choices={[
        { kind: "claude-code", name: "Claude Code", detail: "Max plan", available: true },
      ]}
      selected="claude-code"
      onSelect={() => {}}
    />,
  );
  const two = renderToStaticMarkup(
    <HarnessPicker
      choices={[
        { kind: "claude-code", name: "Claude Code", detail: "Max plan", available: true },
        { kind: "codex", name: "Codex", detail: "Installed, not signed in", available: false },
      ]}
      selected="claude-code"
      onSelect={() => {}}
    />,
  );

  assert.equal(one, "");
  assert.match(two, /Claude Code/);
  assert.match(two, /Codex/);
  // Shown and disabled, not hidden: hiding it turns "run `codex login`" into
  // "Novus does not support Codex".
  assert.match(two, /disabled/);
});
