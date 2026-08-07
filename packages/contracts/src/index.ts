import { z } from "zod";

// Runtime-validated contracts shared by the control plane, the desktop main
// process, and the renderer IPC boundary. Domain meanings live in PRODUCT.md;
// representation rules live in ARCHITECTURE.md. This package carries shapes only.

export const UserSchema = z.object({
  userId: z.string().startsWith("usr_"),
  login: z.string().min(1),
  name: z.string().nullable()
});
export type User = z.infer<typeof UserSchema>;

export const OrganizationSchema = z.object({
  orgId: z.string().startsWith("org_"),
  name: z.string().min(1)
});
export type Organization = z.infer<typeof OrganizationSchema>;

/** The subset of PRODUCT.md#the-mission-state-model this build can actually
 *  reach. The schema widens as states become real; it never invents one. */
export const MissionStateSchema = z.enum([
  "new_mission",
  "workspace_needs_setup",
  "provisioning_workspace",
  "workspace_failed",
  "ready_for_instruction",
  "agent_starting",
  "agent_running",
  "agent_stopping",
  "needs_direction",
  "needs_approval",
  "paused",
  "work_completed_unverified",
  "ready_for_review",
  /** Somebody chose a result and said why. Deliberately not a terminal state
   *  and deliberately not "done": nothing has been published, which is a
   *  different fact and is said as one (D-075). */
  "decision_recorded",
  "verification_failed",
  "execution_interrupted"
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

/** Conditions that coexist with a primary state (PRODUCT.md overlays). */
export const MissionOverlaySchema = z.enum([
  "app_running",
  "verification_stale",
  "direction_queued",
  "control_requested",
  "handoff_offered",
  "handoff_waiting_for_boundary",
  /** The harness has reported nothing for long enough to say so. Never a limit
   *  and never a stop: D-034 forbids a Novus-imposed ceiling, and a turn that
   *  is quiet because it is running somebody's twenty-minute test suite is
   *  still running. What this fixes is the room having no way to say it. */
  "execution_stalled",
  "runner_offline"
]);
export type MissionOverlay = z.infer<typeof MissionOverlaySchema>;

// --- Repositories and workstreams (D-025, D-031) --------------------------

export const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-hex commit SHA");

/** A repository as the provider reports it, before Novus records it. */
export const AvailableRepositorySchema = z.object({
  providerRepoId: z.string().min(1), // stable provider identifier, never the name
  name: z.string().min(1), // owner/name, display only
  defaultBranch: z.string().min(1)
});
export type AvailableRepository = z.infer<typeof AvailableRepositorySchema>;

/** A repository Novus has recorded for an organization. `local` repositories
 *  live on a user's machine: the control plane records identity and receives
 *  reported outcomes; it never touches the folder, and paths never leave the
 *  machine (D-032). */
export const RepositoryProviderKindSchema = z.enum(["github", "local"]);
export const RepositoryRefSchema = z.object({
  repoId: z.string().startsWith("rep_"),
  provider: RepositoryProviderKindSchema,
  providerRepoId: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1)
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const RegisterLocalRepoInputSchema = z.object({
  localId: z.string().uuid(),
  name: z.string().min(1).max(200),
  defaultBranch: z.string().min(1),
  headSha: ShaSchema
});
export type RegisterLocalRepoInput = z.infer<typeof RegisterLocalRepoInputSchema>;

export const ReportBranchInputSchema = z.object({
  status: z.enum(["created", "failed"]),
  error: z.string().max(500).nullable().optional()
});
export type ReportBranchInput = z.infer<typeof ReportBranchInputSchema>;

export const BaseRevisionSchema = z.object({ ref: z.string().min(1), sha: ShaSchema });
export type BaseRevision = z.infer<typeof BaseRevisionSchema>;

export const BranchStatusSchema = z.enum(["pending", "created", "failed"]);
export type BranchStatus = z.infer<typeof BranchStatusSchema>;

/** How an approach must differ from the lane it forks. Required when the
 *  approach flag is set, and never long enough to be a plan (D-074). */
export const APPROACH_INTENT_MAX = 240;

export const WorkstreamSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  missionId: z.string().startsWith("msn_"),
  name: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: ShaSchema,
  missionBranch: z.string().min(1),
  branchStatus: BranchStatusSchema,
  branchError: z.string().nullable(),
  /** A deliberately created competing implementation, never a retry (D-006). */
  approach: z.boolean().default(false),
  /** One sentence on how this attempt is meant to differ. Present exactly when
   *  `approach` is true: an approach nobody can tell apart from its sibling is
   *  a continuation wearing a lane's clothes. */
  intent: z.string().max(APPROACH_INTENT_MAX).nullable().default(null),
  /** The lane this forked from, and the exact revision it forked at — two
   *  approaches are comparable because they started from the same commit. */
  forkedFromWorkstreamId: z.string().startsWith("wst_").nullable().default(null),
  originSha: z.string().nullable().default(null)
});
export type Workstream = z.infer<typeof WorkstreamSchema>;

export const CreateApproachInputSchema = z.object({
  /** The lane to fork beside. The new lane starts from the last checkpoint
   *  this lane *shares* with the lane it was itself forked from — for the
   *  mission's first lane that is its latest checkpoint, and for an approach
   *  it is the approach's own recorded origin, so a sibling never inherits
   *  work that exists only in the lane being read (D-079). */
  fromWorkstreamId: z.string().startsWith("wst_"),
  intent: z.string().trim().min(1, "Say how this approach should differ.").max(APPROACH_INTENT_MAX),
  /** Optional human label; the server names it when this is absent. */
  name: z.string().trim().min(1).max(80).optional(),
  /** The shared checkpoint the caller was shown. When present, the server
   *  refuses creation rather than forking from any other revision — an
   *  approach must never start from a commit nobody looked at (D-079). */
  expectedOriginSha: z.string().min(7).max(64).optional()
});
export type CreateApproachInput = z.infer<typeof CreateApproachInputSchema>;

export const MissionSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  orgId: z.string().startsWith("org_"),
  goal: z.string().min(1).max(500),
  successCriteria: z.string().min(1).max(5000),
  primaryState: MissionStateSchema,
  createdBy: z.string().startsWith("usr_"),
  createdByLogin: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Null only for missions created before repository connection existed. */
  repository: RepositoryRefSchema.nullable(),
  /** When this mission was filed away, and by whom. Null while it is in the
   *  ordinary list. Archival hides nothing and destroys nothing — every
   *  direction, event, checkpoint, check and approval stays exactly where it
   *  was, and the mission is still reachable and still restorable (D-063). */
  archivedAt: z.string().datetime().nullable(),
  archivedByLogin: z.string().nullable(),
  /** How many lanes this mission holds — 1 for almost every mission, more only
   *  where somebody deliberately forked an approach. The rail's "2 approaches"
   *  line reads this rather than fetching every room (D-080). */
  workstreamCount: z.number().int().positive().default(1)
});
export type Mission = z.infer<typeof MissionSchema>;

export const EventSchema = z.object({
  eventId: z.string().startsWith("evt_"),
  missionId: z.string().startsWith("msn_"),
  seq: z.number().int().positive(),
  kind: z.string().min(1),
  actor: z.object({
    kind: z.enum(["user", "harness", "runner", "system", "external"]),
    id: z.string().min(1),
    /** Display name for user actors, resolved server-side. */
    login: z.string().nullable()
  }),
  /** What authority the event acted under (ARCHITECTURE.md#event-model). */
  cause: z.object({
    directionId: z.string().nullable(),
    leaseId: z.string().nullable()
  }),
  executionId: z.string().nullable(),
  /** The lane the event acted on; null for mission-level events. The room
   *  filters its trace on this so one lane's activity never reads as
   *  another's (D-080). */
  workstreamId: z.string().nullable().default(null),
  payload: z.record(z.unknown()),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.string().datetime()
});
export type MissionEvent = z.infer<typeof EventSchema>;

export const CreateMissionInputSchema = z.object({
  goal: z.string().trim().min(1, "A mission needs a goal").max(500),
  successCriteria: z.string().trim().min(1, "State what success looks like").max(5000),
  provider: RepositoryProviderKindSchema.default("github"),
  providerRepoId: z.string().min(1, "Pick a repository"),
  baseRef: z.string().min(1),
  baseSha: ShaSchema,
  /** Client-generated per creation attempt; retries reuse it, so a retried
   *  or double-submitted creation can never mint a second mission or branch. */
  creationKey: z.string().uuid()
});
export type CreateMissionInput = z.infer<typeof CreateMissionInputSchema>;

// --- Harness selection ------------------------------------------------------
// The single allowlist for models. Each id is a real `--model` value verified
// live against the Claude Code CLI (PROGRESS.md, 2026-08-02). The renderer,
// the IPC boundary, and the execution adapter all read this one list; adding a
// value here without live verification is how a fictional model ships.

export const CLAUDE_MODELS = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
] as const;

/** Written literally so the type stays a union of exact ids; a contract test
 *  asserts it never drifts from CLAUDE_MODELS. */
