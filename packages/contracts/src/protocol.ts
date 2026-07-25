import { z } from "zod";

/**
 * The HTTP contract between a Novus client and the local worker.
 *
 * Kept separate from the session/event contracts so the transport can change
 * without touching the domain model.
 */

export const CreateSessionRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  allowWrites: z.boolean().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  repositoryPath: z.string().min(1),
  allowWrites: z.boolean(),
  createdAt: z.string().datetime(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SubmitTurnRequestSchema = z.object({
  goal: z.string().min(1).max(20_000),
});

export type SubmitTurnRequest = z.infer<typeof SubmitTurnRequestSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string().min(1),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
