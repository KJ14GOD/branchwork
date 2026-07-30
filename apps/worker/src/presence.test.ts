import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * Live presence: who has an open stream right now, distinct from
 * `participant.joined` in the log, which only ever says who was invited.
 *
 * Opening `/events` and closing it is what flips this — no run needs to be in
 * flight for presence to be meaningful, so these tests never start a turn.
 */

const TOKEN = "presence-test-token-abcdefghijklmnopqrst";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

type Presence = {
  participants: { id: string; name: string; role: string; connected: boolean }[];
};

const readPresence = async (url: string, sessionId: string): Promise<Presence> => {
  const response = await fetch(`${url}/sessions/${sessionId}/presence`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.status, 200);

  return (await response.json()) as Presence;
};

/** Opens an SSE stream and returns a way to close it again. */
const watch = (
  url: string,
  sessionId: string,
  token: string,
): { close: () => void } => {
  const controller = new AbortController();

  void fetch(`${url}/events?session=${sessionId}`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {
    // Aborting rejects the fetch itself; that is how this test closes the
    // stream, not a failure to report.
  });

  return { close: () => controller.abort() };
};

const withSession = async (
  run: (context: {
    url: string;
    sessionId: string;
    participants: ParticipantRegistry;
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

    await run({ url: server.url, sessionId: created.id, participants });
  } finally {
    await server.close();
  }
};

test("presence on an unknown session 404s", async () => {
  await withSession(async ({ url }) => {
    const response = await fetch(`${url}/sessions/nope/presence`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 404);
  });
});

test("the host is in the roster but not connected before opening a stream", async () => {
  await withSession(async ({ url, sessionId }) => {
    const presence = await readPresence(url, sessionId);

    assert.equal(presence.participants.length, 1);
    assert.equal(presence.participants[0]?.role, "owner");
    assert.equal(presence.participants[0]?.connected, false);
  });
});

test("opening and closing the event stream flips presence live and back", async () => {
  await withSession(async ({ url, sessionId }) => {
    const stream = watch(url, sessionId, TOKEN);

    let connected = false;

    for (let attempt = 0; attempt < 50 && !connected; attempt += 1) {
      await delay(10);
      const presence = await readPresence(url, sessionId);
      connected = presence.participants[0]?.connected === true;
    }

    assert.ok(connected, "the host never showed as connected");

    stream.close();

    let disconnected = false;

    for (let attempt = 0; attempt < 50 && !disconnected; attempt += 1) {
      await delay(10);
      const presence = await readPresence(url, sessionId);
      disconnected = presence.participants[0]?.connected === false;
    }

    assert.ok(disconnected, "the host never showed as disconnected after closing");
  });
});

test("an invited participant appears in presence once they connect, separately from the host", async () => {
  await withSession(async ({ url, sessionId }) => {
    const invited = (await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "Reviewer", role: "reviewer" }),
    }).then((response) => response.json())) as { token: string; participant: { id: string } };

    const stream = watch(url, sessionId, invited.token);

    let reviewerConnected = false;

    for (let attempt = 0; attempt < 50 && !reviewerConnected; attempt += 1) {
      await delay(10);
      const presence = await readPresence(url, sessionId);
      const reviewer = presence.participants.find(
        (entry) => entry.id === invited.participant.id,
      );

      reviewerConnected = reviewer?.connected === true;

      if (reviewerConnected) {
        // The host's own stream was never opened in this test — presence must
        // not conflate "in the roster" with "connected" for anyone else either.
        const host = presence.participants.find((entry) => entry.role === "owner");
        assert.equal(host?.connected, false);
      }
    }

    assert.ok(reviewerConnected, "the invited reviewer never showed as connected");

    stream.close();
  });
});

test("presence requires participants to be configured", async () => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    const response = await fetch(`${server.url}/sessions/${created.id}/presence`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
