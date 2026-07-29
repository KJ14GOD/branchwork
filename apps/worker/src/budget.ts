/**
 * What actually stops a run.
 *
 * The loop was bounded by a step count, which is the wrong question asked
 * confidently. A step ceiling stops a run that is going well for the same
 * reason it stops one that is stuck — the number says nothing about which — so
 * raising it to fit a harder task is the only available response, and that
 * makes it useless as a safety limit at exactly the moment it matters.
 *
 * V1_README already says what the bounds should be: a run "may use many model
 * turns, but it must remain cancellable and bounded by explicit time, cost,
 * token, failure, and emergency-step policies". Those measure things a person
 * actually cares about. Tokens are what a run costs. Wall time is what a person
 * waits. Consecutive failures are what distinguishes correcting from looping.
 * Steps are the emergency backstop, set far above any real trajectory, and are
 * the last thing that should ever be the reason a run ended.
 *
 * A harness should work until the job is done or something real runs out.
 */

export type RunBudget = {
  /** Provider tokens, in and out. Null lets a run cost whatever it costs. */
  totalTokens: number | null;
  /** Wall-clock milliseconds from the first model call. */
  wallClockMs: number | null;
  /**
   * Consecutive failed tool calls.
   *
   * The one bound that is about behaviour rather than resources: an agent that
   * cannot recover after this many tries in a row is repeating itself, and
   * every further turn costs money to learn nothing.
   */
  consecutiveFailures: number;
  /**
   * Emergency only.
   *
   * Deliberately far above any observed trajectory — the small-feature
   * benchmark's real run took sixteen. This exists so a pathological loop that
   * somehow avoids the failure counter cannot bill forever, not to shape how
   * much work a run may do.
   */
  maxModelCalls: number;
};

export const DEFAULT_RUN_BUDGET: RunBudget = {
  totalTokens: 2_000_000,
  wallClockMs: 30 * 60 * 1000,
  consecutiveFailures: 3,
  maxModelCalls: 500,
};

export type BudgetUsage = {
  modelCalls: number;
  totalTokens: number;
  consecutiveFailures: number;
  startedAt: number;
};

/**
 * Which limit a run has reached, or null when it may continue.
 *
 * Returns the reason rather than a boolean, because "the run stopped" is not
 * something a receipt can be written from. A person reading it later needs to
 * know whether they ran out of money, ran out of patience, or watched an agent
 * fail the same call three times.
 */
export const budgetExhausted = (
  budget: RunBudget,
  usage: BudgetUsage,
  now: number,
): string | null => {
  if (usage.consecutiveFailures >= budget.consecutiveFailures) {
    return `stopped after ${usage.consecutiveFailures} consecutive tool failures — the agent was repeating itself rather than recovering`;
  }

  if (budget.totalTokens !== null && usage.totalTokens >= budget.totalTokens) {
    return `stopped at ${usage.totalTokens} tokens, the limit for this run`;
  }

  if (
    budget.wallClockMs !== null &&
    now - usage.startedAt >= budget.wallClockMs
  ) {
    return `stopped after ${Math.round((now - usage.startedAt) / 1000)}s, the time limit for this run`;
  }

  if (usage.modelCalls >= budget.maxModelCalls) {
    return `stopped at the ${budget.maxModelCalls}-call emergency ceiling without finishing — this is a backstop, so reaching it means something looped`;
  }

  return null;
};
