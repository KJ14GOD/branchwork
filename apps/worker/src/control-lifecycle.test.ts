import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { AuthorityResponseSchema } from "@novus/contracts/protocol";
import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { projectSession } from "./projection.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * The handoff lifecycle and the direction lifecycle, driven through the real
 * event server and the real SessionRegistry.
 *
 * No provider is contacted. The adapter's `complete` never settles, which is
 * exactly what a test of authority wants: a turn submitted here starts a run
 * that stays running until the test ends, so "is an execution in flight" is
 * something the test controls rather than races.
 */

const TOKEN = "control-lifecycle-token-abcdefghijklmnop";

/**
 * A model call that never returns, and a way to know it has been entered.
 *
 * The run loop drains pending direction at the top of each iteration, and the
 * top of the *first* iteration is a boundary like any other. A direction
 * posted between `run.started` and the first model call is therefore folded
 * in immediately and correctly — it just leaves `pendingDirection` empty,
 * which is not the state a test of "queued but not yet applied" is trying to
 * observe. That window is narrow on an idle machine and wide under load,
 * which is why this read as a contention flake for so long rather than as the
 * race it is.
 *
 * `entered` resolves once the loop is parked inside `complete`, past that
 * first boundary, where a direction can only be queued.
 */
let enterModel: (() => void) | null = null;
let entered = Promise.resolve();
let releaseModel: (() => void) | null = null;

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () =>
    new Promise((settle) => {
      // Parked, not finished. `releaseModel` is what lets a test move the run
      // to its next boundary — a call that can never return also means cancel
      // and pause can never be observed, because both are checked at the top
      // of the loop the call is blocking.
      releaseModel = () => settle({ type: "final", summary: "Released." });
      enterModel?.();
    }),
};

/** Lets the parked model call return, so the loop reaches its next boundary. */
const releaseRun = async (): Promise<void> => {
  releaseModel?.();
  releaseModel = null;
  await delay(0);
};

type Guest = { token: string; id: string };

type Context = {
  url: string;
  sessionId: string;
  hostId: string;
  invite: (
    role: "editor" | "reviewer" | "viewer",
    name?: string,
  ) => Promise<Guest>;
  /** A second session on the same worker, for the cross-session checks. */
  otherSession: () => Promise<string>;
};

