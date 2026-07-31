import { z } from "zod";

import { DecisionOutcomeSchema, ParticipantSchema } from "./contracts.ts";

const IdSchema = z.string().min(1);

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
  /**
   * Continue a session the log already knows about.
   *
   * Reusing its id is what makes the old timeline reappear — a new id would
   * start an empty stream beside a history nobody can reach. Permissions are
   * deliberately *not* restored: a session recorded with writes allowed should
   * not silently regain them, so a resumed session takes the host's current
   * defaults and the checkboxes still decide.
   */
  resume: IdSchema.optional(),
  // Omitted means "use the host's default". Present wins: the operator opening
  // the repository is the host, on a loopback-only API, so the control they are
  // looking at is the authority for that session. If session creation is ever
  // exposed to a remote guest, this needs to become a ceiling rather than a
  // default — the guest must not be able to widen what the host configured.
  allowWrites: z.boolean().optional(),
  allowCommands: z.boolean().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * Whether this repository can do everything Novus offers.
 *
 * Reported when a session opens rather than discovered when a feature fails. A
 * directory with no commits is a perfectly good place to write code and a
 * useless one to fork from, and finding that out only when you press Fork means
 * finding out after you have done the work.
 *
 * `absent` — not a Git repository at all. `no-commits` — initialised, nothing
 * committed, so there is no base for a checkpoint. `ready` — everything works.
 */
export const RepositoryStateSchema = z.enum(["ready", "no-commits", "absent"]);

export type RepositoryState = z.infer<typeof RepositoryStateSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  repositoryPath: z.string().min(1),
  repositoryState: RepositoryStateSchema,
  allowWrites: z.boolean(),
  allowCommands: z.boolean(),
  createdAt: z.string().datetime(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SubmitTurnRequestSchema = z.object({
  goal: z.string().min(1).max(20_000),
  /**
   * An explicit model for this turn — the composer's picker, as opposed to
   * its "Auto". Absent means route: the worker's router decides. Present, it
   * wins outright and the router is not consulted, because a human choosing
   * a model is an instruction rather than a hint.
   *
   * Validated against the adapters the worker actually has before the turn
   * starts, so a model nobody can serve is a 400 the composer can show
   * rather than a run that dies mid-flight with "No model adapter is
   * configured".
   */
  model: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .optional(),
});

export type SubmitTurnRequest = z.infer<typeof SubmitTurnRequestSchema>;

// An owner cannot mint a second owner — ownership moves by handoff, which both
// parties see, so the roles offered here are deliberately the ones below it.
export const InviteRequestSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["editor", "reviewer", "viewer"]),
});

export type InviteRequest = z.infer<typeof InviteRequestSchema>;

// The token is returned exactly once, in this response. Nothing stores it
// anywhere it can be read back afterward.
export const InviteResponseSchema = z.object({
  participant: ParticipantSchema,
  token: z.string().min(1),
});

export type InviteResponse = z.infer<typeof InviteResponseSchema>;

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
  status: z.enum(["running", "paused", "completed", "failed", "cancelled"]),
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

/**
 * The most recent choice recorded for this session, if a host has made one.
 *
 * Carried on the comparison rather than left to the caller's own memory of
 * having clicked a button: a decision that only lived in one browser tab's
 * state was not really recorded, and this is what lets a reload or a second
 * window agree on what was already decided.
 */
export const DecisionSummarySchema = z.object({
  runId: z.string().min(1),
  outcome: DecisionOutcomeSchema,
});

export type DecisionSummary = z.infer<typeof DecisionSummarySchema>;

export const ComparisonSchema = z.object({
  attempts: z.array(AttemptComparisonSchema),
  /** Paths more than one attempt changed: where they genuinely disagree. */
  contestedPaths: z.array(z.string().min(1)),
  /** Paths only one attempt changed, by run id. */
  uniquePaths: z.record(z.string(), z.array(z.string().min(1))),
  /** Null until a host has chosen an attempt. */
  decision: DecisionSummarySchema.nullable(),
});

export type Comparison = z.infer<typeof ComparisonSchema>;

/** What a host submits to choose between attempts. */
export const DecisionRequestSchema = z.object({
  runId: z.string().min(1),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** What a host submits to stop a run in flight. */
export const CancelRunRequestSchema = z.object({
  runId: z.string().min(1),
});

export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

/** What a host submits to suspend a run in flight, for a later resume. */
export const PauseRunRequestSchema = z.object({
  runId: z.string().min(1),
});

export type PauseRunRequest = z.infer<typeof PauseRunRequestSchema>;

/** What a host submits to continue a run it previously paused. */
export const ResumeRunRequestSchema = z.object({
  runId: z.string().min(1),
});

export type ResumeRunRequest = z.infer<typeof ResumeRunRequestSchema>;

/** What a participant submits to ask the current controller for control. */
export const ControlRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});

export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/**
 * What an owner submits to move execution authority to someone else.
 *
 * V1_README describes acceptance as a separate step; this contract keeps it
 * atomic, the same way an invite mints a role without a confirmation
 * round-trip — the recipient sees the transfer in the timeline the moment it
 * happens rather than being asked to confirm one first.
 */
export const HandoffRequestSchema = z.object({
  toParticipantId: z.string().min(1),
});

export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

/**
 * Who has this session open right now, distinct from who was ever invited.
 *
 * Crosses the HTTP boundary like everything else here, closing the gap
 * `apps/desktop/src/use-presence.ts` and `apps/guest/src/use-presence.ts`
 * both flagged with a TODO when `/presence` was first built: the response was
 * read as a plain shape rather than validated.
 */
export const PresenceEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["owner", "editor", "reviewer", "viewer"]),
  connected: z.boolean(),
});

export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const PresenceResponseSchema = z.object({
  participants: z.array(PresenceEntrySchema),
});

export type PresenceResponse = z.infer<typeof PresenceResponseSchema>;

/**
 * A session the log remembers, for the Open screen to offer.
 *
 * Durable history that nothing can reach is not really durable — the event log
 * held every session ever opened and there was no way to get back to one.
 */
export const RememberedSessionSchema = z.object({
  id: z.string().min(1),
  repositoryPath: z.string().min(1),
  createdAt: z.string().datetime(),
  /** How much happened, so an abandoned session is distinguishable from real work. */
  events: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime(),
});

export type RememberedSession = z.infer<typeof RememberedSessionSchema>;

export const SessionHistorySchema = z.object({
  sessions: z.array(RememberedSessionSchema),
});

export type SessionHistory = z.infer<typeof SessionHistorySchema>;

/**
 * What changed in the session's own working tree — not a fork's.
 *
 * Deliberately the same shape `AttemptComparisonSchema.filesChanged` above
 * already uses, because it is the same computation: both are
 * `RunProjection.filesChanged`, folded by `projectSession`. This is that
 * projection's numbers for the session's own (non-fork) runs, summed across
 * every turn so far — the honest source for a changed-files panel, not a
 * second way of tracking what an agent touched. See the same caveat
 * `filesChanged` carries elsewhere: it covers `apply_patch` only, not writes
 * made through `run_command`.
 */
export const SessionFilesResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type SessionFilesResponse = z.infer<typeof SessionFilesResponseSchema>;
