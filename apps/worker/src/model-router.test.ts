import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_ROUTING_TIERS,
  readGoal,
  SignalModelRouter,
} from "./model-router.ts";
import { DEFAULT_MODEL_PRICING } from "./pricing.ts";

/**
 * The router is a pure function of its request, and these tests treat it as
 * one: same input, same selection, and a reason a person could check against
 * the rules. No live calls — routing must cost nothing, so it must also be
 * provable for nothing.
 */

const router = () =>
  new SignalModelRouter(ANTHROPIC_ROUTING_TIERS, DEFAULT_MODEL_PRICING);

test("the shipped tiers are the three real Anthropic model ids", () => {
  // Exact ids, confirmed against the provider's catalogue — a routed model
  // that does not exist fails in a way that looks like a bad key.
  assert.deepEqual(ANTHROPIC_ROUTING_TIERS.fast, {
    provider: "anthropic",
    model: "claude-sonnet-5",
  });
  assert.deepEqual(ANTHROPIC_ROUTING_TIERS.deep, {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  assert.deepEqual(ANTHROPIC_ROUTING_TIERS.max, {
    provider: "anthropic",
    model: "claude-fable-5",
  });
});

test("focused goals route to the fast tier and say why", () => {
  for (const goal of [
    "Fix the typo in README.md",
    "Rename SessionRegistry.remembered to rememberedSessions",
    "Bump the version to 0.4.0",
    "Add a --json flag to the export command",
  ]) {
    const routed = router().select({ goal });

    assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.fast, goal);
    assert.equal(routed.source, "router");
    assert.match(routed.reason, /focused task/);
  }
});

test("broad exploration routes to the deep tier, with the matched evidence", () => {
  const cases: [string, RegExp][] = [
    ["Why does the relay drop events after a reconnect?", /opens as a question/],
    ["Explain how the approval gate decides", /asks for exploration/],
    ["Refactor the event store to support compaction", /cross-cutting change/],
    ["Audit the whole repo for path traversal", /asks for exploration/],
    ["Find the cause of the flaky presence test", /asks for a diagnosis/],
    ["Describe the architecture of the worker", /repository-scale/],
  ];

  for (const [goal, evidence] of cases) {
    const routed = router().select({ goal });

    assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.deep, goal);
    assert.match(routed.reason, /broad exploration/);
    assert.match(routed.reason, evidence, goal);
  }
});

test("a multi-paragraph brief reads as broad even without keyword signals", () => {
  const brief = `Build the settings screen. ${"The layout mirrors the open screen. ".repeat(60)}`;
  const routed = router().select({ goal: brief });

  assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.deep);
  assert.match(routed.reason, /-character brief/);
});

test("a failure in the session escalates one tier, and never past the top", () => {
  // The cheap tier just failed this session; re-running the same tier at the
  // same price is how a run fails twice. Focused work escalates to deep…
  const focused = router().select({
    goal: "Fix the typo in README.md",
    lastRunFailed: true,
  });

  assert.deepEqual(focused.selection, ANTHROPIC_ROUTING_TIERS.deep);
  assert.match(focused.reason, /previous run failed/);

  // …and broad work escalates to the max tier.
  const broad = router().select({
    goal: "Explain how the approval gate decides",
    lastRunFailed: true,
  });

  assert.deepEqual(broad.selection, ANTHROPIC_ROUTING_TIERS.max);
  assert.match(broad.reason, /previous run failed/);
});

test("the empty goal is the unsignaled default and never escalates", () => {
  // Session bootstrap and checkpoints ask "what would you pick" with no task
  // in hand. That answer must be stable — a checkpoint's recorded model
  // should not depend on whether the previous run happened to fail.
  const plain = router().select({ goal: "" });
  const afterFailure = router().select({ goal: "", lastRunFailed: true });

  assert.deepEqual(plain.selection, ANTHROPIC_ROUTING_TIERS.fast);
  assert.deepEqual(afterFailure.selection, plain.selection);
});