export const ModelIdSchema = z.enum([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001"
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MODEL: ModelId = "claude-fable-5";
export const DEFAULT_EFFORT: Effort = "high";

// --- Roles, capabilities, participants (PRODUCT.md#roles-and-capabilities) --

export const MissionRoleSchema = z.enum(["mission_admin", "operator", "contributor", "viewer"]);
export type MissionRole = z.infer<typeof MissionRoleSchema>;

/** Every verb the server enforces. The interface renders from these; it never
 *  grants them (AGENTS.md rule 13). */
export const CapabilitySchema = z.enum([
  "mission.view",
  "mission.invite",
  /** File a mission away, and take it back out. Not deletion: nothing is
   *  destroyed, and there is no verb that destroys one (D-063). Distinct from
   *  the unimplemented `mission.close`, which would *end* a mission's work —
   *  a different act on a different lifecycle. */
  "mission.archive",
  "direction.submit",
  "direction.apply",
  "execution.start",
  "execution.stop",
  /** Start a competing approach beside this lane. A decision about the
   *  mission, not an operating verb on the lane being forked, so it is held by
   *  role and never granted by the baton (D-074). */
  "approach.create",
  /** Record a decision, or ask for a revision instead. PRODUCT.md's capability
   *  table has carried this since the first draft; D-075 implements it. */
  "review.approve",
  "workspace.command",
  /** Answering a harness approval. Lease-held only — a Mission Admin who is not
   *  the controller cannot answer for them (PRODUCT.md#roles-and-capabilities). */
  "approval.respond",
  "control.request",
  "control.offer",
  "control.accept",
  "control.revoke"
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ParticipantSchema = z.object({
  userId: z.string().startsWith("usr_"),
  login: z.string().min(1),
  name: z.string().nullable(),
  role: MissionRoleSchema,
  joinedAt: z.string().datetime(),
  isController: z.boolean()
});
export type Participant = z.infer<typeof ParticipantSchema>;

// --- Direction (PRODUCT.md#direction) ---------------------------------------

export const DirectionStateSchema = z.enum([
  "submitted",
  "queued",
  "applied",
  "superseded",
  "rejected",
  "cancelled"
]);
export type DirectionState = z.infer<typeof DirectionStateSchema>;

export const DirectionSchema = z.object({
  directionId: z.string().startsWith("dir_"),
  workstreamId: z.string().startsWith("wst_"),
  authorUserId: z.string().startsWith("usr_"),
  authorLogin: z.string().min(1),
  body: z.string().min(1),
  state: DirectionStateSchema,
  ordinal: z.number().int(),
  submittedAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable(),
  resolutionReason: z.string().nullable(),
  consumedByExecutionId: z.string().nullable()
});
export type Direction = z.infer<typeof DirectionSchema>;

export const DirectionInputSchema = z.object({
  body: z.string().trim().min(1, "Say what should happen").max(4000),
  model: ModelIdSchema.default(DEFAULT_MODEL),
  effort: EffortSchema.default(DEFAULT_EFFORT),
  /** Which lane this is for. Absent means the lane the mission started with,
   *  which is every mission that never forked an approach (D-074). Control is
   *  per lane, so this also decides whose baton the direction is judged
   *  against. */
  workstreamId: z.string().startsWith("wst_").optional()
});
export type DirectionInput = z.infer<typeof DirectionInputSchema>;

/** What the controller does with someone else's queued direction. */
export const DirectionResolutionSchema = z.object({
  action: z.enum(["apply", "reject", "supersede"]),
  reason: z.string().trim().max(500).optional()
});
export type DirectionResolution = z.infer<typeof DirectionResolutionSchema>;

// --- Execution (PRODUCT.md#domain-model) ------------------------------------

export const ExecutionStateSchema = z.enum([
  "requested",
  "starting",
  "running",
  "needs_direction",
  "needs_approval",
  "stopping",
  "completed",
  "stopped",
  "interrupted",
  "failed"
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const TERMINAL_EXECUTION_STATES: ExecutionState[] = [
  "completed",
  "stopped",
  "interrupted",
  "failed"
];

/**
 * What a turn cost, as the harness reported it.
 *
 * An opaque claim, exactly as ARCHITECTURE.md#harness-protocol says: nothing is
 * billed from it and nothing is enforced by it. It exists so a person can see
 * what a long run is spending and a receipt can say what it spent. Counts are
 * non-negative integers and the cost is the harness's own figure in US dollars;
 * a harness that reports none leaves them null rather than zero, because "not
 * reported" and "free" are different facts.
 */
export const HarnessUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    cacheReadTokens: z.number().int().nonnegative().nullable().default(null),
    cacheCreationTokens: z.number().int().nonnegative().nullable().default(null),
    /** The harness's own cost figure for this turn, in US dollars. */
    costUsd: z.number().nonnegative().nullable().default(null),
    /** How long the harness says the turn took, wall clock. */
    durationMs: z.number().int().nonnegative().nullable().default(null),
    /** Model round trips inside the turn, as the harness counts them. */
    turns: z.number().int().nonnegative().nullable().default(null)
  })
  .strict();
export type HarnessUsage = z.infer<typeof HarnessUsageSchema>;

export const ExecutionSchema = z.object({
  executionId: z.string().startsWith("exe_"),
  workstreamId: z.string().startsWith("wst_"),
  harness: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  runnerId: z.string().nullable(),
  startingDirectionId: z.string().nullable(),
  state: ExecutionStateSchema,
  startedBy: z.string().startsWith("usr_"),
  startedByLogin: z.string().min(1),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  harnessSessionId: z.string().nullable(),
  /** True when the harness resumed an earlier session rather than starting
   *  fresh; false with a session id present means continuity was lost. */
  resumedSession: z.boolean(),
  exitOutcome: z.string().nullable(),
  failureReason: z.string().nullable(),
  latestCheckpointSha: z.string().nullable(),
  /** Every turn of this execution added up, as the harness reported them. A
   *  claim about what the work cost, never a bill and never a limit. */
  usage: HarnessUsageSchema
});
export type Execution = z.infer<typeof ExecutionSchema>;

// --- Harness approvals (D-056) ----------------------------------------------
// The harness asks before it acts; Novus routes the question to the controller
// and carries the typed answer back. ARCHITECTURE.md#harness-protocol calls this
// out as *not normalizable*: the payload is harness-specific and passes through
// with attribution rather than being flattened.
//
// What travels is deliberately narrow. A tool's raw input can hold a whole file,
// a command line with a token in it, or a repository's contents; none of that
// belongs in a durable row distributed to every participant. So a request
// carries the tool's name and a **bounded, redacted summary** built from named
// fields, and nothing else.

// --- Approaches, and the decision between them (D-074, D-075) ---------------

export const MAX_RATIONALE = 4_000;
export const MAX_ACCEPTED_RISKS = 4_000;

/**
 * One approach, as the comparison surface reads it.
 *
 * Every field is either a durable record or arithmetic over durable records.
 * There is deliberately **no** score, rank, total, or recommendation: the
 * surface shows each lane's own evidence in the same shape and stops
 * (PRODUCT.md#scope-and-non-goals, D-074). Absence is reported as absence —
 * `checksRun` of 0 means nothing ran, which is a finding rather than a blank.
 */
export const ApproachSummarySchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  name: z.string().min(1),
  /** Null on the lane the mission started with; required on every fork. */
  intent: z.string().nullable(),
  approach: z.boolean(),
  missionBranch: z.string().min(1),
  originSha: z.string().nullable(),
  /** The shared checkpoint a new approach created beside this lane would start
   *  from: the lane's own origin where it has one, its latest checkpoint
   *  otherwise, null when there is nothing to fork. Computed by the server so
   *  the creation dialog and the creation route can never disagree (D-079). */
  forkPointSha: z.string().nullable(),
  /** The lane's own primary state, projected exactly as a mission's is. */
  state: MissionStateSchema,
  controllerLogin: z.string().nullable(),
  /** The revision its evidence is about, and what changed to reach it. */
  checkpointSha: z.string().nullable(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  paths: z.array(z.string()).max(200),
  /** Verification, split so that what did *not* happen is as visible as what
   *  did. `unresolvedChecks` counts checks that errored, were skipped, or prove
   *  a revision this lane has moved past. */
  checksRun: z.number().int().nonnegative(),
  checksPassed: z.number().int().nonnegative(),
  checksFailed: z.number().int().nonnegative(),
  unresolvedChecks: z.number().int().nonnegative(),
  /** What people did to it: direction they wrote, approvals they answered,
   *  stops they pressed. Human intervention is evidence too. */
  directions: z.number().int().nonnegative(),
  approvalsAnswered: z.number().int().nonnegative(),
  stops: z.number().int().nonnegative(),
  /** Harness claims, carried as claims (D-071). */
  usage: HarnessUsageSchema,
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable()
});
export type ApproachSummary = z.infer<typeof ApproachSummarySchema>;

/** A file more than one approach changed. Contested by construction and
 *  resolved by nobody: Novus shows both diffs and merges nothing (D-074). */
export const ContestedPathSchema = z.object({
  path: z.string().min(1),
  workstreamIds: z.array(z.string().startsWith("wst_")).min(2)
});
export type ContestedPath = z.infer<typeof ContestedPathSchema>;

export const DecisionSchema = z.object({
  decisionId: z.string().startsWith("dec_"),
  missionId: z.string().startsWith("msn_"),
  workstreamId: z.string().startsWith("wst_"),
  /** The exact revision chosen. A decision without one is a claim about a
   *  moving target. */
  checkpointSha: z.string().nullable(),
  decidedBy: z.string().startsWith("usr_"),
  decidedByLogin: z.string().min(1),
  /** The person's own words, and never empty (D-075). */
  rationale: z.string().min(1).max(MAX_RATIONALE),
  acceptedRisks: z.string().max(MAX_ACCEPTED_RISKS).nullable(),
  /** What was still unverified at the moment of choosing, captured then rather
   *  than recomputed later. */
  unresolvedCheckIds: z.array(z.string()).max(200),
  unresolvedSummary: z.array(z.string().max(200)).max(200),
  decidedAt: z.string().datetime(),
  /** When a later decision replaced this one. Reversals stay in the record. */
  supersededAt: z.string().datetime().nullable()
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RecordDecisionInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  rationale: z.string().trim().min(1, "Say why you chose this.").max(MAX_RATIONALE),
  acceptedRisks: z.string().trim().max(MAX_ACCEPTED_RISKS).optional()
});
export type RecordDecisionInput = z.infer<typeof RecordDecisionInputSchema>;

export const RequestRevisionInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  reason: z.string().trim().min(1, "Say what needs to change.").max(MAX_RATIONALE)
});
export type RequestRevisionInput = z.infer<typeof RequestRevisionInputSchema>;

/**
 * The pull request a decision *would* open — a projection over durable state,
 * never a stored draft and never a request that has been sent (D-075).
 *
 * Nothing here has contacted GitHub. It exists so a team can carry a decision
 * out of Novus by hand while live publication is unbuilt, and so the surface
 * can say "prepared" and mean it.
 */
export const PreparedPullRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  /** True only where a provider could actually receive this. A local folder
   *  cannot, and the surface says so rather than offering a dead action. */
  publishable: z.boolean()
});
export type PreparedPullRequest = z.infer<typeof PreparedPullRequestSchema>;

