import type { SessionEvent } from "@novus/contracts";

import { agentName, type Workstream } from "../../workstreams.ts";

/**
 * What has happened, told as the mission's story.
 *
 * The timeline this replaces led with a sequence number and a tool name on
 * every row — `0 ◇ session.created`, `read_file ×3` — which is the contract's
 * own vocabulary and answers a question nobody in a shared room is asking.
 * What a second person arriving needs is: who did what, what changed, what a
 * human asked for, and what is still moving.
 *
 * So each entry is attributed to an agent or a person, carries a milestone in
 * plain language, and keeps its machinery in a quiet inset underneath. Nothing
 * is hidden — the raw event view is still one command away — but the default
 * tells the story rather than the mechanism.
 */

export type Milestone = {
  id: string;
  /** Who did it: an agent's name, or a person's. */
  actor: string;
  /** Human, so the room can tell a teammate's direction from an agent's work. */
  human: boolean;
  /** The signal token of the workstream this belongs to, when it has one. */
  signal: string | null;
  /** Plain-language headline. */
  headline: string;
  /** Technical support for the headline, shown quietly. */
  detail: string | null;
  at: string;
  tone: "normal" | "verified" | "failed" | "attention";
};

const clock = (iso: string): string => {
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";

/**
 * Folds the log into milestones.
 *
 * Reads only what is already on the log. Runs of tool calls collapse into one
 * line naming what they amounted to, because thirty rows of `read_file` is a
 * transcript of the mechanism rather than an account of the work.
 */
export const readMilestones = (
  events: readonly SessionEvent[],
  workstreams: readonly Workstream[],
): Milestone[] => {
  const signalFor = (runId: string): string | null =>
    workstreams.find((stream) => stream.runId === runId)?.signal ?? null;
  const nameFor = (runId: string): string =>
    workstreams.find((stream) => stream.runId === runId)?.name ?? "The agent";

  const milestones: Milestone[] = [];
  let readsPending = new Map<string, Set<string>>();

  const flushReads = (runId: string, at: string) => {
    const files = readsPending.get(runId);

    if (!files || files.size === 0) {
      return;
    }

    milestones.push({
      id: `read-${runId}-${at}-${files.size}`,
      actor: nameFor(runId),
      human: false,
      signal: signalFor(runId),
      headline: `Read ${files.size} file${files.size === 1 ? "" : "s"}`,
      // Counted by file rather than by call: re-reading one file four times is
      // one file's worth of understanding, and counting calls made a stuck
      // agent look like the busiest one in the room.
      detail: [...files].slice(0, 3).join(", "),
      at,
      tone: "normal",
    });
    readsPending.delete(runId);
  };

  for (const event of events) {
    switch (event.type) {
      case "run.started": {
        const model = event.payload.run.model.model;
        milestones.push({
          id: event.eventId,
          actor: agentName(model),
          human: false,
          signal: signalFor(event.payload.run.id),
          headline: "Started on the mission",
          detail: event.payload.run.goal,
          at: event.occurredAt,
          tone: "normal",
        });
        break;
      }

      case "tool.requested": {
        const { runId, call } = event.payload;

        if (call.name === "read_file") {
          const seen = readsPending.get(runId) ?? new Set<string>();
          seen.add(call.input.path);
          readsPending.set(runId, seen);
        }
        break;
      }

      case "tool.completed": {
        const { runId, result } = event.payload;

        // A read's own completion must not flush the run it belongs to, or
        // every read closes its own group and the fold never happens — which
        // is exactly what six consecutive "Read 1 file" rows looked like.
        // Only a call of a different kind ends a stretch of reading.
        if (result.name !== "read_file") {
          flushReads(runId, event.occurredAt);
        }

        if (result.name === "apply_patch") {
          milestones.push({
            id: event.eventId,
            actor: nameFor(runId),
            human: false,
            signal: signalFor(runId),
            headline: `Changed ${result.output.path}`,
            detail: `+${result.output.additions} −${result.output.deletions}`,
            at: event.occurredAt,
            tone: "normal",
          });
        }

        if (result.name === "run_tests") {
          milestones.push({
            id: event.eventId,
            actor: nameFor(runId),
            human: false,
            signal: signalFor(runId),
            headline: result.output.passed ? "Tests passed" : "Tests failed",
            detail: result.output.command,
            at: event.occurredAt,
            tone: result.output.passed ? "verified" : "failed",
          });
        }
        break;
      }

      case "direction.queued": {
        milestones.push({
          id: event.eventId,
          actor: "You",
          // Attributed to a person on purpose: in a shared room, a direction
          // somebody gave and a thing the agent decided are different facts.
          human: true,
          signal: signalFor(event.payload.runId),
          headline: "Directed the work",
          detail: event.payload.direction,
          at: event.occurredAt,
          tone: "attention",
        });
        break;
      }

      case "run.failed": {
        flushReads(event.payload.runId, event.occurredAt);
        milestones.push({
          id: event.eventId,
          actor: nameFor(event.payload.runId),
          human: false,
          signal: signalFor(event.payload.runId),
          headline: "Stopped",
          detail: event.payload.reason,
          at: event.occurredAt,
          tone: "failed",
        });
        break;
      }

      case "run.completed": {
        flushReads(event.payload.runId, event.occurredAt);
        milestones.push({
          id: event.eventId,
          actor: nameFor(event.payload.runId),
          human: false,
          signal: signalFor(event.payload.runId),
          headline: "Finished",
          detail: event.payload.summary,
          at: event.occurredAt,
          // Finishing is not verifying. This is the boundary the whole
          // product turns on, so it never gets the verified tone.
          tone: "normal",
        });
        break;
      }

      default:
        break;
    }
  }

  for (const [runId] of readsPending) {
    flushReads(runId, events.at(-1)?.occurredAt ?? new Date(0).toISOString());
  }

  return milestones;
};

export const ActivityMilestone = ({ milestone }: { milestone: Milestone }) => (
  <li
    className={`beat beat--${milestone.tone}`}
    style={
      milestone.signal ? { ["--ws" as string]: `var(${milestone.signal})` } : undefined
    }
  >
    <span
      className={
        milestone.human ? "beat__avatar beat__avatar--human" : "beat__avatar"
      }
      aria-hidden="true"
    >
      {initials(milestone.actor)}
    </span>

    <div className="beat__body">
      <p className="beat__head">
        <span className="beat__actor">{milestone.actor}</span>
        <span className="beat__headline">{milestone.headline}</span>
        <time className="beat__time">{clock(milestone.at)}</time>
      </p>
      {milestone.detail ? (
        <p className="beat__detail">{milestone.detail}</p>
      ) : null}
    </div>
  </li>
);

export const ActivityFeed = ({
  milestones,
}: {
  milestones: readonly Milestone[];
}) => (
  <ol className="feed">
    {milestones.map((milestone) => (
      <ActivityMilestone key={milestone.id} milestone={milestone} />
    ))}
  </ol>
);
