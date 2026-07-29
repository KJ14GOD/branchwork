import type { SessionEvent } from "@novus/contracts";

/**
 * What the guest knows about its connection to the session, and nothing more.
 *
 * A guest's whole contribution is telling the truth about a run it cannot
 * touch, so the states here are deliberately narrower than "connected or not":
 * an empty timeline means something completely different when the worker is
 * unreachable, when the session id is wrong, and when the run simply has not
 * started yet. Collapsing those three into one silent blank screen is the
 * failure this type exists to prevent.
 */
export type GuestConnection =
  /** No session chosen yet. */
  | { kind: "idle" }
  /** Asking the worker whether this session exists. */
  | { kind: "locating" }
  /** The worker did not answer at all. */
  | { kind: "unreachable"; detail: string; attempt: number; retryAt: number }
  /** The worker answered, and has no session with this id. */
  | { kind: "absent"; attempt: number; retryAt: number }
  /** Opening the event stream. */
  | { kind: "connecting" }
  /**
   * Receiving events. `blind` means the worker would not enumerate its
   * sessions, so an empty timeline here could still be a mistyped id.
   */
  | { kind: "live"; blind: boolean }
  /** The stream ended; a reconnect is scheduled. */
  | { kind: "dropped"; attempt: number; retryAt: number };

export type ConnectionTone = "idle" | "live" | "warn" | "error";

export type ConnectionReport = {
  /** One word for the status dot. */
  label: string;
  tone: ConnectionTone;
  /** What an empty timeline means right now. Never "nothing happened". */
  emptyTimeline: string;
};

const RETRY_BASE_MS = 1_000;
const RETRY_CEILING_MS = 15_000;

/**
 * Backoff for reconnection attempts.
 *
 * Capped rather than unbounded: a guest that has been watching a paused run for
 * an hour must still notice within seconds when the host starts working again.
 */
export const retryDelayMs = (attempt: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CEILING_MS);

/**
 * Inserts an event into the ordered timeline.
 *
 * Sequence is the authority, not arrival order: a reconnect replays from the
 * last sequence we hold, and a replayed event we already have must not appear
 * twice. Returns the original array when nothing changed so React can skip the
 * render.
 */
export const mergeEvent = (
  events: SessionEvent[],
  event: SessionEvent,
): SessionEvent[] => {
  if (events.some((existing) => existing.sequence === event.sequence)) {
    return events;
  }

  const last = events.at(-1);

  if (!last || last.sequence < event.sequence) {
    return [...events, event];
  }

  return [...events, event].sort(
    (first, second) => first.sequence - second.sequence,
  );
};

/**
 * The sequence a reconnect should resume from.
 *
 * The worker treats `since` as inclusive and numbers a session's events from
 * zero, so resuming means asking for one past the last event we hold.
 */
export const resumeSequence = (events: SessionEvent[]): number => {
  const last = events.at(-1);

  return last ? last.sequence + 1 : 0;
};

export const describeConnection = (
  connection: GuestConnection,
  endpoint: string,
  sessionId: string,
): ConnectionReport => {
  switch (connection.kind) {
    case "idle":
      return {
        label: "no session",
        tone: "idle",
        emptyTimeline: "Join a session to watch its timeline.",
      };

    case "locating":
      return {
        label: "locating",
        tone: "idle",
        emptyTimeline: `Looking for session ${sessionId} on ${endpoint}…`,
      };

    case "unreachable":
      return {
        label: "unreachable",
        tone: "error",
        emptyTimeline: `No answer from the worker at ${endpoint} (${connection.detail}). This timeline is not empty — it is unread.`,
      };

    case "absent":
      return {
        label: "no such session",
        tone: "error",
        emptyTimeline: `The worker at ${endpoint} has no session ${sessionId}. Nothing is being shown because there is nothing to show, not because the run is quiet.`,
      };

    case "connecting":
      return {
        label: "connecting",
        tone: "idle",
        emptyTimeline: `Opening the event stream for ${sessionId}…`,
      };

    case "live":
      return {
        label: "live",
        tone: connection.blind ? "warn" : "live",
        emptyTimeline: connection.blind
          ? `Connected to ${endpoint}, but this worker does not list its sessions, so an empty timeline here may mean ${sessionId} does not exist.`
          : "Connected. This session has not recorded an event yet.",
      };

    case "dropped":
      return {
        label: "reconnecting",
        tone: "warn",
        emptyTimeline: `The event stream to ${endpoint} dropped. Reconnecting — what you can see may be behind what has happened.`,
      };
  }
};

type ToolCompletedEvent = Extract<SessionEvent, { type: "tool.completed" }>;

/** A completed `propose_patch`, narrowed so its diff counters are readable. */
export type PatchEvent = Omit<ToolCompletedEvent, "payload"> & {
  payload: Omit<ToolCompletedEvent["payload"], "result"> & {
    result: Extract<
      ToolCompletedEvent["payload"]["result"],
      { name: "propose_patch" }
    >;
  };
};

export const isPatchEvent = (event: SessionEvent): event is PatchEvent =>
  event.type === "tool.completed" &&
  event.payload.result.name === "propose_patch";

export type TimelineSummary = {
  goal: string | null;
  model: string | null;
  /** What the run is doing, derived only from events the guest has seen. */
  runStatus: "waiting" | "working" | "completed" | "failed";
  events: number;
  toolCalls: SessionEvent[];
  patches: PatchEvent[];
  additions: number;
  deletions: number;
  elapsed: string;
};

const formatElapsed = (events: SessionEvent[]): string => {
  const first = events.at(0);
  const last = events.at(-1);

  if (!first || !last) {
    return "—";
  }

  const ms =
    new Date(last.occurredAt).getTime() - new Date(first.occurredAt).getTime();

  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

/**
 * Projects the ordered log into the counters the rail shows.
 *
 * Everything here is read out of the events themselves. The guest holds no
 * second ledger, so it cannot claim anything the host's log does not say.
 */
export const summarise = (events: SessionEvent[]): TimelineSummary => {
  const started = events.findLast((event) => event.type === "run.started");
  const ended = events.findLast(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  );
  const patches = events.filter(isPatchEvent);

  const runStatus = !started
    ? "waiting"
    : !ended || ended.sequence < started.sequence
      ? "working"
      : ended.type === "run.failed"
        ? "failed"
        : "completed";

  return {
    goal: started?.type === "run.started" ? started.payload.run.goal : null,
    model:
      started?.type === "run.started"
        ? `${started.payload.run.model.provider}/${started.payload.run.model.model}`
        : null,
    runStatus,
    events: events.length,
    toolCalls: events.filter((event) => event.type === "tool.requested"),
    patches,
    additions: patches.reduce(
      (total, event) => total + event.payload.result.output.additions,
      0,
    ),
    deletions: patches.reduce(
      (total, event) => total + event.payload.result.output.deletions,
      0,
    ),
    elapsed: formatElapsed(events),
  };
};
