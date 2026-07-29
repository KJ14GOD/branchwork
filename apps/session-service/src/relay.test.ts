import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { SessionEvent, SessionEventDraft } from "@novus/contracts";

import { fixedTokens, startRelay, type Relay } from "./relay.ts";

const SESSION = "shared-session";
const PUBLISH = "publish-token-abcdefghijklmnop";
const WATCH = "watch-token-abcdefghijklmnopq";

const progress = (message: string, sequence: number) => ({
  eventId: `event-${message}`,
  sessionId: SESSION,
  sequence,
  actorId: "agent-1",
  occurredAt: new Date().toISOString(),
  type: "run.progress" as const,
  payload: { runId: "run-1", message },
});

const withRelay = async (run: (relay: Relay) => Promise<void>): Promise<void> => {
  const relay = await startRelay({
    authorize: fixedTokens(SESSION, PUBLISH, WATCH),
  });

  try {
    await run(relay);
  } finally {
    await relay.close();
  }
};

type Client = {
  frames: SessionEvent[];
  settled(count: number): Promise<void>;
  close(): void;
};

const connect = async (
  url: string,
  token: string,
  intent: "publish" | "watch",
  since?: number,
): Promise<Client & { send(draft: unknown): void }> => {
  const query = since === undefined ? "" : `&since=${since}`;
  const socket = new WebSocket(`${url}/?token=${token}&intent=${intent}${query}`);
  const frames: SessionEvent[] = [];

  socket.addEventListener("message", (message) => {
    const parsed = JSON.parse((message as MessageEvent<string>).data);

    if (!parsed.error) {
      frames.push(parsed as SessionEvent);
    }
  });

  await new Promise<void>((settle, fail) => {
    socket.addEventListener("open", () => settle());
    socket.addEventListener("error", () => fail(new Error("refused")));
  });

  return {
    frames,
    send: (draft: unknown) => socket.send(JSON.stringify(draft)),
    async settled(count: number) {
      for (let waited = 0; waited < 200 && frames.length < count; waited += 1) {
        await delay(10);
      }
      assert.ok(
        frames.length >= count,
        `expected ${count} frames, saw ${frames.length}`,
      );
    },
    close: () => socket.close(),
  };
};

test("a guest receives what the worker publishes", async () => {
  await withRelay(async (relay) => {
    const worker = await connect(relay.url, PUBLISH, "publish");
    const guest = await connect(relay.url, WATCH, "watch", 0);

    worker.send(progress("first", 0));
    await guest.settled(1);

    assert.equal(guest.frames[0]?.type, "run.progress");
    worker.close();
    guest.close();
  });
});

test("the relay assigns order, not the worker", async () => {
  await withRelay(async (relay) => {
    const worker = await connect(relay.url, PUBLISH, "publish");
    const guest = await connect(relay.url, WATCH, "watch", 0);

    // A worker that reconnects and republishes, or two workers on one session,
    // must not decide what order a guest sees. V1: the server assigns sequence
    // numbers and server-confirmed order is canonical.
    worker.send(progress("a", 99));
    worker.send(progress("b", 7));
    worker.send(progress("c", 41));
    await guest.settled(3);

    assert.deepEqual(
      guest.frames.map((event) => event.sequence),
      [0, 1, 2],
    );
    worker.close();
    guest.close();
  });
});

test("a late joiner holds the same log as one present throughout", async () => {
  await withRelay(async (relay) => {
    const worker = await connect(relay.url, PUBLISH, "publish");
    const early = await connect(relay.url, WATCH, "watch", 0);

    worker.send(progress("one", 0));
    worker.send(progress("two", 1));
    await early.settled(2);

    const late = await connect(relay.url, WATCH, "watch", 0);
    await late.settled(2);

    worker.send(progress("three", 2));
    await early.settled(3);
    await late.settled(3);

    // The property that makes this a shared session rather than two people
    // watching different things.
    assert.deepEqual(
      early.frames.map((event) => event.payload),
      late.frames.map((event) => event.payload),
    );
    worker.close();
    early.close();
    late.close();
  });
});

test("resuming by sequence loses nothing and repeats nothing", async () => {
  await withRelay(async (relay) => {
    const worker = await connect(relay.url, PUBLISH, "publish");
    const first = await connect(relay.url, WATCH, "watch", 0);

    worker.send(progress("one", 0));
    worker.send(progress("two", 1));
    await first.settled(2);
    first.close();

    // Events published while nobody was listening.
    worker.send(progress("three", 2));
    worker.send(progress("four", 3));
    await delay(50);

    const resumed = await connect(relay.url, WATCH, "watch", 2);
    await resumed.settled(2);

    assert.deepEqual(
      resumed.frames.map((event) => event.sequence),
      [2, 3],
    );
    worker.close();
    resumed.close();
  });
});

test("an unauthenticated connection is refused during the handshake", async () => {
  await withRelay(async (relay) => {
    await assert.rejects(() => connect(relay.url, "not-a-token", "watch"));
  });
});

test("a watch token cannot publish", async () => {
  await withRelay(async (relay) => {
    // Roles are the point of having two tokens. A guest holding the watch
    // token must not be able to write into the session everyone is reading.
    await assert.rejects(() => connect(relay.url, WATCH, "publish"));
  });
});

test("an event the contract rejects never reaches a guest", async () => {
  await withRelay(async (relay) => {
    const worker = await connect(relay.url, PUBLISH, "publish");
    const guest = await connect(relay.url, WATCH, "watch", 0);

    worker.send({ type: "not.an.event", payload: {} });
    worker.send(progress("valid", 0));
    await guest.settled(1);

    // The worker is trusted to be the host, not trusted to be correct.
    assert.equal(guest.frames.length, 1);
    assert.equal(relay.history(SESSION).length, 1);
    worker.close();
    guest.close();
  });
});

test("sessions do not leak into one another", async () => {
  const relay = await startRelay({
    authorize: (token, intent) => {
      if (token === "a-publish" && intent === "publish") return "session-a";
      if (token === "b-watch" && intent === "watch") return "session-b";

      return null;
    },
  });

  try {
    const workerA = await connect(relay.url, "a-publish", "publish");
    const guestB = await connect(relay.url, "b-watch", "watch", 0);

    workerA.send({ ...progress("private", 0), sessionId: "session-a" });
    await delay(80);

    assert.equal(guestB.frames.length, 0);
    workerA.close();
    guestB.close();
  } finally {
    await relay.close();
  }
});
