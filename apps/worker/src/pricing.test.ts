import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  callCostUsd,
  DEFAULT_MODEL_PRICING,
  loadPricing,
  ratesFor,
} from "./pricing.ts";

/**
 * Money math has to be exactly right or honestly absent — a receipt is the
 * artifact people trust when they were not watching, and the budget now stops
 * runs on these numbers.
 */

test("the shipped table prices exactly the three routed Anthropic models", () => {
  // Rates confirmed against Anthropic's published price list, 2026-06-24.
  // If these change, asOf must change with them — that date is what a reader
  // of an old receipt uses to judge the figure inside it.
  assert.deepEqual(
    ratesFor(DEFAULT_MODEL_PRICING, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    }),
    { inputPerMTokUsd: 3, outputPerMTokUsd: 15, asOf: "2026-06-24" },
  );
  assert.deepEqual(
    ratesFor(DEFAULT_MODEL_PRICING, {
      provider: "anthropic",
      model: "claude-opus-5",
    }),
    { inputPerMTokUsd: 5, outputPerMTokUsd: 25, asOf: "2026-06-24" },
  );
  assert.deepEqual(
    ratesFor(DEFAULT_MODEL_PRICING, {
      provider: "anthropic",
      model: "claude-fable-5",
    }),
    { inputPerMTokUsd: 10, outputPerMTokUsd: 50, asOf: "2026-06-24" },
  );
});

test("a model with no configured price gets null, never a guess", () => {
  // An OpenAI selection is expressible — the router interface can return one,
  // an operator can pin one — but its price is not known here, and a wrong
  // dollar figure is worse than none.
  assert.equal(
    ratesFor(DEFAULT_MODEL_PRICING, { provider: "openai", model: "gpt-x" }),
    null,
  );
  assert.equal(
    ratesFor(DEFAULT_MODEL_PRICING, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    }),
    null,
  );
});

test("cost is rate times tokens, per million", () => {
  const rates = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, asOf: "test" };

  // One million of each costs exactly the two per-MTok rates added together.
  assert.equal(
    callCostUsd(rates, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    18,
  );
  // A realistic call: 41k in, 3.4k out — the live bug-fix benchmark's shape.
  assert.equal(
    callCostUsd(rates, { inputTokens: 41_000, outputTokens: 3_400 }),
    (41_000 * 3 + 3_400 * 15) / 1_000_000,
  );
  assert.equal(callCostUsd(rates, { inputTokens: 0, outputTokens: 0 }), 0);
});

test("base rate times equivalent tokens reproduces the blended cache bill", () => {
  // The Anthropic adapter reports inputTokens as a full-price-equivalent
  // count: cacheRead/10 + cacheWrite*1.25 folded in. This test proves that
  // multiplying that count by the base input rate equals what the provider
  // actually bills for the same call priced component by component — which is
  // the whole reason callCostUsd may use one rate instead of three.
  const rates = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, asOf: "test" };
  const raw = 1_000;
  const cacheRead = 10_000;
  const cacheWrite = 800;

  // What the adapter reports (responseFromMessage's arithmetic).
  const equivalentInput = raw + Math.round(cacheRead / 10 + cacheWrite * 1.25);

  // What Anthropic bills: full price on raw input, 0.1x on cache reads,
  // 1.25x on five-minute-TTL cache writes.
  const blendedUsd =
    (raw * 3 + cacheRead * (3 * 0.1) + cacheWrite * (3 * 1.25)) / 1_000_000;

  assert.equal(
    callCostUsd(rates, { inputTokens: equivalentInput, outputTokens: 0 }),
    blendedUsd,
  );
});

test("an operator's pricing file overrides per model and keeps the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novus-pricing-"));
  const path = join(dir, "pricing.json");

  try {
    // The realistic case: sonnet-5's introductory rate, set until it expires.
    await writeFile(
      path,
      JSON.stringify({
        "anthropic/claude-sonnet-5": {
          inputPerMTokUsd: 2,
          outputPerMTokUsd: 10,
          asOf: "2026-07-30",
        },
        "openai/gpt-x": {
          inputPerMTokUsd: 1,
          outputPerMTokUsd: 4,
          asOf: "2026-07-30",
        },
      }),
      "utf8",
    );

    const table = loadPricing({ NOVUS_MODEL_PRICING: path });

    assert.deepEqual(
      ratesFor(table, { provider: "anthropic", model: "claude-sonnet-5" }),
      { inputPerMTokUsd: 2, outputPerMTokUsd: 10, asOf: "2026-07-30" },
    );
    // A model the defaults never knew becomes priceable.
    assert.deepEqual(ratesFor(table, { provider: "openai", model: "gpt-x" }), {
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 4,
      asOf: "2026-07-30",
    });
    // Untouched entries keep the shipped rates.
    assert.deepEqual(
      ratesFor(table, { provider: "anthropic", model: "claude-opus-5" }),
      { inputPerMTokUsd: 5, outputPerMTokUsd: 25, asOf: "2026-06-24" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unset, pricing is exactly the shipped defaults", () => {
  assert.equal(loadPricing({}), DEFAULT_MODEL_PRICING);
});

test("a pricing file that cannot be used refuses loudly, naming the path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novus-pricing-"));

  try {
    // Missing file: the operator pointed at something that is not there.
    const missing = join(dir, "absent.json");

    assert.throws(
      () => loadPricing({ NOVUS_MODEL_PRICING: missing }),
      (error: Error) => error.message.includes(missing),
    );

    // Not JSON at all.
    const garbled = join(dir, "garbled.json");

    await writeFile(garbled, "not json", "utf8");
    assert.throws(
      () => loadPricing({ NOVUS_MODEL_PRICING: garbled }),
      (error: Error) =>
        error.message.includes(garbled) && /not valid JSON/.test(error.message),
    );

    // Valid JSON, wrong shape: a negative rate is not a price.
    const negative = join(dir, "negative.json");

    await writeFile(
      negative,
      JSON.stringify({
        "anthropic/claude-opus-5": {
          inputPerMTokUsd: -5,
          outputPerMTokUsd: 25,
          asOf: "2026-07-30",
        },
      }),
      "utf8",
    );
    assert.throws(
      () => loadPricing({ NOVUS_MODEL_PRICING: negative }),
      (error: Error) => error.message.includes(negative),
    );

    // A key that is not provider/model would never be found by ratesFor, so
    // it is refused at load rather than silently ignored forever.
    const badKey = join(dir, "badkey.json");

    await writeFile(
      badKey,
      JSON.stringify({
        "claude-opus-5": {
          inputPerMTokUsd: 5,
          outputPerMTokUsd: 25,
          asOf: "2026-07-30",
        },
      }),
      "utf8",
    );
    assert.throws(
      () => loadPricing({ NOVUS_MODEL_PRICING: badKey }),
      (error: Error) => error.message.includes(badKey),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
