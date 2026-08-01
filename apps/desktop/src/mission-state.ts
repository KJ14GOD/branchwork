import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";

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
  | "failed";

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

export const missionState = (input: {
  events: readonly SessionEvent[];
  comparison: Comparison | null;
  filesChanged: number;
  /** True while a run is in flight. */
  busy: boolean;
  /** An approval, control request, or handoff is waiting on somebody. */
  awaitingPerson: boolean;
}): MissionState => {
  const runs = input.events.filter((event) => event.type === "run.started");

  if (runs.length === 0) {
    return "empty";
  }

  const attempts = input.comparison?.attempts ?? [];
  const everyRunFailed =
    attempts.length > 0 && attempts.every((attempt) => attempt.status === "failed");
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

  const tested = attempts.filter((attempt) => attempt.testsRun > 0);

  // Verified means something ran and passed. Finishing is not verifying, and
  // this is the boundary that decides whether green may appear at all.
  return tested.length > 0 && tested.every((attempt) => attempt.green === true)
    ? "verified"
    : "changed-unverified";
};

export const composeMission = (
  state: MissionState,
  facts: { agents: number; changed: number; verified: boolean },
): MissionComposition => {
  const base = { state, showRecovery: false };

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
        headline: "Stopped before it changed anything",
        detail: "Read why, then send it back in with more to go on.",
      };
  }
};
