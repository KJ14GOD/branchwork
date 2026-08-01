import { z } from "zod";

import {
  DecisionKindSchema,
  DecisionOutcomeSchema,
  DecisionRationaleSchema,
  DecisionTargetSchema,
  ParticipantSchema,
} from "./contracts.ts";

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
  /**
   * The execution the alternatives are alternatives *to*.
   *
   * At most one attempt carries it, and it is not a rank: the baseline is the
   * work already in flight, not the leading candidate. The screen drew only
   * forks before this existed, so a session with no fork yet showed an empty
   * comparison — a decision surface with nothing on it — and a session with one
   * fork showed the alternative without the thing it was an alternative to.
   * One approach on screen is the correct state for work that has not branched.
   */
  baseline: z.boolean(),
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
  /**
   * What a person did during this approach: steered it, approved a write,
   * refused one.
   *
   * Evidence, and ranked above the agent's summary deliberately — a human
   * having had to intervene three times says something about an approach that
   * its own account of itself will not, and an approach that reached a clean
   * result only because somebody denied a bad patch is not the same result as
   * one that got there alone.
   */
  interventions: z.array(
    z.object({
      kind: z.enum(["direction", "approved", "denied"]),
      /** The direction's text, or the tool that was approved or refused. */
      detail: z.string().min(1),
      at: z.string().datetime(),
    }),
  ),
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
  /**
   * Whether `runId` names an alternative or the baseline.
   *
   * Carried rather than re-derived. A client could ask whether `runId` matches
   * the attempt currently flagged `baseline`, but that flag moves the moment
   * somebody forks again — the screen would then say a past decision had been
   * about an alternative. Absent on decisions recorded before the baseline
   * could be chosen; those all named an attempt.
   */
  target: DecisionTargetSchema.optional(),
  /** The checkpoint the comparison was made across, when the decision named one. */
  checkpointId: z.string().min(1).optional(),
  /** The approaches this was decided against, by run id. Absent means unrecorded. */
  alternatives: z.array(z.string().min(1)).optional(),
  /** Absent on decisions recorded before the kind existed; those were adoptions. */
  kind: DecisionKindSchema.optional(),
  rationale: z.string().min(1).optional(),
  /** Who recorded it. The event's actor, carried through so a reload still names them. */
  decidedBy: z.string().min(1).optional(),
  outcome: DecisionOutcomeSchema,
});

export type DecisionSummary = z.infer<typeof DecisionSummarySchema>;

// Re-exported so a renderer importing the HTTP contract does not also have to
// import the domain contract for the one enum it needs alongside it.
export type { DecisionKind, DecisionTarget } from "./contracts.ts";

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

