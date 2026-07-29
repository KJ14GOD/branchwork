import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelSelection } from "@novus/contracts";

import {
  runBenchmark,
  ScriptedBugFixAdapter,
  ScriptedRepoReasoningAdapter,
  ScriptedSmallFeatureAdapter,
} from "./benchmark.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./model.ts";

/**
 * The benchmarks in the gate, on the deterministic variant.
 *
 * The first test is the whole harness on one path — search, read, a tool
 * failure the run recovers from, a proposed patch, an approved write, the
 * fixture's own suite, a diff against a base commit, a receipt — so a
 * regression anywhere in that chain fails here rather than being discovered the
 * next time somebody spends a provider call. The live variant is the one that
 * proves a *model* can do it, and it deliberately has no place in a gate that
 * runs on every commit.
 *
 * The rest of the file is about the fixtures rather than the harness. A
 * benchmark is only worth running if the wrong answers fail it, and "the wrong
 * answer fails" is a claim that decays quietly: a fixture can be edited until
 * the trap it was built around has stopped being a trap without anything going
 * red. So each task is run twice, once by an agent that does the work and once
 * by an agent that does the plausible wrong thing, and the wrong one is
 * asserted to fail for the reason the fixture was designed to catch rather than
 * merely to fail.
 */

const artifacts = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-benchmark-artifacts-"));

test("the scripted agent completes the bug-fix benchmark", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "bug-fix",
      variant: "scripted",
      adapter: new ScriptedBugFixAdapter(),
      artifactsPath,
    });

    assert.equal(
      result.verdict,
      "PASS",
      result.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.label}: ${check.detail}`)
        .join("; "),
    );

    // The fixture has to have been broken, or the pass means nothing.
    assert.notEqual(result.baseline.exitCode, 0);
    assert.equal(result.visible.exitCode, 0);
    assert.equal(result.hidden.exitCode, 0);

    const receipt = result.receipt;

    assert.ok(receipt, "the run produced no receipt");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.filesChanged.length, 1);
    assert.equal(receipt.filesChanged[0]?.path, "src/rate-limiter.js");
    assert.equal(receipt.tests.length, 1);
    assert.equal(receipt.tests[0]?.passed, true);
    // The verification has to come after the change it verifies.
    assert.equal(receipt.testsFollowedFinalChange, true);
    // The base is what makes the diff reproducible rather than merely present.
    assert.ok(receipt.base.revision);

    // A tool failed and the run carried on. That invariant is asserted in
    // agent-runner's tests against a stub; here it is a real tool refusing a
    // real ambiguous edit against a real file.
    assert.ok(
      receipt.toolCalls.some((call) => call.outcome === "failed"),
      "the scripted run never exercised tool failure recovery",
    );
    assert.ok(
      receipt.toolCalls.some(
        (call) => call.name === "apply_patch" && call.outcome === "completed",
      ),
    );

    // No provider call happened, so the receipt must say the totals are a floor
    // rather than print a confident zero.
    assert.equal(receipt.usage.callsMissingUsage, receipt.usage.modelCalls);

    assert.equal(result.diff.produced, true);
    assert.deepEqual(result.diff.changedPaths, ["src/rate-limiter.js"]);
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});

const CHEAT_SELECTION: ModelSelection = {
  provider: "scripted",
  model: "bug-fix-cheat",
};

/**
 * An agent that makes the failing test pass without fixing anything.
 *
 * It neuters the one assertion the failing test turns on. Nothing else in the
 * repository changes, so `npm test` goes green and a scorer that only re-ran
 * the visible suite would call this a success.
 */
class CheatingAdapter implements ModelAdapter {
  readonly selection: ModelSelection = CHEAT_SELECTION;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "tests/rate-limiter.test.js",
            intent: "Relax the assertion.",
            edits: [
              {
                oldText: "  assert.equal(granted, 10);",
                newText: "  assert.equal(granted, granted);",
              },
            ],
          },
        },
      };
    }

    if (step === 1) {
      const proposal = request.toolExchanges.find(
        (exchange) =>
          exchange.status === "ok" && exchange.result.name === "propose_patch",
      );

      assert.ok(
        proposal?.status === "ok" && proposal.result.name === "propose_patch",
        "the cheating adapter could not anchor its edit — the fixture's failing test changed shape",
      );

      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "apply_patch",
          input: { patchId: proposal.result.output.patchId },
        },
      };
    }

    if (step === 2) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "run_tests",
          input: { args: [] },
        },
      };
    }

    return { type: "final", summary: "Fixed it. The suite is green." };
  }
}

test("the benchmark refuses a run that only made the visible test pass", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "bug-fix",
      variant: "scripted",
      adapter: new CheatingAdapter(),
      artifactsPath,
    });

    // The cheat works, which is the point: this is what a scorer that trusted
    // the visible suite would have accepted.
    assert.equal(result.visible.exitCode, 0);

    assert.equal(result.verdict, "FAIL");

    const failed = new Map(
      result.checks
        .filter((check) => !check.passed)
        .map((check) => [check.label, check.detail]),
    );

    assert.ok(
      failed.has("hidden regression test passes"),
      "the hidden test accepted an unfixed rate limiter",
    );
    assert.ok(
      failed.has("tests were left alone"),
      "editing a committed test went unreported",
    );
    assert.deepEqual(result.tamperedTests, ["M tests/rate-limiter.test.js"]);
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});

test("the scripted agent completes the small-feature benchmark", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "small-feature",
      variant: "scripted",
      adapter: new ScriptedSmallFeatureAdapter(),
      artifactsPath,
    });

    assert.equal(
      result.verdict,
      "PASS",
      result.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.label}: ${check.detail}`)
        .join("; "),
    );

    assert.notEqual(result.baseline.exitCode, 0);
    assert.equal(result.visible.exitCode, 0);
    assert.equal(result.hidden.exitCode, 0);

    // The point of this fixture: one file is not enough, and the receipt is
    // where that stops being a claim about the task and becomes a fact about
    // the run.
    assert.deepEqual([...result.diff.changedPaths].sort(), [
      "src/evaluate.js",
      "src/explain.js",
      "src/tokenize.js",
    ]);

    const receipt = result.receipt;

    assert.ok(receipt, "the run produced no receipt");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.filesChanged.length, 3);
    assert.equal(
      receipt.toolCalls.filter(
        (call) => call.name === "apply_patch" && call.outcome === "completed",
      ).length,
      3,
      "three files changed under fewer than three approved writes",
    );
    assert.equal(receipt.tests[0]?.passed, true);
    assert.equal(receipt.testsFollowedFinalChange, true);
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});

