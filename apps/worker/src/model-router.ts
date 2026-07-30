import type { ModelSelection } from "@novus/contracts";

import type {
  ModelRouter,
  ModelRoutingRequest,
  RoutedSelection,
} from "./model.ts";
import { callCostUsd, ratesFor, type PricingTable } from "./pricing.ts";

/**
 * The real model router: three capability tiers of one provider, chosen per
 * turn from signals the harness can actually compute.
 *
 * What it routes on, and why each signal is real:
 *
 * - THE GOAL'S SHAPE. Whether the words read as broad exploration (explain,
 *   investigate, "why does…", a repository-scale refactor, a multi-paragraph
 *   brief) or as a focused task. Lexical and deterministic — a handful of
 *   named patterns, each with a stated justification, not a pretend
 *   difficulty model. The verdict and the matched evidence go into the
 *   recorded reason.
 * - WHETHER THE PREVIOUS RUN FAILED. Read from this session's own log. A goal
 *   arriving after a failure is usually the same problem back again, so the
 *   router escalates one tier rather than repeating the tier that just
 *   failed. This is the only shard of "historical success" that exists today;
 *   see ModelRoutingRequest for why the rest is absent.
 * - A CONFIGURED COST BUDGET, weighed against context size. When the operator
 *   set a per-run ceiling, the router estimates what one worst-case call
 *   would cost at the chosen tier given the context the session is carrying,
 *   and steps down while a cheaper tier fits. Without a budget, context size
 *   changes nothing — a threshold that moved selections without an operator
 *   asking for cost control would be an invented preference.
 *
 * What it deliberately does NOT do: pretend to weigh historical success it
 * has never measured, latency it has only just started recording, or policy
 * and eval stores that do not exist. Those arrive through ModelRoutingRequest
 * when their data does.
 *
 * The shipped tiers are Anthropic-only because Anthropic credentials are what
 * this host has. The router can EXPRESS any provider — tiers are plain
 * ModelSelections, so an OpenAI tier is configuration, not new code — but no
 * shipped policy guesses at models it cannot run.
 */

export type RoutingTiers = {
  /** Cheapest tier: focused, well-specified work. */
  fast: ModelSelection;
  /** The reasoning workhorse: broad exploration, and the escalation from fast. */
  deep: ModelSelection;
  /** The most capable tier, at twice the deep tier's price: reached only by
   *  escalation (or an explicit human choice — which never comes through the
   *  router at all). */
  max: ModelSelection;
};

/**
 * Model ids confirmed against Anthropic's live catalogue (all three are
 * served, 1M-token context, 128K output; sonnet $3/$15, opus $5/$25, fable
 * $10/$50 per MTok as of 2026-06-24 — see pricing.ts). Capability and price
 * are what separate the tiers; context window does not, so nothing here
 * routes on it.
 */
export const ANTHROPIC_ROUTING_TIERS: RoutingTiers = {
  fast: { provider: "anthropic", model: "claude-sonnet-5" },
  deep: { provider: "anthropic", model: "claude-opus-5" },
  max: { provider: "anthropic", model: "claude-fable-5" },
};

export type GoalReading = {
  shape: "broad" | "focused";
  /** The matched signal, quoted in the recorded reason. */
  evidence: string;
};

/**
 * Each pattern is one stated, testable claim about goal text. The list is
 * short on purpose: every entry must be defensible on its own, because its
 * `describes` string ends up in the session log as part of the reason.
 */
const BROAD_SIGNALS: readonly { pattern: RegExp; describes: string }[] = [
  {
    // A goal that opens as a question wants an explanation, and producing one
    // means reading widely before writing anything.
    pattern: /^\s*(why|how|what|where|which|who|when)\b/i,
    describes: "opens as a question",
  },
  {
    // Exploration verbs: the deliverable is understanding, not a diff.
    pattern:
      /\b(explain|understand|investigate|explore|audit|review|analy[sz]e|summari[sz]e|trace|diagnose|debug)\b/i,
    describes: "asks for exploration",
  },
  {
    // Cross-cutting change verbs: the working set is many files at once.
    pattern:
      /\b(refactor|redesign|re-?architect|restructure|migrate|overhaul|rewrite)\b/i,
    describes: "asks for a cross-cutting change",
  },
  {
    // Repository-scale nouns: the goal names the whole codebase as its scope.
    pattern:
      /\b(architecture|codebase|whole (repo|repository|project)|entire (repo|repository|project|codebase))\b/i,
    describes: "names repository-scale scope",
  },
  {
    // Diagnosis: finding a cause is exploration even when phrased imperatively.
    pattern:
      /\bfind\b[\s\S]*\b(cause|bug|leak|race|deadlock|regression|bottleneck)\b/i,
    describes: "asks for a diagnosis",
  },
];