test("a tight cost budget steps the choice down and shows the arithmetic", () => {
  // One worst-case deep-tier call with no context is ~$0.22 (3k overhead
  // input at $5/MTok + 8,192 output at $25/MTok). A $0.15 ceiling cannot
  // afford that, and the fast tier's ~$0.13 fits.
  const routed = router().select({
    goal: "Explain how the approval gate decides",
    costBudgetUsd: 0.15,
  });

  assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.fast);
  assert.match(routed.reason, /stepped down from claude-opus-5/);
  assert.match(routed.reason, /\$0\.15/);
});

test("a budget the tier fits inside changes nothing", () => {
  const routed = router().select({
    goal: "Explain how the approval gate decides",
    costBudgetUsd: 20,
  });

  assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.deep);
  assert.doesNotMatch(routed.reason, /stepped down/);
});

test("context size raises the estimate the budget is checked against", () => {
  // The same broad goal fits a $1 budget with an empty session — a deep-tier
  // call is ~$0.22 — but not when the session drags 1.6M characters of
  // conversation: ~403k estimated input tokens is ~$2.2 at $5/MTok before
  // output. The budget rule is where context size earns its keep; without a
  // configured budget it moves nothing, because a threshold no operator set
  // would be an invented preference.
  const goal = "Explain how the approval gate decides";
  const light = router().select({ goal, costBudgetUsd: 1 });
  const heavy = router().select({ goal, costBudgetUsd: 1, contextChars: 1_600_000 });
  const heavyNoBudget = router().select({ goal, contextChars: 1_600_000 });

  assert.deepEqual(light.selection, ANTHROPIC_ROUTING_TIERS.deep);
  assert.deepEqual(heavy.selection, ANTHROPIC_ROUTING_TIERS.fast);
  assert.match(heavy.reason, /stepped down/);
  assert.deepEqual(heavyNoBudget.selection, ANTHROPIC_ROUTING_TIERS.deep);
});

test("the budget can veto a failure escalation", () => {
  // Broad + previous failure wants the max tier (~$0.44 a worst-case call);
  // a $0.30 ceiling can afford deep (~$0.22) but not that. Escalation is a
  // preference; the operator's ceiling is a constraint.
  const routed = router().select({
    goal: "Explain how the approval gate decides",
    lastRunFailed: true,
    costBudgetUsd: 0.3,
  });

  assert.deepEqual(routed.selection, ANTHROPIC_ROUTING_TIERS.deep);
  assert.match(routed.reason, /previous run failed/);
  assert.match(routed.reason, /stepped down from claude-fable-5/);
});

test("unpriced tiers cannot be budget-checked, and the router does not guess", () => {
  // An operator could configure tiers this table has no rates for. The
  // affordability rule skips what it cannot price — the budget bound itself
  // refuses to run an unpriced model under a cost ceiling, and one refusal
  // in one place is enough.
  const unpriced = new SignalModelRouter(
    {
      fast: { provider: "example", model: "small" },
      deep: { provider: "example", model: "large" },
      max: { provider: "example", model: "huge" },
    },
    DEFAULT_MODEL_PRICING,
  );
  const routed = unpriced.select({
    goal: "Explain how the approval gate decides",
    costBudgetUsd: 0.01,
  });

  assert.deepEqual(routed.selection, { provider: "example", model: "large" });
  assert.doesNotMatch(routed.reason, /stepped down/);
});

test("the same request always gets the same answer", () => {
  // A selection that cannot be reproduced from its inputs cannot be
  // explained from the log either.
  const request = {
    goal: "Investigate the reconnect gap",
    contextChars: 52_000,
    lastRunFailed: true,
    costBudgetUsd: 2,
  };

  assert.deepEqual(router().select(request), router().select(request));
});

test("readGoal names its evidence, because the reason quotes it", () => {
  assert.deepEqual(readGoal("Why is the build red?"), {
    shape: "broad",
    evidence: "opens as a question",
  });
  assert.deepEqual(readGoal("Fix the failing refresh test"), {
    shape: "focused",
    evidence: "no exploration signals",
  });
});