/** What a host submits to choose between attempts, or to keep the baseline. */
export const DecisionRequestSchema = z.object({
  runId: z.string().min(1),
  /**
   * Absent means adopt, so a caller written before this existed still works.
   * Nothing in the desktop app relies on that — the composer always sends one
   * — but the route is the boundary and it should not break on an old client.
   */
  kind: DecisionKindSchema.optional(),
  /**
   * Required, here, at the boundary — not only in the form.
   *
   * This used to be optional with the argument that enforcing it would make
   * decisions recorded before rationales existed unreplayable. That argument
   * confused two schemas. This one describes what a client is *submitting
   * now*, and there is no such thing as a historical submission; the durable
   * shape is `DecisionRecordedEventSchema`, which stays lenient precisely so
   * the old rows keep parsing. Leaving the rule in React meant the rule was a
   * property of one build of one renderer: curl, a stale desktop, a future
   * joined client or a relay replaying a hand-written body all wrote
   * rationale-free decisions into a log whose whole purpose is to say why.
   *
   * The floor is `DecisionRationaleSchema`'s 12 characters — the same number
   * the compare screen already disables its button below, so the form stays
   * the courtesy and this is the backstop, and neither can drift from the
   * other because both read this one schema.
   */
  rationale: DecisionRationaleSchema,
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
 * What a controller submits to offer execution authority to someone else.
 *
 * An offer, not a transfer. The atomic version let a controller assign
 * responsibility to someone offline, asleep, or not looking — control landing
 * on a participant who never agreed to hold it. Now the recipient answers,
 * and control moves only after acceptance, at a safe boundary if a run is
 * executing.
 */
export const HandoffRequestSchema = z.object({
  toParticipantId: z.string().min(1),
});

export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

/**
 * What a participant submits to answer a pending handoff offer — accept or
 * decline as the recipient, withdraw as the offerer. The offerEventId pins
 * which offer is being answered, so an answer racing a newer offer refuses
 * rather than settling the wrong one.
 */
export const HandoffAnswerSchema = z.object({
  offerEventId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export type HandoffAnswer = z.infer<typeof HandoffAnswerSchema>;

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
 * Who holds control, who is asking for it, and what direction is waiting.
 *
 * The authority slice of the worker's own projection, served rather than
 * re-folded per renderer. Every client already receives the whole event log
 * and could fold this itself — but the worker folds the same log to decide who
 * may act, and two folds of one lifecycle is how a timeline and a baton come
 * to disagree. When they disagree it is the baton that is wrong and the person
 * acting on it who pays, so there is one fold and it is the server's.
 *
 * A response rather than an event stream for the same reason presence is:
 * a client that just opened needs the standing facts immediately — that
 * somebody requested control an hour ago, that an offer is waiting on it —
 * without replaying anything.
 */
export const ControlOfferSchema = z.object({
  /** The offer's own event id. Every later step in the handoff points at it. */
  offerEventId: z.string().min(1),
  fromParticipantId: z.string().min(1),
  toParticipantId: z.string().min(1),
  /** Waiting on the recipient, or accepted and waiting on a safe boundary. */
  state: z.enum(["offered", "accepted"]),
  offeredAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
});

export type ControlOfferView = z.infer<typeof ControlOfferSchema>;

export const AuthorityResponseSchema = z.object({
  /**
   * Which participant the calling token is.
   *
   * "Maya in control" and "You are in control" are the same fact and
   * completely different screens, so a renderer cannot draw authority without
   * this. Null on a worker with no participant registry — the single-user
   * path, where there is nobody to be.
   */
  you: z.string().min(1).nullable(),
  controlHeldBy: z.string().min(1).nullable(),
  controlOffer: ControlOfferSchema.nullable(),
  controlRequests: z.array(
    z.object({
      eventId: z.string().min(1),
      participantId: z.string().min(1),
      reason: z.string().nullable(),
      requestedAt: z.string().datetime(),
    }),
  ),
  pendingDirection: z.array(
    z.object({
      eventId: z.string().min(1),
      direction: z.string().min(1),
      submittedAt: z.string().datetime(),
      /**
       * Non-null means a live run has committed to folding it in at its next
       * turn boundary. Null means it is recorded and waits for whatever runs
       * next, which may be never — two different promises to whoever typed it.
       */
      queuedForRunId: z.string().min(1).nullable(),
      queuedAt: z.string().datetime().nullable(),
    }),
  ),
  /** What a transfer waiting on a safe boundary is waiting on. */
  executingRunIds: z.array(z.string().min(1)),
});

export type Authority = z.infer<typeof AuthorityResponseSchema>;

/**
 * A session the log remembers, for the Open screen to offer.
 *
 * Durable history that nothing can reach is not really durable — the event log
 * held every session ever opened and there was no way to get back to one.
 */
/**
 * Why this mission is in front of you, ordered most-urgent first.
 *
 * The home screen was a list of repository paths and event counts, which
 * answers "what exists" and never "what needs me" — and a count of 4 tells a
 * person nothing at all. These are the states from STEERING's inbox, and they
 * are derived rather than stored: the log already knows whether a run is in
 * flight, whether a decision is outstanding, and whether somebody is waiting.
 */
export const MissionAttentionSchema = z.enum([
  /** Approaches exist and nobody has decided between them. */
  "needs-decision",
  /** A tool is waiting on an approval that has not been given or refused. */
  "needs-approval",
  /** Somebody asked for control, or a handoff is in flight. */
  "waiting-on-someone",
  /** A run is in flight right now. */
  "running",
  /** Nothing is running and nothing is blocked — it is waiting for a person. */
  "needs-direction",
  /** A decision was recorded. Nothing is being asked of anyone. */
  "settled",
]);

export type MissionAttention = z.infer<typeof MissionAttentionSchema>;

export const RememberedSessionSchema = z.object({
  id: z.string().min(1),
  repositoryPath: z.string().min(1),
  createdAt: z.string().datetime(),
  /** How much happened, so an abandoned session is distinguishable from real work. */
  events: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime(),
  /**
   * What this mission is actually about — the first run's goal.
   *
   * The row led with the repository path, so five missions in one repository
   * were five identical rows. The goal is the thing a person recognises; the
   * repository is how they narrow down once they already know which one.
   */
  goal: z.string().min(1).nullable(),
  attention: MissionAttentionSchema,
  /** How many approaches exist, baseline included. */
  approaches: z.number().int().nonnegative(),
  /**
   * Whether anything in this mission was actually verified.
   *
   * `unverified` is not a synonym for failing: it is a mission whose runs
   * finished having tested nothing, which is precisely the state that reads as
   * success everywhere it is not named.
   */
  evidence: z.enum(["verified", "failing", "unverified"]),
  /** Who holds control, by display name, when anyone does. */
  controller: z.string().min(1).nullable(),
  participants: z.number().int().nonnegative(),
});

export type RememberedSession = z.infer<typeof RememberedSessionSchema>;

/**
 * What GitHub says about the branch this repository is on.
 *
 * Local tests prove a change works on this machine. Required checks prove it
 * works somewhere that is not yours, against a configuration you did not set
 * up for yourself — a different and usually stronger claim, and the one a
 * reviewer wants before adopting anything.
 *
 * Read through the operator's own `gh` CLI, so Novus never sees a token and
 * never stores one. Not connected is a first-class answer rather than an
 * error: most repositories this runs against will have no GitHub remote, and
 * that is a fact about the repository, not a failure.
 */
export const GithubStatusSchema = z.union([
  z.object({
    connected: z.literal(false),
    reason: z.string().min(1),
  }),
  z.object({
    connected: z.literal(true),
    repository: z.string().min(1),
    /** Null when this branch has no pull request open. */
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        title: z.string().min(1),
        url: z.string().min(1),
        state: z.string().min(1),
        draft: z.boolean(),
      })
      .nullable(),
    checks: z.array(
      z.object({
        name: z.string().min(1),
        state: z.string().min(1),
        url: z.string().min(1).optional(),
      }),
    ),
    /**
     * The checks taken together.
     *
     * `none` is its own answer and is never folded into `passing`. A branch
     * nobody configured checks for has been verified by nothing, which is
     * exactly as unproven as a run that skipped its tests.
     *
     * `stale` is the trap this exists to name. Checks ran, but against a
     * different commit than the branch is on now — including the case where
     * the workflow has since been deleted and its last runs simply linger.
     * A green run from two weeks ago says nothing about the code in front of
     * you, and reporting it as the branch's state is the same lie as a tick
     * on a suite that passed before the final edit.
     */
    verdict: z.enum(["passing", "failing", "running", "none", "stale"]),
  }),
]);

export type GithubStatus = z.infer<typeof GithubStatusSchema>;

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
/**
 * One thing this machine can run, and on whose account.
 *
 * Novus holds no accounts and runs no sign-in flow of its own. The harnesses a
 * team already uses have each done their own OAuth, and the credential lives
 * with them — so this reports what was *found*, never what Novus granted.
 *
 * `installed` and `connected` are separate because they fail differently and
 * are fixed differently: one is `brew install`, the other is `claude auth
 * login`. Collapsing them into a tick would tell somebody nothing about which
 * of the two they need to do.
 */
export const ProviderStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** A harness runs agents; a service is something a mission depends on. */
  kind: z.enum(["harness", "service"]),
  installed: z.boolean(),
  connected: z.boolean(),
  version: z.string().min(1).nullable(),
  /**
   * The provider's own words about its plan or login — "Max plan", "Logged in
   * using ChatGPT", "API key — billed per token". Materially different facts
   * that a generic tick would flatten: one is already paid for, another bills
   * per token.
   */
  detail: z.string().min(1),
  account: z.string().min(1).nullable(),
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderStatusSchema),
});

