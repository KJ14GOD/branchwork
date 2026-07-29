import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { SessionEvent, SessionEventDraft } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { startEventServer } from "./event-server.ts";
import { createRedactor } from "./redaction.ts";

/**
 * Milestone 5: reconnect and resume, and multi-client end-to-end.
 *
 * These drive the real SSE endpoint over a real socket with a real store. What
 * is being proved is not that a handler was called but that a client which
 * drops and comes back holds the same log as one that never left — every event
 * once, in order, with nothing invented in the gap.
 *
 * The redactor is seeded from an empty environment rather than from
 * `process.env`, so the assertions compare the events the store recorded rather
 * than whatever the machine running the suite happens to export. Redaction has
 * its own tests; this file is about delivery.
 */

const SESSION = "reconnect-session";

const progress = (message: string): SessionEventDraft => ({
  sessionId: SESSION,
  actorId: "agent-1",
  type: "run.progress",
  payload: { runId: "run-1", message },
});

type Frame = { id: number; event: SessionEvent };

type Client = {
  readonly frames: Frame[];
  /** Resolves when the server acknowledges the connection. See the last test. */
  ready(): Promise<number>;
  /** Resolves once at least `count` frames have arrived, or fails loudly. */
  settle(count: number): Promise<Frame[]>;
  ids(): number[];
  messages(): string[];
  close(): Promise<void>;
};

const ARRIVAL_TIMEOUT_MS = 5_000;

/**
 * A minimal SSE client.
 *
 * Deliberately does not await the response before returning. Connecting and
 * then appending is the ordinary shape of these tests, and awaiting the
 * response first would serialise the two. The worker now flushes its headers
 * immediately, so a connection is acknowledged before anything is written —
 * the last test in this file is what holds that.
 *
 * Frames are split on the blank line rather than counted, because a heartbeat
 * and the `unreadable` notice are also frames and neither carries data. A test
 * that counted `\n\n` would silently mistake one for an event.
 */
const connect = (
  url: string,
  options: { since?: number; lastEventId?: number } = {},
): Client => {
  const controller = new AbortController();
  const query =
    options.since === undefined ? "" : `&since=${String(options.since)}`;
  const frames: Frame[] = [];

  const opened = fetch(`${url}/events?session=${SESSION}${query}`, {
    signal: controller.signal,
    ...(options.lastEventId === undefined
      ? {}
      : { headers: { "last-event-id": String(options.lastEventId) } }),
  });

  const pump = opened
    .then(async (response) => {
      assert.equal(response.status, 200);
      assert.ok(response.body);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          return;
        }

        buffer += decoder.decode(chunk.value, { stream: true });

        for (;;) {
          const boundary = buffer.indexOf("\n\n");

          if (boundary === -1) {
            break;
          }

          const lines = buffer.slice(0, boundary).split("\n");
          buffer = buffer.slice(boundary + 2);

          const data = lines.find((line) => line.startsWith("data: "));
          const id = lines.find((line) => line.startsWith("id: "));

          if (!data) {
            continue;
          }

          frames.push({
            id: Number(id?.slice("id: ".length)),
            event: JSON.parse(data.slice("data: ".length)) as SessionEvent,
          });
        }
      }
    })
    .catch(() => {
      // Closing the client aborts the read. There is nothing to report.
    });

  return {
    frames,
    ready: () => opened.then((response) => response.status),
    async settle(count: number) {
      const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;

      while (frames.length < count) {
        if (Date.now() > deadline) {
          assert.fail(
            `only ${String(frames.length)} of ${String(count)} events arrived`,
          );
        }

        await delay(2);
      }

      // A duplicate would arrive just after the count is met, so waiting a
      // moment longer is what makes "exactly once" mean anything.
      await delay(20);

      return frames;
    },
    ids: () => frames.map((frame) => frame.id),
    messages: () =>
      frames.map((frame) =>
        frame.event.type === "run.progress"
          ? frame.event.payload.message
          : frame.event.type,
      ),
    async close() {
      controller.abort();
      await pump;
    },
  };
};

