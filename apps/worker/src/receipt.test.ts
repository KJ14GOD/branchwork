import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { buildReceipt } from "./receipt.ts";

const SESSION = "session-1";
const RUN = "run-1";
const USAGE = {
  inputTokens: 120,
  outputTokens: 45,
  modelCalls: 3,
  callsMissingUsage: 0,
  modelTimeMs: 0,
  costUsd: null,
  rates: null,
};
const BASE: { revision: string | null; dirty: boolean | null } = {
  revision: null,
  dirty: false,
};

const storeWithRun = (): InMemorySessionEventStore => {
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: RUN,
        sessionId: SESSION,
        goal: "Fix the failing refresh test",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "claude-opus-5" },
        createdAt: new Date().toISOString(),
      },
    },
  });

  return store;
};

const applyPatch = (store: InMemorySessionEventStore, path: string) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: `call-${path}`,
        name: "apply_patch",
        output: {
          patchId: `patch-${path}`,
          path,
          status: "applied",
          additions: 3,
          deletions: 1,
        },
      },
    },
  });

const runTests = (store: InMemorySessionEventStore, passed: boolean) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: `call-tests-${passed}`,
        name: "run_tests",
        output: {
          command: "pnpm test",
          exitCode: passed ? 0 : 1,
          timedOut: false,
          durationMs: 4_200,
          stdout: "",
          stderr: "",
          truncated: false,
          passed,
        },
      },
    },
  });

const runBuild = (store: InMemorySessionEventStore, succeeded: boolean) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: `call-build-${succeeded}`,
        name: "run_build",
        output: {
          command: "pnpm build",
          exitCode: succeeded ? 0 : 2,
          timedOut: false,
          durationMs: 11_000,
          stdout: "",
          stderr: "",
          truncated: false,
          succeeded,
        },
      },
    },
  });

const runDiagnostics = (
  store: InMemorySessionEventStore,
  kind: "typecheck" | "lint",
  ok: boolean,
  problems = 0,
) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: `call-${kind}-${ok}`,
        name: "run_diagnostics",
        output: {
          kind,
          command: kind === "lint" ? "pnpm lint" : "pnpm typecheck",
          exitCode: ok ? 0 : 1,
          timedOut: false,
          durationMs: 3_000,
          ok,
          diagnostics: Array.from({ length: problems }, (_, index) => ({
            path: "src/auth.ts",
            line: index + 1,
            column: 1,
            severity: "error" as const,
            message: "Type 'string' is not assignable to type 'number'.",
            code: "TS2322",
          })),
          diagnosticsTruncated: false,
          raw: "",
          rawTruncated: false,
        },
      },
    },
  });

const complete = (store: InMemorySessionEventStore) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.completed",
    payload: { runId: RUN, summary: "Fixed the locking behaviour." },
  });

test("a receipt reports the files, tests, and usage of a completed run", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  runTests(store, true);
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: { revision: "abc1234def", dirty: true },
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.goal, "Fix the failing refresh test");
  assert.equal(receipt.base.revision, "abc1234def");
  assert.equal(receipt.base.dirty, true);
  assert.equal(receipt.filesChanged.length, 1);
  assert.equal(receipt.filesChanged[0]?.path, "src/auth.ts");
  assert.equal(receipt.filesChanged[0]?.additions, 3);
  assert.equal(receipt.filesChanged[0]?.patches, 1);
  // The suite ran after the change, so it speaks to this diff.
  assert.equal(receipt.testsFollowedFinalChange, true);
  assert.equal(receipt.tests.length, 1);
  assert.equal(receipt.tests[0]?.passed, true);
  // Cost and model time survive into the receipt now. They used to be
  // computed on every call and then silently dropped: RunReceiptSchema
  // carried only the token fields, so Zod stripped the rest on the way
  // through and README's "records ... latency, and cost for every call"
  // was unmet by a schema nobody had widened. deepEqual is deliberate —
  // it is what catches the next field that gets computed and quietly lost.
  assert.deepEqual(receipt.usage, {
    inputTokens: USAGE.inputTokens,
    outputTokens: USAGE.outputTokens,
    modelCalls: USAGE.modelCalls,
    callsMissingUsage: USAGE.callsMissingUsage,
    costUsd: USAGE.costUsd,
    modelTimeMs: USAGE.modelTimeMs,
  });
  assert.equal(receipt.summary, "Fixed the locking behaviour.");
  assert.equal(receipt.failure, undefined);
});

test("a proposed patch is not reported as a file change", () => {
  const store = storeWithRun();

  // A proposal is a preview that never touched the tree. Counting it would make
  // the receipt claim an edit that a denial prevented.
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: "call-1",
        name: "propose_patch",
        output: {
          patchId: "patch-1",
          path: "src/auth.ts",
          intent: "fix the lock",
          status: "proposed",
          diff: "--- a\n+++ b\n",
          additions: 3,
          deletions: 1,
        },
      },
    },
  });
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.deepEqual(receipt.filesChanged, []);
  assert.equal(receipt.toolCalls.length, 1);
});

test("a receipt records a denial and who made it", () => {
  const store = storeWithRun();

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "tool.denied",
    payload: {
      runId: RUN,
      toolCallId: "call-1",
      deniedBy: "host",
      reason: "apply_patch is not in this session's allow list.",
    },
  });
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.approvals.length, 1);
  assert.equal(receipt.approvals[0]?.decision, "denied");
  assert.equal(receipt.approvals[0]?.actorId, "host");
  assert.match(receipt.approvals[0]?.reason ?? "", /allow list/);
  assert.deepEqual(receipt.filesChanged, []);
});

