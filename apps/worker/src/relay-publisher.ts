import type { SessionEvent } from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import type { Redactor } from "./redaction.ts";
import { shareableEvent } from "./shareable.ts";

/**
 * Pushes this worker's events to the relay, so somebody elsewhere can watch.
 *
 * Outbound by design. The worker holds the repository, the provider key, and
 * the ability to run commands; nothing dials in to it. It decides what leaves,
 * and it leaves already redacted — the same subset a guest would have received
 * over loopback, sent somewhere a guest can actually reach.
 *
 * Best-effort on purpose. A relay that is down, slow, or unreachable must not
 * slow a run or fail one: the host's log is the source of truth and the shared
 * copy is a projection of it. Events queue while disconnected and go out on
 * reconnect, and if the queue overruns, the run continues and the gap is
 * reported rather than the run being sacrificed to preserve it.
 */

export type RelayPublisherOptions = {
  url: string;
  token: string;
  /**
   * The one session this publisher carries.
   *
   * `store.subscribe` is process-wide and a worker hosts many sessions, so
   * without this every session's events went out under a token that names one
   * of them — a guest invited to watch one repository received another. The
   * loopback path this replaces has always filtered; the path that leaves the
   * machine did not.
   */
  sessionId: string;
  redactor: Redactor;
  /**
   * How many events to hold while disconnected.
   *
   * A bound rather than none: an hour of disconnection during a busy run should
   * not become a memory problem on the host. Overrunning it is visible.
   */
  maxQueued?: number;
  /** Injected in tests. Node 24 ships a WebSocket client. */
  connect?: (url: string) => WebSocket;
};

export type RelayPublisher = {
  /** Events dropped because the queue was full, for the receipt to admit. */
  dropped(): number;
  connected(): boolean;
  close(): void;
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export const publishToRelay = (
  store: SessionEventStore,
  options: RelayPublisherOptions,
): RelayPublisher => {
  const maxQueued = options.maxQueued ?? 1_000;
  const open = options.connect ?? ((url: string) => new WebSocket(url));

  const queue: SessionEvent[] = [];
  let socket: WebSocket | null = null;
  let attempts = 0;
  let dropped = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (queue.length > 0) {
      const event = queue.shift();

      if (event) {
        socket.send(JSON.stringify(event));
      }
    }
  };

  // Backoff, capped. A worker running for hours against a relay that is gone
  // should not spend the whole time reconnecting.
  const scheduleReconnect = (): void => {
    if (closed) {
      return;
    }

    attempts += 1;
    const wait = Math.min(
      RECONNECT_BASE_MS * 2 ** (attempts - 1),
      RECONNECT_MAX_MS,
    );
    timer = setTimeout(connect, wait);
    timer.unref?.();
  };

  const connect = (): void => {
    if (closed) {
      return;
    }

    try {
      socket = open(`${options.url}/?token=${options.token}&intent=publish`);
    } catch {
      // A constructor that throws — a malformed relay URL, a host that does not
      // resolve — must not reach the caller. This path is best-effort by
      // design, and publishToRelay throwing would take the worker down over a
      // shared copy nobody may even be reading.
      socket = null;
      scheduleReconnect();

      return;
    }

    socket.addEventListener("open", () => {
      attempts = 0;
      flush();
    });

    socket.addEventListener("close", () => {
      socket = null;

      if (closed) {
        return;
      }

      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The close handler owns reconnection; this exists so an error does not
      // reach an unhandled rejection and take the worker down with it.
    });
  };

  const unsubscribe = store.subscribe((event) => {
    if (event.sessionId !== options.sessionId) {
      return;
    }

    // Two different questions, asked in order. Shareability decides whether a
    // field may leave the host at all; redaction removes secrets from what is
    // left. A log with no secrets in it still contains the repository.
    const shareable = options.redactor.redactEvent(shareableEvent(event));

    if (queue.length >= maxQueued) {
      dropped += 1;

      return;
    }

    queue.push(shareable);
    flush();
  });

  connect();

  return {
    dropped: () => dropped,
    connected: () => socket?.readyState === WebSocket.OPEN,
    close: () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      socket?.close();
      socket = null;
    },
  };
};
