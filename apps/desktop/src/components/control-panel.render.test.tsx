import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { Authority } from "@novus/contracts/protocol";

import {
  ControlBaton,
  ControlPanel,
  MissionAuthority,
  PendingDirection,
} from "./control-panel.tsx";
import type { PresenceEntry } from "../use-presence.ts";

/**
 * The authority surface, rendered.
 *
 * The first test of the desktop renderer. Everything under `apps/desktop/src`
 * was unreachable by any test before this — the runner only ever globbed
 * `electron/*.test.ts`, so the main process was covered and the thing people
 * actually look at was not.
 *
 * What is worth defending here is not layout. It is that a participant who may
 * not act cannot see a control at all, and that the three states of a handoff
 * stay three states — both are rules a later styling pass can erase without
 * failing anything else.
 */

const HOST = "p-host";
const GUEST = "p-guest";

const people: PresenceEntry[] = [
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

const panel = (over: Partial<Authority> = {}) =>
  renderToStaticMarkup(
    <ControlPanel
      authority={authority(over)}
      participants={people}
      onOffer={noop}
      onRequest={noop}
      onAnswer={noop}
    />,
  );

test("someone who does not hold control gets no handoff controls at all", () => {
  const html = panel({ you: GUEST, controlHeldBy: HOST });

  // Absent, not disabled. A greyed-out "Offer control" still tells a guest
  // that offering control is something this screen does and they are being
  // refused it; the honest answer is that it is not theirs to offer.
  assert.doesNotMatch(html, /Offer control|Offer to/);
  assert.doesNotMatch(html, /disabled/);

  // What they can do is ask, and that is present.
  assert.match(html, /Request control/);

  // Who holds it is *not* here any more: the header's MissionAuthority states
  // it once, and the rail repeating it put control identity on screen twice.
  assert.doesNotMatch(html, /is in control/);
});

test("a handoff is three states, and the middle one is said out loud", () => {
  const offer = {
    offerEventId: "e-1",
    fromParticipantId: HOST,
    toParticipantId: GUEST,
    state: "offered" as const,
    offeredAt: "2026-07-31T00:00:00.000Z",
    acceptedAt: null,
  };

  const offered = panel({ controlOffer: offer });
  const acceptedMidRun = panel({
    controlOffer: { ...offer, state: "accepted", acceptedAt: "2026-07-31T00:01:00.000Z" },
    executingRunIds: ["run-1"],
  });
  const acceptedIdle = panel({
    controlOffer: { ...offer, state: "accepted", acceptedAt: "2026-07-31T00:01:00.000Z" },
    executingRunIds: [],
  });

  assert.match(offered, /waiting for them to accept/);

  // Accepted and not yet moved is its own state. Collapsing it into either
  // neighbour would be wrong for however long a run takes to reach a boundary.
  assert.match(acceptedMidRun, /transfers at the next safe boundary/);
  assert.match(acceptedIdle, /Control is moving/);
  assert.notEqual(acceptedMidRun, acceptedIdle);
});

test("only the participant an offer names can answer it", () => {
  const offer = {
    offerEventId: "e-1",
    fromParticipantId: HOST,
    toParticipantId: GUEST,
    state: "offered" as const,
    offeredAt: "2026-07-31T00:00:00.000Z",
    acceptedAt: null,
  };

  const recipient = panel({ you: GUEST, controlHeldBy: HOST, controlOffer: offer });
  const offerer = panel({ controlOffer: offer });
  const bystander = panel({
    you: "p-third",
    controlHeldBy: HOST,
    controlOffer: offer,
  });

  assert.match(recipient, /Accept control/);
  assert.match(recipient, /Decline/);

  // The offerer may take it back and may not accept on their behalf.
  assert.match(offerer, /Withdraw offer/);
  assert.doesNotMatch(offerer, /Accept control/);

  // A third party sees the state and touches none of it.
  assert.doesNotMatch(bystander, /Accept control|Decline|Withdraw offer/);
});

test("a standing request shows who asked and why, and survives being unanswered", () => {
  const html = panel({
    controlRequests: [
      {
        eventId: "r-1",
        participantId: GUEST,
        reason: "I have context on this",
        requestedAt: "2026-07-31T00:00:00.000Z",
      },
    ],
  });

  assert.match(html, /Maya requested control/);
  assert.match(html, /I have context on this/);

  // The controller can answer it here — that is the whole point of the request
  // being a standing fact rather than a notification that can be missed.
  assert.match(html, /Offer control/);
});

test("the single-user path renders no authority chrome at all", () => {
  // No participant registry means nobody is asking who is in control. The
  // harness has to stay usable by one person with none of this on screen.
  assert.equal(panel({ you: null }), "");
  assert.equal(
    renderToStaticMarkup(
      <ControlBaton authority={authority({ you: null })} participants={people} />,
    ),
    "",
  );
});

test("pending direction distinguishes queued from merely recorded", () => {
  const html = renderToStaticMarkup(
    <PendingDirection
      pending={[
        {
          eventId: "d-1",
          direction: "prefer the smaller change",
          submittedAt: "2026-07-31T00:00:00.000Z",
          queuedForRunId: "run-1",
          queuedAt: "2026-07-31T00:00:01.000Z",
        },
        {
          eventId: "d-2",
          direction: "and add a test",
          submittedAt: "2026-07-31T00:00:02.000Z",
          queuedForRunId: null,
          queuedAt: null,
        },
      ]}
    />,
  );

  assert.match(html, /prefer the smaller change/);
  assert.match(html, /and add a test/);

  // Two different promises to whoever typed them: one gets folded in within
  // the minute, the other waits for whatever runs next, which may be never.
  // Rendering them identically is the failure this exists to prevent.
  const queued = html.slice(html.indexOf("prefer the smaller change"));
  const recorded = html.slice(html.indexOf("and add a test"));
  assert.notEqual(
    queued.replace(/prefer the smaller change/, ""),
    recorded.replace(/and add a test/, ""),
  );
});


test("control identity is stated once, by the component that owns it", () => {
  const html = renderToStaticMarkup(
    <MissionAuthority
      authority={authority({ you: GUEST, controlHeldBy: HOST })}
      participants={people}
    />,
  );

  // The header used to carry a "You in control" pill beside a separate row of
  // initial circles: identity twice in the same 200 pixels, and neither half
  // saying which face was the controller. One component, and the holder is the
  // marked face.
  assert.match(html, /Kartik has control/);
  assert.match(html, /authority__face--holder/);
  assert.equal(html.split("authority__face--holder").length - 1, 1);
});

test("a mission waiting on somebody says so in amber, not green", () => {
  const html = renderToStaticMarkup(
    <MissionAuthority
      authority={authority({
        controlRequests: [
          {
            eventId: "r-1",
            participantId: GUEST,
            reason: null,
            requestedAt: "2026-07-31T00:00:00.000Z",
          },
        ],
      })}
      participants={people}
    />,
  );

  // Attention is not success. Green here would read as "this went well" about
  // a mission that is blocked on a person.
  assert.match(html, /authority__waiting/);
  assert.match(html, /1 asking/);
});

test("a mission with one person in it shows no authority chrome at all", () => {
  const alone: PresenceEntry[] = [
    { id: HOST, name: "Kartik", role: "owner", connected: true },
  ];

  // Every control here is about handing work to somebody who is not there.
  // "You have control" is not information when nobody could have it instead,
  // and a Request control button pointed at yourself is a puzzle.
  assert.equal(
    renderToStaticMarkup(
      <MissionAuthority authority={authority()} participants={alone} />,
    ),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      <ControlPanel
        authority={authority()}
        participants={alone}
        onOffer={noop}
        onRequest={noop}
        onAnswer={noop}
      />,
    ),
    "",
  );
});

test("a control holder the roster cannot resolve is never announced to a lone host", () => {
  // The real shape from a restarted worker: participant ids in the durable log
  // outlive the in-memory presence registry, so `controlHeldBy` points at an id
  // nobody carries any more. A solo host was told "Someone who has left has
  // control" about themselves.
  const alone: PresenceEntry[] = [
    { id: HOST, name: "Kartik", role: "owner", connected: true },
  ];
  const html = renderToStaticMarkup(
    <MissionAuthority
      authority={authority({ controlHeldBy: "an-id-from-a-previous-process" })}
      participants={alone}
    />,
  );

  assert.equal(html, "");
  assert.doesNotMatch(html, /has left/);
});
