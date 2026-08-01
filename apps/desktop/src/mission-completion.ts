import type { MissionOutcome, SessionEvent } from "@novus/contracts";

/**
 * Whether a person has declared this mission over, read from the log.
 *
 * The same fold `projectSession` performs on the worker, done here for the same
 * reason `readMilestones` folds the log rather than fetching a projection: the
 * events are already in this window, and a completion that arrived a second ago
 * must not wait on the next poll to change the screen.
 *
 * Emphatically not derived from whether the runs have stopped. A mission whose
 * last run completed an hour ago is not finished — it is waiting on somebody —
 * and the whole reason `mission.completed` exists is that the product could not
 * previously tell those two apart. Only a person appends this.
 */

export type MissionCompletion = {
  outcome: MissionOutcome;
  /** What the team said happened, in their words. */
  summary: string;
  /**
   * What the evidence said at the moment of completion, frozen onto the event.
   *
   * Read rather than recomputed, deliberately. Recomputing it would read the
   * repository as it stands now, so a mission completed unverified would
   * silently start claiming it was verified the next time anybody ran the suite
   * for an unrelated reason.
   */
  verification: "verified" | "failing" | "unverified";
  filesChanged: number;
  completedBy: string;
  completedAt: string;
};

export const readCompletion = (
  events: readonly SessionEvent[],
): MissionCompletion | null => {
  let completion: MissionCompletion | null = null;

  for (const event of events) {
    if (event.type === "mission.completed") {
      completion = {
        outcome: event.payload.outcome,
        summary: event.payload.summary,
        verification: event.payload.verification,
        filesChanged: event.payload.filesChanged,
        completedBy: event.payload.actorId,
        completedAt: event.occurredAt,
      };
    }

    // Null, not a completion carrying a flag. A reopened mission is live, and
    // a screen that kept the ending around with a badge on it would be showing
    // somebody a finished mission they are actively working in.
    if (event.type === "mission.reopened") {
      completion = null;
    }
  }

  return completion;
};
