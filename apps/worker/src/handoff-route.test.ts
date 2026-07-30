import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const TOKEN = "handoff-route-token-abcdefghijklmnopq";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const withSession = async (
  run: (context: {
    url: string;
    sessionId: string;
    invite: (role: "editor" | "reviewer" | "viewer") => Promise<{ token: string; id: string }>;
  }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const participants = new ParticipantRegistry();

  participants.add(
    { sessionId: HOST_SESSION, name: "Host", kind: "human", role: "owner" },
    TOKEN,
  );

  const server = await startEventServer(store, {
    port: 0,
    token: TOKEN,
    sessions,
    participants,
  });

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    const invite = async (
      role: "editor" | "reviewer" | "viewer",
    ): Promise<{ token: string; id: string }> => {
      const body = (await fetch(`${server.url}/sessions/${created.id}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: `${role}-guest`, role }),
      }).then((response) => response.json())) as {
        token: string;
        participant: { id: string };
      };

      return { token: body.token, id: body.participant.id };
    };

    await run({ url: server.url, sessionId: created.id, invite });
  } finally {
    await server.close();
  }
};

test("requesting control requires the token", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/control/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 401);
  });
});

test("any participant, including a viewer, can request control", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const viewer = await invite("viewer");

    const response = await fetch(`${url}/sessions/${sessionId}/control/request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewer.token}`,
      },
      body: JSON.stringify({ reason: "I see something worth fixing." }),
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as { accepted: boolean; eventId: string };
    assert.equal(body.accepted, true);
  });
});

test("a non-owner cannot hand off control", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");
    const other = await invite("viewer");

    const response = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor.token}`,
      },
      body: JSON.stringify({ toParticipantId: other.id }),
    });

    assert.equal(response.status, 403);
  });
});

test("handing off to someone outside the session is refused", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: "not-a-real-participant" }),
    });

    assert.equal(response.status, 404);
  });
});

test("the owner can hand off control, which records control.transferred and actually moves the role", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    const response = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: editor.id }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { transferred: boolean };
    assert.equal(body.transferred, true);

    // The transfer is not just an event — it actually moved the capability.
    // The new owner can now invite; the old owner (now an editor) cannot.
    const newOwnerInvites = await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor.token}`,
      },
      body: JSON.stringify({ name: "someone-else", role: "viewer" }),
    });

    assert.equal(newOwnerInvites.status, 201);

    const oldOwnerInvites = await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "someone-else-again", role: "viewer" }),
    });

    assert.equal(oldOwnerInvites.status, 403);
  });
});

test("handing off twice moves control on again, not back", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const first = await invite("editor");
    const second = await invite("editor");

    const firstHandoff = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: first.id }),
    });

    assert.equal(firstHandoff.status, 200);

    const secondHandoff = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${first.token}`,
      },
      body: JSON.stringify({ toParticipantId: second.id }),
    });

    assert.equal(secondHandoff.status, 200);

    // The very first host token, having already handed off, is now an editor
    // and lacks the "transfer" capability outright — refused by the same
    // capability gate every other owner-only route goes through, before the
    // handler's own `transferOwnership` check would even run.
    const staleHandoff = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: first.id }),
    });

    assert.equal(staleHandoff.status, 403);
  });
});

test("handoff and control requests on an unknown session 404", async () => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    const handoff = await fetch(`${server.url}/sessions/nope/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: "whoever" }),
    });

    assert.equal(handoff.status, 404);

    const controlRequest = await fetch(`${server.url}/sessions/nope/control/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });

    assert.equal(controlRequest.status, 404);
  } finally {
    await server.close();
  }
});