export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

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

/**
 * What a session has spent, and what each run in it spent.
 *
 * Folded from the receipts in the session's own log, so it survives the
 * restart that used to reset it: budgets accumulate in memory, and that memory
 * dies with the process — a resumed session showed zero spend to a host who
 * had already spent real money on it, which made the cost ceiling they set
 * decoration rather than a guard.
 *
 * `costUsd` is null, never zero, when nothing could be priced. A session
 * reported as free because no model in it had a published rate is a worse
 * answer than one that says it does not know, and a ceiling checked against
 * an uncounted spend would never trip.
 */
export const SessionUsageResponseSchema = z.object({
  session: z.object({
    costUsd: z.number().nonnegative().nullable(),
    /**
     * True when the figure is a floor rather than a total — some run was
     * unpriced, some call reported no usage, or a run is still in flight and
     * has not written its receipt yet.
     */
    costIsFloor: z.boolean(),
    totalTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    unpricedRuns: z.number().int().nonnegative(),
  }),
  /** One row per finished run, attempts named so spend reads per approach. */
  runs: z.array(
    z.object({
      runId: IdSchema,
      label: z.string().min(1).nullable(),
      isAttempt: z.boolean(),
      costUsd: z.number().nonnegative().nullable(),
      totalTokens: z.number().int().nonnegative(),
      modelCalls: z.number().int().nonnegative(),
      verification: z.enum(["verified", "failing", "unverified"]),
    }),
  ),
});

export type SessionUsageResponse = z.infer<typeof SessionUsageResponseSchema>;
