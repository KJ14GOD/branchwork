import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const TOKEN = "pause-resume-route-token-abcdefghijkl";

/** An adapter that never answers, so a run stays genuinely in flight. */
const hangingAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const withRunningSession = async (
  run: (context: {
    url: string;
    sessionId: string;
    runId: string;
    store: InMemorySessionEventStore;
  }) => Promise<void>,
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

    // Not awaited: the adapter never resolves, so the turn stays running.
    void fetch(`${server.url}/sessions/${created.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ goal: "Do something that never finishes" }),
    });

    let runId: string | null = null;

    for (let attempt = 0; attempt < 50 && runId === null; attempt += 1) {
      await delay(10);

      const started = store
        .list(created.id)
        .find((event) => event.type === "run.started");

      if (started?.type === "run.started") {
        runId = started.payload.run.id;
      }
    }

    assert.ok(runId, "the run never started");

    await run({ url: server.url, sessionId: created.id, runId: runId!, store });
  } finally {
    await server.close();
  }
};

test("pausing a run requires the token", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 401);
  });
});

test("a viewer cannot pause or resume a run", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const invited = (await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "Watcher", role: "viewer" }),
    }).then((response) => response.json())) as { token: string };

    for (const route of ["pause", "resume"]) {
      const response = await fetch(`${url}/sessions/${sessionId}/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${invited.token}`,
        },
        body: JSON.stringify({ runId }),
      });

      assert.equal(response.status, 403, `expected 403 from /${route}`);
    }
  });
});

test("pausing requests a suspension and the run loop records it", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as { accepted: boolean };
    assert.equal(body.accepted, true);
  });
});

test("pausing an unknown or already-finished run is refused", async () => {
  await withRunningSession(async ({ url, sessionId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId: "not-a-real-run" }),
    });

    assert.equal(response.status, 409);
  });
});

test("pausing a run twice in a row is refused the second time", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const first = await fetch(`${url}/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(first.status, 202);

    const second = await fetch(`${url}/sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(second.status, 409);
  });
});

test("resuming a run that was never paused is refused", async () => {
  await withRunningSession(async ({ url, sessionId, runId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 409);
  });
});

test("resuming an actually-paused run restarts the loop, which records run.resumed", async () => {
  // Deliberately not `withRunningSession`: that harness's session already has
  // a turn permanently stuck inside the hanging adapter's unresolved
  // `complete()`, which occupies `session.queue` forever — anything chained
  // onto it, resume included, would never run regardless of what the log
  // says. This test needs a session whose queue was never touched by a real
  // turn, so the resume this test issues is the first thing waiting on it.
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

    const runId = "hand-crafted-run-1";

    // Set up the paused precondition directly on the log, the way the run
    // loop itself would have left it — same events, same shape, just not
    // reached by a real turn. `resumeTurn` reads the log, not memory, and
    // AgentRunner.resume only needs a model matching a configured adapter.
    store.append({
      sessionId: created.id,
      actorId: "agent-1",
      type: "run.started",
      payload: {
        run: {
          id: runId,
          sessionId: created.id,
          goal: "Do something",
          status: "running",
          startedBy: "agent-1",
          model: hangingAdapter.selection,
          createdAt: new Date().toISOString(),
        },
      },
    });
    store.append({
      sessionId: created.id,
      actorId: "agent-1",
      type: "run.paused",
      payload: { runId },
    });

    const response = await fetch(`${server.url}/sessions/${created.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId }),
    });

    assert.equal(response.status, 202);

    let resumed = false;

    for (let attempt = 0; attempt < 50 && !resumed; attempt += 1) {
      await delay(10);
      resumed = store
        .list(created.id)
        .some((event) => event.type === "run.resumed");
    }

    assert.ok(resumed, "the run loop never recorded run.resumed");
  } finally {
    await server.close();
  }
});

test("pausing or resuming on an unknown session 404s", async () => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(hangingAdapter.selection),
    [hangingAdapter],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    for (const route of ["pause", "resume"]) {
      const response = await fetch(`${server.url}/sessions/nope/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId: "whatever" }),
      });

      assert.equal(response.status, 404, `expected 404 from /${route}`);
    }
  } finally {
    await server.close();
  }
});
