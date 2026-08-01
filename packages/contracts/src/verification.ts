import type { SessionEvent } from "./contracts.ts";

/**
 * What "verified" means, once, for every screen and every artifact.
 *
 * This function exists because the rule had been written four times and three
 * of them were wrong in the same direction — too generous. The receipt counted
 * four kinds of check and refused a stale one; the inbox counted only tests
 * and had no staleness rule; the mission record had a third copy; and the host
 * Workroom had a fourth that also summed a fork's passing tests into its
 * parent. So one mission could be green in the header, amber in the inbox, and
 * frozen as `unverified` the moment somebody finished it — the product
 * contradicting itself about the single claim it exists to make.
 *
 * The rule, in full:
 *
 * 1. **Every checker counts, not only tests.** `run_tests`, `run_build` and
 *    `run_diagnostics` each have their own word for passing — `passed`,
 *    `succeeded`, `ok` — and they are mapped onto one vocabulary here. A
 *    mission verified by a clean typecheck is verified.
 * 2. **A known failure outranks a missing one.** `failing` is a fact and
 *    `unverified` is the absence of one, so reporting the absence would hide
 *    the fact.
 * 3. **Stale-and-green is not verified.** A check that ran before the final
 *    edit describes a tree that no longer exists and cannot vouch for the diff
 *    it is attached to. When nothing changed there is nothing to go stale, and
 *    a passing check still counts.
 *
 * Completion is never an input. A run ending says the machine stopped, and
 * this repository has twice shipped a screen that read that as success.
 */

export type VerificationVerdict = "verified" | "failing" | "unverified";

export type VerificationReading = {
  verdict: VerificationVerdict;
  /** How many checks ran at all, so a surface can tell stale from absent. */
  checksRun: number;
  checksPassed: number;
  /** Distinct paths this scope changed. */
  filesChanged: number;
  /**
   * Whether the last check followed the last change.
   *
   * Null when either side never happened, which is not the same as false: "no
   * check has run" and "a check ran too early" are different things to tell
   * somebody, and only the second is worth re-running the suite over.
   */
  checksFollowedFinalChange: boolean | null;
};

export type VerificationScope = {
  /** Restrict to one run. Omit to read a whole mission. */
  runId?: string | undefined;
  /**
   * Runs to leave out — in practice a session's forks.
   *
   * A fork runs in its own worktree against its own checkpoint, so its passing
   * suite says nothing about the parent's tree. Folding one in is how a
   * mission whose baseline was never tested came to show a green banner.
   */
  excludeRunIds?: ReadonlySet<string> | undefined;
};

/**
 * Whether a completed tool call was a check, and whether it passed.
 *
 * Null for anything that is not a check. Each checker's own field name is
 * honoured rather than normalised upstream, so adding a checker is a change
 * here and nowhere else.
 */
const checkOutcome = (
  result: Extract<SessionEvent, { type: "tool.completed" }>["payload"]["result"],
): boolean | null => {
  switch (result.name) {
    case "run_tests":
      return result.output.passed;
    case "run_build":
      return result.output.succeeded;
    case "run_diagnostics":
      return result.output.ok;
    default:
      return null;
  }
};

export const readVerification = (
  events: readonly SessionEvent[],
  scope: VerificationScope = {},
): VerificationReading => {
  const paths = new Set<string>();
  let lastChange: number | undefined;
  let lastCheck: number | undefined;
  let checksRun = 0;
  let checksPassed = 0;

  for (const event of events) {
    if (
      event.type !== "tool.completed" &&
      event.type !== "harness.changes_observed"
    ) {
      continue;
    }

    // Scoping happens before anything is counted rather than after — a fork's
    // check filtered out of the totals but left in `lastCheck` would still
    // un-stale the parent, which is the same bug wearing a different hat.
    const { runId } = event.payload;

    if (scope.runId !== undefined && runId !== scope.runId) {
      continue;
    }

    if (scope.excludeRunIds?.has(runId) === true) {
      continue;
    }

    // What an external harness did to the tree. Counted as a change for
    // staleness even though Novus never saw the patch: a suite that ran before
    // Claude Code edited five files is exactly as stale as one that ran before
    // `apply_patch` did, and only this family records the former.
    if (event.type === "harness.changes_observed") {
      for (const file of event.payload.files) {
        paths.add(file.path);
      }

      if (event.payload.files.length > 0) {
        lastChange = event.sequence;
      }

      continue;
    }

    const { result } = event.payload;

    // Only an applied patch changed the tree. A proposal is a preview, and
    // counting one would make a mission look edited by work nobody accepted.
    if (result.name === "apply_patch") {
      paths.add(result.output.path);
      lastChange = event.sequence;
    }

    const passed = checkOutcome(result);

    if (passed !== null) {
      checksRun += 1;
      checksPassed += passed ? 1 : 0;
      lastCheck = event.sequence;
    }
  }

  const checksFollowedFinalChange =
    lastCheck === undefined || lastChange === undefined
      ? null
      : lastCheck > lastChange;
  const checksAreCurrent =
    lastCheck !== undefined && (lastChange === undefined || lastCheck > lastChange);

  return {
    verdict:
      checksPassed < checksRun
        ? "failing"
        : checksAreCurrent
          ? "verified"
          : "unverified",
    checksRun,
    checksPassed,
    filesChanged: paths.size,
    checksFollowedFinalChange,
  };
};
