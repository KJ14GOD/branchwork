import {
  RunReceiptSchema,
  type RunReceipt,
  type SessionEvent,
} from "@novus/contracts";
import { readVerification } from "@novus/contracts/verification";

import type { ModelRates } from "./pricing.ts";

export type ReceiptUsage = {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  callsMissingUsage: number;
  /**
   * Wall-clock milliseconds spent inside model calls, summed — measured by
   * the runner's own clock around each successful call. Divided by
   * modelCalls it is the run's mean per-call latency. Retry waits are not in
   * it; the run's elapsedMs carries those.
   *
   * A true per-call breakdown in the log needs the model.requested /
   * model.responded event family V1_README's protocol already names — a
   * cross-surface change (projection, receipt, compare, guest) this slice
   * deliberately did not make. Totals here; per-call events are the marked
   * next step. Like tokens, this restarts at zero on resume — per-call
   * figures are never logged, so a resumed run has nothing to rebuild from.
   */
  modelTimeMs: number;
  /**
   * USD spent, from per-call token usage times the configured rates. Null
   * when the run's model has no configured pricing — unknown, never zero.
   * A floor when callsMissingUsage is above zero.
   */
  costUsd: number | null;
  /** The rates that priced it, carried so the figure can be re-derived. */
  rates: ModelRates | null;
};

export type RepositoryBase = {
  revision: string | null;
  dirty: boolean | null;
};

export type ReceiptContext = {
  base: RepositoryBase;
  usage: ReceiptUsage;
};

/**
 * Builds a run receipt by reading back the run's own events.
 *
 * The alternative — accumulating a receipt alongside the run — lets the two
 * drift, and a receipt that disagrees with the history is worse than none,
 * because it is the artifact people trust when they were not watching. Reading
 * the log means the receipt can only ever restate what was recorded, and V1
 * already requires current state to be a projection rebuilt from events.
 *
 * Token usage is the one exception. It is reported per model call by the
 * adapter and never enters the event log, so the caller passes it in.
 */