export const ApprovalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  /** The execution ended before anyone answered — a Stop, a completion, a
   *  failure, or the host quitting. The question is moot, not unanswered. */
  "cancelled",
  /** The machine that asked was declared gone, so no answer can ever reach it. */
  "expired"
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

/** The first implementation answers once, for this request, and remembers
 *  nothing: there is deliberately no "always allow" (D-056). */
export const ApprovalDecisionSchema = z.enum(["approve", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** How much of a request's summary is durable. Long enough to say what is being
 *  asked, short enough that a file's contents can never be it. */
export const MAX_APPROVAL_SUMMARY = 400;

export const ApprovalRequestSchema = z.object({
  approvalId: z.string().startsWith("apr_"),
  executionId: z.string().startsWith("exe_"),
  workstreamId: z.string().startsWith("wst_"),
  /** The harness's own correlation id. Novus answers by naming it back. */
  harnessRequestId: z.string().min(1),
  /** The tool call this permission is for, when the harness named one. */
  toolUseId: z.string().nullable(),
  toolName: z.string().min(1),
  displayName: z.string().min(1),
  /** Bounded and redacted before it left the machine that read it. */
  summary: z.string().max(MAX_APPROVAL_SUMMARY),
  state: ApprovalStateSchema,
  requestedAt: z.string().datetime(),
  respondedByLogin: z.string().nullable(),
  respondedAt: z.string().datetime().nullable(),
  /** Why it ended the way it did, in words. */
  resolution: z.string().nullable()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** What the rail asks for by default, and what the Archived view asks for. */
export const MissionListFilterSchema = z.enum(["active", "archived"]);
export type MissionListFilter = z.infer<typeof MissionListFilterSchema>;

export const RespondApprovalInputSchema = z.object({
  decision: ApprovalDecisionSchema,
  /** Carried to the harness verbatim on a denial, so the agent is told why. */
  reason: z.string().trim().max(500).optional()
});
export type RespondApprovalInput = z.infer<typeof RespondApprovalInputSchema>;

// --- Evidence: changes and verification (D-037) -----------------------------

export const FileChangeStateSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type FileChangeState = z.infer<typeof FileChangeStateSchema>;

export const FileChangeSchema = z.object({
  changeId: z.string().startsWith("chg_"),
  path: z.string().min(1),
  previousPath: z.string().nullable(),
  changeState: FileChangeStateSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  truncated: z.boolean()
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const CheckpointOutcomeSchema = z.enum(["committed", "clean", "failed"]);

export const CheckpointSchema = z.object({
  checkpointId: z.string().startsWith("ckp_"),
  executionId: z.string().min(1),
  outcome: CheckpointOutcomeSchema,
  sha: z.string().nullable(),
  parentSha: z.string().nullable(),
  branch: z.string().min(1),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  withheldSecrets: z.number().int().nonnegative(),
  uncommitted: z.boolean(),
  environment: z.string().min(1),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  files: z.array(FileChangeSchema)
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CheckCategorySchema = z.enum(["test", "typecheck", "build", "lint", "diagnostic"]);
export const CheckOutcomeSchema = z.enum(["passed", "failed", "skipped", "errored"]);

/** Where a check came from. Collapsing these into one green row is the
 *  fabrication the ledger exists to prevent (D-037). `automatic` is Novus
 *  running the project's declared checks after a checkpoint that changed
 *  files — nobody pressed Run, and the row says so. */
export const CheckOriginSchema = z.enum(["harness", "participant", "external", "automatic"]);
export type CheckOrigin = z.infer<typeof CheckOriginSchema>;

/**
 * Why a command stopped running. A process that ran out of time is not merely
 * a process that failed, and one a person cancelled is neither: collapsing the
 * three into "failed" is how a room ends up unable to say what happened.
 */
export const CommandEndingSchema = z.enum(["exit", "signal", "timeout", "cancelled", "spawn_failed"]);
export type CommandEnding = z.infer<typeof CommandEndingSchema>;

export const VerificationCheckSchema = z.object({
  checkId: z.string().startsWith("chk_"),
  executionId: z.string().nullable(),
  /** The lane this proves. A participant-run check has no execution, so with a
   *  mission holding competing approaches this is the only thing that says
   *  which one it is evidence for (D-074). */
  workstreamId: z.string().nullable(),
  name: z.string().min(1),
  category: CheckCategorySchema,
  outcome: CheckOutcomeSchema,
  origin: CheckOriginSchema,
  requestedByLogin: z.string().nullable(),
  command: z.string().min(1),
  /** How it ended. A check with no verdict says which — timed out, cancelled,
   *  or never started — rather than reading as an ordinary failure. */
  ending: CommandEndingSchema.nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string().nullable(),
  truncated: z.boolean(),
  environment: z.string().min(1),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** The revision this check proves. */
  checkpointSha: z.string().nullable(),
  /** True once the workstream moved past `checkpointSha`: still history, no
   *  longer evidence for what is there now. Derived server-side, never stored. */
  stale: z.boolean(),
  observedAt: z.string().datetime()
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const FileDiffResponseSchema = z.object({
  changeId: z.string().startsWith("chg_"),
  path: z.string().min(1),
  diff: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean()
});
export type FileDiffResponse = z.infer<typeof FileDiffResponseSchema>;

// --- Workspace runtime (D-040 … D-042) --------------------------------------

export const WorkspaceReadinessSchema = z.enum(["unconfigured", "configuring", "ready", "failed"]);
export type WorkspaceReadiness = z.infer<typeof WorkspaceReadinessSchema>;

export const ProcessKindSchema = z.enum(["setup", "run", "verification"]);
export const ProcessStateSchema = z.enum(["starting", "running", "exited", "failed", "stopped"]);

/**
 * Whether the *application* a run command started is actually up.
 *
 * A process existing does not prove it. `not_required` is a command that never
 * claimed to serve anything; `pending` is one whose declared readiness signal
 * has not answered yet, which the room says as *Starting*; `unreachable` is one
 * that stayed silent past its own deadline — still running, honestly not ready.
 */
export const ProcessReadinessSchema = z.enum(["not_required", "pending", "ready", "unreachable"]);
export type ProcessReadiness = z.infer<typeof ProcessReadinessSchema>;

export const WorkspaceProcessSchema = z.object({
  processId: z.string().startsWith("prc_"),
  /** The lane whose worktree ran it (D-080). Optional so an older payload
   *  still parses; the server always sends it. */
  workstreamId: z.string().startsWith("wst_").optional(),
  kind: ProcessKindSchema,
  name: z.string().min(1),
  /** Sanitized: the command as declared, never an expanded secret. */
  command: z.string().min(1),
  state: ProcessStateSchema,
  readiness: ProcessReadinessSchema,
  ending: CommandEndingSchema.nullable(),
  startedByLogin: z.string().nullable(),
  previewUrl: z.string().nullable(),
  port: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable()
});
export type WorkspaceProcess = z.infer<typeof WorkspaceProcessSchema>;

// --- Project secret values (D-041, D-044) ------------------------------------
// A secret's *name* is project configuration and travels with the branch. Its
// value belongs to the machine that supplied it: it is held in operating-system
// storage there, injected only into the project commands the configuration
// selected it for, and never returned across this bridge, never sent to the
// control plane, and never written into an event, a diff, a log, or a snapshot.

export const SecretNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

/**
 * The shortest value Novus will hold (D-044).
 *
 * Redaction works by removing a held value from anything a command printed
 * before it can be reported. Below this length a "secret" is a common word, and
 * removing every occurrence would shred ordinary output while protecting
 * nothing — so instead of leaking it quietly, Novus refuses to store it and
 * says why. Real credentials clear this floor by an order of magnitude.
 */
export const MIN_SECRET_LENGTH = 8;

// The shape of `.novus/settings.toml`. Committed, shared, and non-secret; the
// machine-local override has the identical shape and layers over it key by key.

const CommandName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase, hyphenated, 40 characters or fewer");
const CommandLine = z.string().min(1).max(400);
/** A path inside the workspace. Never absolute, never escaping upward. */
const RelativeDir = z
  .string()
  .max(200)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "must be a relative path inside the workspace"
  });

/**
 * A preview URL, validated rather than pattern-matched (D-045).
 *
 * This is repository-controlled data that ends up behind an "Open preview"
 * button in *every* participant's Novus, including a reviewer who has never
 * seen this machine. A committed `previewUrl = "https://looks-like-your-sso/"`
 * would otherwise be a one-click phishing surface with no code execution
 * needed. So: loopback only, http or https only, no credentials in the
 * authority — `http://localhost@elsewhere.example` has the host
 * `elsewhere.example`, which is exactly what a `startsWith` check waves through.
 *
 * The hostname allowlist is on the literal string, before any resolution. A
 * name that merely *resolves* to loopback (`localtest.me`, `*.nip.io`, an
 * attacker's own A record) is somebody else's host with a friendly spelling.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackPreviewUrl(candidate: string): boolean {
  // Whitespace and control characters never belong in a URL; they are how a
  // newline gets smuggled into whatever consumes one downstream.
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) return false;
  let url: URL;
  try {
    // `{port}` is filled in at run time; a stand-in keeps this parseable now.
    url = new URL(candidate.split("{port}").join("1"));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

const LoopbackUrl = z
  .string()
  .max(300)
  .refine(isLoopbackPreviewUrl, {
    message: "must be a loopback http or https address, with no credentials in it"
  });

// --- Timeout policy (D-043) --------------------------------------------------
// Every finite command has a deadline the project states, or one it inherits
// from a stated default. There is no universal hidden constant: a policy nobody
// can see is a policy nobody can argue with when it cuts a real build in half.

/** The ceiling on any finite command, stated once and enforced by validation.
 *  A project that genuinely needs longer than this needs a run command, which
 *  has no ceiling at all, rather than a setup command that never ends. */
export const MAX_COMMAND_TIMEOUT_MINUTES = 240;
export const DEFAULT_SETUP_TIMEOUT_MINUTES = 30;
export const DEFAULT_VERIFY_TIMEOUT_MINUTES = 15;

const TimeoutMinutes = z
  .number()
  .int()
  .min(1, "must be at least one minute")
  .max(MAX_COMMAND_TIMEOUT_MINUTES, `must be ${MAX_COMMAND_TIMEOUT_MINUTES} minutes or fewer`);

/** The project's defaults for the two finite kinds. A single command may state
 *  its own; a run command may not, because it is not finite. */
export const CommandTimeoutsSchema = z.object({
  setupMinutes: TimeoutMinutes.default(DEFAULT_SETUP_TIMEOUT_MINUTES),
  verifyMinutes: TimeoutMinutes.default(DEFAULT_VERIFY_TIMEOUT_MINUTES)
});
export type CommandTimeouts = z.infer<typeof CommandTimeoutsSchema>;

/**
 * How the project says its application is actually up (D-043). A process
 * existing proves a process exists; it does not prove anything is serving.
 * `process` is the honest default for a command that never claimed to.
 */
export const ReadinessKindSchema = z.enum(["process", "http", "port"]);
export const ReadinessSchema = z.object({
  kind: ReadinessKindSchema.default("process"),
  /** For `http`: `{port}` is substituted. Loopback only — this probe runs on
   *  the host machine and is not a general-purpose fetcher. */
  url: LoopbackUrl.optional(),
  /** For `port`: defaults to the port this command was given. */
  port: z.number().int().min(1).max(65_535).optional(),
  /** How long the declared signal has to answer before Novus says plainly that
   *  it has not. The process keeps running either way. */
  timeoutSeconds: z.number().int().min(1).max(900).default(120),
  /** Whether a readiness failure stops the process. Off unless the project says
   *  so out loud: killing somebody's server because a health URL was wrong is
   *  not a decision Novus makes for them. */
  stopOnFailure: z.boolean().default(false)
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/**
 * The same signal with every field stated.
 *
 * `ReadinessSchema` fills defaults in, which is right for a file a person
 * writes and wrong for a snapshot two parties must agree on: a shape whose
 * fields may be absent is a shape whose digest depends on who parsed it. The
 * runner resolves one into the other once, and this is what travels.
 */
export const ResolvedReadinessSchema = z.object({
  kind: ReadinessKindSchema,
  url: z.string().max(300).nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  timeoutSeconds: z.number().int().min(1).max(900),
  stopOnFailure: z.boolean()
});
export type ResolvedReadiness = z.infer<typeof ResolvedReadinessSchema>;

export const RunCommandSchema = z.object({
  name: CommandName,
  command: CommandLine,
  cwd: RelativeDir.optional(),
  /** Where the project says its preview appears; `{port}` is substituted. */
  previewUrl: LoopbackUrl.optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  /** How this command says it is ready. Absent means the process starting is
   *  all Novus knows, and all it will claim. */
  readiness: ReadinessSchema.optional()
});

export const VerificationCommandSchema = z.object({
  name: CommandName,
  command: CommandLine,
  cwd: RelativeDir.optional(),
  category: CheckCategorySchema.default("test"),
  /** Overrides `timeouts.verifyMinutes` for this check alone. */
  timeoutMinutes: TimeoutMinutes.optional()
});

export const SetupCommandSchema = z.object({
  command: CommandLine,
  cwd: RelativeDir.optional(),
  /** Overrides `timeouts.setupMinutes`. */
  timeoutMinutes: TimeoutMinutes.optional()
});

export const WorkspaceSettingsSchema = z.object({
  setup: SetupCommandSchema.optional(),
  run: z.array(RunCommandSchema).max(20).default([]),
  /** Which run command the Run control offers first. */
  defaultRun: CommandName.optional(),
  /** Whether two run commands may be alive at once. Default: no. */
  concurrentRuns: z.boolean().default(false),
  verify: z.array(VerificationCommandSchema).max(20).default([]),
  /** Whether the declared checks run themselves after a checkpoint that
   *  changed files. On unless the project says otherwise: a turn that landed
   *  work unverified is the state this exists to prevent. */
  autoVerify: z.boolean().default(true),
  /** The project's finite-command deadlines. Bounded by validation, visible in
   *  the file a team reviews, never a constant hidden in Novus. */
  timeouts: CommandTimeoutsSchema.default({}),
  /** Shared, non-secret. A value here is committed; the gate says so. */
  env: z.record(z.string().max(2_000)).default({}),
  /** Names only. Values live in operating-system storage on the machine that
   *  supplied them and never reach the control plane or the renderer (D-041). */
  secretNames: z.array(SecretNameSchema).max(50).default([]),
  /** Gitignored paths this workspace needs, from settings or .worktreeinclude. */
  localFiles: z.array(z.string().max(300)).max(100).default([])
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

/**
 * One command exactly as it stood when a participant authorized it (D-043).
 *
 * The runner reads `.novus/settings.toml` and publishes what it found; the
 * control plane hands that snapshot back with the command it enqueues; the
 * runner executes the snapshot rather than reading the file again. A turn that
 * edits the configuration between the click and the run therefore changes what
 * the *next* command will be, never what this one already is.
 */
export const DeclaredCommandSchema = z.object({
  kind: ProcessKindSchema,
  name: CommandName,
  /** As the project declared it; never an expanded secret. */
  command: CommandLine,
  cwd: RelativeDir.nullable(),
  /** The deadline this command runs under. Null for a run command, which has
   *  none by design (PRODUCT.md: an authorized execution has no Novus ceiling). */
  timeoutMs: z.number().int().positive().nullable(),
  category: CheckCategorySchema.nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  previewUrl: LoopbackUrl.nullable(),
  readiness: ResolvedReadinessSchema.nullable(),
  /** Of every field above. Same configuration, same digest, on any machine. */
  digest: z.string().regex(/^[0-9a-f]{16}$/)
});
export type DeclaredCommand = z.infer<typeof DeclaredCommandSchema>;

export const WorkspaceSchema = z.object({
  workspaceId: z.string().startsWith("wsp_"),
  workstreamId: z.string().startsWith("wst_"),
  location: z.literal("local"),
  readiness: WorkspaceReadinessSchema,
  /** Allocated per workstream so two on one host never collide. */
  portRangeStart: z.number().int().nullable(),
  portRangeEnd: z.number().int().nullable(),
  setupError: z.string().nullable(),
  configuredAt: z.string().datetime().nullable(),
  /** What the project declared, as the runner last read it (D-043). This is
   *  what the Run control offers — to every participant, not only the one at
   *  the host machine — and what an authorized command is pinned to. */
  declared: z.array(DeclaredCommandSchema).max(60),
  declaredAt: z.string().datetime().nullable()
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const SettingsScopeSchema = z.enum(["shared", "local"]);

/** What Novus noticed about a project, and what it would therefore propose.
 *  A proposal is never executed without an explicit confirmation. */
export const WorkspaceProposalSchema = z.object({
  projectType: z.string().min(1),
  signals: z.array(z.string().max(120)),
  setup: CommandLine.nullable(),
  run: z.array(RunCommandSchema),
  verify: z.array(VerificationCommandSchema),
  /** Filenames only — never contents (D-041). */
  localFiles: z.array(
    z.object({
      path: z.string().min(1),
      /** Whether the source repository actually has it right now. */
      availableInSource: z.boolean(),
      /** Whether the worktree already has a copy. */
      presentInWorkspace: z.boolean(),
      /** Only a Git-ignored file may ever be copied. */
      gitIgnored: z.boolean()
    })
  ),
  /** Non-null when the project already carries committed configuration. */
  shared: WorkspaceSettingsSchema.nullable(),
  local: WorkspaceSettingsSchema.nullable(),
  /** Why the workspace is not runnable yet, in the product's words. */
  blockers: z.array(z.string().max(200))
});
export type WorkspaceProposal = z.infer<typeof WorkspaceProposalSchema>;
export type SettingsScope = z.infer<typeof SettingsScopeSchema>;
export type ProcessKind = z.infer<typeof ProcessKindSchema>;
export type PreparedFile = z.infer<typeof PreparedFileSchema>;

export const SaveWorkspaceSettingsInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  scope: SettingsScopeSchema,
  settings: WorkspaceSettingsSchema
});

export const PrepareLocalFilesInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  /** Explicitly confirmed by the person at the machine, one by one. */
  paths: z.array(z.string().min(1).max(300)).min(1).max(50)
});

export const PreparedFileSchema = z.object({
  path: z.string().min(1),
  copied: z.boolean(),
  /** Named refusal — path escape, symlink, not ignored, a directory. */
  refusedBecause: z.string().nullable()
});

export const WorkspaceCommandInputSchema = z.object({
  kind: ProcessKindSchema,
  /** Omitted for setup, and for "run every configured check". */
  name: CommandName.optional(),
  /** The lane whose worktree runs it. Absent means the one the mission
   *  started with, so nothing that never forked changes (D-080). */
  workstreamId: z.string().startsWith("wst_").optional()
});

// --- Supplying a secret value (D-044) ----------------------------------------
// The one direction a value travels: from the person sitting at the machine
// that has it, into that machine's operating-system credential store. Nothing
// reads one back out across this bridge, ever.

export const SupplySecretInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  name: SecretNameSchema,
  value: z.string().min(MIN_SECRET_LENGTH).max(8_000)
});

export const ForgetSecretInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  name: SecretNameSchema
});

/** What the interface may know: which names the project declared, which of them
 *  this machine has supplied, and whether it can hold one at all. Never a
 *  value, and never a length or a prefix of one. */
export const SecretStateSchema = z.object({
  /** False when the operating system offers no credential encryption. Novus
   *  then holds nothing rather than writing a plaintext secret to disk, and the
   *  workspace is honestly unprepared. */
  encryptionAvailable: z.boolean(),
  names: z.array(z.object({ name: SecretNameSchema, supplied: z.boolean() })).max(50),
  /** Values this machine still holds for names the project no longer declares,
   *  so they can be forgotten rather than lingering unnoticed. */
  orphaned: z.array(z.string().max(120)).max(50)
});
export type SecretState = z.infer<typeof SecretStateSchema>;

// --- Opening a local preview (D-045) -----------------------------------------
// A narrow bridge, not a browser: loopback `http`/`https` only, handed to the
// operating system's own external-browser API. No shell command is involved.

export const OpenPreviewInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  url: z.string().min(1).max(2_000)
});

// --- The runtime dock (D-045) ------------------------------------------------
// Setup, run, and verification output, bounded and redacted, for the machine
// that ran it. It crosses the local IPC bridge and stops there — exactly like
// the terminal. What a remote participant sees is the bounded result attached
// to the evidence a check produced, never an unrestricted stream.

export const ProcessLogSchema = z.object({
  processId: z.string().startsWith("prc_"),
  workstreamId: z.string().startsWith("wst_"),
  kind: ProcessKindSchema,
  name: z.string().min(1),
  /** As declared, sanitized; never an expanded secret. */
  command: z.string().min(1),
  state: ProcessStateSchema,
  readiness: ProcessReadinessSchema,
  exitCode: z.number().int().nullable(),
  ending: CommandEndingSchema.nullable(),
  failureReason: z.string().nullable(),
  /** Where this run command can be opened, once something reported one. */
  previewUrl: LoopbackUrl.nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  /** Bounded local output; oldest dropped, because the end is what says how a
   *  command finished. */
  output: z.string(),
  truncated: z.boolean()
});
export type ProcessLog = z.infer<typeof ProcessLogSchema>;

/** One streamed piece of a process's output; the state rides along so the last
 *  chunk is also the news that it ended. */
export const ProcessLogChunkSchema = z.object({
  processId: z.string().startsWith("prc_"),
  workstreamId: z.string().startsWith("wst_"),
  data: z.string(),
  state: ProcessStateSchema,
  readiness: ProcessReadinessSchema,
  exitCode: z.number().int().nullable(),
  ending: CommandEndingSchema.nullable()
});
export type ProcessLogChunk = z.infer<typeof ProcessLogChunkSchema>;

// --- Reading the workspace's files (D-048) -----------------------------------
// The worktree is on this machine, so browsing it is a local act like every
// other one in this block: there is no control-plane route and no runner
// command, and a path is resolved against the worktree and refused if it leaves
// it. Contents cross this bridge to be *shown*; they are never reported, never
// an event, and never evidence.

/** A path inside the worktree, as a person and git both write one. */
export const WorkspacePathSchema = z
  .string()
  .max(400)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "must be a relative path inside the workspace"
  });

export const WorkspaceEntrySchema = z.object({
  /** Relative to the worktree; `""` is the worktree itself. */
  path: WorkspacePathSchema,
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  /** Lowercase, no dot. Empty for a directory or a file without one. */
  extension: z.string().max(20)
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const ListWorkspaceFilesInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  /** The directory to list. Omitted for the worktree's own top level. */
  path: WorkspacePathSchema.optional()
});

/** What a file holds, for showing. Bounded: this opens a pane, not a stream. */
export const WorkspaceFileSchema = z.object({
  path: WorkspacePathSchema,
  /** Null when the file is not text — a pane cannot honestly show one. */
  text: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative()
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const ReadWorkspaceFileInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  path: WorkspacePathSchema
});

export const WriteWorkspaceFileInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  path: WorkspacePathSchema,
  /** Bounded for the same reason reading is: this is an editor pane, not an
   *  upload channel. */
  text: z.string().max(2_000_000)
});

