/**
 * Rewards and preference pairs from the record (D-255). Pure: every input
 * is a projection the control plane already keeps, and every output names
 * the signals it came from, so a number in a dataset can be traced back to
 * the events that produced it. Where a signal is absent the field is null,
 * never zero — an unverified turn is not a failed one.
 */

export interface TrajectorySignals {
  executionId: string;
  workstreamId: string;
  checkpointSha: string | null;
  /** Checks that ran against this trajectory's checkpoint. */
  checks: { outcome: "passed" | "failed" | "skipped" | "errored" }[];
  /** Approvals answered during the turn: the person's own yes or no. */
  approvals: { answer: "approve" | "deny" }[];
  /** A decision that stood at some point, naming a lane and a checkpoint. */
  decisions: { workstreamId: string; checkpointSha: string; supersededAt: string | null }[];
  /** A revision asked for against this lane after the turn. */
  revisionRequested: boolean;
  /** The decided branch's fate on the host, once known. */
  pull: { state: "merged" | "closed" | "open" | "draft" } | null;
  /** How the turn ended. */
  exitOutcome: "completed" | "failed" | "interrupted" | "stopped" | null;
}

export interface RewardWeights {
  checksPassed: number;
  checksFailed: number;
  approvalDenied: number;
  decisionChosen: number;
  decisionPassedOver: number;
  revisionRequested: number;
  merged: number;
  closedUnmerged: number;
  turnFailed: number;
}

/** The weights, in one place, bounded to [-1, 1] after summing. */
export const DEFAULT_WEIGHTS: RewardWeights = {
  checksPassed: 0.4,
  checksFailed: -0.6,
  approvalDenied: -0.3,
  decisionChosen: 0.5,
  decisionPassedOver: -0.3,
  revisionRequested: -0.4,
  merged: 0.6,
  closedUnmerged: -0.4,
  turnFailed: -0.5
};

export interface Reward {
  /** Null when no signal at all touched this trajectory. */
  value: number | null;
  /** Which signals contributed, with their contribution, for the record. */
  signals: { name: keyof RewardWeights; contribution: number }[];
}

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

export function rewardOf(t: TrajectorySignals, weights: RewardWeights = DEFAULT_WEIGHTS): Reward {
  const signals: Reward["signals"] = [];
  const add = (name: keyof RewardWeights, times = 1) => {
    if (times > 0) signals.push({ name, contribution: weights[name] * times });
  };
  const ran = t.checks.filter((check) => check.outcome === "passed" || check.outcome === "failed");
  if (ran.length > 0) {
    const passed = ran.filter((check) => check.outcome === "passed").length;
    // The ratio, not the count: ten passing checks are one verified turn.
    if (passed === ran.length) add("checksPassed");
    else add("checksFailed", (ran.length - passed) / ran.length);
  }
  add("approvalDenied", t.approvals.filter((approval) => approval.answer === "deny").length > 0 ? 1 : 0);
  const standing = t.decisions.filter((decision) => decision.supersededAt === null);
  const chosenHere = standing.some((decision) => decision.workstreamId === t.workstreamId && decision.checkpointSha === t.checkpointSha);
  const passedOver = standing.length > 0 && !chosenHere && t.checkpointSha !== null;
  if (chosenHere) add("decisionChosen");
  if (passedOver) add("decisionPassedOver");
  if (t.revisionRequested) add("revisionRequested");
  if (chosenHere && t.pull?.state === "merged") add("merged");
  if (chosenHere && t.pull?.state === "closed") add("closedUnmerged");
  if (t.exitOutcome === "failed") add("turnFailed");
  if (signals.length === 0) return { value: null, signals };
  return { value: clamp(signals.reduce((sum, signal) => sum + signal.contribution, 0)), signals };
}

export interface LaneAtFork {
  workstreamId: string;
  /** The checkpoint the lanes share — the prompt's starting tree. */
  originSha: string;
  /** The lane's first trajectory after the fork: its completion. */
  completion: string | null;
}

export interface PreferencePair {
  originSha: string;
  chosenWorkstreamId: string;
  rejectedWorkstreamId: string;
  chosen: string;
  rejected: string;
}

/** Pairs from a decision between lanes forked at one checkpoint: the chosen
 *  lane's completion against each passed-over sibling's, same origin, same
 *  goal. A lane without a completion pairs with nobody. */
export function pairsOf(
  lanes: LaneAtFork[],
  standingDecision: { workstreamId: string } | null
): PreferencePair[] {
  if (!standingDecision) return [];
  const chosen = lanes.find((lane) => lane.workstreamId === standingDecision.workstreamId);
  if (!chosen || !chosen.completion) return [];
  return lanes
    .filter((lane) => lane.workstreamId !== chosen.workstreamId && lane.originSha === chosen.originSha && lane.completion)
    .map((lane) => ({
      originSha: chosen.originSha,
      chosenWorkstreamId: chosen.workstreamId,
      rejectedWorkstreamId: lane.workstreamId,
      chosen: chosen.completion!,
      rejected: lane.completion!
    }));
}
