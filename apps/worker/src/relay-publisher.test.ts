import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { InMemorySessionEventStore } from "@novus/session-service";

import { createRedactor } from "./redaction.ts";
import { publishToRelay } from "./relay-publisher.ts";

const SESSION = "published-session";
const KEY = "sk-ant-api03-ZxQwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefGH";

/** A socket that records what was sent, and can be opened and closed at will. */
const fakeSocket = () => {
  const sent: string[] = [];
  const listeners = new Map<string, () => void>();
  const socket = {
    readyState: 0,
    send: (data: string) => sent.push(data),
    close: () => {
      socket.readyState = 3;
      listeners.get("close")?.();
    },
    addEventListener: (name: string, handler: () => void) => {
      listeners.set(name, handler);
    },
  };

  return {
    sent,
    socket: socket as unknown as WebSocket,
    open: () => {
      socket.readyState = 1;
      listeners.get("open")?.();
    },
    drop: () => {
      socket.readyState = 3;
      listeners.get("close")?.();
    },
  };
};

const progress = (message: string) => ({
  sessionId: SESSION,
  actorId: "agent-1",
  type: "run.progress" as const,
  payload: { runId: "run-1", message },
});

test("events reach the relay once it is connected", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => fake.socket,
  });

  fake.open();
  store.append(progress("hello"));
  await delay(10);

  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0] ?? "", /hello/);
  publisher.close();
});

test("events queue while disconnected and go out on reconnect", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => fake.socket,
  });

  // Published before the socket ever opened. A relay that is slow to come up
  // must not lose the beginning of a run.
  store.append(progress("before"));
  await delay(10);
  assert.equal(fake.sent.length, 0);

  fake.open();
  await delay(10);

  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0] ?? "", /before/);
  publisher.close();
});

test("a relay that is down does not stop the run", async () => {
  const store = new InMemorySessionEventStore();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => {
      throw new Error("relay unreachable");
    },
  });

  // The host's log is the source of truth; the shared copy is a projection of
  // it. Appending must work whether or not anyone is watching.
  assert.doesNotThrow(() => store.append(progress("still running")));
  assert.equal(store.list(SESSION).length, 1);
  publisher.close();
});

test("what leaves is redacted, even though the store's copy is not", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: { ANTHROPIC_API_KEY: KEY } }),
    connect: () => fake.socket,
  });

  fake.open();
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "c1",
        name: "run_command",
        output: {
          command: "printenv",
          exitCode: 0,
          timedOut: false,
          durationMs: 5,
          stdout: `ANTHROPIC_API_KEY=${KEY}`,
          stderr: "",
          truncated: false,
        },
      },
    },
  });
  await delay(10);

  // Redacted on this path specifically. Every outbound route does its own,
  // because a route that assumed someone else had is the leak.
  assert.doesNotMatch(fake.sent[0] ?? "", new RegExp(KEY));
  assert.match(JSON.stringify(store.list(SESSION)), new RegExp(KEY));
  publisher.close();
});

test("a full queue drops events and says how many", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    maxQueued: 2,
    connect: () => fake.socket,
  });

  store.append(progress("one"));
  store.append(progress("two"));
  store.append(progress("three"));
  await delay(10);

  // The run continues and the gap is admitted, rather than the run being
  // sacrificed to preserve a shared copy nobody is reading.
  assert.equal(publisher.dropped(), 1);
  assert.equal(store.list(SESSION).length, 3);
  publisher.close();
});

test("only the session this publisher carries goes out", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => fake.socket,
  });

  fake.open();
  store.append(progress("mine"));
  store.append({
    sessionId: "somebody-elses-session",
    actorId: "agent-1",
    type: "run.progress",
    payload: { runId: "run-2", message: "theirs" },
  });
  await delay(10);

  // The store's subscribe is process-wide and a worker hosts many sessions.
  // One relay token authorises one session, so an unfiltered publisher sent a
  // guest somebody else's repository.
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0] ?? "", /mine/);
  assert.doesNotMatch(fake.sent[0] ?? "", /theirs/);
  publisher.close();
});

test("a file the agent read does not leave the host", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => fake.socket,
  });

  fake.open();
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "c1",
        name: "read_file",
        output: {
          path: "src/private.ts",
          content: "const companySecretAlgorithm = 42;",
        },
      },
    },
  });
  await delay(10);

  // Redaction removes secrets; it does not decide whether source may leave.
  // V1 says source stays local, and the file's contents are the repository.
  assert.doesNotMatch(fake.sent[0] ?? "", /companySecretAlgorithm/);
  // The path stays, because what the agent looked at is what a reviewer follows.
  assert.match(fake.sent[0] ?? "", /src\/private\.ts/);
  publisher.close();
});

test("the host's own filesystem path does not leave with the session", async () => {
  const store = new InMemorySessionEventStore();
  const fake = fakeSocket();
  const publisher = publishToRelay(store, {
    url: "ws://relay.test",
    token: "publish-token",
    sessionId: SESSION,
    redactor: createRedactor({ environment: {} }),
    connect: () => fake.socket,
  });

  fake.open();
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "session.created",
    payload: {
      session: {
        id: SESSION,
        repositoryPath: "/Users/someone/private/work",
        goal: "Fix the thing",
        status: "active",
        createdAt: new Date().toISOString(),
      },
    },
  });
  await delay(10);

  assert.doesNotMatch(fake.sent[0] ?? "", /Users\/someone/);
  assert.match(fake.sent[0] ?? "", /Fix the thing/);
  publisher.close();
});
