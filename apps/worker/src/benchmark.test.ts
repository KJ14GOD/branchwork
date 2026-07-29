import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelSelection } from "@novus/contracts";

import { runBugFixBenchmark, ScriptedBugFixAdapter } from "./benchmark.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./model.ts";

/**
 * The benchmark in the gate, on the deterministic variant.
 *
 * This is the whole harness on one path — search, read, a tool failure the run
 * recovers from, a proposed patch, an approved write, the fixture's own suite,
 * a diff against a base commit, a receipt — so a regression anywhere in that
 * chain fails here rather than being discovered the next time somebody spends a
 * provider call. The live variant is the one that proves a *model* can do it,
 * and it deliberately has no place in a gate that runs on every commit.
 */

const artifacts = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-benchmark-artifacts-"));

test("the scripted agent completes the bug-fix benchmark", async () => {
  const artifactsPath = await artifacts();

  try {
    const result = await runBugFixBenchmark({
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
    const result = await runBugFixBenchmark({
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
