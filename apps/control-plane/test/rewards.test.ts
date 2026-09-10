import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, pairsOf, rewardOf, type TrajectorySignals } from "../src/learning/rewards.ts";

const base: TrajectorySignals = {
  executionId: "exe_1",
  workstreamId: "wst_a",
  checkpointSha: "aaa",
  checks: [],
  approvals: [],
  decisions: [],
  revisionRequested: false,
  pull: null,
  exitOutcome: "completed"
};

describe("rewards from the record (D-255)", () => {
  it("is null with no signal, and names every signal it uses", () => {
    expect(rewardOf(base)).toEqual({ value: null, signals: [] });
    const verified = rewardOf({ ...base, checks: [{ outcome: "passed" }, { outcome: "passed" }] });
    expect(verified.value).toBe(DEFAULT_WEIGHTS.checksPassed);
    expect(verified.signals.map((signal) => signal.name)).toEqual(["checksPassed"]);
  });

  it("weighs failures by their share, and bounds the sum", () => {
    const half = rewardOf({ ...base, checks: [{ outcome: "passed" }, { outcome: "failed" }] });
    expect(half.value).toBeCloseTo(DEFAULT_WEIGHTS.checksFailed / 2);
    const worst = rewardOf({
      ...base,
      checks: [{ outcome: "failed" }],
      approvals: [{ answer: "deny" }],
      revisionRequested: true,
      exitOutcome: "failed"
    });
    expect(worst.value).toBe(-1);
  });

  it("reads the decision as chosen or passed over, and the merge only for the chosen lane", () => {
    const decisions = [{ workstreamId: "wst_a", checkpointSha: "aaa", supersededAt: null }];
    const chosen = rewardOf({ ...base, decisions, pull: { state: "merged" } });
    expect(chosen.signals.map((signal) => signal.name)).toEqual(["decisionChosen", "merged"]);
    const sibling = rewardOf({ ...base, workstreamId: "wst_b", checkpointSha: "bbb", decisions, pull: { state: "merged" } });
    expect(sibling.signals.map((signal) => signal.name)).toEqual(["decisionPassedOver"]);
    const superseded = rewardOf({ ...base, decisions: [{ ...decisions[0]!, supersededAt: "2026-09-10T00:00:00Z" }] });
    expect(superseded.value).toBeNull();
  });

  it("pairs the chosen lane against each passed-over sibling from the same origin", () => {
    const lanes = [
      { workstreamId: "wst_a", originSha: "o", completion: "A" },
      { workstreamId: "wst_b", originSha: "o", completion: "B" },
      { workstreamId: "wst_c", originSha: "o", completion: null },
      { workstreamId: "wst_d", originSha: "other", completion: "D" }
    ];
    expect(pairsOf(lanes, { workstreamId: "wst_a" })).toEqual([
      { originSha: "o", chosenWorkstreamId: "wst_a", rejectedWorkstreamId: "wst_b", chosen: "A", rejected: "B" }
    ]);
    expect(pairsOf(lanes, null)).toEqual([]);
    expect(pairsOf(lanes, { workstreamId: "wst_c" })).toEqual([]);
  });
});
