import type { DecisionOutcome, SessionEvent } from "@novus/contracts";

import { projectSession, type RunProjection } from "./projection.ts";

/**
 * Two attempts, side by side, on evidence rather than presentation.
 *
 * V1's wedge is that a human picks between forks using diffs, tests, cost and
 * time — not by reading which agent wrote the more confident summary. So this
 * deliberately does not rank them and does not recommend one. It lines up the
 * facts and says where they differ, and the choice stays where V1 puts it: with
 * a person.
 *
 * Built on the projection, so a comparison of a live session and a comparison of
 * the same session replayed are the same value. Anything derived a second way
 * would eventually disagree with the timeline it sits next to.
 */

export type AttemptComparison = {
  runId: string;
  label: string;
  /** The execution the alternatives branched from. At most one, never a rank. */
  baseline: boolean;
  status: RunProjection["status"];
  summary: string | null;
  failure: string | null;
  filesChanged: RunProjection["filesChanged"];
  /** Net lines added and removed across every file this attempt touched. */
  additions: number;
  deletions: number;
  toolCalls: number;
  testsRun: number;
  testsPassed: number;
  /**
   * Whether every test this attempt ran passed.
   *
   * Null when it ran none — which is not the same as passing, and a compare
   * screen that showed a tick for it would be telling somebody their untested
   * attempt was verified.
   */
  green: boolean | null;
};

export type Comparison = {
  attempts: AttemptComparison[];
  /** Paths more than one attempt changed. Where the attempts genuinely disagree. */
  contestedPaths: string[];
  /** Paths only one attempt changed, by run id. */
  uniquePaths: Record<string, string[]>;
  /** The most recent choice recorded for this session, or null if none yet. */
  decision: { runId: string; outcome: DecisionOutcome } | null;
};

const compareAttempt = (
  run: RunProjection,
  label: string,
  baseline: boolean,
): AttemptComparison => {
  const testsPassed = run.tests.filter((test) => test.passed).length;

  return {
    runId: run.runId,
    label,
    baseline,
    status: run.status,
    summary: run.summary,
    failure: run.failure,
    filesChanged: run.filesChanged,
    additions: run.filesChanged.reduce((total, file) => total + file.additions, 0),
    deletions: run.filesChanged.reduce((total, file) => total + file.deletions, 0),
    toolCalls: run.toolCalls,
    testsRun: run.tests.length,
    testsPassed,
    green: run.tests.length === 0 ? null : testsPassed === run.tests.length,
  };
};

/**
 * Which run the alternatives are alternatives to.
 *
 * A fork branches from a checkpoint of one specific run, so when forks exist
 * the honest baseline is the run they branched from — not simply the newest
 * one. Forking at turn three and then continuing the parent to turn four would
 * otherwise line the fork up against work it never saw.
 *
 * With no forks yet there is nothing to have branched from, and the baseline is
 * the latest run: the work currently in flight, which is exactly what a first
 * alternative would be compared against.
 */
const baselineRunId = (
  projected: ReturnType<typeof projectSession>,
  forks: readonly { runId: string; parentRunId: string }[],
): string | null => {
  const branchedFrom = forks.at(-1)?.parentRunId;

  if (branchedFrom !== undefined) {
    return branchedFrom;
  }

  return projected.runs.at(-1)?.runId ?? null;
};

export const compareAttempts = (
  sessionId: string,
  events: readonly SessionEvent[],
  forks: readonly { runId: string; label: string; parentRunId: string }[],
): Comparison => {
  const projected = projectSession(sessionId, events);
  const compared: AttemptComparison[] = [];

  // The baseline leads because it is the work in flight, not because it is
  // winning. Ordering is the one ranking signal a screen gives away for free,
  // so the alternatives that follow stay in the order they were created rather
  // than in any order derived from their evidence.
  const baseline = baselineRunId(projected, forks);
  const forkIds = new Set(forks.map((fork) => fork.runId));
  const baselineRun =
    baseline !== null && !forkIds.has(baseline)
      ? projected.runs.find((entry) => entry.runId === baseline)
      : undefined;

  if (baselineRun) {
    compared.push(compareAttempt(baselineRun, "Baseline", true));
  }

  for (const attempt of forks) {
    const run = projected.runs.find((entry) => entry.runId === attempt.runId);

    if (run) {
      compared.push(compareAttempt(run, attempt.label, false));
      continue;
    }

    // No projected run means run.started never landed for this attempt — a
    // fork whose run failed before it could begin (no model adapter, a
    // worktree that vanished between creation and start). The failure is in
    // the log as run.failed under the fork's preassigned id; the projection
    // ignores a terminal event for a run it never saw start, so it has to be
    // read directly here. Dropping the attempt instead would leave a
    // reviewer looking at a fork they made that simply is not on the screen.
    const failed = events.find(
      (event) =>
        event.sessionId === sessionId &&
        event.type === "run.failed" &&
        event.payload.runId === attempt.runId,
    );

    if (failed?.type === "run.failed") {
      compared.push({
        runId: attempt.runId,
        label: attempt.label,
        baseline: false,
        status: "failed",
        summary: null,
        failure: failed.payload.reason,
        filesChanged: [],
        additions: 0,
        deletions: 0,
        toolCalls: 0,
        testsRun: 0,
        testsPassed: 0,
        green: null,
      });
    }
  }

  // Which files more than one attempt touched. This is the part a reviewer
  // actually needs: two attempts that changed different files are not really
  // competing, and two that changed the same one have to be chosen between.
  const touchedBy = new Map<string, string[]>();

  for (const attempt of compared) {
    for (const file of attempt.filesChanged) {
      touchedBy.set(file.path, [
        ...(touchedBy.get(file.path) ?? []),
        attempt.runId,
      ]);
    }
  }

  const contestedPaths = [...touchedBy.entries()]
    .filter(([, runIds]) => runIds.length > 1)
    .map(([path]) => path)
    .sort();

  const uniquePaths: Record<string, string[]> = {};

  for (const attempt of compared) {
    uniquePaths[attempt.runId] = attempt.filesChanged
      .filter((file) => (touchedBy.get(file.path) ?? []).length === 1)
      .map((file) => file.path)
      .sort();
  }

  // Latest by sequence, not first found: a host can decide more than once,
  // and the most recent choice is the one the screen should agree with.
  const decided = events
    .filter(
      (event): event is Extract<SessionEvent, { type: "decision.recorded" }> =>
        event.sessionId === sessionId && event.type === "decision.recorded",
    )
    .sort((first, second) => first.sequence - second.sequence)
    .at(-1);

  const decision = decided
    ? { runId: decided.payload.runId, outcome: decided.payload.outcome }
    : null;

  return { attempts: compared, contestedPaths, uniquePaths, decision };
};
