import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { composeMission, type MissionState } from "../../mission-state.ts";
import type { Person, Workstream } from "../../workstreams.ts";
import type { Milestone } from "./activity-feed.tsx";
import { EmptyMission } from "./empty-mission.tsx";
import { Workroom } from "./workroom.tsx";

/**
 * Seven states, seven compositions.
 *
 * The failure this file is aimed at is the one the whole pass exists for: a
 * universal shell that rendered every region on every screen and changed only
 * the words inside them. So these assertions are almost all about what is
 * *absent*. A test that only checked the text would have passed against the
 * interface being replaced.
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

const workroom = (
  state: MissionState,
  over: {
    changed?: number;
    workstreams?: Workstream[];
    milestones?: Milestone[];
    failureReason?: string | null;
    verified?: boolean | null;
  } = {},
): string => {
  const changed = over.changed ?? 0;

  return renderToStaticMarkup(
    <Workroom
      composition={composeMission(state, {
        agents: 1,
        changed,
        verified: state === "verified",
      })}
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

/* ---------- across every state ---------- */

test("every state keeps the composer, and no state renders two primary actions", () => {
  const states: MissionState[] = [
    "starting",
    "working",
    "needs-direction",
    "changed-unverified",
    "verified",
    "failed",
  ];

  for (const state of states) {
    const html = workroom(state, {
      changed: state === "changed-unverified" || state === "verified" ? 2 : 0,
      failureReason: state === "failed" ? "boom" : null,
      verified: state === "verified" ? true : null,
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
