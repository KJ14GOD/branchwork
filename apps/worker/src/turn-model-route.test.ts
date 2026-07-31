import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter, type ModelResponse } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * The composer's model picker, over the wire.
 *
 * `POST /turns` accepts an optional `model`, and the rule it has to enforce
 * is precedence: a human's explicit pick beats the router outright. Getting
 * that backwards would be invisible in the UI — the run would simply be on a
 * model nobody asked for — so it is checked here rather than trusted.
 *
 * The second case is the one that motivated validating at the route at all: a
 * model this worker has no adapter for used to be accepted, start a run, and
 * die inside the loop with "No model adapter is configured", leaving a failed
 * run in the log for what is really a malformed request.
 */

const TOKEN = "turn-model-route-token-abcdefghij";

/** Records which selection it was constructed for when asked to complete. */
const recordingAdapter = (
  model: string,
  seen: string[],
): ModelAdapter => ({
  selection: { provider: "anthropic", model },
  complete: async (): Promise<ModelResponse> => {
    seen.push(model);

    return { type: "final", summary: `Answered by ${model}.` };
  },
});

const withServer = async (
  run: (context: { url: string; sessionId: string; seen: string[] }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const seen: string[] = [];
  // Two adapters, so "which one ran" is a real question rather than the only
  // possible answer. The router is pinned to the first; the picker asks for
  // the second.
  const adapters = [
    recordingAdapter("claude-opus-5", seen),
    recordingAdapter("claude-sonnet-5", seen),
  ];
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(adapters[0]!.selection),
    adapters,
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

    await run({ url: server.url, sessionId: created.id, seen });
  } finally {
    await server.close();
  }
};

const settle = async (store: () => number, target: number): Promise<void> => {
  for (let attempt = 0; attempt < 100 && store() < target; attempt += 1) {
    await new Promise((wake) => setTimeout(wake, 20));
  }
};

test("an explicit model choice beats the router", async () => {
  await withServer(async ({ url, sessionId, seen }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        goal: "Explain this repository",
        model: { provider: "anthropic", model: "claude-sonnet-5" },
      }),
    });

    assert.equal(response.status, 202);

    await settle(() => seen.length, 1);

    // The router is pinned to opus. The pick asked for sonnet, and the pick
    // is what has to win — a human naming a model is an instruction, not a
    // hint the router gets to weigh.
    assert.deepEqual(seen, ["claude-sonnet-5"]);
  });
});

test("no explicit choice leaves the routing to the router", async () => {
  await withServer(async ({ url, sessionId, seen }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ goal: "Explain this repository" }),
    });

    assert.equal(response.status, 202);

    await settle(() => seen.length, 1);

    assert.deepEqual(seen, ["claude-opus-5"]);
  });
});

test("a model this worker cannot serve is refused before a run starts", async () => {
  await withServer(async ({ url, sessionId, seen }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        goal: "Explain this repository",
        model: { provider: "anthropic", model: "claude-not-a-real-model" },
      }),
    });

    assert.equal(response.status, 400);

    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /no adapter for anthropic\/claude-not-a-real-model/i);

    // And crucially nothing ran. Accepting this used to mean a run that
    // started, reached the model call, and failed there — a failed run on
    // the record for a request that was never valid.
    await new Promise((wake) => setTimeout(wake, 100));
    assert.deepEqual(seen, []);
  });
});