// --- The interactive terminal (D-042) ---------------------------------------
// An interactive shell on a local workspace belongs to the person whose machine
// hosts it, and to nobody else. It is not lease-granted and not role-granted:
// there is no shell kind in `RunnerCommandKindSchema` and none is added, so the
// restriction is structural rather than presentational and a crafted request
// has nothing to reach. These shapes cross the local IPC bridge only.

/** What a session is for. Distinguished so a tab says what it is, never so a
 *  kind grants anything: every kind is the same shell with the same authority. */
export const TerminalKindSchema = z.enum(["shell", "run", "test", "log"]);
export type TerminalKind = z.infer<typeof TerminalKindSchema>;

/** A PTY does not survive the process that owned it, so there is no third
 *  state: after a relaunch a session is simply gone, never a dead tab shown
 *  as live. */
export const TerminalSessionStateSchema = z.enum(["running", "exited"]);
export type TerminalSessionState = z.infer<typeof TerminalSessionStateSchema>;

export const TerminalSessionSchema = z.object({
  sessionId: z.string().startsWith("trm_"),
  /** Sessions belong to a workstream, like every other workspace process. */
  workstreamId: z.string().startsWith("wst_"),
  name: z.string().min(1).max(60),
  kind: TerminalKindSchema,
  state: TerminalSessionStateSchema,
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable()
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

/** One streamed piece of a session's output. `state` rides along so the last
 *  chunk of a session is also the news that it ended. */
export const TerminalChunkSchema = z.object({
  sessionId: z.string().startsWith("trm_"),
  data: z.string(),
  state: TerminalSessionStateSchema,
  exitCode: z.number().int().nullable()
});
export type TerminalChunk = z.infer<typeof TerminalChunkSchema>;

export const OpenTerminalInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  /** The lane whose worktree this acts on. Absent means the one the
   *  mission started with (D-080). */
  workstreamId: z.string().startsWith("wst_").optional(),
  name: z.string().trim().min(1).max(60).optional(),
  kind: TerminalKindSchema.default("shell"),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(1).max(500).optional()
});

