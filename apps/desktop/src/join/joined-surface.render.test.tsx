import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { SessionEvent } from "@novus/contracts";
import type { Authority } from "@novus/contracts/protocol";
import { summarise, type PresenceEntry } from "@novus/session-client";

import { JoinedSurface, type JoinedSurfaceProps } from "./joined-surface.tsx";
import type { JoinedActions } from "./use-joined-actions.ts";

/**
 * What a joined window offers, and to whom.
 *
 * The joined tab had the whole control protocol available to it and used none
 * of it: a joiner could not see who held control, could not ask for it, and
 * could not answer an offer made to them by name. These tests pin the rules
 * that came with wiring it up — every one of which is invisible to the
 * compiler and erasable by a styling pass.
 *
 * The rule under most of them: an action a participant may not take is
 * *absent*, not disabled. A greyed-out "Pause" still tells a viewer that this
 * screen pauses runs and that they are being refused. The worker refuses these
 * calls independently — `joined-api.test.ts` drives that half against the real
 * routes — so nothing here is the security boundary. It is the interface
 * agreeing with one.
 */

const HOST = "p-host";
const YOU = "p-you";
const THIRD = "p-third";

const people: PresenceEntry[] = [
  { id: HOST, name: "Kartik", role: "owner", connected: true },
  { id: YOU, name: "Maya", role: "editor", connected: true },
  { id: THIRD, name: "Ines", role: "reviewer", connected: true },
];

const authority = (over: Partial<Authority> = {}): Authority => ({
  you: YOU,
  controlHeldBy: HOST,
  controlOffer: null,
  controlRequests: [],
  pendingDirection: [],
  executingRunIds: [],
  ...over,
});

const offer = {
  offerEventId: "e-offer",
  fromParticipantId: HOST,
  toParticipantId: YOU,
  state: "offered" as const,
  offeredAt: "2026-07-31T00:00:00.000Z",
  acceptedAt: null,
};

const started: SessionEvent = {
  eventId: "e1",
  sessionId: "s",
  sequence: 1,
  occurredAt: "2026-07-31T00:00:00.000Z",
  actorId: "agent-1",
  type: "run.started",
  payload: {
    run: {
      id: "run-1",
      sessionId: "s",
      goal: "make the thing work",
      status: "running",
      startedBy: "p-host",
      model: { provider: "anthropic", model: "test" },
      createdAt: "2026-07-31T00:00:00.000Z",
    },
  },
};

const actions: JoinedActions = {
  error: null,
  direct: async () => true,
  cancel: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  requestControl: async () => undefined,
  offerControl: async () => undefined,
  answerHandoff: async () => undefined,
};

const base: JoinedSurfaceProps = {
  active: true,
  relay: false,
  label: "novus",
  repositoryPath: "/repos/novus",
  report: { label: "Live", tone: "live", emptyTimeline: "Nothing yet." },
  summary: summarise([]),
  events: [],
  onRetry: null,
  role: "viewer",
  youId: YOU,
  participants: people,
  authority: authority(),
  actions,
};

const surface = (over: Partial<JoinedSurfaceProps> = {}) =>
  renderToStaticMarkup(<JoinedSurface {...base} {...over} />);

/** A live run, so the steering controls have something to steer. */
const running = {
  events: [started],
  summary: { ...summarise([]), runStatus: "working" as const },
};

test("a viewer may ask for control, and that is all they may do", () => {
  const html = surface({ role: "viewer", ...running });

  assert.match(html, /Request control/);

  // Direction and steering are not theirs.
  assert.doesNotMatch(html, /Add direction/);
  assert.doesNotMatch(html, />Direct</);
  assert.doesNotMatch(html, /Pause|Resume|Cancel/);
  assert.match(html, /your role does not include adding direction/);

  // Absent, not disabled: nothing on this screen tells them what they are
  // being refused.
  assert.doesNotMatch(html, /disabled/);
});

test("requesting control does not claim to have taken it", () => {
  const html = surface({ role: "viewer" });

  // The one thing this button must never imply. Control still sits where the
  // authority fold says it sits.
  assert.doesNotMatch(html, /Take control|You have control|You in control/);
  assert.match(html, /Kartik in control/);
});

