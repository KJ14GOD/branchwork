import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";

/**
 * What has actually been proven about this mission's changes.
 *
 * Read from the log first, and from the comparison only where the comparison
 * knows more. That order is the whole point of this module. The screen used to
 * compute its verdict from `comparison.attempts` alone, so a mission with one
 * workstream — which is most missions — reported `verified: null` no matter how
 * many test runs were on its own log: `/compare` only ever describes the
 * baseline and the approaches forked from it, and a session that never forked
 * had nothing in it the moment the fetch was slow, refused, or simply behind.
 * The evidence panel then said "Nothing has verified these changes" directly
 * underneath a feed saying "Tests passed", which is the product asserting the
 * opposite of its own record.
 *
 * `run_tests` completions are the same events `projectSession` folds into
 * `RunProjection.tests`, so the two derivations agree by construction rather
 * than by luck — and because fork runs append to this same session log, the log
 * total already covers every approach the comparison would have counted. The
 * comparison is consulted anyway, and the larger figure wins, so a future
 * source of verification the renderer cannot see still counts.
 */

export type Verification = {
  /**
   * Three values, never two. Null means nothing ran, which is not the same
   * fact as a check that ran and failed, and colouring it either way would be
   * the product claiming something nobody measured.
   */
  verified: boolean | null;
  testsRun: number;
  testsPassed: number;
  /** Paths more than one approach changed. Only the comparison knows these. */
  contested: string[];
};

export const readVerification = (
  events: readonly SessionEvent[],
  comparison: Comparison | null,
): Verification => {
  let testsRun = 0;
  let testsPassed = 0;

  for (const event of events) {
    if (
      event.type === "tool.completed" &&
      event.payload.result.name === "run_tests"
    ) {
      testsRun += 1;

      if (event.payload.result.output.passed) {
        testsPassed += 1;
      }
    }
  }

  const attempts = comparison?.attempts ?? [];
  const comparedRun = attempts.reduce(
    (total, attempt) => total + attempt.testsRun,
    0,
  );

  if (comparedRun > testsRun) {
    testsRun = comparedRun;
    testsPassed = attempts.reduce(
      (total, attempt) => total + attempt.testsPassed,
      0,
    );
  }

  return {
    verified: testsRun === 0 ? null : testsPassed === testsRun,
    testsRun,
    testsPassed,
    contested: comparison?.contestedPaths ?? [],
  };
};
