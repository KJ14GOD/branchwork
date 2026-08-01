import type { SessionEvent } from "@novus/contracts";
import type { Comparison, PresenceEntry } from "@novus/contracts/protocol";

/**
 * Who is in this mission and what each of them is doing.
 *
 * The product this is being pointed at is a room where several people and
 * several agents work one change together, so the objects that have to be
 * legible first are the participants — not a lifecycle, not a file list. The
 * rail used to show a five-stage ladder and a count of tool calls; what a
 * person actually needs to know on arriving is who is here, what each one was
 * given, and which of them is stuck.
 *
 * Derived entirely from what the log and presence already carry. No new event,
 * no new route: a *workstream* is a run — the mission's own run, or a fork —
 * and its agent identity is the model that run was started with.
 */

export type WorkstreamState =
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type Workstream = {
  runId: string;
  /** A person-facing name for the agent doing this work. */
  name: string;
  /** The model, shown as secondary technical metadata. */
  model: string;
  /**
   * Which harness is running this — "Claude Code", "Codex", "Novus agent".
   *
   * The thing the rail could not say. It named the *model* and left the
   * harness invisible, so a workstream driven by real Claude Code and one
   * driven by Novus's own loop against a Claude model read identically —
   * despite differing in who enforces permissions, whether Novus sees typed
   * tool calls, and whose account pays.
   */
  harness: string;
  /** What this workstream was asked to do differently, or the mission goal. */
  assignment: string;
  state: WorkstreamState;
  /** Identity colour token. Provenance only — never a ranking. */
  signal: string;
  /** The mission's own run, as opposed to an alternative branched from it. */
  primary: boolean;
};

export type Person = {
  id: string;
  name: string;
  role: string;
  connected: boolean;
  /** Holds execution authority right now. */
  inControl: boolean;
};

/** Four is the point at which more colours stop helping somebody tell them apart. */
const SIGNALS = ["--ws-1", "--ws-2", "--ws-3", "--ws-4"] as const;

/**
 * A person-facing name for an agent, from the model that is running it.
 *
 * "claude-sonnet-5" is the model; "Claude" is who a teammate refers to in a
 * sentence. The room needs the second, and keeps the first beside it rather
 * than instead of it.
 */
/**
 * A person-facing name for a harness.
 *
 * Deliberately distinct from `agentName`, which names the *model*. "Claude
 * Code" and "Claude" are different answers to different questions, and the
 * rail needs both: which program is running, and which intelligence it is
 * running on.
 */
export const harnessName = (kind: string | undefined): string => {
  switch (kind) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "external":
      return "External harness";
    default:
      return "Novus agent";
  }
};

export const agentName = (model: string): string => {
  const family = model.toLowerCase();

  if (family.includes("claude")) {
    return "Claude";
  }

  if (family.includes("gpt") || family.includes("codex") || family.includes("o1")) {
    return "Codex";
  }

  // Unknown model: say the model rather than invent a persona for it.
  return model.split(/[-/]/)[0] ?? "Agent";
};

const stateOf = (
  status: string | undefined,
): WorkstreamState => {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "done";
  }
};

/** What this workstream is doing, in words a person would use out loud. */
export const workstreamStatus = (stream: Workstream): string => {
  switch (stream.state) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Done";
  }
};

export const readWorkstreams = (
  events: readonly SessionEvent[],
  comparison: Comparison | null,
): Workstream[] => {
  const attempts = comparison?.attempts ?? [];
  const started = new Map<
    string,
    { goal: string; model: string; harness: string }
  >();

  for (const event of events) {
    if (event.type === "run.started") {
      started.set(event.payload.run.id, {
        goal: event.payload.run.goal,
        model: event.payload.run.model.model,
        // Absent on every run recorded before harnesses had names, and all of
        // those went through the built-in loop.
        harness: harnessName(event.payload.run.harness?.kind),
      });
    }
  }

  // The comparison knows which run is the baseline and what each alternative
  // was told to do differently; the log knows the model. Neither alone is
  // enough to name a workstream.
  const streams: Workstream[] = attempts.map((attempt, index) => {
    const run = started.get(attempt.runId);
    const model = run?.model ?? "unknown";

    return {
      runId: attempt.runId,
      name: agentName(model),
      model,
      harness: run?.harness ?? harnessName(undefined),
      assignment: attempt.baseline
        ? (run?.goal ?? "The mission")
        : attempt.label,
      state: stateOf(attempt.status),
      signal: SIGNALS[index % SIGNALS.length]!,
      primary: attempt.baseline,
    };
  });

  if (streams.length > 0) {
    return streams;
  }

  // No comparison yet — a mission whose first run has only just begun. The room
  // still has an agent in it and should say so rather than waiting for the
  // comparison to arrive before showing anybody.
  //
  // The *latest* run, not every run on the log. A workstream is an approach —
  // the baseline and the forks taken from it — which is exactly what the
  // worker's comparison returns. Two sequential turns in one session are one
  // agent doing two things, and listing them as two agents would put a second
  // participant in the room until the comparison loaded and took it away
  // again.
  //
  // State comes from the log's own terminators rather than being assumed:
  // a run whose `run.failed` is already recorded must not sit in the rail
  // saying "Running" because the comparison has not been fetched yet. A rail
  // that overstates liveness is the one lie this surface cannot afford.
  const ended = new Map<string, WorkstreamState>();

  for (const event of events) {
    if (event.type === "run.completed") {
      ended.set(event.payload.runId, "done");
    }

    if (event.type === "run.failed") {
      ended.set(event.payload.runId, "failed");
    }

    if (event.type === "run.cancelled") {
      ended.set(event.payload.runId, "cancelled");
    }

    if (event.type === "run.paused") {
      ended.set(event.payload.runId, "paused");
    }

    // A resumed run is live again, so the terminator is withdrawn rather than
    // left standing beside a run that is moving.
    if (event.type === "run.resumed") {
      ended.delete(event.payload.runId);
    }
  }

  const latest = [...started.entries()].at(-1);

  if (!latest) {
    return [];
  }

  const [runId, run] = latest;

  return [
    {
      runId,
      name: agentName(run.model),
      model: run.model,
      harness: run.harness,
      assignment: run.goal,
      state: ended.get(runId) ?? "running",
      signal: SIGNALS[0]!,
      primary: true,
    },
  ];
};

export const readPeople = (
  participants: readonly PresenceEntry[],
  controlHeldBy: string | null,
): Person[] =>
  participants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    role: participant.role,
    connected: participant.connected,
    inControl: participant.id === controlHeldBy,
  }));
