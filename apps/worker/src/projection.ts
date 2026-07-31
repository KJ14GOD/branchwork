import type { DecisionOutcome, Participant, SessionEvent } from "@novus/contracts";

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

/**
 * A pending or accepted transfer of control.
 *
 * Named rather than written inline inside `SessionProjection` because the fold
 * below reads it back into a local, and an indexed access into a type that is
 * still being inferred made that local circular.
 */
export type ControlOffer = {
  offerEventId: string;
  fromParticipantId: string;
  toParticipantId: string;
  /** Offered and not yet taken up, or accepted and awaiting a safe boundary. */
  state: "offered" | "accepted";
  offeredAt: string;
  acceptedAt: string | null;
};

export type SessionProjection = {
  sessionId: string;
  /** Highest sequence folded in, so a projection can be resumed rather than redone. */
  sequence: number;
  participants: Participant[];
  /** Who currently holds execution authority, by participant id. */
  controlHeldBy: string | null;
  /**
   * The handoff in flight, if any. "offered" is waiting on the recipient;
   * "accepted" is waiting on a safe boundary. Declined, withdrawn, and
   * transferred all clear it — a settled offer is history, not state.
   */
  controlOffer: ControlOffer | null;
  /**
   * Who has asked for control and not yet received it, oldest first, one per
   * participant. A request is a standing fact until control reaches the
   * requester or they leave — it must survive a refresh, or a controller who
   * was not looking at the moment it arrived never learns it exists.
   */
  controlRequests: {
    eventId: string;
    participantId: string;
    reason: string | null;
    requestedAt: string;
  }[];
  runs: RunProjection[];
  /**
   * Submitted but not yet applied, oldest first. Queued means a live run has
   * committed to folding it in at its next safe boundary; still-unqueued means
   * it is recorded and waits for the next execution.
   */
  pendingDirection: {
    eventId: string;
    direction: string;
    submittedAt: string;
    queuedForRunId: string | null;
    queuedAt: string | null;
  }[];
  /**
   * The most recent attempt a host chose on the compare screen, if any.
   *
   * Was reachable only through the live event stream before this — a
   * decision landed in the log and drew a row, but a projection rebuilt from
   * the log (a restart, a replay, a guest that missed the live event) had no
   * way to know one had ever been made.
   */
  decision: { runId: string; checkpointId: string; outcome: DecisionOutcome } | null;
  /**
   * What this session has spent, summed from the receipts in its own log.
   *
   * Budgets accumulate in memory, per run, and that memory dies with the
   * process — so a resumed session's spend restarted at zero and a person who
   * had already spent real money on it was shown nothing. The log is the only
   * thing that survives a restart, and `receipt.created` carries each run's
   * usage, so this is where an honest session total has to come from.
   *
   * Per *run*, not per attempt-in-flight: a receipt is written when a run ends,
   * so a run still going is not in here yet. That is a floor, and `costIsFloor`
   * says when it is one for the other reason too — a call whose adapter
   * reported no usage, or a run whose model had no published rate.
   */
  usage: {
    /**
     * Dollars, summed over the runs that could be priced. Null when no run
     * could be — never zero, because a session reported as free because
     * nobody priced its model is a worse answer than one that says it does
     * not know.
     */
    costUsd: number | null;
    /**
     * Whether the figure above is a floor rather than a total. True when a
     * run's model had no rate, or when some call's adapter reported no usage,
     * or when a run is still in flight and has not written its receipt.
     */
    costIsFloor: boolean;
    totalTokens: number;
    modelCalls: number;
    /** Finished runs whose receipt was counted. */
    runs: number;
    /** Of those, how many could not be priced at all. */
    unpricedRuns: number;
  };
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
  const submitted = new Map<
    string,
    {
      direction: string;
      submittedAt: string;
      queuedForRunId: string | null;
      queuedAt: string | null;
    }
  >();
  const applied = new Set<string>();
  const controlRequests = new Map<
    string,
    { eventId: string; participantId: string; reason: string | null; requestedAt: string }
  >();
  let controlHeldBy: string | null = null;
  let controlOffer: ControlOffer | null = null;
  let decision: SessionProjection["decision"] = null;
  let sequence = -1;
  // Session spend, folded from receipts. Null rather than 0 until something
  // priced actually lands, so "nothing was counted" stays distinguishable
  // from "it was counted and came to nothing".
  let costUsd: number | null = null;
  let totalTokens = 0;
  let modelCalls = 0;
  let countedRuns = 0;
  let unpricedRuns = 0;
  let someUsageMissing = false;

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

        // A disconnect is not a departure: the recipient of an offer may come
        // back and accept, so only a deliberate leave or a removal voids the
        // handoff in flight and any standing request from the leaver.
        if (event.payload.reason !== "disconnected") {
          controlRequests.delete(event.payload.participantId);

          if (
            controlOffer &&
            (controlOffer.toParticipantId === event.payload.participantId ||
              controlOffer.fromParticipantId === event.payload.participantId)
          ) {
            controlOffer = null;
          }
        }
        break;
      }

      case "control.requested": {
        // Latest per participant: asking twice sharpens the one request
        // rather than stacking duplicates in front of the controller.
        controlRequests.set(event.payload.participantId, {
          eventId: event.eventId,
          participantId: event.payload.participantId,
          reason: event.payload.reason ?? null,
          requestedAt: event.occurredAt,
        });
        break;
      }

      case "control.offered": {
        // A newer offer supersedes an unsettled one in the view. The server
        // refuses to mint one while another is pending, but a projection must
        // fold whatever log it is given without wedging.
        controlOffer = {
          offerEventId: event.eventId,
          fromParticipantId: event.payload.fromParticipantId,
          toParticipantId: event.payload.toParticipantId,
          state: "offered",
          offeredAt: event.occurredAt,
          acceptedAt: null,
        };
        break;
      }

      case "control.accepted": {
        // Written field by field rather than spread. The spread form tripped
        // TypeScript into treating the narrowed local as non-object here, and
        // naming the fields is clearer about what acceptance actually changes:
        // the offer stands, its state advances, and the moment is recorded.
        if (
          controlOffer !== null &&
          controlOffer.offerEventId === event.payload.offerEventId
        ) {
          controlOffer = {
            offerEventId: controlOffer.offerEventId,
            fromParticipantId: controlOffer.fromParticipantId,
            toParticipantId: controlOffer.toParticipantId,
            state: "accepted",
            offeredAt: controlOffer.offeredAt,
            acceptedAt: event.occurredAt,
          };
        }
        break;
      }

      case "control.declined":
      case "control.withdrawn": {
        if (controlOffer?.offerEventId === event.payload.offerEventId) {
          controlOffer = null;
        }
        break;
      }

      case "control.transferred": {
        controlHeldBy = event.payload.toParticipantId;
        // Control reaching the requester answers the request, and any offer
        // in flight is settled by authority actually moving.
        controlRequests.delete(event.payload.toParticipantId);
        controlOffer = null;
        break;
      }

      case "direction.submitted": {
        submitted.set(event.eventId, {
          direction: event.payload.direction,
          submittedAt: event.occurredAt,
          queuedForRunId: null,
          queuedAt: null,
        });
        break;
      }

      case "direction.queued": {
        const entry = submitted.get(event.payload.directionEventId);

        if (entry) {
          entry.queuedForRunId = event.payload.runId;
          entry.queuedAt = event.occurredAt;
        }
        break;
      }

      case "direction.applied": {
        applied.add(event.payload.directionEventId);
        break;
      }

      case "decision.recorded": {
        // Latest wins, mirroring how the pause/resume events above are
        // read: a decision can in principle be revisited, and only the log
        // order says which one is current.
        decision = {
          runId: event.payload.runId,
          checkpointId: event.payload.checkpointId,
          outcome: event.payload.outcome,
        };
        break;
      }

      // Usage enters the log here and nowhere else — there is no
      // model.requested / model.responded family yet — so this is the only
      // place a session total can be folded from.
      case "receipt.created": {
        const { usage } = event.payload.receipt;

        countedRuns += 1;
        totalTokens += usage.inputTokens + usage.outputTokens;
        modelCalls += usage.modelCalls;

        if (usage.costUsd === null) {
          unpricedRuns += 1;
        } else {
          costUsd = (costUsd ?? 0) + usage.costUsd;
        }

        if (usage.callsMissingUsage > 0) {
          someUsageMissing = true;
        }

        break;
      }

      default:
        break;
    }
  }

  // A run that started and has not ended has no receipt yet, so its spend is
  // not in the total. Saying the total is a floor is the honest way to report
  // that, rather than quietly under-counting a session that is mid-run.
  const runInFlight = [...runs.values()].some(
    (run) => run.status === "running" || run.status === "paused",
  );

  return {
    sessionId,
    sequence,
    usage: {
      costUsd,
      costIsFloor: someUsageMissing || unpricedRuns > 0 || runInFlight,
      totalTokens,
      modelCalls,
      runs: countedRuns,
      unpricedRuns,
    },
    participants: [...participants.values()],
    controlHeldBy,
    controlOffer,
    controlRequests: [...controlRequests.values()],
    runs: [...runs.values()],
    decision,
    pendingDirection: [...submitted.entries()]
      .filter(([eventId]) => !applied.has(eventId))
      .map(([eventId, entry]) => ({ eventId, ...entry })),
  };
};