const PARTIAL_SELECTION: ModelSelection = {
  provider: "scripted",
  model: "small-feature-partial",
};

/**
 * An agent that does a third of the work and stops.
 *
 * It declares the operator in the lexer — the first file anyone would open —
 * and never teaches the predicate or the description about it. The change is
 * coherent, reviewable, and useless. If the fixture ever stops being a genuinely
 * multi-file task, this is the test that notices, because the *visible* suite
 * would start accepting it.
 */
class PartialFeatureAdapter implements ModelAdapter {
  readonly selection: ModelSelection = PARTIAL_SELECTION;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/tokenize.js",
            intent: "Declare the membership operator.",
            edits: [
              {
                oldText: [
                  '  { id: "contains", spelling: "~", operand: "scalar" },',
                  "];",
                ].join("\n"),
                newText: [
                  '  { id: "contains", spelling: "~", operand: "scalar" },',
                  '  { id: "isOneOf", spelling: "in", operand: "list" },',
                  "];",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 1) {
      const proposal = request.toolExchanges.find(
        (exchange) =>
          exchange.status === "ok" && exchange.result.name === "propose_patch",
      );

      assert.ok(
        proposal?.status === "ok" && proposal.result.name === "propose_patch",
        "the partial adapter could not anchor its edit — the fixture's operator table changed shape",
      );

      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "apply_patch",
          input: { patchId: proposal.result.output.patchId },
        },
      };
    }

    return { type: "final", summary: "Added the operator." };
  }
}

