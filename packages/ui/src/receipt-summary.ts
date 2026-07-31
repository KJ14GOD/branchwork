import type { RunReceipt } from "@novus/contracts";

/**
 * How a run's receipt reads on screen.
 *
 * Pulled out of `event-row.tsx` so it can be tested. The rule it enforces is
 * the one STEERING calls load-bearing — **completion is not verification** —
 * and a rule that only exists inside a JSX branch is a rule nothing can check.
 * Every other pure module in this package (`diff.ts`, `tool-results.ts`) is
 * split from its component for the same reason.
 */
export type ReceiptSummary = {
  /** What the checks say. Never what the run's status says. */
  verdict: string;
  /** What it cost, or that nobody could count it. Never a fabricated zero. */
  spend: string;
  /**
   * Which of the row's three tones to paint.
   *
   * `unverified` is deliberately its own tone rather than folding into
   * `muted`. Muted is the colour of "nothing to see here", and a completed
   * run that nothing checked is the opposite of that — it is the row a
   * reviewer most needs to not skim past.
   */
  tone: "muted" | "unverified" | "error";
  /** The row's fields, in the order a reviewer reads them. */
  parts: string[];
};

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The dollar figure, or an admission that there is not one.
 *
 * Null is not zero and must never be rendered as it: a run reported as
 * costing $0.00 because nobody published a rate for its model is a worse
 * answer than one that says it does not know. Sub-cent runs are the ordinary
 * case, so precision follows magnitude — two decimals would round every real
 * figure in a normal session to nothing.
 */
export const formatSpend = (
  costUsd: number | null,
  callsMissingUsage: number,
): string => {
  if (costUsd === null) {
    return "Cost not counted";
  }

  // A floor, not a total: some call's adapter reported no usage, so the true
  // figure is at least this. Saying so is the difference between a number and
  // a confident number that is quietly short.
  const floor = callsMissingUsage > 0 ? "≥" : "";
  // Ten cents, not one. A four-cent run is an ordinary run, and two decimals
  // renders it "$0.04" — which reads as noise rather than as a figure, and
  // makes two runs an order of magnitude apart in cost look identical.
  const amount = costUsd < 0.1 ? costUsd.toFixed(4) : costUsd.toFixed(2);

  return `${floor}$${amount}`;
};

export const summariseReceipt = (receipt: RunReceipt): ReceiptSummary => {
  const failed = receipt.checks.filter((check) => !check.passed);
  const kinds = [...new Set(receipt.checks.map((check) => check.kind))];
  const tokens = receipt.usage.inputTokens + receipt.usage.outputTokens;

  // Read off `receipt.verification` rather than re-derived here. The receipt
  // already decided, and a second opinion computed in a renderer is how the
  // screen and the record drift until they disagree about the same run.
  const verdict =
    receipt.verification === "failing"
      ? `${plural(failed.length, "check")} failed: ${[
          ...new Set(failed.map((check) => check.kind)),
        ].join(", ")}`
      : receipt.verification === "unverified"
        ? receipt.checks.length === 0
          ? "Unverified — nothing was run against these changes"
          : "Unverified — the checks ran before the last change"
        : `Verified — ${kinds.join(", ")} passed`;

  const spend = formatSpend(receipt.usage.costUsd, receipt.usage.callsMissingUsage);

  return {
    verdict,
    spend,
    tone:
      receipt.verification === "failing"
        ? "error"
        : receipt.verification === "unverified"
          ? "unverified"
          : "muted",
    // Leads with what a reviewer checks first: did it change anything, did the
    // checks agree, and what did it cost.
    parts: [
      `${plural(receipt.filesChanged.length, "file")} changed`,
      verdict,
      spend,
      plural(receipt.usage.modelCalls, "model call"),
      // "Effective" because cached tokens are counted at what they bill — a
      // tenth for a cache read — so this is spend, not a raw count.
      `${receipt.usage.callsMissingUsage > 0 ? "≥" : ""}${tokens} effective tokens`,
      `${Math.round(receipt.elapsedMs / 100) / 10}s`,
    ],
  };
};
