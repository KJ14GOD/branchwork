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
): AttemptComparison => {
  const testsPassed = run.tests.filter((test) => test.passed).length;

  return {
    runId: run.runId,
    label,
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

export const compareAttempts = (
  sessionId: string,
  events: readonly SessionEvent[],
  attempts: readonly { runId: string; label: string }[],
): Comparison => {
  const projected = projectSession(sessionId, events);
  const compared: AttemptComparison[] = [];

  for (const attempt of attempts) {
    const run = projected.runs.find((entry) => entry.runId === attempt.runId);

    if (run) {
      compared.push(compareAttempt(run, attempt.label));
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