const TerminalSessionId = z.string().startsWith("trm_");

export const TerminalWriteInputSchema = z.object({
  sessionId: TerminalSessionId,
  /** Keystrokes, bounded: an input channel is not a file-transfer channel. */
  data: z.string().max(8_192)
});

export const TerminalResizeInputSchema = z.object({
  sessionId: TerminalSessionId,
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500)
});

export const TerminalRenameInputSchema = z.object({
  sessionId: TerminalSessionId,
  name: z.string().trim().min(1).max(60)
});

// --- Control (PRODUCT.md#control) -------------------------------------------

export const ControlRequestSchema = z.object({
  requestId: z.string().startsWith("crq_"),
  requesterUserId: z.string().startsWith("usr_"),
  requesterLogin: z.string().min(1),
  state: z.enum(["open", "fulfilled", "declined", "withdrawn", "expired", "superseded"]),
  createdAt: z.string().datetime()
});
export type ControlRequestView = z.infer<typeof ControlRequestSchema>;

export const HandoffOfferSchema = z.object({
  offerId: z.string().startsWith("hof_"),
  fromUserId: z.string().startsWith("usr_"),
  fromLogin: z.string().min(1),
  toUserId: z.string().startsWith("usr_"),
  toLogin: z.string().min(1),
  state: z.enum([
    "open",
    "accepted",
    "waiting_for_boundary",
    "completed",
    "declined",
    "withdrawn",
    "expired",
    "failed"
  ]),
  createdAt: z.string().datetime()
});
export type HandoffOfferView = z.infer<typeof HandoffOfferSchema>;

export const ControlSnapshotSchema = z.object({
  leaseId: z.string().nullable(),
  holderUserId: z.string().nullable(),
  holderLogin: z.string().nullable(),
  state: z.enum(["held", "releasing", "released"]).nullable(),
  openRequests: z.array(ControlRequestSchema),
  liveOffer: HandoffOfferSchema.nullable()
});
export type ControlSnapshot = z.infer<typeof ControlSnapshotSchema>;

// --- Invitations ------------------------------------------------------------

export const CreateInvitationInputSchema = z.object({
  role: MissionRoleSchema.default("contributor")
});