const withSession = async (
  run: (context: Context) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const participants = new ParticipantRegistry();

  const host = participants.add(
    { sessionId: HOST_SESSION, name: "Host", kind: "human", role: "owner" },
    TOKEN,
  );

  const server = await startEventServer(store, {
    port: 0,
    token: TOKEN,
    sessions,
    participants,
  });

  const open = async (): Promise<string> => {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    return created.id;
  };

  try {
    const sessionId = await open();

    const invite = async (
      role: "editor" | "reviewer" | "viewer",
      name = `${role}-guest`,
    ): Promise<Guest> => {
      const body = (await fetch(`${server.url}/sessions/${sessionId}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name, role }),
      }).then((response) => response.json())) as {
        token: string;
        participant: { id: string };
      };

      return { token: body.token, id: body.participant.id };
    };

    await run({
      url: server.url,
      sessionId,
      hostId: host.participant.id,
      invite,
      otherSession: open,
    });
  } finally {
    await server.close();
  }
};

const post = (
  url: string,
  token: string,
  body: unknown,
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });

type Authority = {
  controlHeldBy: string | null;
  controlOffer: {
    offerEventId: string;
    fromParticipantId: string;
    toParticipantId: string;
    state: "offered" | "accepted";
  } | null;
  controlRequests: { participantId: string; reason: string | null }[];
  pendingDirection: {
    eventId: string;
    direction: string;
    queuedForRunId: string | null;
  }[];
  executingRunIds: string[];
};

const authority = async (
  url: string,
  sessionId: string,
  token = TOKEN,
): Promise<Authority> =>
  (await fetch(`${url}/sessions/${sessionId}/authority`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json())) as Authority;

/** Offers control and returns the offer's id. */
const offer = async (
  url: string,
  sessionId: string,
  fromToken: string,
  toParticipantId: string,
): Promise<string> => {
  const response = await post(
    `${url}/sessions/${sessionId}/handoff`,
    fromToken,
    { toParticipantId },
  );

  assert.equal(response.status, 202);

  return ((await response.json()) as { offerEventId: string }).offerEventId;
};

/**
 * Starts a turn and waits until the run is actually executing.
 *
 * The route answers 202 before the runner has appended run.started — a turn is
 * accepted, not completed — so a test that assumed the run was live the moment
 * the response arrived would be racing the queue.
 */
const startRun = async (url: string, sessionId: string): Promise<string> => {
  // Armed before the turn is submitted, so the signal cannot be missed by a
  // run that reaches the model faster than this function does.
  entered = new Promise<void>((settle) => {
    enterModel = settle;
  });

  const accepted = await post(`${url}/sessions/${sessionId}/turns`, TOKEN, {
    goal: "a goal whose model call never returns",
  });

  assert.equal(accepted.status, 202);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const running = (await authority(url, sessionId)).executingRunIds[0];

    if (running !== undefined) {
      // Wait for the loop to be parked inside the model call rather than
      // merely started. `run.started` is appended before the first boundary,
      // so returning here would hand back a run that is about to drain
      // anything submitted in the next few milliseconds.
      await entered;

      return running;
    }

    await delay(10);
  }

  assert.fail("the run never started");
};

test("what /authority sends validates against the contract", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    // Populated rather than empty: every nullable field null is the one shape
    // a wrong schema is most likely to accept by accident.
    const editor = await invite("editor");
    const runId = await startRun(url, sessionId);

    // Statuses asserted, not discarded. All three of these were fire-and-
    // forget, so a request that was refused looked exactly like a projection
    // that came back empty — and the one intermittent failure this test has
    // ever produced was an empty pendingDirection with no way to tell which
    // of the two had happened.
    const asked = await post(
      `${url}/sessions/${sessionId}/control/request`,
      editor.token,
      { reason: "I have context on this" },
    );
    assert.equal(asked.status, 202, await asked.text());

    const directed = await post(`${url}/sessions/${sessionId}/direction`, TOKEN, {
      goal: "prefer the smaller change",
    });
    assert.equal(directed.status, 202, await directed.text());

    await offer(url, sessionId, TOKEN, editor.id);

    const body = await fetch(`${url}/sessions/${sessionId}/authority`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());

    // The route's payload is annotated `Authority`, so the field *names* are
    // compiler-checked. Nothing checks the values — a timestamp in the wrong
    // format satisfies `string` and fails `z.string().datetime()` at the
    // renderer, where it shows up as a panel that silently never populates.
    const parsed = AuthorityResponseSchema.safeParse(body);

    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
    );

    assert.equal(parsed.success && parsed.data.controlOffer?.state, "offered");
    assert.equal(parsed.success && parsed.data.controlRequests.length, 1);
    assert.equal(
      parsed.success && parsed.data.pendingDirection[0]?.queuedForRunId,
      runId,
      `pendingDirection was ${JSON.stringify(parsed.success ? parsed.data.pendingDirection : null)}, executing ${JSON.stringify(parsed.success ? parsed.data.executingRunIds : null)}`,
    );
  });
});

test("offer then accept: control moves, and only after the acceptance", async () => {
  await withSession(async ({ url, sessionId, hostId, invite }) => {
    const editor = await invite("editor");

    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    const offered = await authority(url, sessionId);
    assert.equal(offered.controlOffer?.state, "offered");
    assert.equal(offered.controlOffer?.toParticipantId, editor.id);
    // The baton has not moved. An offer that moved control would make the
    // recipient responsible for an execution they never agreed to hold.
    assert.equal(offered.controlHeldBy, hostId);

    const accepted = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      editor.token,
      { offerEventId },
    );

    assert.equal(accepted.status, 202);
    assert.equal(
      ((await accepted.json()) as { transferred: boolean }).transferred,
      true,
    );

    const settled = await authority(url, sessionId);
    assert.equal(settled.controlHeldBy, editor.id);
    // Settled offers are history, not state.
    assert.equal(settled.controlOffer, null);
  });
});

test("offer then decline: the offer clears and control stays put", async () => {
  await withSession(async ({ url, sessionId, hostId, invite }) => {
    const editor = await invite("editor");
    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    const declined = await post(
      `${url}/sessions/${sessionId}/handoff/decline`,
      editor.token,
      { offerEventId, reason: "in the middle of something" },
    );

    assert.equal(declined.status, 202);

    const after = await authority(url, sessionId);
    assert.equal(after.controlOffer, null);
    assert.equal(after.controlHeldBy, hostId);

    // And the controller can offer again — a declined offer must not leave the
    // session unable to hand off at all.
    await offer(url, sessionId, TOKEN, editor.id);
  });
});

test("offer then withdraw: the offerer takes back an offer nobody answered", async () => {
  await withSession(async ({ url, sessionId, hostId, invite }) => {
    const editor = await invite("editor");
    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    // The recipient cannot withdraw somebody else's offer, and the offerer
    // cannot decline on the recipient's behalf. Each verb belongs to one side.
    const wrongWay = await post(
      `${url}/sessions/${sessionId}/handoff/withdraw`,
      editor.token,
      { offerEventId },
    );

    assert.equal(wrongWay.status, 403);

    const withdrawn = await post(
      `${url}/sessions/${sessionId}/handoff/withdraw`,
      TOKEN,
      { offerEventId },
    );

    assert.equal(withdrawn.status, 202);

    const after = await authority(url, sessionId);
    assert.equal(after.controlOffer, null);
    assert.equal(after.controlHeldBy, hostId);

    // The withdrawn offer cannot then be accepted by a client that still had
    // it on screen.
    const stale = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      editor.token,
      { offerEventId },
    );

    assert.equal(stale.status, 409);
  });
});

test("a second offer is refused while one is in flight", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const first = await invite("editor", "first");
    const second = await invite("editor", "second");

    const offerEventId = await offer(url, sessionId, TOKEN, first.id);

    // Two live offers would mean two people each told they are about to hold
    // control, and whichever accepted last winning a race neither could see.
    const overlapping = await post(
      `${url}/sessions/${sessionId}/handoff`,
      TOKEN,
      { toParticipantId: second.id },
    );

    assert.equal(overlapping.status, 409);

    const after = await authority(url, sessionId);
    assert.equal(after.controlOffer?.offerEventId, offerEventId);
    assert.equal(after.controlOffer?.toParticipantId, first.id);
  });
});

test("an answer naming a superseded offer is refused", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    const stale = await offer(url, sessionId, TOKEN, editor.id);

    assert.equal(
      (await post(`${url}/sessions/${sessionId}/handoff/withdraw`, TOKEN, {
        offerEventId: stale,
      })).status,
      202,
    );

    const current = await offer(url, sessionId, TOKEN, editor.id);
    assert.notEqual(current, stale);

    // A client that still had the withdrawn offer on screen answers the one it
    // saw. Pinning the id is what stops that from settling an offer its sender
    // never knew about — here, one made to the same person for a different
    // reason a moment later.
    const answered = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      editor.token,
      { offerEventId: stale },
    );

    assert.equal(answered.status, 409);

    const after = await authority(url, sessionId);
    assert.equal(after.controlOffer?.offerEventId, current);
    assert.equal(after.controlOffer?.state, "offered");
  });
});

test("an offer can only be answered by the participant it names", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");
    const bystander = await invite("viewer");
    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    const intercepted = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      bystander.token,
      { offerEventId },
    );

    assert.equal(intercepted.status, 403);
    assert.equal((await authority(url, sessionId)).controlOffer?.state, "offered");
  });
});

test("a viewer offered control can accept it — authority is the offer, not the rank", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    // The case a capability check gets wrong. A viewer has no "transfer" and no
    // "steer"; gating acceptance on either would mean the only people who can
    // take control are the people who already hold it.
    const viewer = await invite("viewer");
    const offerEventId = await offer(url, sessionId, TOKEN, viewer.id);

    const accepted = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      viewer.token,
      { offerEventId },
    );

    assert.equal(accepted.status, 202);
    assert.equal((await authority(url, sessionId)).controlHeldBy, viewer.id);
  });
});

test("acceptance during a live run waits for the boundary, then transfers", async () => {
  await withSession(async ({ url, sessionId, hostId, invite }) => {
    const editor = await invite("editor");

    const runId = await startRun(url, sessionId);

    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    const accepted = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      editor.token,
      { offerEventId },
    );

    assert.equal(accepted.status, 202);
    assert.equal(
      ((await accepted.json()) as { transferred: boolean }).transferred,
      false,
    );

    // Three distinct states, and this is the middle one: accepted, and waiting.
    // A UI that collapsed the lifecycle into a toggle would have shown control
    // as already moved here.
    const waiting = await authority(url, sessionId);
    assert.equal(waiting.controlOffer?.state, "accepted");
    assert.equal(waiting.controlHeldBy, hostId);
    assert.deepEqual(waiting.executingRunIds, [runId]);

    const cancelled = await post(`${url}/sessions/${sessionId}/cancel`, TOKEN, {
      runId,
    });

    assert.equal(cancelled.status, 202);

    // The run is parked inside its model call, and cancel is read at the top
    // of the loop that call is blocking. Letting it return is what carries the
    // run to the boundary where both the cancel and the accepted handoff are
    // acted on — without it the loop never iterates again and nothing moves.
    await releaseRun();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const now = await authority(url, sessionId);

      if (now.controlHeldBy === editor.id) {
        assert.equal(now.controlOffer, null);
        return;
      }

      await delay(10);
    }

    assert.fail("control never reached the boundary");
  });
});

test("the requester leaving withdraws their standing request", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    const requested = await post(
      `${url}/sessions/${sessionId}/control/request`,
      editor.token,
      { reason: "I can take this from here" },
    );

    assert.equal(requested.status, 202);
    assert.equal((await authority(url, sessionId)).controlRequests.length, 1);

    const left = await post(`${url}/sessions/${sessionId}/leave`, editor.token, {});
    assert.equal(left.status, 202);

    // A request is a standing fact until control reaches the requester or they
    // leave. They left, so the controller must stop being shown a request from
    // somebody who is not in the room.
    assert.deepEqual((await authority(url, sessionId)).controlRequests, []);
  });
});

test("the controller leaving mid-offer voids the offer and leaves control unheld", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");
    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    const left = await post(`${url}/sessions/${sessionId}/leave`, TOKEN, {});
    assert.equal(left.status, 202);

    const after = await authority(url, sessionId, editor.token);

    // Never held by someone who has left, and never silently inherited by the
    // person who happened to be mid-offer.
    assert.equal(after.controlHeldBy, null);
    assert.equal(after.controlOffer, null);

    const orphaned = await post(
      `${url}/sessions/${sessionId}/handoff/accept`,
      editor.token,
      { offerEventId },
    );

    assert.equal(orphaned.status, 409);
  });
});

test("a disconnect is not a departure: a standing request survives it", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    await post(`${url}/sessions/${sessionId}/control/request`, editor.token, {
      reason: "please",
    });

    // A real stream, opened and dropped — the same thing a refresh does.
    const aborter = new AbortController();

    await fetch(`${url}/events?session=${sessionId}&since=0`, {
      headers: { authorization: `Bearer ${editor.token}`, accept: "text/event-stream" },
      signal: aborter.signal,
    });

    const connected = (await fetch(`${url}/sessions/${sessionId}/presence`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json())) as {
      participants: { id: string; connected: boolean }[];
    };

    assert.equal(
      connected.participants.find((entry) => entry.id === editor.id)?.connected,
      true,
    );

    aborter.abort();

    let dropped = false;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const presence = (await fetch(`${url}/sessions/${sessionId}/presence`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json())) as {
        participants: { id: string; connected: boolean }[];
      };

      if (
        presence.participants.find((entry) => entry.id === editor.id)
          ?.connected === false
      ) {
        dropped = true;
        break;
      }

      await delay(10);
    }

    // Asserted, not merely awaited: without this the test would pass on a
    // build where the stream never opened, and "the request survived a
    // disconnect" would be a claim about something that never happened.
    assert.equal(dropped, true);

    // Back after the drop, and the request they made before it is still there.
    // A controller who was not looking when it arrived still learns it exists.
    const after = await authority(url, sessionId);
    assert.equal(after.controlRequests.length, 1);
    assert.equal(after.controlRequests[0]?.participantId, editor.id);
    assert.equal(after.controlRequests[0]?.reason, "please");
  });
});

/**
 * The fold's own rule, tested directly, because no route can reach it.
 *
 * A dropped stream deliberately writes nothing to the log — it flips the
 * registry's `connected` flag and that is all — so the route-level test above
 * cannot distinguish "the request survived because the fold protects it" from
 * "the request survived because nothing happened". This one can: it hands the
 * fold the event a disconnect *would* write and checks it is not treated as a
 * departure, which is the guard a future disconnect-writes-an-event change
 * would otherwise silently remove.
 */
test("the fold keeps a request across a disconnect and drops it on a departure", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const requester = "22222222-2222-4222-8222-222222222222";

  const joined = {
    eventId: "33333333-3333-4333-8333-333333333333",
    sessionId,
    actorId: requester,
    sequence: 0,
    occurredAt: "2026-07-31T00:00:00.000Z",
    type: "participant.joined",
    payload: {
      participant: {
        id: requester,
        sessionId,
        name: "Maya",
        kind: "human",
        role: "editor",
        joinedAt: "2026-07-31T00:00:00.000Z",
      },
    },
  } as const;

  const requested = {
    eventId: "44444444-4444-4444-8444-444444444444",
    sessionId,
    actorId: requester,
    sequence: 1,
    occurredAt: "2026-07-31T00:00:01.000Z",
    type: "control.requested",
    payload: { participantId: requester, reason: "I can take this from here" },
  } as const;

  const gone = (reason: "disconnected" | "left") =>
    ({
      eventId: "55555555-5555-4555-8555-555555555555",
      sessionId,
      actorId: requester,
      sequence: 2,
      occurredAt: "2026-07-31T00:00:02.000Z",
      type: "participant.left",
      payload: { participantId: requester, reason },
    }) as const;

  assert.equal(
    projectSession(sessionId, [joined, requested, gone("disconnected")])
      .controlRequests.length,
    1,
  );

  assert.deepEqual(
    projectSession(sessionId, [joined, requested, gone("left")]).controlRequests,
    [],
  );
});

test("asking twice sharpens one request rather than stacking two", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    await post(`${url}/sessions/${sessionId}/control/request`, editor.token, {
      reason: "first reason",
    });
    await post(`${url}/sessions/${sessionId}/control/request`, editor.token, {
      reason: "second reason",
    });

    const after = await authority(url, sessionId);

    assert.equal(after.controlRequests.length, 1);
    assert.equal(after.controlRequests[0]?.reason, "second reason");
  });
});

test("control reaching the requester answers their request", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    await post(`${url}/sessions/${sessionId}/control/request`, editor.token, {
      reason: "mine now",
    });

    const offerEventId = await offer(url, sessionId, TOKEN, editor.id);

    await post(`${url}/sessions/${sessionId}/handoff/accept`, editor.token, {
      offerEventId,
    });

    const after = await authority(url, sessionId);
    assert.equal(after.controlHeldBy, editor.id);
    assert.deepEqual(after.controlRequests, []);
  });
});

test("an invite for one session cannot act on another", async () => {
  await withSession(async ({ url, sessionId, invite, otherSession }) => {
    const editor = await invite("editor");
    const other = await otherSession();

    assert.notEqual(other, sessionId);

    // Requesting control needs only "watch", which an editor plainly has — so
    // the role check cannot refuse this. Only the session-scope check can, and
    // the assertion below is on the log rather than the status: without the
    // scope check this returns 202 and appends a control.requested into a
    // session this token was never invited to.
    const crossed = await post(
      `${url}/sessions/${other}/control/request`,
      editor.token,
      { reason: "not my session" },
    );

    assert.equal(crossed.status, 403);
    assert.deepEqual((await authority(url, other)).controlRequests, []);

    const crossedLeave = await post(
      `${url}/sessions/${other}/leave`,
      editor.token,
      {},
    );

    assert.equal(crossedLeave.status, 403);

    const crossedAccept = await post(
      `${url}/sessions/${other}/handoff/accept`,
      editor.token,
      { offerEventId: "whatever" },
    );

    assert.equal(crossedAccept.status, 403);
    assert.match(
      ((await crossedAccept.json()) as { error: string }).error,
      /different session/,
    );
  });
});

test("direction submitted while a run is live is queued for it", async () => {
  await withSession(async ({ url, sessionId }) => {
    await startRun(url, sessionId);

    const submitted = await post(`${url}/sessions/${sessionId}/direction`, TOKEN, {
      goal: "prefer the smaller change",
    });

    assert.equal(submitted.status, 202);

    const body = (await submitted.json()) as { queuedForRunId: string | null };
    assert.notEqual(body.queuedForRunId, null);

    const after = await authority(url, sessionId);
    assert.equal(after.pendingDirection.length, 1);
    assert.equal(after.pendingDirection[0]?.queuedForRunId, body.queuedForRunId);
  });
});

test("direction submitted while idle is recorded but not queued", async () => {
  await withSession(async ({ url, sessionId }) => {
    const submitted = await post(`${url}/sessions/${sessionId}/direction`, TOKEN, {
      goal: "when you next run, start with the tests",
    });

    assert.equal(submitted.status, 202);
    assert.equal(
      ((await submitted.json()) as { queuedForRunId: string | null })
        .queuedForRunId,
      null,
    );

    const after = await authority(url, sessionId);
    assert.equal(after.pendingDirection.length, 1);
    // Recorded, and waiting for whatever runs next — which is a different
    // promise from "the execution in flight will read this at its next turn",
    // and the difference is what the submitter needs to see.
    assert.equal(after.pendingDirection[0]?.queuedForRunId, null);
    assert.deepEqual(after.executingRunIds, []);
  });
});
