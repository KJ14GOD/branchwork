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

test("a dev server's output does not leave the host; its lifecycle does", async () => {
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
        name: "dev_server",
        output: {
          action: "start",
          serverId: "server-1",
          command: "node server.js",
          port: 4950,
          pid: 4242,
          state: "listening",
          exitCode: null,
          logs: "Loaded fixture user secretCompanyCustomer from db\n",
        },
      },
    },
  });
  await delay(10);

  // Server logs are raw process output — repository content by another name,
  // the same class of thing run_command's stdout is. The shareable boundary
  // was a fallthrough for tool names it did not know, so a new tool's output
  // crossed verbatim until it was decided here.
  assert.doesNotMatch(fake.sent[0] ?? "", /secretCompanyCustomer/);
  // The lifecycle is what a teammate follows: which server, whether it came
  // up, on which port.
  assert.match(fake.sent[0] ?? "", /listening/);
  assert.match(fake.sent[0] ?? "", /4950/);
  publisher.close();
});

test("diagnostics cross as structure; the checker's transcript stays home", async () => {
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
        name: "run_diagnostics",
        output: {
          kind: "typecheck",
          command: "npm run typecheck",
          exitCode: 2,
          timedOut: false,
          durationMs: 900,
          ok: false,
          diagnostics: [
            {
              path: "src/auth.ts",
              line: 41,
              column: 7,
              severity: "error",
              message: "Type 'string' is not assignable to type 'number'.",
              code: "TS2322",
            },
          ],
          diagnosticsTruncated: false,
          raw: "src/auth.ts(41,7): error TS2322 ... const internalRefreshSecretPath = ...",
          rawTruncated: false,
        },
      },
    },
  });
  await delay(10);

  // V1's compare screen names diagnostics as evidence a reviewer needs, so
  // the structured list crosses. The raw transcript is command output that
  // can quote source — a checker echoing the offending line is normal — and
  // stays on the host like every other transcript.
  assert.match(fake.sent[0] ?? "", /TS2322/);
  assert.match(fake.sent[0] ?? "", /src\/auth\.ts/);
  assert.doesNotMatch(fake.sent[0] ?? "", /internalRefreshSecretPath/);
  publisher.close();
});

test("git_branches shares branch names but not the host's worktree paths", async () => {
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
        name: "git_branches",
        output: {
          current: "main",
          branches: [
            {
              name: "main",
              isCurrent: true,
              revision: "abc1234",
              subject: "initial",
              upstream: null,
            },
          ],
          worktrees: [
            {
              path: "/Users/someone/private/work",
              branch: "main",
              revision: "abc1234deadbeef",
              isCurrent: true,
            },
          ],
          truncated: false,
        },
      },
    },
  });
  await delay(10);

  // A worktree path is the host's filesystem — the same fact fork.created's
  // worktreePath already withholds, and it must not re-enter through a
  // different tool's output.
  assert.doesNotMatch(fake.sent[0] ?? "", /Users\/someone/);
  assert.match(fake.sent[0] ?? "", /main/);
  publisher.close();
});