/**
 * A goal this long is a brief, and a brief describes a run measured in many
 * model calls. Length is a proxy for task size and claims to be nothing more
 * — but it is a real, computable one: nobody writes 1,500 characters to ask
 * for a typo fix.
 */
const LONG_BRIEF_CHARS = 1_500;

/**
 * Broad exploration or a focused task. Two shapes, not three: a narrow edit
 * ("fix the typo in README") and an ordinary well-specified task route the
 * same way, so a narrow/standard distinction would be a category that never
 * changes the answer — decoration, not a signal.
 */
export const readGoal = (goal: string): GoalReading => {
  for (const signal of BROAD_SIGNALS) {
    if (signal.pattern.test(goal)) {
      return { shape: "broad", evidence: signal.describes };
    }
  }

  if (goal.length >= LONG_BRIEF_CHARS) {
    return {
      shape: "broad",
      evidence: `is a ${goal.length}-character brief`,
    };
  }

  return { shape: "focused", evidence: "no exploration signals" };
};

// Cost estimation for the budget rule. Both constants are stated worst-case
// bounds, not measurements dressed up as precision:
// ~4 characters per token is the coarse industry rule of thumb for English
// and code; the overhead covers the system prompt and tool schemas every
// call carries; 8,192 output tokens is the adapter's own max_tokens, the
// most one call can possibly emit.
const CHARS_PER_TOKEN = 4;
const CALL_OVERHEAD_TOKENS = 3_000;
const WORST_CASE_OUTPUT_TOKENS = 8_192;

const TIER_ORDER = ["fast", "deep", "max"] as const;

type TierName = (typeof TIER_ORDER)[number];

export class SignalModelRouter implements ModelRouter {
  private readonly tiers: RoutingTiers;
  private readonly pricing: PricingTable;

  constructor(tiers: RoutingTiers, pricing: PricingTable) {
    this.tiers = tiers;
    this.pricing = pricing;
  }

  select(request: ModelRoutingRequest): RoutedSelection {
    const reading = readGoal(request.goal);
    const notes: string[] = [];

    // Rule 1 — shape. Focused work goes to the cheapest tier because the fast
    // tier genuinely handles it (near-deep-tier coding quality at 60% of the
    // price, per the provider's own positioning), and because defaulting up
    // "to be safe" is how a harness burns $40 overnight. Broad exploration
    // goes to the deep tier, whose reasoning is what such goals are buying.
    let tier: TierName = reading.shape === "broad" ? "deep" : "fast";

    notes.push(
      reading.shape === "broad"
        ? `the goal ${reading.evidence}, so it routes as broad exploration`
        : `the goal reads as a focused task (${reading.evidence})`,
    );

    // Rule 2 — escalate after a failure. Never above max, and never for the
    // empty goal (session bootstrap asks "what would you pick" with no task).
    if (request.lastRunFailed === true && request.goal !== "") {
      const escalated: TierName = tier === "fast" ? "deep" : "max";

      if (escalated !== tier) {
        notes.push(
          "escalated one tier because this session's previous run failed",
        );
        tier = escalated;
      }
    }

    // Rule 3 — the configured budget caps the tiers, never raises them. The
    // estimate is one worst-case call at the context the session carries; if
    // that alone exceeds the ceiling, a cheaper tier that fits is the honest
    // choice, said so in the reason. A tier without pricing cannot be judged
    // here at all — the budget bound in budget.ts refuses such a run outright
    // rather than letting an uncountable ceiling pretend to be enforced, so
    // the router does not duplicate that refusal.
    const budget = request.costBudgetUsd;

    if (budget !== null && budget !== undefined) {
      while (tier !== "fast") {
        const estimate = this.estimatedCallUsd(
          this.tiers[tier],
          request.contextChars ?? 0,
        );

        if (estimate === null || estimate <= budget) {
          break;
        }

        const cheaper: TierName = tier === "max" ? "deep" : "fast";

        notes.push(
          `stepped down from ${this.tiers[tier].model}: one worst-case call there could cost ~$${estimate.toFixed(2)} against the $${budget} run budget`,
        );
        tier = cheaper;
      }
    }

    return {
      selection: this.tiers[tier],
      source: "router",
      reason: notes.join("; "),
    };
  }

  private estimatedCallUsd(
    tier: ModelSelection,
    contextChars: number,
  ): number | null {
    const rates = ratesFor(this.pricing, tier);

    if (rates === null) {
      return null;
    }

    return callCostUsd(rates, {
      inputTokens:
        Math.ceil(contextChars / CHARS_PER_TOKEN) + CALL_OVERHEAD_TOKENS,
      outputTokens: WORST_CASE_OUTPUT_TOKENS,
    });
  }
}
