import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime();

export const ModelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ReadFileToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("read_file"),
  input: z.object({
    path: z.string().min(1),
  }),
});

export const SearchRepositoryToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("search_repository"),
  input: z.object({
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
});

export const ProposePatchToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("propose_patch"),
  input: z.object({
    path: z.string().min(1),
    intent: z.string().min(1),
    edits: z
      .array(
        z.object({
          oldText: z.string().min(1),
          newText: z.string(),
        }),
      )
      .min(1)
      .max(20),
  }),
});

// Applying carries no edits of its own: it references a `patchId` returned by
// an earlier propose_patch call. Application is a separate, permissioned step,
// so a proposal can be reviewed (and denied) before it touches the working tree.
export const ApplyPatchToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("apply_patch"),
  input: z.object({
    patchId: IdSchema,
  }),
});

// Commands are described as a program plus an argument vector, never as a single
// string. A string would have to reach a shell to be useful, and a shell turns
// every argument the model writes into possible `;`, `&&`, `$()`, and
// redirection — an escape from the repository boundary through the one tool
// whose whole job is to run code.
export const RunCommandToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_command"),
  input: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).max(64).default([]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

export const RunTestsToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_tests"),
  input: z.object({
    args: z.array(z.string()).max(32).default([]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadFileToolCallSchema,
  SearchRepositoryToolCallSchema,
  ProposePatchToolCallSchema,
  ApplyPatchToolCallSchema,
  RunCommandToolCallSchema,
  RunTestsToolCallSchema,
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ReadFileToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("read_file"),
  output: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
});

export const SearchRepositoryToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("search_repository"),
  output: z.object({
    query: z.string().min(1),
    matches: z.array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        text: z.string(),
      }),
    ),
  }),
});

// A proposal is a preview only. `status` stays "proposed" until a separate,
// permissioned application step writes it to the working tree.
export const ProposePatchToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("propose_patch"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    intent: z.string().min(1),
    status: z.literal("proposed"),
    diff: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export const ApplyPatchToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("apply_patch"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    status: z.literal("applied"),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

// Both execution tools report the same shape, because the model needs the same
// evidence either way: what ran, how it ended, and what it said. `exitCode` is
// null when a signal ended the process — a timeout kill is not exit 0, and
// collapsing the two would let a killed command read as a clean one.
const CommandOutcomeSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  // Output is capped so one runaway command cannot exhaust the model's context.
  truncated: z.boolean(),
});

export const RunCommandToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_command"),
  output: CommandOutcomeSchema,
});

export const RunTestsToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_tests"),
  output: CommandOutcomeSchema.extend({
    // Stated explicitly rather than left for the model to infer from exitCode,
    // because "did my change work" is the entire question this tool exists for.
    passed: z.boolean(),
  }),
});

export const ToolResultSchema = z.discriminatedUnion("name", [
  ReadFileToolResultSchema,
  SearchRepositoryToolResultSchema,
  ProposePatchToolResultSchema,
  ApplyPatchToolResultSchema,
  RunCommandToolResultSchema,
  RunTestsToolResultSchema,
]);

export type ToolResult = z.infer<typeof ToolResultSchema>;

// session
export const SessionSchema = z.object({
  id: IdSchema,
  repositoryPath: z.string().min(1),
  goal: z.string().min(1),
  status: z.enum(["active", "paused", "completed"]),
  createdAt: TimestampSchema,
});

export type Session = z.infer<typeof SessionSchema>;

// a human or agent
export const ParticipantSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  name: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  role: z.enum(["owner", "editor", "reviewer", "viewer"]),
  joinedAt: TimestampSchema,
});

export type Participant = z.infer<typeof ParticipantSchema>;

// one agent execution
export const RunSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  goal: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "waiting_for_human",
    "completed",
    "failed",
    "cancelled",
  ]),
  startedBy: IdSchema,
  model: ModelSelectionSchema,
  createdAt: TimestampSchema,
});

export type Run = z.infer<typeof RunSchema>;


