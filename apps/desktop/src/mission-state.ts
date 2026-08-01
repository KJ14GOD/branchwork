import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";

import { readCompletion, type MissionCompletion } from "./mission-completion.ts";
import { readVerification } from "./verification.ts";

/**
 * What the mission is, and therefore what the screen is.
 *
 * The old shell rendered every region on every mission: a five-stage lifecycle
 * with nothing in it, an Approaches explanation for a mission with one
 * approach, Control and Participants for a room with one person, Required
 * checks and Changed files with nothing to check or change. A person opening a
 * repository met the whole product before doing anything, which is the reason
 * it read as an admin dashboard rather than a place to start work.
 *
 * So composition is derived, not fixed. Each state below names a genuinely
 * different screen — not the same three columns with different words in them —
 * and every region a state does not need is *absent*, not empty.
 */

export type MissionState =
  /** A repository is open and nobody has asked for anything. One question. */
  | "empty"
  /** A mission was submitted and the first agent has not reported yet. */
  | "starting"
  /** An agent is working and has produced nothing to review yet. */
  | "working"
  /** Something is waiting on a person: an approval, a handoff, a decision. */
  | "needs-direction"
  /** Files changed, nothing verified them. The state most easily misread. */
  | "changed-unverified"
  /** Changed and verified. The only state green may appear in. */
  | "verified"
  /** It stopped before producing anything. Needs recovery, not a decision. */
  | "failed"
  /**
   * A person declared it over — resolved or abandoned.
   *
   * Outranks every state above it, because somebody saying the mission is
   * finished settles every question the rest of this derivation asks. It is
   * also the only state nothing can derive: a run ending is the machine
   * stopping, a mission ending is a person saying so.
   */
  | "completed";

export type MissionComposition = {
  state: MissionState;
  /** The centred start canvas, with no rails at all. */
  showStartCanvas: boolean;
  /** People and agents. Present once there is work to attribute. */
  showWorkstreams: boolean;
  /** Verification, changes, risk. Present only when it has something to say. */
  showEvidence: boolean;
  /** A recovery affordance rather than a decision surface. */
  showRecovery: boolean;
  /** The frozen outcome, the frozen evidence, and a way back in. */
  showCompletion: boolean;
  /** One line naming what is true and what happens next. */
  headline: string;
  detail: string;
};

const hasEvidence = (
  comparison: Comparison | null,
  filesChanged: number,
): boolean => {
  if (filesChanged > 0) {
    return true;
  }

  return (comparison?.attempts ?? []).some(
    (attempt) =>
      attempt.filesChanged.length > 0 ||
      attempt.testsRun > 0 ||
      attempt.failure !== null,
  );
};

/**
 * Which runs ended badly, from the log itself.
 *
 * Read here and not only from the comparison, because the comparison is a
 * fetch and the log is already in hand. A mission whose only run died on a 401
 * used to read "Working" in its header while its own rail said "Failed" beside
 * it — the header waited on `/compare`, and if that request was slow, absent,
 * or refused, it waited forever. The log knows immediately, and a screen that
 * claims work is in flight when it has stopped is the worst thing this
 * derivation can say.
 */
const runOutcomes = (
  events: readonly SessionEvent[],
): Map<string, "failed" | "cancelled" | "completed"> => {
  const outcomes = new Map<string, "failed" | "cancelled" | "completed">();

  for (const event of events) {
    if (event.type === "run.failed") {
      outcomes.set(event.payload.runId, "failed");
    }

    if (event.type === "run.cancelled") {
      outcomes.set(event.payload.runId, "cancelled");
    }

    if (event.type === "run.completed") {
      outcomes.set(event.payload.runId, "completed");
    }
  }

  return outcomes;
};

export const missionState = (input: {
  events: readonly SessionEvent[];
  comparison: Comparison | null;
  filesChanged: number;
  /** True while a run is in flight. */
  busy: boolean;
  /** An approval, control request, or handoff is waiting on somebody. */
  awaitingPerson: boolean;
}): MissionState => {
  // Above everything, including "empty": a mission can be abandoned before it
  // ever ran, and asking somebody "what are we building?" on a mission they
  // closed yesterday is the app forgetting a decision a person made.
  if (readCompletion(input.events) !== null) {
    return "completed";
  }

  const runs = input.events.filter((event) => event.type === "run.started");

  if (runs.length === 0) {
    return "empty";
  }

  const attempts = input.comparison?.attempts ?? [];
  const outcomes = runOutcomes(input.events);
  // Every run this session started has ended, and every one of them failed.
  // Answered from whichever source has an answer: the log always does, the
  // comparison sometimes does, and they must not be able to disagree.
  const everyRunFailedOnLog =
    runs.length > 0 &&
    runs.every(
      (event) =>
        event.type === "run.started" &&
        outcomes.get(event.payload.run.id) === "failed",
    );
  const everyRunFailed =
    everyRunFailedOnLog ||
    (attempts.length > 0 && attempts.every((attempt) => attempt.status === "failed"));
  const changed = input.filesChanged > 0;

  // Failure first, and only when it produced nothing. A run that failed after
  // changing files still has evidence worth reading, so it is not a recovery
  // screen — it is a normal review with a failure on the record.
  if (everyRunFailed && !changed) {
    return "failed";
  }

  if (input.awaitingPerson) {
    return "needs-direction";
  }

  if (input.busy) {
    // Nothing to show yet is a different screen from working *with* evidence,
    // because an inspector holding "0 files, no checks" teaches people to
    // stop looking at it.
    return hasEvidence(input.comparison, input.filesChanged)
      ? "changed-unverified"
      : "starting";
  }

  if (!changed && !hasEvidence(input.comparison, input.filesChanged)) {
    return "working";
  }

  // Verified means something ran and passed. Finishing is not verifying, and
  // this is the boundary that decides whether green may appear at all.
  //
  // From the log as well as from the comparison — see verification.ts. Reading
  // the comparison alone is what made a one-workstream mission that ran its
  // suite sit in "Changed, not verified" forever, while its own activity feed
  // three inches away said the tests had passed.
  const proven = readVerification(input.events, input.comparison);

  return proven.verified === true ? "verified" : "changed-unverified";
};

