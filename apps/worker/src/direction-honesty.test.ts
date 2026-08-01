import assert from "node:assert/strict";
import test from "node:test";

import type { HarnessDescriptor, SessionEvent } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * What `POST /direction` promises, and to which harness.
 *
 * `direction.queued` means *this execution* will read the words at its next
 * turn boundary. Only Novus's own loop keeps that promise —
 * `AgentRunner.drainDirection` is the sole emitter of `direction.applied` —
 * and the route decided by asking whether anything was running at all. So a
 * direction typed into a Claude Code mission, which is the golden scenario,
 * sat queued against a run containing no direction code, forever.
 *
 * These tests are the difference between the two promises, driven over HTTP
 * against a real store. The run is appended to the log directly rather than
 * executed: what decides the answer is what `run.started` declares, which is
 * exactly the thing an external adapter writes and the built-in loop omits.
 */

const TOKEN = "direction-honesty-token-abcdefghijkl";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const CLAUDE_CODE: HarnessDescriptor = {
  kind: "claude-code",
  id: "claude-code",
  version: "1.0.0",
  command: "claude",
  capabilities: {
    pause: "none",
    // The field this whole file turns on.
    steer: "next-run",
    toolVisibility: "named",
    fileChanges: "observed",
    approvals: "harness-internal",
    usage: "totals",
    cost: "reported",
    cancel: "kill",
    reportsModel: true,
  },
};

const withSession = async (
  run: (context: {
    url: string;
    store: InMemorySessionEventStore;
    sessionId: string;
  }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const server = await startEventServer(store, {
    port: 0,
    token: TOKEN,
    sessions,
  });

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    await run({ url: server.url, store, sessionId: created.id });
  } finally {
    await server.close();
  }
};

/**
 * A live run on the log. `harness` omitted is the built-in loop — only
 * `AgentRunner` appends `run.started` without a descriptor, and it is the
 * thing that drains direction.
 */
const startedRun = (
  sessionId: string,
  runId: string,
  harness?: HarnessDescriptor,
) => ({
  sessionId,
  actorId: "agent-1",
  type: "run.started" as const,
  payload: {
    run: {
      id: runId,
      sessionId,
      goal: "Fix the rounding bug.",
      status: "running" as const,
      startedBy: "agent-1",
      model: { provider: "anthropic", model: "test" },
      ...(harness ? { harness } : {}),
      createdAt: new Date().toISOString(),
    },
  },
});

const direct = (
  url: string,
  sessionId: string,
  goal: string,
): Promise<Response> =>
  fetch(`${url}/sessions/${sessionId}/direction`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ goal }),
  });

const typesIn = (
  store: InMemorySessionEventStore,
  sessionId: string,
  type: SessionEvent["type"],
): SessionEvent[] =>
  store.list(sessionId).filter((event) => event.type === type);

test("the built-in loop is queued, because it folds direction into the run in flight", async () => {
  await withSession(async ({ url, store, sessionId }) => {
    store.append(startedRun(sessionId, "run-1"));

    const response = await direct(url, sessionId, "prefer the smaller change");

    assert.equal(response.status, 202);
    assert.equal(
      ((await response.json()) as { queuedForRunId: string | null })
        .queuedForRunId,
      "run-1",
    );
    assert.equal(typesIn(store, sessionId, "direction.queued").length, 1);
    assert.equal(typesIn(store, sessionId, "harness.unsupported").length, 0);
  });
});

test("a harness that cannot steer is not queued, and says so on the log", async () => {
  await withSession(async ({ url, store, sessionId }) => {
    store.append(startedRun(sessionId, "run-1", CLAUDE_CODE));

    const response = await direct(url, sessionId, "prefer the smaller change");

    assert.equal(response.status, 202);
    // Recorded either way — the words are kept and become the next thing the
    // harness is asked.
    assert.equal(typesIn(store, sessionId, "direction.submitted").length, 1);

    // But never promised to a run that will not read it.
    assert.equal(
      ((await response.json()) as { queuedForRunId: string | null })
        .queuedForRunId,
      null,
    );
    assert.equal(typesIn(store, sessionId, "direction.queued").length, 0);

    const [refusal] = typesIn(store, sessionId, "harness.unsupported");

    assert.ok(refusal && refusal.type === "harness.unsupported");
    assert.equal(refusal.payload.requested, "steer");
    assert.equal(refusal.payload.runId, "run-1");
    // Silence would be indistinguishable from a steer that worked, which is
    // the entire reason this event family exists.
    assert.match(refusal.payload.reason, /next thing it is asked/);
  });
});

test("nothing running is recorded and refuses nothing — there is no harness to refuse", async () => {
  await withSession(async ({ url, store, sessionId }) => {
    const response = await direct(url, sessionId, "start with the tests");

    assert.equal(response.status, 202);
    assert.equal(typesIn(store, sessionId, "direction.queued").length, 0);
    // An idle session has no harness in flight, so there is no unsupported
    // control to report: "waits for whatever runs next" is already the honest
    // reading of a bare `direction.submitted`.
    assert.equal(typesIn(store, sessionId, "harness.unsupported").length, 0);
  });
});

test("a submitted direction names a run, not the session it was typed in", async () => {
  await withSession(async ({ url, store, sessionId }) => {
    store.append(startedRun(sessionId, "run-1"));
    await direct(url, sessionId, "prefer the smaller change");

    const [submitted] = typesIn(store, sessionId, "direction.submitted");

    assert.ok(submitted && submitted.type === "direction.submitted");
    // A session id in a field called runId is a claim about a run that does
    // not exist, and every log written before this fix carries one.
    assert.equal(submitted.payload.runId, "run-1");
    assert.notEqual(submitted.payload.runId, sessionId);
  });
});