const withServer = async (
  body: (context: {
    store: InMemorySessionEventStore;
    url: string;
  }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const server = await startEventServer(store, { port: 0, token: null, redactor: createRedactor({ environment: {} }),
  });

  try {
    await body({ store, url: server.url });
  } finally {
    await server.close();
    store.close();
  }
};

test("a reconnect receives every event it missed, exactly once", async () => {
  await withServer(async ({ store, url }) => {
    for (let index = 0; index < 3; index += 1) {
      store.append(progress(`before-${String(index)}`));
    }

    const first = connect(url, { since: 0 });
    await first.settle(3);

    assert.deepEqual(first.ids(), [0, 1, 2]);

    await first.close();

    // The gap. Nothing is listening, and the log keeps growing.
    for (let index = 0; index < 4; index += 1) {
      store.append(progress(`during-${String(index)}`));
    }

    // Exactly what the guest computes in `resumeSequence`: one past the last
    // event held, because the worker treats `since` as inclusive.
    const resumeFrom = (first.frames.at(-1)?.id ?? -1) + 1;
    assert.equal(resumeFrom, 3);

    const resumed = connect(url, { since: resumeFrom });
    await resumed.settle(4);

    // And it keeps up once it is back.
    store.append(progress("after-0"));
    await resumed.settle(5);

    assert.deepEqual(resumed.ids(), [3, 4, 5, 6, 7]);
    assert.deepEqual(resumed.messages(), [
      "during-0",
      "during-1",
      "during-2",
      "during-3",
      "after-0",
    ]);

    // The point of the whole exercise: the two connections together are the
    // log, with nothing skipped between them and nothing delivered twice.
    const seen = [...first.ids(), ...resumed.ids()];
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(new Set(seen).size, seen.length);

    await resumed.close();
  });
});

test("a browser reconnect resumes from Last-Event-ID, not from the start", async () => {
  await withServer(async ({ store, url }) => {
    for (let index = 0; index < 4; index += 1) {
      store.append(progress(`event-${String(index)}`));
    }

    // What EventSource sends by itself. It names the last event the client
    // already holds, so the resume point is one past it.
    const resumed = connect(url, { lastEventId: 1 });
    await resumed.settle(2);

    assert.deepEqual(resumed.ids(), [2, 3]);
    assert.deepEqual(resumed.messages(), ["event-2", "event-3"]);

    await resumed.close();
  });
});

test("two clients on one session hold the same ordered log", async () => {
  await withServer(async ({ store, url }) => {
    // Present from before anything happened.
    const throughout = connect(url, { since: 0 });

    for (let index = 0; index < 5; index += 1) {
      store.append(progress(`early-${String(index)}`));
    }

    await throughout.settle(5);

    // Joins once the run is already under way and asks for the whole history.
    const late = connect(url, { since: 0 });
    await late.settle(5);

    for (let index = 0; index < 3; index += 1) {
      store.append(progress(`late-${String(index)}`));
    }

    await throughout.settle(8);
    await late.settle(8);

    assert.deepEqual(throughout.ids(), [0, 1, 2, 3, 4, 5, 6, 7]);
    // Identical ordering, not merely the same set: two timelines that agree on
    // membership and disagree on order are two different stories.
    assert.deepEqual(late.ids(), throughout.ids());
    // And identical content — same event ids, same payloads, same timestamps.
    assert.deepEqual(
      late.frames.map((frame) => frame.event),
      throughout.frames.map((frame) => frame.event),
    );

    await throughout.close();
    await late.close();
  });
});

test("a client that drops mid-stream misses nothing the others received", async () => {
  await withServer(async ({ store, url }) => {
    const steady = connect(url, { since: 0 });

    store.append(progress("step-0"));
    store.append(progress("step-1"));
    await steady.settle(2);

    const flaky = connect(url, { since: 0 });
    await flaky.settle(2);
    await flaky.close();

    store.append(progress("step-2"));
    store.append(progress("step-3"));
    await steady.settle(4);

    const recovered = connect(url, {
      since: (flaky.frames.at(-1)?.id ?? -1) + 1,
    });
    await recovered.settle(2);

    assert.deepEqual([...flaky.ids(), ...recovered.ids()], steady.ids());
    assert.deepEqual(
      [
        ...flaky.frames.map((frame) => frame.event),
        ...recovered.frames.map((frame) => frame.event),
      ],
      steady.frames.map((frame) => frame.event),
    );

    await steady.close();
    await recovered.close();
  });
});

/**
 * Pinning behaviour rather than endorsing it.
 *
 * `since` filters the live subscription as well as the backlog, so a client
 * that asks to resume past the end of the log is not merely given an empty
 * backlog — it stays silent until the log reaches the sequence it named. For a
 * client resuming from its own last event that is exactly right, and it is what
 * makes the reconnect above exact rather than approximate. It is worth stating
 * because it also means a client whose worker restarted against a different
 * database — sequences beginning at zero again — would sit on a connection that
 * reports itself live and never delivers anything. Nothing detects that today.
 */
test("resuming past the end of the log delivers nothing until the log arrives there", async () => {
  await withServer(async ({ store, url }) => {
    store.append(progress("only-event"));

    const ahead = connect(url, { since: 5 });

    store.append(progress("ignored-1"));
    store.append(progress("ignored-2"));
    await delay(50);

    assert.deepEqual(ahead.ids(), []);

    for (let index = 3; index <= 5; index += 1) {
      store.append(progress(`caught-up-${String(index)}`));
    }

    await ahead.settle(1);
    assert.deepEqual(ahead.ids(), [5]);

    await ahead.close();
  });
});

/**
 * The fifteen seconds a quiet session used to look dead for.
 *
 * `streamSession` writes its status line and headers through `writeHead`, and
 * Node holds those back until the first body write. A session with no backlog
 * writes nothing until its first event, so a joining client was not acknowledged
 * at all: `fetch` did not resolve, `EventSource` never fired `open`, and the
 * guest sat on "connecting" until the 15-second heartbeat finally flushed the
 * response. Joining a quiet session was indistinguishable from a worker being
 * down, in the client written specifically so that a stuck state never reads as
 * progress.
 *
 * This arrived as a characterisation test asserting the defect, written by the
 * agent that found it while it could not reach the event server to fix it. The
 * fix is one `flushHeaders()` call, and this is the same test inverted: it now
 * holds the behaviour rather than documenting its absence.
 */
test("a quiet session acknowledges a connection before it has anything to send", async () => {
  await withServer(async ({ store, url }) => {
    const joining = connect(url, { since: 0 });

    // The point is that this resolves without anything being appended first.
    // 750ms is far below the 15s heartbeat that used to be the only thing that
    // flushed the response, so passing this cannot be the old behaviour.
    const acknowledged = await Promise.race([
      joining.ready(),
      delay(750, -1),
    ]);

    assert.equal(
      acknowledged,
      200,
      "the connection was not acknowledged before the first write — flushHeaders has regressed",
    );

    // And it is a working stream, not merely an open socket.
    store.append(progress("first-sign-of-life"));
    await joining.settle(1);
    assert.deepEqual(joining.ids(), [0]);

    await joining.close();
  });
});
