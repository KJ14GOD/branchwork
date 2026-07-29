import {
  RunReceiptSchema,
  type RunReceipt,
  type SessionEvent,
} from "@novus/contracts";

export type ReceiptUsage = {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
};

export type ReceiptContext = {
  startingRevision: string | null;
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
  const terminal = completed ?? failed;

  if (!terminal) {
    return null;
  }

  const toolCalls: RunReceipt["toolCalls"] = [];
  const filesChanged: RunReceipt["filesChanged"] = [];
  const tests: RunReceipt["tests"] = [];
  const approvals: RunReceipt["approvals"] = [];

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
        filesChanged.push({
          path: result.output.path,
          additions: result.output.additions,
          deletions: result.output.deletions,
        });
      }

      if (result.name === "run_tests") {
        tests.push({
          command: result.output.command,
          passed: result.output.passed,
          exitCode: result.output.exitCode,
          durationMs: result.output.durationMs,
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
        name: "denied",
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

  return RunReceiptSchema.parse({
    runId,
    sessionId: started.sessionId,
    goal: started.payload.run.goal,
    model: started.payload.run.model,
    status: completed ? "completed" : "failed",
    startingRevision: context.startingRevision,
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
    approvals,
    ...(completed?.type === "run.completed"
      ? { summary: completed.payload.summary }
      : {}),
    ...(failed?.type === "run.failed"
      ? { failure: failed.payload.reason }
      : {}),
  });
};