test("a request already made shows as pending rather than as a button", () => {
  const html = surface({
    role: "viewer",
    authority: authority({
      controlRequests: [
        {
          eventId: "r-1",
          participantId: YOU,
          reason: "I know this file",
          requestedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
    }),
  });

  assert.match(html, /You requested control/);
  assert.match(html, /I know this file/);

  // Asking twice is not a thing to offer — the fold sharpens one request
  // rather than stacking two, and the button would suggest otherwise.
  assert.doesNotMatch(html, /Request control/);
});

test("an editor may direct and may steer a live run", () => {
  const html = surface({ role: "editor", ...running });

  assert.match(html, /Add direction/);
  assert.match(html, /Pause/);
  assert.match(html, /Cancel/);
});

test("an editor with nothing running is offered nothing to steer", () => {
  const html = surface({ role: "editor" });

  // Steering is authority over a run in flight. With no run there is no safe
  // boundary to stop at and no button that would mean anything.
  assert.doesNotMatch(html, /Pause|Resume|Cancel/);
  assert.match(html, /Add direction/);
});

test("a paused run offers resume in place of pause", () => {
  const html = surface({
    role: "editor",
    events: [started],
    summary: { ...summarise([]), runStatus: "paused" },
  });

  assert.match(html, /Resume/);
  assert.doesNotMatch(html, />Pause</);
});

test("the participant an offer names can accept it or decline it", () => {
  const html = surface({
    role: "editor",
    authority: authority({ controlOffer: offer }),
  });

  assert.match(html, /Kartik is offering you control/);
  assert.match(html, /Accept control/);
  assert.match(html, /Decline/);
});

test("the offerer may withdraw and may not answer on the recipient's behalf", () => {
  const html = surface({
    role: "owner",
    authority: authority({
      you: HOST,
      controlHeldBy: HOST,
      controlOffer: offer,
    }),
  });

  assert.match(html, /Withdraw offer/);
  assert.doesNotMatch(html, /Accept control/);
});

test("a bystander sees somebody else's offer and touches none of it", () => {
  const html = surface({
    role: "reviewer",
    youId: THIRD,
    authority: authority({ you: THIRD, controlOffer: offer }),
  });

  assert.match(html, /Control offered to Maya/);
  assert.doesNotMatch(html, /Accept control|Decline|Withdraw offer/);
});

test("an accepted offer waiting on a run is its own state, not either neighbour", () => {
  const accepted = {
    ...offer,
    state: "accepted" as const,
    acceptedAt: "2026-07-31T00:01:00.000Z",
  };

  const waiting = surface({
    role: "editor",
    authority: authority({ controlOffer: accepted, executingRunIds: ["run-1"] }),
    ...running,
  });
  const moving = surface({
    role: "editor",
    authority: authority({ controlOffer: accepted }),
  });
  const offered = surface({
    role: "editor",
    authority: authority({ controlOffer: offer }),
  });

  // Three steps, not two. The recipient has agreed and control has not moved,
  // and that is true for however long the run takes to reach a boundary.
  assert.match(waiting, /transfers at the next safe boundary/);
  assert.match(moving, /Control is moving/);
  assert.match(offered, /is offering you control/);
  assert.notEqual(waiting, moving);
  assert.notEqual(waiting, offered);
});

test("a newly promoted controller gets the actions their new role allows", () => {
  // What /me and /authority say one poll after the transfer landed: this
  // window is the owner now and holds control.
  const html = surface({
    role: "owner",
    authority: authority({ controlHeldBy: YOU }),
    ...running,
  });

  assert.match(html, /You in control/);

  // Offering it onward is a controller's action and is now available.
  assert.match(html, /Offer to Kartik/);
  assert.match(html, /Offer to Ines/);

  // Asking for what they already hold is not.
  assert.doesNotMatch(html, /Request control/);

  // And the role they were promoted into carries steering with it.
  assert.match(html, /Pause/);
  assert.match(html, /Add direction/);
});

test("the previous controller loses controller-only controls", () => {
  // The mirror image: this window used to hold control and the transfer
  // demoted it to editor. Same component, same poll, opposite answer.
  const before = surface({
    role: "owner",
    authority: authority({ controlHeldBy: YOU }),
  });
  const after = surface({
    role: "editor",
    authority: authority({ controlHeldBy: THIRD }),
  });

  assert.match(before, /Offer to Ines/);
  assert.doesNotMatch(after, /Offer to |Offer control/);
  assert.match(after, /Ines in control/);

  // Demoted, not silenced: an editor still directs, and may ask for the baton
  // back.
  assert.match(after, /Add direction/);
  assert.match(after, /Request control/);
});

test("pending direction says recorded when nothing has committed to it", () => {
  const html = surface({
    role: "editor",
    authority: authority({
      pendingDirection: [
        {
          eventId: "d-1",
          direction: "prefer the smaller change",
          submittedAt: "2026-07-31T00:00:00.000Z",
          queuedForRunId: null,
          queuedAt: null,
        },
      ],
    }),
  });

  assert.match(html, /prefer the smaller change/);
  assert.match(html, /it waits for the next execution/);
  assert.doesNotMatch(html, /folds this in at its next turn/);
});

test("pending direction says queued when a run will apply it", () => {
  const html = surface({
    role: "editor",
    ...running,
    authority: authority({
      executingRunIds: ["run-1"],
      pendingDirection: [
        {
          eventId: "d-1",
          direction: "prefer the smaller change",
          submittedAt: "2026-07-31T00:00:00.000Z",
          queuedForRunId: "run-1",
          queuedAt: "2026-07-31T00:00:01.000Z",
        },
      ],
    }),
  });

  // Two different promises to whoever typed it: one is folded in within the
  // minute, the other waits for whatever runs next, which may be never.
  assert.match(html, /folds this in at its next turn/);
  assert.doesNotMatch(html, /waits for the next execution/);
});

test("a relay join offers nothing to send and says why", () => {
  // The invite's role is deliberately generous here: a relay watcher stays
  // watch-only whatever the link claimed, because the transport has no
  // inbound direction at all.
  const html = surface({
    relay: true,
    role: "owner",
    youId: null,
    participants: [],
    authority: authority({ you: null, controlHeldBy: null }),
  });

  assert.doesNotMatch(html, /Request control|Offer|Accept control|Withdraw/);
  assert.doesNotMatch(html, /Pause|Resume|Cancel/);
  assert.doesNotMatch(html, /Add direction/);
  assert.doesNotMatch(html, /disabled/);

  // Said out loud, not left to be inferred from missing buttons: somebody who
  // can see the run deserves to know which reason applies to them.
  assert.match(html, /cannot be sent back yet/);
  assert.match(html, /Relay — watch only/);
});

test("host-only capabilities are absent from every joined view", () => {
  // A joined window has no standing on the host's machine, and these are
  // refused at the IPC boundary rather than merely unrendered. Rendering them
  // anywhere here would be an offer the app cannot keep.
  for (const html of [
    surface({ role: "owner", authority: authority({ controlHeldBy: YOU }) }),
    surface({ role: "editor" }),
    surface({ role: "viewer" }),
    surface({ relay: true, authority: authority({ you: null }) }),
  ]) {
    assert.doesNotMatch(html, /Terminal|Browse|Open repository|Invite/);
  }
});
