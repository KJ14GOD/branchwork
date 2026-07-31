import assert from "node:assert/strict";
import test from "node:test";

import type { RunReceipt } from "@novus/contracts";

import { formatSpend, summariseReceipt } from "./receipt-summary.ts";

/**
 * These tests exist for one sentence in STEERING: **completion is not
 * verification**. A run that finished having checked nothing is unverified,
 * never successful, and the receipt row is the surface where that is easiest
 * to get wrong — it is a row about a run that ended, sitting in a timeline
 * where ending usually means it went fine.
 */
const receipt = (over: Partial<RunReceipt> = {}): RunReceipt =>
  ({
    runId: "run-1",
    sessionId: "session-1",
    goal: "Fix the refresh test",
    model: { provider: "anthropic", model: "claude-opus-5" },
    status: "completed",
    base: { revision: null, dirty: false },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: 12_300,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      modelCalls: 3,
      callsMissingUsage: 0,
      costUsd: 0.0421,
      modelTimeMs: 900,
    },
    toolCalls: [],
    filesChanged: [],
    tests: [],
    testsFollowedFinalChange: null,
    checks: [],
    verification: "unverified",
    approvals: [],
    ...over,
  }) as RunReceipt;

test("a completed run that checked nothing reads as unverified, not as a pass", () => {
  const summary = summariseReceipt(
    receipt({ status: "completed", checks: [], verification: "unverified" }),
  );

  assert.match(summary.verdict, /^Unverified/);
  // The tone is the half that matters on screen. Muted is the colour of
  // "nothing to see here", so an unverified run must never take it.
  assert.equal(summary.tone, "unverified");
  assert.notEqual(summary.tone, "muted");
  // And nothing anywhere in the row may say it passed.
  assert.equal(
    summary.parts.some((part) => /passed|verified —/i.test(part) && !/^Unverified/.test(part)),
    false,
  );
});

test("stale checks are unverified even though every one of them passed", () => {
  const summary = summariseReceipt(
    receipt({
      verification: "unverified",
      checks: [
        {
          kind: "tests",
          command: "pnpm test",
          passed: true,
          exitCode: 0,
          durationMs: 10,
          problems: null,
          sequence: 1,
        },
      ],
    }),
  );

  assert.match(summary.verdict, /Unverified — the checks ran before the last change/);
  assert.equal(summary.tone, "unverified");
});

test("a verified run names the kinds of check that actually ran", () => {
  const summary = summariseReceipt(
    receipt({
      verification: "verified",
      checks: [
        {
          kind: "typecheck",
          command: "pnpm typecheck",
          passed: true,
          exitCode: 0,
          durationMs: 10,
          problems: 0,
          sequence: 1,
        },
        {
          kind: "tests",
          command: "pnpm test",
          passed: true,
          exitCode: 0,
          durationMs: 10,
          problems: null,
          sequence: 2,
        },
      ],
    }),
  );

  assert.equal(summary.verdict, "Verified — typecheck, tests passed");
  assert.equal(summary.tone, "muted");
});

test("a failing check names what failed and takes the error tone", () => {
  const summary = summariseReceipt(
    receipt({
      verification: "failing",
      checks: [
        {
          kind: "build",
          command: "pnpm build",
          passed: false,
          exitCode: 2,
          durationMs: 10,
          problems: null,
          sequence: 1,
        },
      ],
    }),
  );

  assert.equal(summary.verdict, "1 check failed: build");
  assert.equal(summary.tone, "error");
});

test("an uncounted cost says so instead of showing zero", () => {
  // A run reported as costing $0.00 because nobody published a rate for its
  // model is a worse answer than one that admits it does not know — and the
  // difference matters, because a cost ceiling checked against an uncounted
  // spend would never trip.
  assert.equal(formatSpend(null, 0), "Cost not counted");
  assert.notEqual(formatSpend(null, 0), "$0.00");
});

test("a sub-cent run is not rounded away, and a partial count is marked a floor", () => {
  assert.equal(formatSpend(0.0421, 0), "$0.0421");
  assert.equal(formatSpend(1.5, 0), "$1.50");
  assert.equal(formatSpend(0.0421, 2), "≥$0.0421");
});

test("spend is on the row, not only in a log line", () => {
  const summary = summariseReceipt(receipt());

  assert.ok(
    summary.parts.some((part) => part.includes("$0.0421")),
    "what a run cost belongs on screen",
  );
});
