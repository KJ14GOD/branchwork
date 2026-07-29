import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";

import { watchRelay } from "./relay-client.ts";

const event = (sequence: number, message: string) => ({
  eventId: `event-${sequence}`,
  sessionId: "shared",
  sequence,
  actorId: "agent-1",
  occurredAt: new Date().toISOString(),
  type: "run.progress",
  payload: { runId: "run-1", message },
});

/** A socket whose lifecycle the test drives. */
const fakeSocket = () => {
  const listeners = new Map<string, (payload?: unknown) => void>();
  const socket = {
    close: () => listeners.get("close")?.(),
    addEventListener: (name: string, handler: (payload?: unknown) => void) => {
      listeners.set(name, handler);
    },
  };

  return {
    socket: socket as unknown as WebSocket,
    url: "",
    open: () => listeners.get("open")?.(),
    deliver: (payload: unknown) =>
      listeners.get("message")?.({ data: JSON.stringify(payload) }),
    drop: () => listeners.get("close")?.(),
  };
};

const collect = () => {
  const events: SessionEvent[] = [];
  const refusals: string[] = [];
  const closures: string[] = [];
  let opened = 0;

  return {
    events,
    refusals,
    closures,
    opened: () => opened,
    handlers: {
      onEvent: (received: SessionEvent) => events.push(received),
      onOpen: () => {
        opened += 1;
      },
      onClosed: (reason: string) => closures.push(reason),
      onRefused: (reason: string) => refusals.push(reason),
    },
  };
};

test("events from the relay reach the timeline", () => {
  const fake = fakeSocket();
  const sink = collect();

  watchRelay(
    { relay: "wss://relay.example.com", token: "t", since: 0, connect: () => fake.socket },
    sink.handlers,
  );

  fake.open();
  fake.deliver(event(0, "first"));
  fake.deliver(event(1, "second"));

  assert.equal(sink.opened(), 1);
  assert.deepEqual(
    sink.events.map((received) => received.sequence),
    [0, 1],
  );
});

test("a frame the contract rejects never reaches the timeline", () => {
  const fake = fakeSocket();
  const sink = collect();

  watchRelay(
    { relay: "wss://relay.example.com", token: "t", since: 0, connect: () => fake.socket },
    sink.handlers,
  );

  fake.open();
  fake.deliver({ type: "not.an.event", payload: {} });
  fake.deliver("plain text, not even JSON");
  fake.deliver(event(0, "valid"));

  // A relay is another party's server. A frame this client cannot parse is one
  // the timeline would draw as a half-known row.
  assert.equal(sink.events.length, 1);
});

test("a refused relay address is never contacted", () => {
  const sink = collect();
  let dialled = 0;

  watchRelay(
    {
      relay: "ws://relay.example.com",
      token: "t",
      since: 0,
      connect: () => {
        dialled += 1;

        return fakeSocket().socket;
      },
    },
    sink.handlers,
  );

  // Plaintext off this machine. The refusal has to happen before a socket, or
  // the leak has already occurred by the time it is reported.
  assert.equal(dialled, 0);
  assert.equal(sink.refusals.length, 1);
  assert.match(sink.refusals[0] ?? "", /wss:\/\//);
});

test("resumption asks for the next unseen sequence", () => {
  let requested = "";
  const fake = fakeSocket();

  watchRelay(
    {
      relay: "wss://relay.example.com",
      token: "t",
      since: 7,
      connect: (url) => {
        requested = url;

        return fake.socket;
      },
    },
    collect().handlers,
  );

  assert.match(requested, /since=7/);
  assert.match(requested, /intent=watch/);
});

test("a dropped relay is reported rather than retried in silence", () => {
  const fake = fakeSocket();
  const sink = collect();

  watchRelay(
    { relay: "wss://relay.example.com", token: "t", since: 0, connect: () => fake.socket },
    sink.handlers,
  );

  fake.open();
  fake.drop();

  // The relay refuses an unauthorised connection during the handshake, so a
  // socket that opened and then closed is a relay that went away — the message
  // must not send someone hunting for a token problem.
  assert.equal(sink.closures.length, 1);
  assert.doesNotMatch(sink.closures[0] ?? "", /token/i);
});

test("closing stops reporting", () => {
  const fake = fakeSocket();
  const sink = collect();

  const connection = watchRelay(
    { relay: "wss://relay.example.com", token: "t", since: 0, connect: () => fake.socket },
    sink.handlers,
  );

  connection.close();
  fake.deliver(event(0, "after close"));

  assert.equal(sink.events.length, 0);
  assert.equal(sink.closures.length, 0);
});
