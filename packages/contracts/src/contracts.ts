import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime();

// shared repo
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
  createdAt: TimestampSchema,
});

export type Run = z.infer<typeof RunSchema>;


const EventEnvelopeSchema = z.object({
  id: IdSchema,
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

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  RunStartedEventSchema,
  RunProgressEventSchema,
  DirectionSubmittedEventSchema,
  RunCompletedEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
