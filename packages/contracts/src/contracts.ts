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

export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadFileToolCallSchema,
  SearchRepositoryToolCallSchema,
  ProposePatchToolCallSchema,
  ApplyPatchToolCallSchema,
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

export const ToolResultSchema = z.discriminatedUnion("name", [
  ReadFileToolResultSchema,
  SearchRepositoryToolResultSchema,
  ProposePatchToolResultSchema,
  ApplyPatchToolResultSchema,
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
]);

export type SessionEventDraft = z.infer<typeof SessionEventDraftSchema>;
