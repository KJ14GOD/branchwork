import type { Participant, SessionEvent } from "@novus/contracts";

/**
 * Session state, rebuilt from the log and nowhere else.
 *
 * V1 says the event log is the source of truth and current state is a
 * projection that can be rebuilt from it. Nothing performed that reconstruction
 * — the renderers assembled what they needed as events arrived, which works
 * while you are watching and gives you nothing after a restart. "Replay
 * reconstructs UI and session state from events" was a claim with no code
 * behind it.
 *
 * This is that code. It is deliberately the only thing that derives state, so
 * the desktop, the guest, and a replay all agree by construction rather than by
 * three implementations happening to match.
 *
 * It replays; it does not re-execute. A tool call in the log is a record that
 * something ran, and rebuilding state from it must never run anything — V1 is
 * explicit that re-execution is a separate operation started from a checkpoint.
 */

export type RunProjection = {
  runId: string;
  goal: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  model: { provider: string; model: string };
  summary: string | null;
  failure: string | null;
  toolCalls: number;
  filesChanged: { path: string; additions: number; deletions: number }[];
  tests: { command: string; passed: boolean }[];
  approvals: { toolCallId: string; decision: "approved" | "denied" }[];
};

export type SessionProjection = {
  sessionId: string;
  /** Highest sequence folded in, so a projection can be resumed rather than redone. */
  sequence: number;
  participants: Participant[];
  /** Who currently holds execution authority, by participant id. */
  controlHeldBy: string | null;
  runs: RunProjection[];
  /** Submitted but not yet applied, oldest first. */
  pendingDirection: { eventId: string; direction: string }[];
};

const emptyRun = (
  runId: string,
  goal: string,
  model: RunProjection["model"],
): RunProjection => ({
  runId,
  goal,
  status: "running",
  model,
  summary: null,
  failure: null,
  toolCalls: 0,
  filesChanged: [],
  tests: [],
  approvals: [],
});

/**
 * Folds an ordered log into the state it describes.
 *
 * Order is the log's, not the caller's: events are sorted by sequence before
 * folding, because a projection that depended on arrival order would disagree
 * with itself between a live session and a replay of the same session.
 */
export const projectSession = (
  sessionId: string,
  events: readonly SessionEvent[],
): SessionProjection => {
  const ordered = [...events]
    .filter((event) => event.sessionId === sessionId)
    .sort((first, second) => first.sequence - second.sequence);

  const runs = new Map<string, RunProjection>();
  const participants = new Map<string, Participant>();
  const submitted = new Map<string, string>();
  const applied = new Set<string>();
  let controlHeldBy: string | null = null;
  let sequence = -1;

  const runFor = (runId: string): RunProjection | undefined => runs.get(runId);

  for (const event of ordered) {
    sequence = event.sequence;

    switch (event.type) {
      case "run.started": {
        const { run } = event.payload;
        runs.set(run.id, emptyRun(run.id, run.goal, run.model));
        break;
      }

      case "run.completed": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.status = "completed";
          run.summary = event.payload.summary;
        }
        break;
      }

      case "run.failed": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.status = "failed";
          run.failure = event.payload.reason;
        }
        break;
      }

      case "run.cancelled": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.status = "cancelled";
        }
        break;
      }

      case "run.paused": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.status = "paused";
        }
        break;
      }

      case "run.resumed": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.status = "running";
        }
        break;
      }

      case "tool.completed": {
        const run = runFor(event.payload.runId);

        if (!run) {
          break;
        }

        run.toolCalls += 1;
        const { result } = event.payload;

        // Only an applied patch changed the tree. A proposal is a preview, and
        // counting it would make a replay claim edits a denial prevented — the
        // same distinction the receipt makes, for the same reason.
        if (result.name === "apply_patch") {
          const existing = run.filesChanged.find(
            (file) => file.path === result.output.path,
          );

          if (existing) {
            existing.additions += result.output.additions;
            existing.deletions += result.output.deletions;
          } else {
            run.filesChanged.push({
              path: result.output.path,
              additions: result.output.additions,
              deletions: result.output.deletions,
            });
          }
        }

        if (result.name === "run_tests") {
          run.tests.push({
            command: result.output.command,
            passed: result.output.passed,
          });
        }
        break;
      }

      case "tool.failed": {
        const run = runFor(event.payload.runId);

        if (run) {
          run.toolCalls += 1;
        }
        break;
      }

      case "tool.approved": {
        const run = runFor(event.payload.runId);

        run?.approvals.push({
          toolCallId: event.payload.toolCallId,
          decision: "approved",
        });
        break;
      }

      case "tool.denied": {
        const run = runFor(event.payload.runId);

        run?.approvals.push({
          toolCallId: event.payload.toolCallId,
          decision: "denied",
        });
        break;
      }

      case "participant.joined": {
        const { participant } = event.payload;
        participants.set(participant.id, participant);

        // The first owner to appear holds control until something says
        // otherwise. Inferring it from the log rather than carrying it
        // separately is what lets a replay know who was steering.
        if (participant.role === "owner" && controlHeldBy === null) {
          controlHeldBy = participant.id;
        }
        break;
      }

      case "participant.left": {
        participants.delete(event.payload.participantId);

        if (controlHeldBy === event.payload.participantId) {
          // Nobody holds it. Better than silently leaving it with someone who
          // is gone, which would read as a session under control when it is not.
          controlHeldBy = null;
        }
        break;
      }

      case "control.transferred": {
        controlHeldBy = event.payload.toParticipantId;
        break;
      }

      case "direction.submitted": {
        submitted.set(event.eventId, event.payload.direction);
        break;
      }

      case "direction.applied": {
        applied.add(event.payload.directionEventId);
        break;
      }

      default:
        break;
    }
  }

  return {
    sessionId,
    sequence,
    participants: [...participants.values()],
    controlHeldBy,
    runs: [...runs.values()],
    pendingDirection: [...submitted.entries()]
      .filter(([eventId]) => !applied.has(eventId))
      .map(([eventId, direction]) => ({ eventId, direction })),
  };
};
