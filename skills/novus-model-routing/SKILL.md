---
name: novus-model-routing
description: Change how Novus chooses a model, what a run costs, or what a budget enforces — router tiers and signals, the per-turn override's precedence, pricing as configuration, and cache-aware cost accounting. Use when adding a model or tier, adjusting routing signals or thresholds, updating rates, wiring a new budget, or debugging a run that landed on an unexpected model or reported a wrong cost.
---

# Novus Model Routing

Three pieces, deliberately separate: the **router** picks a model before a
run (`apps/worker/src/model-router.ts`), **pricing** turns a call's usage
into USD (`pricing.ts`), and the **budget** stops a run that has spent too
much (`budget.ts`). They meet in `agent-runner.ts` and nowhere else. Keep
them separable — a routing change must not need a pricing change to
typecheck, and vice versa.

## Precedence, and why the test is shaped the way it is

Selection precedence, highest first:

1. **A human's per-turn choice** — `POST /sessions/:id/turns` with `model`.
   When present, the router is never consulted; the run records source
   `"human"`, reason "chosen explicitly for this turn". A model with no
   adapter on this worker is refused with a 400 *before* the run starts.
2. **The router** — `SignalModelRouter` by default, `FixedModelRouter`
   (`model.ts`) when the host pins one.

The precedence test in `turn-model-route.test.ts` pins the router to one
adapter and asks for a *different* one, so "the pick won" and "the router
won" produce different observable answers. Keep that shape: with both
pointing at the same model, inverted precedence is invisible — the run is
simply on a model nobody asked for. Note the desktop's command palette
submits without a model (only the composer's picker carries one), so palette
asks always route.

## The router's rules

`ANTHROPIC_ROUTING_TIERS`: fast `claude-sonnet-5`, deep `claude-opus-5`,
max `claude-fable-5`. Three rules, applied in order:

1. **Goal shape.** `readGoal` scores broad signals (opens as a question,
   asks for exploration, a cross-cutting change, repository-scale scope, a
   diagnosis — plus sheer length); broad goals start deep, focused ones
   fast.
2. **Failure escalates.** `lastRunFailed` moves the choice up one tier,
   capped at max.
3. **Budget steps down.** While a worst-case call estimate (context chars /
   4 + overhead, worst-case output) exceeds `costBudgetUsd`, step down a
   tier.

Every decision is appended to the log as a `run.progress` line — "Selected
provider/model (source: reason)" — so a surprising choice is diagnosed from
the event log, not by re-running. If you add a signal, it must be computable
at selection time from what the request already carries
(`ModelRoutingRequest` in `model.ts`), and its influence must show up in the
recorded reason. The signals README names that need measured data —
historical success, evaluation results — are marked extension points;
leaving them unbuilt is the current correct behaviour, not an oversight.

## Adding a model or tier

1. The **adapter** must exist for the provider, or every route to the model
   400s — which is correct behaviour, not a bug to route around.
2. A **pricing entry** in the same commit. Rates are keyed
   `"provider/model"`. An unpriced model does not cost zero — `ratesFor`
   returns null, cost reads *unknown*, and the receipt says nothing instead
   of something wrong. That is the designed fallback for models you did not
   anticipate, not a licence to skip the entry for one you did: an unpriced
   routed model also cannot be bounded by the cost budget.
3. `model-router.test.ts` tier expectations, and PROGRESS.md's router row.

Nothing enforces tiers ↔ pricing ↔ adapters agreement at compile time; the
tests and this checklist are the enforcement.

## Pricing is configuration with a date

Rates carry `asOf` — the date they were last confirmed against the
provider's published list — and every receipt inherits it, so a reader of an
old receipt can judge the figure. Operators override with
`NOVUS_MODEL_PRICING` (JSON, merged per model, throws at boot on a bad file
— a silently-ignored override would produce figures the operator explicitly
asked to change).

The worked example of the honesty policy: `claude-sonnet-5` ships at sticker
($3/$15) while an introductory rate ($2/$10) runs to 2026-08-31. Sticker was
chosen because it outlives the promotion — the default errs toward
*overstating* cost rather than silently understating it after September, and
the intro rate is exactly what the override file is for. When you update any
rate: change the numbers *and* `asOf`, run `pricing.test.ts`, and check
PROGRESS.md gap 5, which exists to expire.

**Cache accounting is already inside the token count.** `inputTokens` is a
full-price-equivalent figure — the Anthropic adapter folds cache reads
(0.1x) and writes (1.25x) in using the provider's own ratios, so
rate-times-tokens reproduces the blended bill and a cost figure means the
same thing whether the cache was warm. Do **not** add cache-read/write rates
to the pricing table; that double-counts a discount already applied.
`pricing.test.ts` proves the identity with numbers — keep that test when
touching either side.

## Budgets are two mechanisms, not one

The router's `costBudgetUsd` is *predictive* — it steps the tier down before
a run. The run budget in `budget.ts` is *enforcement* — it ends a run whose
accumulated `costUsd` crosses the ceiling. Do not merge them: the router
guessing wrong must still be caught by enforcement, and enforcement firing
is not a routing bug. Known limits of the accumulated figure (PROGRESS.md
gaps 4 and 6): a resumed run's usage and clock restart, and nothing renders
cost to a person yet.

## When routing changes, re-test

`model-router.test.ts`, `pricing.test.ts`, `turn-model-route.test.ts`, and —
because routing decides which adapter runs — `novus-agent-quality`'s
adapter-change list (`model-response.test.ts`, transient-error mapping). All
deterministic; none of this needs a live call, and as of 2026-07-30 none of
it has ever had one — the router has never routed a real request. That
standing is recorded in PROGRESS.md; flip it there the day a live run
happens.