/**
 * Which single control on the mission screen is the dominant one.
 *
 * `.button--primary` is the only inversion in the whole app, which is what
 * makes it unmistakable without spending a hue — and what makes two of them on
 * one screen destroy the mechanism for both. Three surfaces can each honestly
 * claim it, so the claim is settled once, here, instead of by whichever
 * component happens to render first.
 *
 * The order is an order of obligation, not of importance. A handoff offered to
 * you is a person waiting on an answer; a decision waiting is work waiting on a
 * judgement; direction is what you do when neither is true. A focused surface
 * opened over the work brings its own primary action and takes it from the
 * composer for as long as it is open.
 */
export const dominantAction = (input: {
  /** An offer names you and has not been answered. */
  offeredToYou: boolean;
  /** Approaches have stopped and nothing has been recorded about them. */
  decisionWaiting: boolean;
  /** Approaches, the repository or the raw log is open over the work. */
  focused: boolean;
}): "handoff" | "decision" | "focus" | "direction" => {
  if (input.offeredToYou) {
    return "handoff";
  }

  if (input.focused) {
    return "focus";
  }

  return input.decisionWaiting ? "decision" : "direction";
};

export const composeMission = (
  state: MissionState,
  facts: {
    agents: number;
    changed: number;
    verified: boolean;
    /** Present only in the `completed` state, and frozen when it is. */
    completion?: MissionCompletion | null;
  },
): MissionComposition => {
  const base = { state, showRecovery: false, showCompletion: false };

  switch (state) {
    case "empty":
      return {
        ...base,
        showStartCanvas: true,
        showWorkstreams: false,
        showEvidence: false,
        headline: "What are we building?",
        detail:
          "Describe the outcome. Novus will organise the work and keep the evidence together.",
      };

    case "starting":
      return {
        ...base,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: false,
        headline: "Getting started",
        detail:
          facts.agents > 1
            ? `${facts.agents} agents are picking up the mission.`
            : "The agent is reading the repository.",
      };

    case "working":
      return {
        ...base,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: false,
        headline: "Working",
        detail: "Nothing has changed yet. Direct the work as it goes.",
      };

    case "needs-direction":
      return {
        ...base,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: facts.changed > 0,
        headline: "Waiting on you",
        detail: "Something in this mission needs a person before it continues.",
      };

    case "changed-unverified":
      return {
        ...base,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: true,
        headline: "Changed, not verified",
        detail: `${facts.changed} file${facts.changed === 1 ? "" : "s"} changed. Nothing has proven them yet.`,
      };

    case "verified":
      return {
        ...base,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: true,
        headline: "Verified",
        detail: "Checks ran against these changes and passed.",
      };

    case "failed":
      return {
        state,
        showStartCanvas: false,
        showWorkstreams: true,
        showEvidence: false,
        showRecovery: true,
        showCompletion: false,
        headline: "Stopped before it changed anything",
        detail: "Read why, then send it back in with more to go on.",
      };

    case "completed": {
      // Resolved and abandoned are both endings and they are not the same
      // ending, so neither borrows the other's words. Neither borrows green
      // either: what was verified is a separate fact, frozen on the event and
      // stated by the completion state itself.
      const outcome = facts.completion?.outcome ?? "resolved";

      return {
        state,
        showStartCanvas: false,
        showWorkstreams: true,
        // The frozen record is what a finished mission shows. A live inspector
        // beside it would re-derive verification from the repository as it is
        // now and could contradict the evidence the ending was called on.
        showEvidence: false,
        showRecovery: false,
        showCompletion: true,
        headline: outcome === "resolved" ? "Resolved" : "Abandoned",
        detail:
          outcome === "resolved"
            ? "A person called this mission finished. Reopen it to carry on."
            : "A person closed this mission without resolving it. Reopen it to carry on.",
      };
    }
  }
};
