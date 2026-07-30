import { z } from "zod";

/**
 * The HTTP contract between a Novus client and the local worker.
 *
 * Kept separate from the session/event contracts so the transport can change
 * without touching the domain model.
 */

// What this host is configured to permit, before any one session narrows it.
// The client reads this to seed its permission controls, so an operator who set
// NOVUS_ALLOW_WRITES=1 sees the box already ticked rather than an unchecked box
// that silently contradicts their environment.
export const HostCapabilitiesSchema = z.object({
  status: z.literal("ok"),
  allowWrites: z.boolean(),
  allowCommands: z.boolean(),
});

export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export const CreateSessionRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  // Omitted means "use the host's default". Present wins: the operator opening
  // the repository is the host, on a loopback-only API, so the control they are
  // looking at is the authority for that session. If session creation is ever
  // exposed to a remote guest, this needs to become a ceiling rather than a
  // default — the guest must not be able to widen what the host configured.
  allowWrites: z.boolean().optional(),
  allowCommands: z.boolean().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  repositoryPath: z.string().min(1),
  allowWrites: z.boolean(),
  allowCommands: z.boolean(),
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

/**
 * Two or more attempts, lined up for a person to choose between.
 *
 * Crosses the HTTP boundary, so it is a schema like everything else — the
 * compare screen is the one place a decision gets made from what it is shown,
 * and a field that arrived unvalidated would be a decision made on a guess.
 *
 * Note what is absent: no score, no ranking, no recommended attempt. V1 puts the
 * choice with a human on the evidence, and a shape that carried a verdict would
 * invite the UI to lead with it.
 */
export const AttemptComparisonSchema = z.object({
  runId: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["running", "completed", "failed"]),
  summary: z.string().min(1).nullable(),
  failure: z.string().min(1).nullable(),
  filesChanged: z.array(
    z.object({
      path: z.string().min(1),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  testsRun: z.number().int().nonnegative(),
  testsPassed: z.number().int().nonnegative(),
  // Null when the attempt ran no tests, which is not the same as failing them
  // and very much not the same as passing them.
  green: z.boolean().nullable(),
});

export type AttemptComparison = z.infer<typeof AttemptComparisonSchema>;

export const ComparisonSchema = z.object({
  attempts: z.array(AttemptComparisonSchema),
  /** Paths more than one attempt changed: where they genuinely disagree. */
  contestedPaths: z.array(z.string().min(1)),
  /** Paths only one attempt changed, by run id. */
  uniquePaths: z.record(z.string(), z.array(z.string().min(1))),
});

export type Comparison = z.infer<typeof ComparisonSchema>;
