import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetExhausted,
  DEFAULT_RUN_BUDGET,
  type BudgetUsage,
} from "./budget.ts";

const fresh = (): BudgetUsage => ({
  modelCalls: 0,
  totalTokens: 0,
  consecutiveFailures: 0,
  identicalReads: 0,
  startedAt: 1_000_000,
});

test("a run that is going well is never stopped for its length", () => {
  // The point of the change: a hundred model calls into productive work is not
  // a reason to stop. The old step ceiling could not tell this apart from a
  // loop, which is why it had to be raised every time a harder task appeared.
  const usage = { ...fresh(), modelCalls: 100, totalTokens: 400_000 };

  assert.equal(
    budgetExhausted(DEFAULT_RUN_BUDGET, usage, usage.startedAt + 60_000),
    null,
  );
});

test("repeating itself stops a run before anything else does", () => {
  const usage = { ...fresh(), consecutiveFailures: 3, totalTokens: 10 };
  const reason = budgetExhausted(DEFAULT_RUN_BUDGET, usage, usage.startedAt);

  // Checked first on purpose: an agent failing the same call three times will
  // otherwise burn the token budget learning nothing.
  assert.match(reason ?? "", /repeating itself/);
});

test("each limit names itself, because a receipt has to say which one", () => {
  const tokens = budgetExhausted(
    { ...DEFAULT_RUN_BUDGET, totalTokens: 100 },
    { ...fresh(), totalTokens: 100 },
    1_000_000,
  );
  assert.match(tokens ?? "", /tokens/);

  const time = budgetExhausted(
    { ...DEFAULT_RUN_BUDGET, wallClockMs: 5_000 },
    fresh(),
    1_000_000 + 5_000,
  );
  assert.match(time ?? "", /time limit/);

  const emergency = budgetExhausted(
    { ...DEFAULT_RUN_BUDGET, maxModelCalls: 4 },
    { ...fresh(), modelCalls: 4 },
    1_000_000,
  );
  // And it says what reaching it means, rather than reporting a number as if
  // the number were the problem.
  assert.match(emergency ?? "", /backstop|looped/);
});

test("re-reading the same thing stops a run while it is still cheap", () => {
  // The elision livelock spent 79 model calls re-reading files it had already
  // read, and nothing tripped: every call succeeded, so the failure counter
  // stayed at zero, and the token and wall-clock ceilings are sized for a
  // hard afternoon of real work, not for noticing a loop. Identical reads are
  // the behavioural signature of that loop — a read is a pure function of the
  // repository, so the fifth identical answer proves the model is not
  // absorbing what it already has.
  const usage = { ...fresh(), identicalReads: 5, totalTokens: 40_000 };
  const reason = budgetExhausted(DEFAULT_RUN_BUDGET, usage, usage.startedAt);

  assert.match(reason ?? "", /re-reading/);
});

test("a healthy run's elision-driven re-reads never trip the read ceiling", () => {
  // A broad trace of this repository legitimately read two files twice: they
  // scrolled out of the verbatim window and the elision stub invited the
  // re-read. The ceiling has to sit far above what elision can explain, or it
  // becomes a step ceiling that punishes exactly the recovery it suggested.
  const usage = { ...fresh(), identicalReads: 2 };

  assert.equal(
    budgetExhausted(DEFAULT_RUN_BUDGET, usage, usage.startedAt),
    null,
  );
});

test("a null limit means unbounded, not zero", () => {
  const unbounded = { ...DEFAULT_RUN_BUDGET, totalTokens: null, wallClockMs: null };
  const usage = { ...fresh(), totalTokens: 50_000_000 };

  assert.equal(
    budgetExhausted(unbounded, usage, usage.startedAt + 86_400_000),
    null,
  );
});

test("the emergency ceiling sits far above a real trajectory", () => {
  // The small-feature benchmark's real run took sixteen model calls. A backstop
  // that a genuine run can reach is a step ceiling wearing a different name.
  assert.ok(DEFAULT_RUN_BUDGET.maxModelCalls > 100);
});