/**
 * What a finished run proves about itself.
 *
 * Assembled from the event log rather than accumulated alongside it, so the
 * receipt cannot claim anything the ordered history does not already contain.
 * If the two ever disagree, the events are right and the receipt is a bug.
 *
 * Cost in currency is deliberately absent. Token counts are exact and come from
 * the provider; a price per token is a table that goes stale, and a stale number
 * inside a document whose whole purpose is evidence is worse than no number.
 * Cost belongs with routing, which V1 defers.
 */
export const RunReceiptSchema = z.object({
  runId: IdSchema,
  sessionId: IdSchema,
  goal: z.string().min(1),
  model: ModelSelectionSchema,
  status: z.enum(["completed", "failed"]),
  // Null when the repository is not a Git checkout. Recorded at session start,
  // so a diff in this receipt can be reproduced against a known base.
  startingRevision: z.string().min(1).nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  elapsedMs: z.number().int().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  }),
  toolCalls: z.array(
    z.object({
      toolCallId: IdSchema,
      name: z.string().min(1),
      outcome: z.enum(["completed", "failed", "denied"]),
    }),
  ),
  filesChanged: z.array(
    z.object({
      path: z.string().min(1),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  tests: z.array(
    z.object({
      command: z.string().min(1),
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
    }),
  ),
  approvals: z.array(
    z.object({
      toolCallId: IdSchema,
      decision: z.enum(["approved", "denied"]),
      actorId: IdSchema,
      reason: z.string().min(1).optional(),
    }),
  ),
  // Present on completion; absent when the run failed, where `failure` explains.
  summary: z.string().min(1).optional(),
  failure: z.string().min(1).optional(),
});

export type RunReceipt = z.infer<typeof RunReceiptSchema>;

const EventEnvelopeSchema = z.object({
  eventId: IdSchema,
  sessionId: IdSchema,
  sequence: z.number().int().nonnegative(),
  actorId: IdSchema,
  occurredAt: TimestampSchema,
});

export const SessionCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("session.created"),
  payload: z.object({
    session: SessionSchema,
  }),
});

export const RunStartedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.started"),
  payload: z.object({
    run: RunSchema,
  }),
});

export const RunProgressEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.progress"),
  payload: z.object({
    runId: IdSchema,
    message: z.string().min(1),
  }),
});

export const DirectionSubmittedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("direction.submitted"),
  payload: z.object({
    runId: IdSchema,
    direction: z.string().min(1),
  }),
});

export const RunCompletedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.completed"),
  payload: z.object({
    runId: IdSchema,
    summary: z.string().min(1),
  }),
});

export const ToolRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.requested"),
  payload: z.object({
    runId: IdSchema,
    call: ToolCallSchema,
  }),
});

export const ToolCompletedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.completed"),
  payload: z.object({
    runId: IdSchema,
    result: ToolResultSchema,
  }),
});

// Write and dangerous tool calls cross an approval boundary before they run.
// The request and its resolution are both recorded, so a receipt can show who
// authorised every consequential action.
export const ToolApprovalRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.approval_requested"),
  payload: z.object({
    runId: IdSchema,
    call: ToolCallSchema,
    toolClass: z.enum(["write", "dangerous"]),
  }),
});

export const ToolApprovedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.approved"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    approvedBy: IdSchema,
  }),
});

export const ToolDeniedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.denied"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    deniedBy: IdSchema,
    reason: z.string().min(1),
  }),
});

// A tool that rejects is an observation, not the end of the run: the message
// is returned to the model so it can correct the call.
export const ToolFailedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.failed"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    name: z.string().min(1),
    message: z.string().min(1),
  }),
});

// Emitted once per run, after run.completed or run.failed, so the receipt can
// summarise the terminal event too.
export const ReceiptCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("receipt.created"),
  payload: z.object({
    runId: IdSchema,
    receipt: RunReceiptSchema,
  }),
});

export const RunFailedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.failed"),
  payload: z.object({
    runId: IdSchema,
    reason: z.string().min(1),
  }),
});

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  RunStartedEventSchema,
  RunProgressEventSchema,
  DirectionSubmittedEventSchema,
  ToolRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovedEventSchema,
  ToolDeniedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  ReceiptCreatedEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionEventDraftSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunStartedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunProgressEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  DirectionSubmittedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolApprovalRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolApprovedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolDeniedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolCompletedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolFailedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunCompletedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunFailedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ReceiptCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
]);

export type SessionEventDraft = z.infer<typeof SessionEventDraftSchema>;