test("a failed run still produces a receipt, carrying the reason", () => {
  const store = storeWithRun();
  runTests(store, false);
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.failed",
    payload: { runId: RUN, reason: "Exceeded the 16-step ceiling." },
  });

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.status, "failed");
  assert.match(receipt.failure ?? "", /16-step ceiling/);
  assert.equal(receipt.summary, undefined);
  assert.equal(receipt.tests[0]?.passed, false);
});

test("a receipt never mixes in another run's events", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");

  // A second run in the same session must not leak into the first's receipt:
  // the session event log is shared, and filtering is the only thing keeping
  // these apart.
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-2",
      result: {
        toolCallId: "call-other",
        name: "apply_patch",
        output: {
          patchId: "patch-other",
          path: "src/other.ts",
          status: "applied",
          additions: 9,
          deletions: 9,
        },
      },
    },
  });
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.deepEqual(
    receipt.filesChanged.map((file) => file.path),
    ["src/auth.ts"],
  );
});

test("two patches to one file are one changed file", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  applyPatch(store, "src/auth.ts");
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  // "2 files changed" would be the headline number, and it would be wrong.
  assert.equal(receipt.filesChanged.length, 1);
  assert.equal(receipt.filesChanged[0]?.patches, 2);
  assert.equal(receipt.filesChanged[0]?.additions, 6);
  assert.equal(receipt.filesChanged[0]?.deletions, 2);
});

test("tests that ran before the last change do not read as passing it", () => {
  const store = storeWithRun();
  runTests(store, true);
  applyPatch(store, "src/auth.ts");
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.tests[0]?.passed, true);
  // A green suite from before the final edit says nothing about the diff this
  // receipt is attached to.
  assert.equal(receipt.testsFollowedFinalChange, false);
});

test("a denial names the tool that was refused", () => {
  const store = storeWithRun();

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.approval_requested",
    payload: {
      runId: RUN,
      call: { id: "call-9", name: "run_command", input: { command: "rm", args: [] } },
      toolClass: "dangerous",
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "tool.denied",
    payload: {
      runId: RUN,
      toolCallId: "call-9",
      deniedBy: "host",
      reason: "not allowed",
    },
  });
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  // "denied" alone loses the one fact a reviewer needs: denied *what*.
  assert.equal(receipt.toolCalls[0]?.name, "run_command");
  assert.equal(receipt.toolCalls[0]?.outcome, "denied");
});

test("an undeterminable tree is unknown, not clean", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  complete(store);

  // Reporting a failed check as clean would make the maximally dirty
  // repository — the one whose status output could not be read — look tidiest.
  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: { revision: "abc1234def", dirty: null },
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.base.dirty, null);
});

test("a run that has not finished has no receipt", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");

  assert.equal(
    buildReceipt(store.list(SESSION), RUN, {
      base: BASE,
      usage: USAGE,
    }),
    null,
  );
});

test("a build and a typecheck are recorded as verification, not thrown away", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  runDiagnostics(store, "typecheck", true);
  runBuild(store, true);
  runTests(store, true);
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.deepEqual(
    receipt.checks.map((check) => [check.kind, check.passed]),
    [
      ["typecheck", true],
      ["build", true],
      ["tests", true],
    ],
    "every check the run ran belongs in the receipt, in the order it ran them",
  );
  assert.equal(receipt.verification, "verified");
  // The narrower list is untouched, because other surfaces already read it.
  assert.equal(receipt.tests.length, 1);
});

test("a run that ran no checks is unverified, never a pass", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  // The run finished. That is the whole point: completion is not verification,
  // and the receipt has to keep the two apart or every surface that renders
  // "completed" as green reports an unchecked diff as a good one.
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.checks, []);
  assert.equal(receipt.verification, "unverified");
});

test("checks that ran before the final change are stale, so unverified", () => {
  const store = storeWithRun();
  runTests(store, true);
  runBuild(store, true);
  applyPatch(store, "src/auth.ts");
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  // Everything passed, and none of it describes the tree the run ended with.
  assert.ok(receipt.checks.every((check) => check.passed));
  assert.equal(receipt.verification, "unverified");
});

test("a failing check outranks a missing one", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  runDiagnostics(store, "lint", false, 4);
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.verification, "failing");
  assert.equal(receipt.checks[0]?.kind, "lint");
  assert.equal(receipt.checks[0]?.problems, 4);
});

test("a checker that fails without parseable output is not clean", () => {
  const store = storeWithRun();
  applyPatch(store, "src/auth.ts");
  // ok: false with zero diagnostics — the parser recognised nothing in the
  // checker's output. Counting problems instead of reading the verdict would
  // report this as a pass, which is the exact shape of a confidently wrong
  // green.
  runDiagnostics(store, "typecheck", false, 0);
  complete(store);

  const receipt = buildReceipt(store.list(SESSION), RUN, {
    base: BASE,
    usage: USAGE,
  });

  assert.ok(receipt);
  assert.equal(receipt.checks[0]?.problems, 0);
  assert.equal(receipt.checks[0]?.passed, false);
  assert.equal(receipt.verification, "failing");
});

test("an unknown run has no receipt rather than an empty one", () => {
  const store = storeWithRun();
  complete(store);

  assert.equal(
    buildReceipt(store.list(SESSION), "run-does-not-exist", {
      base: BASE,
      usage: USAGE,
    }),
    null,
  );
});
