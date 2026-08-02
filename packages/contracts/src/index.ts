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
  "ready_for_instruction",
  "agent_starting",
  "agent_running",
  "needs_direction",
  "needs_approval",
  "paused",
  "work_completed_unverified",
  "ready_for_review",
  "verification_failed",
  "execution_interrupted"
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

/** Conditions that coexist with a primary state (PRODUCT.md overlays). */
export const MissionOverlaySchema = z.enum([
  "direction_queued",
  "control_requested",
  "handoff_offered",
  "handoff_waiting_for_boundary",
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

export const WorkstreamSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  missionId: z.string().startsWith("msn_"),
  name: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: ShaSchema,
  missionBranch: z.string().min(1),
  branchStatus: BranchStatusSchema,
  branchError: z.string().nullable()
});
export type Workstream = z.infer<typeof WorkstreamSchema>;

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
  repository: RepositoryRefSchema.nullable()
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
  "direction.submit",
  "direction.apply",
  "execution.start",
  "execution.stop",
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
  effort: EffortSchema.default(DEFAULT_EFFORT)
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
  latestCheckpointSha: z.string().nullable()
});
export type Execution = z.infer<typeof ExecutionSchema>;

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

export const VerificationCheckSchema = z.object({
  checkId: z.string().startsWith("chk_"),
  executionId: z.string().min(1),
  name: z.string().min(1),
  category: CheckCategorySchema,
  outcome: CheckOutcomeSchema,
  command: z.string().min(1),
  output: z.string().nullable(),
  truncated: z.boolean(),
  environment: z.string().min(1),
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
  "boundary_request"
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
  z.object({ kind: z.literal("harness.text"), payload: z.object({ text: BOUNDED_TEXT }).strict() }),
  z.object({
    kind: z.literal("harness.tool"),
    payload: z.object({ tool: BOUNDED_LINE, detail: BOUNDED_LINE.nullable().default(null) }).strict()
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
  z.object({ kind: z.literal("execution.completed"), payload: z.object({}).strict() }),
  z.object({
    kind: z.literal("execution.stopped"),
    payload: z.object({ reason: BOUNDED_LINE }).strict()
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

export const ReportRunnerEventsInputSchema = z.object({
  executionId: z.string().startsWith("exe_"),
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
  /** Null only for missions created before repository connection existed. */
  workstream: WorkstreamSchema.nullable(),
  events: z.array(EventSchema),
  participants: z.array(ParticipantSchema),
  directions: z.array(DirectionSchema),
  executions: z.array(ExecutionSchema),
  control: ControlSnapshotSchema,
  checkpoints: z.array(CheckpointSchema),
  checks: z.array(VerificationCheckSchema),
  runner: RunnerStatusSchema.nullable(),
  /** The viewer's server-computed effective capabilities (role ∪ lease). */
  capabilities: z.array(CapabilitySchema),
  viewerUserId: z.string().startsWith("usr_"),
  state: MissionStateSchema,
  overlays: z.array(MissionOverlaySchema)
});
export type MissionDetailResponse = z.infer<typeof MissionDetailResponseSchema>;

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
  effort: EffortSchema.default(DEFAULT_EFFORT)
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
  };
  missions: {
    list(): Promise<IpcResult<Mission[]>>;
    create(input: CreateMissionInput): Promise<IpcResult<{ mission: Mission; workstream: Workstream }>>;
    get(missionId: string): Promise<IpcResult<MissionDetailResponse>>;
    retryBranch(workstreamId: string): Promise<IpcResult<Workstream>>;
    /** Submits attributed direction. Whether it runs now or queues for the
     *  controller is the server's decision, reflected in the returned state. */
    direct(input: {
      missionId: string;
      body: string;
      model: ModelId;
      effort: Effort;
    }): Promise<IpcResult<{ directionId: string; dispatched: boolean; deferred: string | null }>>;
    resolveDirection(input: {
      directionId: string;
      action: "apply" | "reject" | "supersede";
      reason?: string;
    }): Promise<IpcResult<null>>;
    cancelDirection(directionId: string): Promise<IpcResult<null>>;
    stop(missionId: string): Promise<IpcResult<null>>;
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
}