export const InvitationSchema = z.object({
  invitationId: z.string().startsWith("inv_"),
  missionId: z.string().startsWith("msn_"),
  role: MissionRoleSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redeemedAt: z.string().datetime().nullable(),
  redeemedByLogin: z.string().nullable(),
  revokedAt: z.string().datetime().nullable()
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** Returned exactly once, at creation: the usable token is never stored. */
export const CreatedInvitationSchema = z.object({
  invitation: InvitationSchema,
  token: z.string().min(32)
});

export const RedeemInvitationInputSchema = z.object({
  token: z.string().min(32).max(200)
});

// --- Runner plane (D-035) ---------------------------------------------------

export const RunnerStatusSchema = z.object({
  runnerId: z.string().startsWith("rnr_"),
  kind: z.literal("local"),
  label: z.string().min(1),
  ownerLogin: z.string().min(1),
  online: z.boolean(),
  lastSeenAt: z.string().datetime().nullable()
});
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

export const RegisterRunnerInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  label: z.string().min(1).max(120)
});

/** The credential is returned exactly once and never leaves Electron main. */
export const RegisterRunnerResponseSchema = z.object({
  runnerId: z.string().startsWith("rnr_"),
  credential: z.string().min(32),
  expiresAt: z.string().datetime()
});
export type RegisterRunnerResponse = z.infer<typeof RegisterRunnerResponseSchema>;

export const RunnerCommandKindSchema = z.enum([
  "start_execution",
  "apply_direction",
  "stop_execution",
  "boundary_request",
  /** The controller's typed answer to an `approval.requested` event (D-056). */
  "respond_approval",
  "run_setup",
  "run_command",
  "stop_command",
  "run_verification"
]);

export const RunnerCommandSchema = z.object({
  commandId: z.string().startsWith("cmd_"),
  kind: RunnerCommandKindSchema,
  workstreamId: z.string().startsWith("wst_"),
  missionId: z.string().startsWith("msn_"),
  executionId: z.string().nullable(),
  seq: z.number().int(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime()
});
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;

export const RunnerCommandsResponseSchema = z.object({
  commands: z.array(RunnerCommandSchema),
  /** Everything the runner needs to act without asking the control plane
   *  again; the renderer never supplies any of it. */
  workstream: z.object({
    workstreamId: z.string().startsWith("wst_"),
    missionId: z.string().startsWith("msn_"),
    missionBranch: z.string().min(1),
    baseSha: ShaSchema,
    provider: RepositoryProviderKindSchema,
    providerRepoId: z.string().min(1),
    harnessSessionId: z.string().nullable()
  })
});
export type RunnerCommandsResponse = z.infer<typeof RunnerCommandsResponseSchema>;

// Runner-reported events. A closed set, each payload validated and bounded.
// Nothing outside this union may be written with a runner or harness actor.

const BOUNDED_TEXT = z.string().max(8_000);
const BOUNDED_LINE = z.string().max(400);

export const RunnerFileChangeSchema = z.object({
  path: BOUNDED_LINE,
  previousPath: BOUNDED_LINE.nullable().default(null),
  changeState: FileChangeStateSchema,
  additions: z.number().int().nonnegative().max(1_000_000),
  deletions: z.number().int().nonnegative().max(1_000_000),
  binary: z.boolean().default(false),
  diff: z.string().max(12_000).nullable().default(null),
  truncated: z.boolean().default(false)
});
export type RunnerFileChange = z.infer<typeof RunnerFileChangeSchema>;

/**
 * Which of the harness's *own* workers produced this, when the harness says so.
 *
 * Claude Code can spawn internal subagents; with `--forward-subagent-text` it
 * forwards what they say, tagged with the id of the tool call that started
 * them. Novus carries that tag and nothing more: a subagent is the harness's
 * business (PRODUCT.md#the-harness-boundary), so its activity groups under the
 * turn that spawned it and is **never** given a branch, a controller, a
 * checkpoint, or a workstream of its own. Null is the ordinary case — the
 * harness itself speaking.
 */
const PARENT_TOOL_USE_ID = BOUNDED_LINE.nullable().default(null);

export const RunnerEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution.starting"), payload: z.object({}).strict() }),
  z.object({
    kind: z.literal("execution.running"),
    payload: z.object({ harness: BOUNDED_LINE, model: BOUNDED_LINE, effort: BOUNDED_LINE }).strict()
  }),
  z.object({
    kind: z.literal("harness.session"),
    payload: z.object({ sessionId: BOUNDED_LINE, resumed: z.boolean() }).strict()
  }),
  z.object({
    kind: z.literal("harness.text"),
    payload: z.object({ text: BOUNDED_TEXT, parentToolUseId: PARENT_TOOL_USE_ID }).strict()
  }),
  z.object({
    kind: z.literal("harness.tool"),
    payload: z
      .object({
        tool: BOUNDED_LINE,
        detail: BOUNDED_LINE.nullable().default(null),
        parentToolUseId: PARENT_TOOL_USE_ID
      })
      .strict()
  }),
  z.object({
    kind: z.literal("harness.usage"),
    payload: HarnessUsageSchema
  }),
  z.object({
    kind: z.literal("direction.applied"),
    payload: z.object({ directionId: z.string().startsWith("dir_") }).strict()
  }),
  z.object({
    kind: z.literal("boundary.reached"),
    payload: z.object({ reason: BOUNDED_LINE }).strict()
  }),
  z.object({
    kind: z.literal("workspace.checkpoint"),
    payload: z
      .object({
        outcome: CheckpointOutcomeSchema,
        sha: z.string().max(64).nullable().default(null),
        parentSha: z.string().max(64).nullable().default(null),
        branch: BOUNDED_LINE,
        withheldSecrets: z.number().int().nonnegative().max(1000).default(0),
        uncommitted: z.boolean().default(false),
        error: BOUNDED_LINE.nullable().default(null),
        files: z.array(RunnerFileChangeSchema).max(150).default([])
      })
      .strict()
  }),
  z.object({
    kind: z.literal("verification.completed"),
    payload: z
      .object({
        name: BOUNDED_LINE,
        category: CheckCategorySchema,
        outcome: CheckOutcomeSchema,
        command: BOUNDED_LINE,
        exitCode: z.number().int().nullable().default(null),
        output: z.string().max(4_000).nullable().default(null),
        truncated: z.boolean().default(false),
        startedAt: z.string().max(40),
        completedAt: z.string().max(40),
        durationMs: z.number().int().nonnegative(),
        /** The two origins a runner-run check can honestly claim: a participant
         *  pressed Run, or Novus ran the declared checks itself after a
         *  checkpoint. Never `harness` (that is `verification.observed`) and
         *  never `external`. The default keeps an older runner's reports
         *  parsing as what they were. */
        origin: z.enum(["participant", "automatic"]).default("participant"),
        /** The revision the check actually ran against. */
        checkpointSha: z.string().max(64).nullable().default(null),
        /** How it ended. A check that ran out of time or was cancelled is never
         *  a pass and never a plain failure — it is evidence that no verdict was
         *  reached, and it says which. */
        ending: CommandEndingSchema.default("exit")
      })
      .strict()
  }),
  z.object({
    kind: z.literal("verification.observed"),
    payload: z
      .object({
        name: BOUNDED_LINE,
        category: CheckCategorySchema,
        outcome: CheckOutcomeSchema,
        command: BOUNDED_LINE,
        output: z.string().max(4_000).nullable().default(null),
        truncated: z.boolean().default(false)
      })
      .strict()
  }),
  z.object({
    kind: z.literal("workspace.readiness"),
    payload: z
      .object({
        readiness: WorkspaceReadinessSchema,
        portRangeStart: z.number().int().nullable().default(null),
        portRangeEnd: z.number().int().nullable().default(null),
        setupError: BOUNDED_LINE.nullable().default(null)
      })
      .strict()
  }),
  z.object({
    kind: z.literal("workspace.declared"),
    payload: z.object({ commands: z.array(DeclaredCommandSchema).max(60) }).strict()
  }),
  z.object({
    kind: z.literal("process.started"),
    payload: z
      .object({
        processId: z.string().startsWith("prc_"),
        kind: ProcessKindSchema,
        name: BOUNDED_LINE,
        command: BOUNDED_LINE,
        port: z.number().int().nullable().default(null),
        previewUrl: LoopbackUrl.nullable().default(null),
        /** `pending` when the command declared a readiness signal: the process
         *  is up, the application is not yet claimed to be. */
        readiness: z.enum(["not_required", "pending"]).default("not_required")
      })
      .strict()
  }),
  z.object({
    kind: z.literal("process.readiness"),
    payload: z
      .object({
        processId: z.string().startsWith("prc_"),
        readiness: z.enum(["ready", "unreachable"]),
        /** A URL the readiness probe confirmed, when it confirmed one. */
        previewUrl: LoopbackUrl.nullable().default(null),
        detail: BOUNDED_LINE.nullable().default(null)
      })
      .strict()
  }),
  z.object({
    kind: z.literal("process.exited"),
    payload: z
      .object({
        processId: z.string().startsWith("prc_"),
        state: z.enum(["exited", "failed", "stopped"]),
        /** Why it stopped: a deadline, a cancellation, and a non-zero exit are
         *  three different things and the room says which. */
        ending: CommandEndingSchema.default("exit"),
        exitCode: z.number().int().nullable().default(null),
        failureReason: BOUNDED_LINE.nullable().default(null)
      })
      .strict()
  }),
  z.object({
    kind: z.literal("approval.requested"),
    payload: z
      .object({
        /** The harness's own id for this question. The answer names it back. */
        requestId: BOUNDED_LINE,
        toolUseId: BOUNDED_LINE.nullable().default(null),
        toolName: BOUNDED_LINE,
        displayName: BOUNDED_LINE,
        /** Built from named fields, bounded, and redacted — never the raw
         *  tool input, which can be a whole file (D-052). */
        summary: z.string().max(MAX_APPROVAL_SUMMARY)
      })
      .strict()
  }),
  z.object({
    /** The harness stopped waiting without an answer: the turn ended, or the
     *  protocol interrupt cancelled the question. The control plane's own
     *  settlement paths never travel this way. */
    kind: z.literal("approval.cancelled"),
    payload: z.object({ requestId: BOUNDED_LINE, reason: BOUNDED_LINE }).strict()
  }),
  z.object({ kind: z.literal("execution.completed"), payload: z.object({}).strict() }),
  z.object({
    kind: z.literal("execution.stopped"),
    payload: z
      .object({
        reason: BOUNDED_LINE,
        /**
         * Which path actually ended the turn (D-053, upgraded by D-056):
         * `protocol_interrupt` is the harness's own interrupt, which ends the
         * turn and leaves the session resumable; `process_signal` is the
         * bounded process-tree kill that follows when the harness does not
         * answer; `never_started` is a stop that reached its execution before
         * any harness process existed, which is prevention rather than
         * interruption and should not read as either kill. Defaulted so an
         * older runner's report still validates.
         */
        via: z.enum(["protocol_interrupt", "process_signal", "never_started"]).default("process_signal")
      })
      .strict()
  }),
  z.object({
    kind: z.literal("execution.failed"),
    payload: z
      .object({
        classification: z.enum([
          "spawn_failed",
          "authentication",
          "nonzero_exit",
          "checkpoint_failed",
          "harness_error",
          /** The installed harness does not speak the approval protocol, so
           *  Novus refuses to run it rather than running it unsupervised. */
          "unsupported_harness",
          "internal"
        ]),
        reason: BOUNDED_LINE
      })
      .strict()
  }),
  z.object({
    kind: z.literal("execution.interrupted"),
    payload: z.object({ reason: BOUNDED_LINE }).strict()
  }),
  z.object({
    kind: z.literal("runner.gap"),
    payload: z.object({ droppedFrom: z.number().int(), droppedTo: z.number().int() }).strict()
  })
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const SequencedRunnerEventSchema = z.object({
  originSeq: z.number().int().positive(),
  event: RunnerEventSchema
});
export type SequencedRunnerEvent = z.infer<typeof SequencedRunnerEventSchema>;

/**
 * What a runner may actually put on the wire, as opposed to what the control
 * plane holds after parsing it. A field with a stated default may be omitted —
 * which is how a runner built against an older contract stays readable rather
 * than being rejected for a field that did not exist when it shipped.
 */
export type ReportableRunnerEvent = z.input<typeof SequencedRunnerEventSchema>;

export const ReportRunnerEventsInputSchema = z.object({
  /** Null for a workspace-scoped report: a setup or run command is not part of
   *  any turn and can happen before a turn has ever existed. The runner's
   *  sequence is then per workstream rather than per execution, and the server
   *  de-duplicates on whichever of the two the report belongs to. */
  executionId: z.string().startsWith("exe_").nullable(),
  events: z.array(SequencedRunnerEventSchema).min(1).max(50)
});
export type ReportRunnerEventsInput = z.infer<typeof ReportRunnerEventsInputSchema>;

export const AckCommandInputSchema = z.object({
  state: z.enum(["acknowledged", "completed", "failed"]),
  failureReason: BOUNDED_LINE.optional(),
  /** For start_execution: the execution the runner actually began. */
  executionId: z.string().startsWith("exe_").optional()
});

// --- Control-plane HTTP responses -----------------------------------------

export const AuthStartResponseSchema = z.object({
  state: z.string().min(16),
  authorizeUrl: z.string().url()
});
export type AuthStartResponse = z.infer<typeof AuthStartResponseSchema>;

export const AuthClaimResponseSchema = z.object({
  token: z.string().min(32),
  user: UserSchema,
  org: OrganizationSchema
});
export type AuthClaimResponse = z.infer<typeof AuthClaimResponseSchema>;

export const MeResponseSchema = z.object({
  user: UserSchema,
  org: OrganizationSchema
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const MissionListResponseSchema = z.object({
  missions: z.array(MissionSchema)
});

/** Everything the room renders, in one poll. Diff bodies are fetched on
 *  demand so the poll stays small. */
export const MissionDetailResponseSchema = z.object({
  mission: MissionSchema,
  /** The lane this response was computed for: the one the caller named, or
   *  the mission's first workstream. Control, capabilities, runner, workspace
   *  and state are this lane's own (D-080). Null only for missions created
   *  before repository connection existed. */
  workstream: WorkstreamSchema.nullable(),
  /** Every lane this mission holds, in creation order — one for almost every
   *  mission, more only where somebody deliberately forked an approach
   *  (D-074). The room shows lane chrome only when this has more than one. */
  workstreams: z.array(WorkstreamSchema),
  /** The comparison the Decision Room reads, and nothing that ranks them. */
  approaches: z.array(ApproachSummarySchema),
  /** Files more than one approach changed. Empty with one lane. */
  contested: z.array(ContestedPathSchema),
  /** Every decision this mission has recorded, oldest first; the last one that
   *  is not superseded is the current one. */
  decisions: z.array(DecisionSchema),
  /** What would be published, if a decision has been recorded (D-075). */
  preparedPullRequest: PreparedPullRequestSchema.nullable(),
  events: z.array(EventSchema),
  participants: z.array(ParticipantSchema),
  directions: z.array(DirectionSchema),
  executions: z.array(ExecutionSchema),
  control: ControlSnapshotSchema,
  checkpoints: z.array(CheckpointSchema),
  checks: z.array(VerificationCheckSchema),
  /** Harness permission questions, newest last. Pending ones are what the
   *  *Needs approval* state is about; settled ones stay so the record can
   *  answer who allowed what. */
  approvals: z.array(ApprovalRequestSchema),
  runner: RunnerStatusSchema.nullable(),
  workspace: WorkspaceSchema.nullable(),
  processes: z.array(WorkspaceProcessSchema),
  /** The viewer's server-computed effective capabilities (role ∪ lease). */
  capabilities: z.array(CapabilitySchema),
  viewerUserId: z.string().startsWith("usr_"),
  state: MissionStateSchema,
  overlays: z.array(MissionOverlaySchema)
});
export type MissionDetailResponse = z.infer<typeof MissionDetailResponseSchema>;

export const CreatedApproachSchema = z.object({ workstream: WorkstreamSchema });
export const RecordedDecisionSchema = z.object({ decisionId: z.string().startsWith("dec_") });

export const AvailableRepositoriesResponseSchema = z.object({
  repositories: z.array(AvailableRepositorySchema)
});
export const CreateMissionResponseSchema = z.object({
  mission: MissionSchema,
  workstream: WorkstreamSchema
});
export const RetryBranchResponseSchema = z.object({
  workstream: WorkstreamSchema
});
export const InvitationListResponseSchema = z.object({
  invitations: z.array(InvitationSchema)
});
export const SubmitDirectionResponseSchema = z.object({
  direction: DirectionSchema,
  /** True when the direction went straight toward the runner because its
   *  author holds the lease; false means it is queued for the controller. */
  dispatched: z.boolean(),
  /** Why nothing was dispatched, when nothing was (no runner, already busy). */
  deferred: z.string().nullable()
});
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export const RedeemInvitationResponseSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  role: MissionRoleSchema
});

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() })
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// --- Desktop IPC boundary (renderer <-> main) ------------------------------
// The renderer never sees session credentials, runner credentials, or local
// filesystem paths; these are the only shapes that cross the context bridge.
// Every handler validates its input with these.

