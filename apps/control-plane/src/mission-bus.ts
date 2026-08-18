import pg from "pg";
import { MISSION_EVENT_CHANNEL } from "./events.ts";
import { RUNNER_COMMAND_CHANNEL } from "./runners.ts";

/**
 * Fan-out of Postgres notifications to whoever is waiting on them: clients
 * watching a room (D-149), and the machines waiting for work on a lane
 * (D-154). **One** dedicated connection holds `LISTEN` for both channels —
 * two would be two things to reconnect, for one thing to hear.
 *
 * Postgres rather than an in-process emitter for two reasons, both load-bearing:
 * a notification sent inside the writing transaction is delivered on commit and
 * never on rollback, so a watcher is never told to re-read a row it cannot yet
 * see; and a second control-plane process fans out to its own watchers from the
 * same channel, which an emitter local to one process cannot do (D-021 accepted
 * self-managed fan-out as our problem — this is the cheapest form of it).
 *
 * The notification is an **address**, never content. A watcher learns that
 * mission X reached sequence N and re-reads through the same authorized
 * projection every other client uses, so the stream can never become a second
 * way to read data the reader is not entitled to.
 */

export interface MissionChange {
  missionId: string;
  seq: number;
  kind: string;
}

type Listener = (change: MissionChange) => void;
type WorkListener = () => void;

/** Reconnection backoff for the listening connection, in milliseconds. */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 10_000;

export interface MissionBus {
  /** Registers interest in one mission. The returned function unsubscribes. */
  subscribe(missionId: string, listener: Listener): () => void;
  /** Registers interest in work arriving for one lane (D-154). The signal
   *  carries nothing: the runner asks for its own commands, under its own
   *  credential, exactly as it does on its timer. */
  subscribeWork(workstreamId: string, listener: WorkListener): () => void;
  /** Watchers currently registered, across every mission. Test and health use. */
  readonly size: number;
  stop(): Promise<void>;
}

/**
 * A bus with no database behind it: every subscribe succeeds and nothing is
 * ever delivered. Used by the deterministic tests that never write events, and
 * as the honest degraded mode when a listening connection cannot be held —
 * the room falls back to its own slow re-read rather than the server pretending
 * a live connection exists.
 */
export function inertMissionBus(): MissionBus {
  return {
    subscribe: () => () => undefined,
    subscribeWork: () => () => undefined,
    size: 0,
    stop: async () => undefined
  };
}

export function createMissionBus(databaseUrl: string): MissionBus {
  const listeners = new Map<string, Set<Listener>>();
  const workListeners = new Map<string, Set<WorkListener>>();
  let client: pg.Client | null = null;
  let stopped = false;
  let attempts = 0;
  let retryTimer: NodeJS.Timeout | null = null;

  const deliver = (raw: string | undefined): void => {
    if (!raw) return;
    let change: MissionChange;
    try {
      const parsed = JSON.parse(raw) as Partial<MissionChange>;
      if (typeof parsed.missionId !== "string" || typeof parsed.seq !== "number") return;
      change = { missionId: parsed.missionId, seq: parsed.seq, kind: String(parsed.kind ?? "") };
    } catch {
      // A malformed payload is noise on a channel anyone could notify. It is
      // never fatal: the connection stays up for the well-formed ones.
      return;
    }
    const set = listeners.get(change.missionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(change);
      } catch {
        // One watcher's write failing (a client that vanished mid-flush) must
        // not deny the notification to the others on the same mission.
      }
    }
  };

  const deliverWork = (raw: string | undefined): void => {
    if (!raw) return;
    let workstreamId: string;
    try {
      const parsed = JSON.parse(raw) as { workstreamId?: unknown };
      if (typeof parsed.workstreamId !== "string") return;
      workstreamId = parsed.workstreamId;
    } catch {
      return;
    }
    const set = workListeners.get(workstreamId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        // One waiting machine's write failing must not deny the others.
      }
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = new pg.Client({ connectionString: databaseUrl });
    // A listening connection that dies takes every watcher's liveness with it,
    // so it re-dials rather than staying down. The clients above it never see
    // this: they re-read on their own timer regardless, which is what makes a
    // missed notification a latency problem instead of a correctness one.
    next.on("error", () => void reconnect());
    next.on("end", () => void reconnect());
    next.on("notification", (message) => {
      if (message.channel === MISSION_EVENT_CHANNEL) deliver(message.payload);
      if (message.channel === RUNNER_COMMAND_CHANNEL) deliverWork(message.payload);
    });
    try {
      await next.connect();
      await next.query(`listen ${MISSION_EVENT_CHANNEL}`);
      await next.query(`listen ${RUNNER_COMMAND_CHANNEL}`);
      client = next;
      attempts = 0;
    } catch {
      await next.end().catch(() => undefined);
      void reconnect();
    }
  };

  const reconnect = async (): Promise<void> => {
    if (stopped || retryTimer) return;
    client = null;
    attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
    // A reconnect timer must never be the reason a process refuses to exit.
    retryTimer.unref?.();
  };

  void connect();

  return {
    subscribe(missionId, listener) {
      const set = listeners.get(missionId) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(missionId, set);
      return () => {
        const current = listeners.get(missionId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(missionId);
      };
    },
    subscribeWork(workstreamId, listener) {
      const set = workListeners.get(workstreamId) ?? new Set<WorkListener>();
      set.add(listener);
      workListeners.set(workstreamId, set);
      return () => {
        const current = workListeners.get(workstreamId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) workListeners.delete(workstreamId);
      };
    },
    get size() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      for (const set of workListeners.values()) total += set.size;
      return total;
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      listeners.clear();
      workListeners.clear();
      const open = client;
      client = null;
      if (open) await open.end().catch(() => undefined);
    }
  };
}
