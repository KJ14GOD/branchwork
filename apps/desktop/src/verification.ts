import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";
import {
  readVerification as readSharedVerification,
  type VerificationVerdict,
} from "@novus/contracts/verification";

/**
 * What has actually been proven about this mission's changes.
 *
 * The rule itself is not here. It lives in `@novus/contracts/verification`,
 * shared with the receipt, the worker's frozen mission record and the inbox,
 * because it had been written four separate times and three of them had each
 * dropped a different clause. This module only decides *which events* the rule
 * is applied to, and translates the answer into what the panel renders.
 *
 * Reading the log at all is the fix this module originally landed: the screen
 * used to compute its verdict from `comparison.attempts` alone, so a mission
 * with one workstream — which is most missions — reported "nothing verified"
 * no matter how many test runs were on its own log, directly underneath a feed
 * saying "Tests passed". That part stands. What did not stand was the totals:
 * fork runs append to this same session log, so summing it unfiltered counted
 * an experimental attempt's passing suite as evidence about the parent's tree,
 * and `/compare` keeps those apart for exactly that reason.
 */

export type Verification = {
  /**
   * Three values, never two. Null means nothing ran, which is not the same
   * fact as a check that ran and failed, and colouring it either way would be
   * the product claiming something nobody measured.
   */
  verified: boolean | null;
  /**
   * Why it is not verified, when it is not.
   *
   * `stale` is a check that ran before the last edit — a suite somebody
   * watched go green, describing a tree that no longer exists. Saying "no
   * checks have run" to that person is exactly wrong, and it is the sentence
   * the two-state version of this type forced.
   */
  reason: "none-ran" | "stale" | null;
  checksRun: number;
  checksPassed: number;
  /** Paths more than one approach changed. Only the comparison knows these. */
  contested: string[];
};

const verdictToVerified = (verdict: VerificationVerdict): boolean | null =>
  verdict === "verified" ? true : verdict === "failing" ? false : null;

export const readVerification = (
  events: readonly SessionEvent[],
  comparison: Comparison | null,
): Verification => {
  // Forks are excluded rather than summed. An attempt runs in its own worktree
  // against its own checkpoint, so its passing suite proves nothing about the
  // tree this mission is about — and the reverse error is just as bad: a green
  // baseline reading unverified because an experimental fork went red.
  const forkRunIds = new Set(
    (comparison?.attempts ?? [])
      .filter((attempt) => !attempt.baseline)
      .map((attempt) => attempt.runId),
  );
  const reading = readSharedVerification(events, { excludeRunIds: forkRunIds });
  const verified = verdictToVerified(reading.verdict);

  return {
    verified,
    reason:
      verified !== null
        ? null
        : reading.checksRun === 0
          ? "none-ran"
          : "stale",
    checksRun: reading.checksRun,
    checksPassed: reading.checksPassed,
    contested: comparison?.contestedPaths ?? [],
  };
};
