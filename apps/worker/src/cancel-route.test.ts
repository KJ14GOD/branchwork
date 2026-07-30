import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const TOKEN = "cancel-route-token-abcdefghijklmnopqr";

/** An adapter that never answers, so a run stays genuinely in flight. */
const hangingAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const withRunningSession = async (
  run: (context: { url: string; sessionId: string; runId: string }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(hangingAdapter.selection),
    [hangingAdapter],
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

    // Not awaited: the adapter never resolves, so the turn stays running for
    // as long as this test needs it to.
    void fetch(`${server.url}/sessions/${created.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ goal: "Do something that never finishes" }),
    });

    // Give the turn a moment to append run.started before the test acts.
    let runId: string | null = null;

    for (let attempt = 0; attempt < 50 && runId === null; attempt += 1) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));

      const events = store.list(created.id);
      const started = events.find((event) => event.type === "run.started");

      if (started?.type === "run.started") {
        runId = started.payload.run.id;
      }
    }

    assert.ok(runId, "the run never started");

    await run({ url: server.url, sessionId: created.id, runId: runId! });
  } finally {
    await server.close();
  }
};

test("cancelling a run requires the token", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 401);
  });
});

test("a viewer cannot cancel a run", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    // Mint a viewer token for this same session through the running server.
    const invited = (await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "Watcher", role: "viewer" }),
    }).then((response) => response.json())) as { token: string };

    const response = await fetch(`${url}/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${invited.token}`,
      },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 403);
  });
});

test("cancelling requests a stop and the run loop records it", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as { accepted: boolean };
    assert.equal(body.accepted, true);
  });
});

test("cancelling an unknown or already-finished run is refused", async () => {
  await withRunningSession(async ({ url, sessionId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId: "not-a-real-run" }),
    });

    assert.equal(response.status, 409);
  });
});

test("cancelling on an unknown session 404s", async () => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(hangingAdapter.selection),
    [hangingAdapter],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    const response = await fetch(`${server.url}/sessions/nope/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId: "whatever" }),
    });

    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