export const buildReceipt = (
  events: readonly SessionEvent[],
  runId: string,
  context: ReceiptContext,
): RunReceipt | null => {
  const forRun = events.filter(
    (event) => "runId" in event.payload && event.payload.runId === runId,
  );
  const started = events.find(
    (event) => event.type === "run.started" && event.payload.run.id === runId,
  );

  // A run that never started cannot have a receipt. Returning null rather than
  // throwing keeps a reporting concern from ending an otherwise finished run.
  if (started?.type !== "run.started") {
    return null;
  }

  const completed = forRun.find((event) => event.type === "run.completed");
  const failed = forRun.find((event) => event.type === "run.failed");
  const cancelled = forRun.find((event) => event.type === "run.cancelled");
  const terminal = completed ?? failed ?? cancelled;

  if (!terminal) {
    return null;
  }

  const toolCalls: RunReceipt["toolCalls"] = [];
  // Keyed by path so repeated patches to one file stay one changed file.
  const changedByPath = new Map<string, RunReceipt["filesChanged"][number]>();
  const tests: RunReceipt["tests"] = [];
  const checks: RunReceipt["checks"] = [];
  const approvals: RunReceipt["approvals"] = [];
  // A denial names only its tool call id, but the approval request that
  // preceded it carries the tool name, so the pair recovers what was refused.
  const deniedToolNames = new Map<string, string>();

  for (const event of forRun) {
    if (event.type === "tool.approval_requested") {
      deniedToolNames.set(event.payload.call.id, event.payload.call.name);
    }
  }

  for (const event of forRun) {
    if (event.type === "tool.completed") {
      const { result } = event.payload;

      toolCalls.push({
        toolCallId: result.toolCallId,
        name: result.name,
        outcome: "completed",
      });

      // Only an applied patch changed the tree. A proposal is a preview, and
      // counting it here would report edits that were never written.
      if (result.name === "apply_patch") {
        const existing = changedByPath.get(result.output.path);

        changedByPath.set(result.output.path, {
          path: result.output.path,
          additions: (existing?.additions ?? 0) + result.output.additions,
          deletions: (existing?.deletions ?? 0) + result.output.deletions,
          patches: (existing?.patches ?? 0) + 1,
          sequence: event.sequence,
        });
      }

      if (result.name === "run_tests") {
        tests.push({
          command: result.output.command,
          passed: result.output.passed,
          exitCode: result.output.exitCode,
          durationMs: result.output.durationMs,
          sequence: event.sequence,
        });
        checks.push({
          kind: "tests",
          command: result.output.command,
          passed: result.output.passed,
          exitCode: result.output.exitCode,
          durationMs: result.output.durationMs,
          problems: null,
          sequence: event.sequence,
        });
      }

      // A build is a verification the receipt used to drop on the floor. Its
      // own word for passing is `succeeded`, for the reason the contract gives
      // — "does it still build" is the entire question — and it maps onto the
      // same `passed` as everything else here so a reader does not have to
      // learn one vocabulary per checker.
      if (result.name === "run_build") {
        checks.push({
          kind: "build",
          command: result.output.command,
          passed: result.output.succeeded,
          exitCode: result.output.exitCode,
          durationMs: result.output.durationMs,
          problems: null,
          sequence: event.sequence,
        });
      }

      // Typecheck and lint arrive through one tool that says which it was, so
      // the receipt records them as the two kinds they are rather than as one
      // undifferentiated "diagnostics" row. `ok` is the verdict and the
      // diagnostic count is not: the contract is explicit that a checker can
      // fail with output the parser did not recognise, so zero problems is not
      // clean unless `ok` also says so.
      if (result.name === "run_diagnostics") {
        checks.push({
          kind: result.output.kind,
          command: result.output.command,
          passed: result.output.ok,
          exitCode: result.output.exitCode,
          durationMs: result.output.durationMs,
          problems: result.output.diagnostics.length,
          sequence: event.sequence,
        });
      }
    }

    // The observed counterpart to the patch list above, and the only file
    // evidence an external harness produces. Without it every Claude Code and
    // Codex receipt reported zero files changed — an under-claim that reads
    // as "the agent wrote nothing", which is the more misleading of the two
    // ways to be wrong here.
    if (event.type === "harness.changes_observed") {
      for (const file of event.payload.files) {
        const existing = changedByPath.get(file.path);

        changedByPath.set(file.path, {
          path: file.path,
          // Replaced, not summed: a diff against the run's base already
          // contains whatever a patch to the same file added.
          additions: file.additions,
          deletions: file.deletions,
          // One *observation*, not one reviewed patch — no patch crossed
          // Novus for any of these. The contract requires a positive count
          // here and cannot say "observed" instead, so the honest reading
          // lives on `harness.changes_observed` itself, whose `attributable`
          // flag is what a reader has to consult before crediting anyone.
          patches: existing?.patches ?? 1,
          sequence: event.sequence,
        });
      }
    }

    if (event.type === "tool.failed") {
      toolCalls.push({
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        outcome: "failed",
      });
    }

    if (event.type === "tool.denied") {
      toolCalls.push({
        toolCallId: event.payload.toolCallId,
        name: deniedToolNames.get(event.payload.toolCallId) ?? "unknown",
        outcome: "denied",
      });
      approvals.push({
        toolCallId: event.payload.toolCallId,
        decision: "denied",
        actorId: event.payload.deniedBy,
        reason: event.payload.reason,
      });
    }

    if (event.type === "tool.approved") {
      approvals.push({
        toolCallId: event.payload.toolCallId,
        decision: "approved",
        actorId: event.payload.approvedBy,
      });
    }
  }

  const startedAt = started.occurredAt;
  const finishedAt = terminal.occurredAt;
  const filesChanged = [...changedByPath.values()].sort(
    (first, second) => first.sequence - second.sequence,
  );

  const lastChange = filesChanged.at(-1)?.sequence;
  const lastTest = tests.at(-1)?.sequence;
  const testsFollowedFinalChange =
    lastChange === undefined || lastTest === undefined
      ? null
      : lastTest > lastChange;

  // The verdict comes from `@novus/contracts/verification`, which is where the
  // rule this file used to own now lives. It was moved rather than copied
  // outward: three other readers had each restated it and each had dropped a
  // clause, so the receipt agreeing with the screen depended on nobody
  // editing either. `checks` above is still built here, because the receipt is
  // the one artifact that needs each check's command and kind, not just the
  // verdict over them.
  const verification: RunReceipt["verification"] = readVerification(
    forRun,
    { runId },
  ).verdict;

  return RunReceiptSchema.parse({
    runId,
    sessionId: started.sessionId,
    goal: started.payload.run.goal,
    model: started.payload.run.model,
    status: completed ? "completed" : failed ? "failed" : "cancelled",
    base: context.base,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    ),
    usage: context.usage,
    toolCalls,
    filesChanged,
    tests,
    testsFollowedFinalChange,
    checks,
    verification,
    approvals,
    ...(completed?.type === "run.completed"
      ? { summary: completed.payload.summary }
      : {}),
    ...(failed?.type === "run.failed"
      ? { failure: failed.payload.reason }
      : {}),
  });
};
