import { readFileSync } from "node:fs";

import { z } from "zod";
import type { ModelSelection } from "@novus/contracts";

import type { ModelUsage } from "./model.ts";

/**
 * What a model bills per million tokens, and when that was last true.
 *
 * Pricing is configuration, not code: a rate hardcoded in an adapter goes
 * stale the day the provider changes its price list, and a stale number in a
 * receipt — the artifact people trust when they were not watching — is worse
 * than no number. So rates live in one table, every figure derived from them
 * carries the rates and their `asOf` date alongside, and an operator updates
 * them with a JSON file (NOVUS_MODEL_PRICING) rather than a code change.
 *
 * `asOf` is the date the rate was last confirmed against the provider's
 * published price list — it is what lets a reader of an old receipt judge
 * whether the dollar figure inside it was computed from rates that were
 * current at the time.
 */
export type ModelRates = {
  /** USD per million full-price-equivalent input tokens. */
  inputPerMTokUsd: number;
  /** USD per million output tokens. */
  outputPerMTokUsd: number;
  /** ISO date the rates were last confirmed against the provider's price list. */
  asOf: string;
};

/** Keyed by `${provider}/${model}` — the same pair ModelSelection carries. */
export type PricingTable = ReadonlyMap<string, ModelRates>;

const ModelRatesSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
  asOf: z.string().min(1),
});

// The override file is an object of "provider/model" keys, same shape as the
// defaults below. Validated at the boundary because a malformed price is not a
// crash — it is a wrong dollar figure presented as evidence, which is quieter
// and worse.
const PricingFileSchema = z.record(
  z.string().regex(/^[^/]+\/.+$/, {
    message: 'Pricing keys are "provider/model", e.g. "anthropic/claude-opus-5".',
  }),
  ModelRatesSchema,
);

/**
 * Anthropic's published first-party rates, confirmed 2026-06-24.
 *
 * Only the three models the shipped router selects between. Anything else —
 * an OpenAI model, a future Anthropic id — is deliberately absent rather than
 * guessed: `ratesFor` returns null for it, cost is reported as unknown, and a
 * receipt says nothing instead of something wrong.
 *
 * claude-sonnet-5 has an introductory rate ($2/$10 per MTok) through
 * 2026-08-31. The sticker rate is shipped here because it is the one that
 * outlives the promotion, so the default errs toward overstating cost rather
 * than silently understating it after September. An operator who wants the
 * introductory rate reflected sets it in NOVUS_MODEL_PRICING until then —
 * which is exactly the "prices changed, update the config" path working as
 * intended.
 */
export const DEFAULT_MODEL_PRICING: PricingTable = new Map<string, ModelRates>([
  [
    "anthropic/claude-sonnet-5",
    { inputPerMTokUsd: 3, outputPerMTokUsd: 15, asOf: "2026-06-24" },
  ],
  [
    "anthropic/claude-opus-5",
    { inputPerMTokUsd: 5, outputPerMTokUsd: 25, asOf: "2026-06-24" },
  ],
  [
    "anthropic/claude-fable-5",
    { inputPerMTokUsd: 10, outputPerMTokUsd: 50, asOf: "2026-06-24" },
  ],
]);

/**
 * The pricing table this process runs with: the defaults, with any entries
 * from the JSON file named by NOVUS_MODEL_PRICING laid over them.
 *
 * Merge is per model, not whole-table replacement, so correcting one price
 * does not require restating the others — but note the flip side: entries you
 * did not override keep the shipped defaults and their shipped `asOf`, which
 * every receipt records, so a stale default is at least a *visible* one.
 *
 * A file that cannot be read or does not validate throws with the path and
 * the reason. This is a boot-time failure on purpose: a pricing override that
 * silently fell back to defaults would produce dollar figures the operator
 * explicitly asked to change.
 */
export const loadPricing = (
  env: NodeJS.ProcessEnv = process.env,
): PricingTable => {
  const path = env.NOVUS_MODEL_PRICING?.trim();

  if (!path) {
    return DEFAULT_MODEL_PRICING;
  }

  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `NOVUS_MODEL_PRICING points at ${path}, which could not be read: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `NOVUS_MODEL_PRICING file ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const validated = PricingFileSchema.safeParse(parsed);

  if (!validated.success) {
    const issue = validated.error.issues[0];

    throw new Error(
      `NOVUS_MODEL_PRICING file ${path} is not a pricing table: ${issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "unknown shape"}`,
    );
  }

  const merged = new Map(DEFAULT_MODEL_PRICING);

  for (const [key, rates] of Object.entries(validated.data)) {
    merged.set(key, rates);
  }

  return merged;
};

/** The rates for a selection, or null when nothing is configured for it. */
export const ratesFor = (
  table: PricingTable,
  selection: ModelSelection,
): ModelRates | null =>
  table.get(`${selection.provider}/${selection.model}`) ?? null;

/**
 * What one model call cost, in USD.
 *
 * This multiplies `inputPerMTokUsd` by ModelUsage's `inputTokens` — which is a
 * FULL-PRICE-EQUIVALENT count, not a raw one. The Anthropic adapter folds
 * prompt-cache reads and writes into that number using the provider's own
 * billing ratios (a cache read bills at 0.1x a full-price input token, a
 * five-minute-TTL cache write at 1.25x — see responseFromMessage in
 * anthropic-model.ts), so base-rate-times-equivalent-tokens reproduces the
 * blended bill exactly. pricing.test.ts proves the identity with numbers.
 *
 * Do NOT add separate cache-read/cache-write rates to this table. The
 * discount is already inside the token count; pricing it again here would
 * double-count it. If an adapter ever reports raw tokens with separate cache
 * counts, ModelUsage's contract is what has to change first, and this
 * function with it.
 */
export const callCostUsd = (rates: ModelRates, usage: ModelUsage): number =>
  (usage.inputTokens * rates.inputPerMTokUsd +
    usage.outputTokens * rates.outputPerMTokUsd) /
  1_000_000;