export const IpcAuthStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed_out") }),
  z.object({ state: z.literal("waiting_for_browser") }),
  z.object({ state: z.literal("signed_in"), user: UserSchema, org: OrganizationSchema }),
  z.object({ state: z.literal("failed"), message: z.string() })
]);
export type IpcAuthStatus = z.infer<typeof IpcAuthStatusSchema>;

/** Read-only facts observed about harness CLIs on this machine (D-029). */
export const HarnessProbeSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  /** e.g. "Max plan", "Pro plan", "signed in" — from the CLI's own local files; null when unknown. */
  account: z.string().nullable()
});
export type HarnessProbe = z.infer<typeof HarnessProbeSchema>;

export const SetupProbeResponseSchema = z.object({
  claudeCode: HarnessProbeSchema,
  codex: HarnessProbeSchema
});
export type SetupProbeResponse = z.infer<typeof SetupProbeResponseSchema>;

export const IpcDirectInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  body: z.string().trim().min(1).max(4000),
  model: ModelIdSchema.default(DEFAULT_MODEL),
  effort: EffortSchema.default(DEFAULT_EFFORT),
  /** Which lane to direct. Absent means the one the mission started with — so
   *  every mission that never forked is unchanged (D-074). */
  workstreamId: z.string().startsWith("wst_").optional()
});
export type IpcDirectInput = z.infer<typeof IpcDirectInputSchema>;

export const IpcResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), code: z.string(), message: z.string() })
  ]);

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

// --- The renderer bridge -----------------------------------------------------
// One declaration for both sides of the context bridge: the preload object is
// annotated with it and the renderer consumes it, so the two cannot drift.

/**
 * The complete renderer surface. Session tokens, runner credentials, and local
 * filesystem paths never cross this boundary — only these typed calls do.
 * Every privileged verb here is enforced again on the server; this interface
 * is a way to ask, never a grant (AGENTS.md rule 13).
 */