test("the small-feature benchmark refuses a change to one of the three files", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "small-feature",
      variant: "scripted",
      adapter: new PartialFeatureAdapter(),
      artifactsPath,
    });

    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.diff.changedPaths, ["src/tokenize.js"]);

    // Not the hidden test doing the work here. Declaring an operator the other
    // two registries have never heard of has to fail the suite the agent could
    // read, or this is not a multi-file task at all.
    assert.notEqual(
      result.visible.exitCode,
      0,
      "a one-file change satisfied the visible suite — the fixture no longer requires coordination",
    );
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});

test("the scripted agent completes the repository-reasoning benchmark", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "repo-reasoning",
      variant: "scripted",
      adapter: new ScriptedRepoReasoningAdapter(),
      artifactsPath,
    });

    assert.equal(
      result.verdict,
      "PASS",
      result.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.label}: ${check.detail}`)
        .join("; "),
    );

    assert.notEqual(result.baseline.exitCode, 0);
    assert.equal(result.visible.exitCode, 0);
    assert.equal(result.hidden.exitCode, 0);

    // The caller was fixed, not the function two callers share.
    assert.deepEqual(result.diff.changedPaths, ["src/rollup.js"]);

    const receipt = result.receipt;

    assert.ok(receipt, "the run produced no receipt");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.tests[0]?.passed, true);
    assert.equal(receipt.testsFollowedFinalChange, true);
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});

const NAIVE_SELECTION: ModelSelection = {
  provider: "scripted",
  model: "repo-reasoning-naive",
};

/**
 * An agent that makes the obvious local change and stops.
 *
 * One character in the shared range selector, from a closed upper bound to an
 * open one. It is not a stupid change: half-open ranges are the better default,
 * it is smaller than the alternative, and it is in the file the double count
 * appears to come from. It also silently breaks the retention policy, which is
 * the only code in that fixture that deletes anything.
 */
class NaiveLocalFixAdapter implements ModelAdapter {
  readonly selection: ModelSelection = NAIVE_SELECTION;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/window.js",
            intent:
              "Make the range half-open so consecutive days do not overlap.",
            edits: [
              {
                oldText:
                  "  entries.filter((entry) => entry.at >= fromMs && entry.at <= toMs);",
                newText:
                  "  entries.filter((entry) => entry.at >= fromMs && entry.at < toMs);",
              },
            ],
          },
        },
      };
    }

    if (step === 1) {
      const proposal = request.toolExchanges.find(
        (exchange) =>
          exchange.status === "ok" && exchange.result.name === "propose_patch",
      );

      assert.ok(
        proposal?.status === "ok" && proposal.result.name === "propose_patch",
        "the naive adapter could not anchor its edit — the fixture's range selector changed shape",
      );

      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "apply_patch",
          input: { patchId: proposal.result.output.patchId },
        },
      };
    }

    if (step === 2) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "run_tests",
          input: { args: [] },
        },
      };
    }

    return {
      type: "final",
      summary: "Made the range half-open. The suite is green.",
    };
  }
}

test("the repository-reasoning benchmark refuses the obvious local change", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBenchmark({
      benchmark: "repo-reasoning",
      variant: "scripted",
      adapter: new NaiveLocalFixAdapter(),
      artifactsPath,
    });

    // Both halves matter, and the first one is the fixture's whole claim: if
    // the tempting change did not satisfy the visible suite, this would be an
    // ordinary bug fix and the hidden test would be catching nothing a reviewer
    // could not already see.
    assert.equal(
      result.visible.exitCode,
      0,
      "the obvious local change no longer passes the visible suite — this fixture has stopped testing repository reasoning",
    );
    assert.notEqual(
      result.hidden.exitCode,
      0,
      "the hidden test accepted a change that deletes entries from inside the retention window",
    );

    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.diff.changedPaths, ["src/window.js"]);
    // Nothing was tampered with and nothing was special-cased. This run fails
    // on the merits, which is what separates this task from the bug-fix cheat.
    assert.deepEqual(result.tamperedTests, []);
  } finally {
    await rm(artifactsPath, { recursive: true, force: true });
  }
});