export interface NovusBridge {
  auth: {
    status(): Promise<IpcAuthStatus>;
    start(): Promise<IpcResult<null>>;
    signOut(): Promise<IpcResult<null>>;
    onChanged(listener: (status: IpcAuthStatus) => void): () => void;
  };
  setup: {
    probe(): Promise<IpcResult<SetupProbeResponse>>;
  };
  repos: {
    available(): Promise<IpcResult<AvailableRepository[]>>;
    base(providerRepoId: string, ref?: string): Promise<IpcResult<BaseRevision>>;
    addLocal(): Promise<
      IpcResult<{ providerRepoId: string; name: string; defaultBranch: string; provider: "local" } | null>
    >;
    localList(): Promise<
      IpcResult<{ providerRepoId: string; name: string; defaultBranch: string; onThisMachine: boolean }[]>
    >;
    baseLocal(localId: string): Promise<IpcResult<BaseRevision>>;
    /**
     * The provider repository ids this machine actually holds a checkout for.
     *
     * The question a room needs answered is *where the checkout is*, never
     * which provider it came from: a GitHub repository the runner fetched lands
     * in the same machine-local map as a folder somebody picked (D-025, D-032),
     * and after that nothing downstream can tell them apart.
     */
    checkedOutHere(): Promise<IpcResult<string[]>>;
  };
  missions: {
    /** The ordinary list by default; `"archived"` is the Archived view. One
     *  verb and one filter, so the two lists cannot disagree (D-063). */
    list(filter?: MissionListFilter): Promise<IpcResult<Mission[]>>;
    create(input: CreateMissionInput): Promise<IpcResult<{ mission: Mission; workstream: Workstream }>>;
    /** The room payload, computed for the named lane when one is given —
     *  control, capabilities, runner, workspace and state are that lane's own
     *  (D-080). Absent means the lane the mission started with. */
    get(missionId: string, workstreamId?: string): Promise<IpcResult<MissionDetailResponse>>;
    retryBranch(workstreamId: string): Promise<IpcResult<Workstream>>;
    /** Submits attributed direction. Whether it runs now or queues for the
     *  controller is the server's decision, reflected in the returned state. */
    direct(input: {
      missionId: string;
      body: string;
      model: ModelId;
      effort: Effort;
      /** The lane this is for; absent means the mission's first (D-074). */
      workstreamId?: string;
    }): Promise<IpcResult<{ directionId: string; dispatched: boolean; deferred: string | null }>>;
    resolveDirection(input: {
      directionId: string;
      action: "apply" | "reject" | "supersede";
      reason?: string;
    }): Promise<IpcResult<null>>;
    cancelDirection(directionId: string): Promise<IpcResult<null>>;
    stop(missionId: string): Promise<IpcResult<null>>;
    /**
     * Answers one harness approval (D-056). Asking is all this is: the server
     * checks `approval.respond` against the current lease, and a request that
     * has already been settled is refused rather than answered twice.
     */
    /** Files a mission away. Refused while its execution is running or an
     *  approval is waiting — an archived mission must not be one still doing
     *  something. Never deletes: no branch, no worktree, no history (D-063). */
    archive(missionId: string): Promise<IpcResult<null>>;
    /** Takes it back out, into the ordinary list it left. */
    restore(missionId: string): Promise<IpcResult<null>>;
    respondApproval(input: {
      approvalId: string;
      decision: ApprovalDecision;
      reason?: string;
    }): Promise<IpcResult<null>>;
  };
  /**
   * Competing approaches and the decision between them (D-074, D-075).
   *
   * Every verb here is a request the server authorizes: `approach.create` and
   * `review.approve` are role-held capabilities checked against durable state,
   * and nothing the renderer does decides who may fork or who may choose.
   */
  approaches: {
    /** Forks a sibling lane from the named workstream's shared checkpoint —
     *  its own origin where it has one, its latest checkpoint otherwise
     *  (D-079). The intent is required and refused empty by the server as well
     *  as here; `expectedOriginSha` pins the revision the person was shown. */
    create(input: {
      missionId: string;
      fromWorkstreamId: string;
      intent: string;
      name?: string;
      expectedOriginSha?: string;
    }): Promise<IpcResult<{ workstream: Workstream }>>;
    /** Records a decision. Writes a record; publishes nothing. */
    decide(input: {
      missionId: string;
      workstreamId: string;
      rationale: string;
      acceptedRisks?: string;
    }): Promise<IpcResult<{ decisionId: string }>>;
    /** Asks for a revision instead, which withdraws the current decision. */
    requestRevision(input: {
      missionId: string;
      workstreamId: string;
      reason: string;
    }): Promise<IpcResult<null>>;
  };
  control: {
    request(missionId: string): Promise<IpcResult<null>>;
    withdrawRequest(missionId: string): Promise<IpcResult<null>>;
    declineRequest(requestId: string): Promise<IpcResult<null>>;
    offer(input: { missionId: string; toUserId: string }): Promise<IpcResult<null>>;
    withdrawOffer(offerId: string): Promise<IpcResult<null>>;
    acceptOffer(offerId: string): Promise<IpcResult<null>>;
    declineOffer(offerId: string): Promise<IpcResult<null>>;
    revoke(missionId: string): Promise<IpcResult<null>>;
  };
  invites: {
    create(input: { missionId: string; role: MissionRole }): Promise<
      IpcResult<{ invitation: Invitation; token: string }>
    >;
    list(missionId: string): Promise<IpcResult<Invitation[]>>;
    revoke(invitationId: string): Promise<IpcResult<null>>;
    redeem(token: string): Promise<IpcResult<{ missionId: string; role: MissionRole }>>;
  };
  evidence: {
    fileDiff(changeId: string): Promise<IpcResult<FileDiffResponse>>;
  };
  /**
   * The workspace runtime. Inspecting a project, writing its configuration,
   * and supplying local files are acts by the person at the machine, so they
   * are local calls. Running a command is remotely invokable, so it goes
   * through the control plane and is authorized there (D-042).
   */
  workspace: {
    /** What Novus noticed and would therefore propose. Executes nothing. */
    inspect(missionId: string, workstreamId?: string): Promise<IpcResult<WorkspaceProposal>>;
    save(input: {
      missionId: string;
      workstreamId?: string;
      scope: SettingsScope;
      settings: WorkspaceSettings;
    }): Promise<IpcResult<null>>;
    /** Copies confirmed Git-ignored files into the worktree. Names in, names
     *  out — a content never crosses this bridge. */
    prepareLocalFiles(input: {
      missionId: string;
      workstreamId?: string;
      paths: string[];
    }): Promise<IpcResult<PreparedFile[]>>;
    /** Asks the control plane to authorize and enqueue a declared command. */
    command(input: {
      missionId: string;
      workstreamId?: string;
      kind: ProcessKind;
      name?: string;
    }): Promise<IpcResult<null>>;
    stop(input: { missionId: string; workstreamId?: string; name: string }): Promise<IpcResult<null>>;
    /**
     * This workstream's local process output. Local only, exactly like the
     * terminal: it never travels to the control plane, and what a remote
     * participant sees is the bounded result attached to a check's evidence.
     */
    logs(missionId: string, workstreamId?: string): Promise<IpcResult<ProcessLog[]>>;
    onLog(listener: (chunk: ProcessLogChunk) => void): () => void;
    /** The declared secret names and whether this machine supplied each. Never
     *  a value: nothing reads one back out of the store. */
    secrets(missionId: string, workstreamId?: string): Promise<IpcResult<SecretState>>;
    supplySecret(input: { missionId: string; workstreamId?: string; name: string; value: string }): Promise<
      IpcResult<SecretState>
    >;
    forgetSecret(input: { missionId: string; workstreamId?: string; name: string }): Promise<IpcResult<SecretState>>;
    /** Opens a loopback preview in the operating system's browser. No shell
     *  command is involved and nothing but loopback http/https is accepted. */
    openPreview(input: { missionId: string; workstreamId?: string; url: string }): Promise<IpcResult<null>>;
    /**
     * The workspace's own files (D-048). Local, like the terminal: the worktree
     * is on this machine, every path is resolved against it and refused if it
     * leaves, and what comes back is shown rather than reported.
     */
    listFiles(input: { missionId: string; workstreamId?: string; path?: string }): Promise<IpcResult<WorkspaceEntry[]>>;
    readFile(input: { missionId: string; workstreamId?: string; path: string }): Promise<IpcResult<WorkspaceFile>>;
    writeFile(input: { missionId: string; workstreamId?: string; path: string; text: string }): Promise<IpcResult<null>>;
  };
  /**
   * The interactive terminal (D-042). Every verb here is local: a session is
   * created by the machine that holds the repository, exactly like
   * `workspace.inspect` and `workspace.prepareLocalFiles`. Nothing in this
   * block has a control-plane route or a runner command behind it, and none is
   * added — controlling a mission is not unrestricted access to the host
   * machine, and the restriction is structural so there is nothing to
   * authorize incorrectly.
   */
  terminal: {
    /** This workstream's sessions on this machine. Empty after a relaunch,
     *  because a PTY does not outlive the process that owned it. */
    list(missionId: string, workstreamId?: string): Promise<IpcResult<TerminalSession[]>>;
    open(input: {
      missionId: string;
      workstreamId?: string;
      name?: string;
      kind: TerminalKind;
      cols?: number;
      rows?: number;
    }): Promise<IpcResult<TerminalSession>>;
    /**
     * What a session has printed so far, so reopening the drawer shows what
     * already happened. Fetched once per pane rather than riding on every
     * list. It crosses the local IPC bridge and stops there: raw terminal
     * output is never written into an event, never reported to the control
     * plane, and never becomes evidence (D-041, D-042).
     */
    scrollback(sessionId: string): Promise<IpcResult<string>>;
    write(input: { sessionId: string; data: string }): Promise<IpcResult<null>>;
    resize(input: { sessionId: string; cols: number; rows: number }): Promise<IpcResult<null>>;
    rename(input: { sessionId: string; name: string }): Promise<IpcResult<TerminalSession>>;
    close(sessionId: string): Promise<IpcResult<null>>;
    onOutput(listener: (chunk: TerminalChunk) => void): () => void;
  };
}
