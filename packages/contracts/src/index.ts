import { z } from "zod";
export * from "./policy.js";
export * from "./scope.js";
import { DEFAULT_PERMISSION_PROFILE, PermissionProfileSchema, ModelIdSchema, EffortSchema, DEFAULT_MODEL, DEFAULT_EFFORT, type ModelId, type Effort, type PermissionProfile } from "./policy.js";

// Runtime-validated contracts shared by the control plane, the desktop main
// process, and the renderer IPC boundary. Domain meanings live in PRODUCT.md;
// representation rules live in ARCHITECTURE.md. This file carries shapes only:
// product policy (profiles, models, evidence claims) lives in policy.ts, and
// the D-097 scope algebra in scope.ts — both re-exported above, so importers
// see one package.

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
  /** A tracked pull request exists and is not yet resolved — draft or ready,
   *  reviews and mergeability tracked (D-099). Merging happens on GitHub, by
   *  humans; a merged or closed request returns the mission to
   *  `decision_recorded`, whose sentence then names how publication ended,
   *  because `completed` is a lifecycle this build has not earned yet. */
  "pull_request_open",
  "verification_failed",
  "execution_interrupted",
  /** Terminal (D-121): a person with `mission.close` ended the mission's
   *  work — result accepted with the receipt snapshotted, or deliberately
   *  ended without acceptance. Terminal states never resume: reopening shows
   *  history and the receipt, and the operating verbs are refused in words. */
  "completed",
  "cancelled"
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

/** The two ways a mission's work ends (D-121). Distinct from archival
 *  (D-063), which files the record away and ends nothing. */
export const MissionOutcomeSchema = z.enum(["completed", "cancelled"]);
export type MissionOutcome = z.infer<typeof MissionOutcomeSchema>;

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
  defaultBranch: z.string().min(1),
  /** When the host last saw a push, for freshest-first listing (D-139).
   *  Null when the provider does not say. */
  pushedAt: z.string().datetime().nullable().default(null)
});
export type AvailableRepository = z.infer<typeof AvailableRepositorySchema>;

/** One branch of a repository, as the base picker lists them (D-139): the
 *  name, the commit it points at right now, and whether it is the default.
 *  The sha is a snapshot for display — a mission pins the ref at creation by
 *  resolving it again at that moment. */
export const BranchInfoSchema = z.object({
  name: z.string().min(1),
  sha: z.string().min(1),
  isDefault: z.boolean()
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

/** Where a mission's pinned base stands against the branch it came from
 *  (D-139). Computed, never stored: the pin itself is immutable.
 *  - `current`: the branch still points at the pinned commit.
 *  - `moved`: the branch moved forward and the pin is an ancestor — new
 *    commits landed on top of what this mission started from.
 *  - `rewritten`: the branch no longer contains the pinned commit — it was
 *    force-pushed, rebased, or squash-merged past it.
 *  - `missing`: the branch is gone.
 *  - `unknown`: the provider could not answer just now. Absence of an answer,
 *    never treated as "fine". */
export const BaseStatusSchema = z.object({
  state: z.enum(["current", "moved", "rewritten", "missing", "unknown"]),
  /** Commits ahead of the pin, when the provider counts them. */
  aheadBy: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime()
});
export type BaseStatus = z.infer<typeof BaseStatusSchema>;

/** A person's explicit act of following a moved base (D-144): every lane's
 *  worktree merges the new base commit — a merge, never a rebase, so every
 *  recorded checkpoint SHA stays true — and the pin moves to it. All lanes
 *  move together or none do; the control plane refuses the record while any
 *  lane holds a live execution, and refuses a pin that is not where the asker
 *  last saw it, so a stale room cannot move the base. */
export const SyncBaseRequestSchema = z.object({
  /** The pin the asker reviewed — the guard against a stale client. */
  expectedBaseSha: ShaSchema,
  /** The base branch's tip the lanes just merged. */
  newBaseSha: ShaSchema,
  lanes: z
    .array(
      z.object({
        workstreamId: z.string().startsWith("wst_"),
        /** The lane's branch head after the merge — the attributed merge
         *  commit, or the unchanged head when the lane already held the base. */
        headSha: ShaSchema
      })
    )
    .min(1)
});
export type SyncBaseRequest = z.infer<typeof SyncBaseRequestSchema>;

export const SyncBaseResponseSchema = z.object({
  baseSha: ShaSchema
});
export type SyncBaseResponse = z.infer<typeof SyncBaseResponseSchema>;

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


// --- Project skills (D-118) --------------------------------------------------
// The worktree's own `.claude/skills/<name>/SKILL.md` files, carried to the
// harness only after a person approved them. D-072 refused the two flags that
// would load them wholesale because both re-admit hooks and MCP servers; its
// revisit clause named the version that could work — Novus composing a
// directory containing only skill files it copied out of the worktree — and
// this is that version. A skill is instructions, never authority: every tool
// call a skill-bearing turn makes still reaches the permission router (D-062),
// so enabling one grants nothing. What the approval pins is the *content*: a
// person enables a name at an exact digest, and a turn carries exactly those
// bytes or drops the skill with the reason on the record — the D-043 rule,
// applied to a file the agent itself can rewrite.

/** How large one SKILL.md may be — the same bound the project's instructions
 *  file has (D-064): larger than anything a person wrote, small enough that a
 *  generated one cannot become the whole prompt. */
export const MAX_SKILL_BYTES = 100_000;
/** A manifest of forty skills is a manifest; more is a generator talking. */
export const MAX_PROJECT_SKILLS = 40;
export const SKILL_DESCRIPTION_MAX = 400;

/** A skill's identity is its directory name under `.claude/skills` — one path
 *  segment, no separators, no leading dot, so a name can never be a traversal
 *  and never resolves anywhere but inside the skills directory. */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "a skill name is its directory name: letters, digits, dot, dash, underscore"
  );

/** One skill as the runner read it from the worktree — what a person reviews
 *  and approves. Published beside the declared commands (D-043's pattern). */
export const ProjectSkillSchema = z.object({
  name: SkillNameSchema,
  /** The SKILL.md frontmatter's own description, when it parses; a skill is
   *  reviewed by what it says it is, and one that says nothing says that. */
  description: z.string().max(SKILL_DESCRIPTION_MAX).nullable().default(null),
  /** SHA-256 of the SKILL.md bytes. The approval pins this, so what loads is
   *  what was reviewed — byte for byte — or nothing. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(MAX_SKILL_BYTES)
});
export type ProjectSkill = z.infer<typeof ProjectSkillSchema>;

/** One enabled skill on a lane: the name, at the exact content a person saw.
 *  A turn whose worktree holds different bytes under this name does not carry
 *  the skill — it reports the drop instead. */
export const EnabledSkillSchema = z.object({
  name: SkillNameSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/)
});
export type EnabledSkill = z.infer<typeof EnabledSkillSchema>;

export const EnabledSkillsSchema = z.array(EnabledSkillSchema).max(MAX_PROJECT_SKILLS);

// --- Project MCP servers (D-119) ---------------------------------------------
// The worktree's own `.mcp.json`, governed the same way as its skills: the
// runner publishes a bounded manifest, a person enables named servers at the
// exact entry they reviewed, and a turn is handed a config Novus authors —
// `--mcp-config` with `--strict-mcp-config`, so only the approved servers
// exist — or nothing. Unlike a skill, a server is genuinely new tool surface,
// so the tier is higher (`mcp.set` is Mission Admin's alone) and the router
// treats its tools like a shell command: an MCP tool's effects are declared
// nowhere, so no profile short of `dont_ask` ever answers one by policy.

/** A manifest of ten servers is a manifest; more is a generator talking. */
export const MAX_MCP_SERVERS = 10;

/** A remote MCP server's address: https away from this machine, http only on
 *  loopback, never a credentialed authority, never control characters — the
 *  preview bridge's rules (D-045), applied to the one place an enablement is
 *  also an egress decision. */
export function validMcpUrl(value: string): boolean {
  if (value.length > 400 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && loopback;
}

/** One MCP server as the runner read it from `.mcp.json` — what a person
 *  reviews and enables. Field values are as the project declared them, never
 *  an expanded secret: the harness environment holds none (D-041). */
export const McpServerSchema = z
  .object({
    name: SkillNameSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    /** stdio: the program this machine would run. */
    command: z.string().max(400).nullable().default(null),
    args: z.array(z.string().max(400)).max(20).default([]),
    env: z
      .array(z.object({ name: z.string().min(1).max(80), value: z.string().max(400) }).strict())
      .max(10)
      .default([]),
    /** http/sse: where this machine would connect. */
    url: z.string().max(400).nullable().default(null),
    /** SHA-256 of the canonical entry. The approval pins this, so what loads
     *  is what was reviewed — field for field — or nothing. */
    digest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === "stdio") {
      if (server.command === null || server.url !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a stdio server names a command and no url" });
      }
      return;
    }
    if (server.url === null || server.command !== null || !validMcpUrl(server.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a remote server names an https url (http only on loopback), with no credentials in the authority"
      });
    }
  });
export type McpServer = z.infer<typeof McpServerSchema>;

export const EnabledMcpServerSchema = z.object({
  name: SkillNameSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/)
});
export type EnabledMcpServer = z.infer<typeof EnabledMcpServerSchema>;

export const EnabledMcpServersSchema = z.array(EnabledMcpServerSchema).max(MAX_MCP_SERVERS);

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
  originSha: z.string().nullable().default(null),
  /** The revision the repository host is known to serve for this branch —
   *  written only by an observed successful push (D-099). Null means nothing
   *  has ever been pushed, which is the ordinary local-first state. */
  remoteHeadSha: ShaSchema.nullable().default(null),
  /** The lane's standing answer policy (D-115). Defaulted so rows from before
   *  profiles existed read as what they were: every question asked. */
  permissionProfile: PermissionProfileSchema.default(DEFAULT_PERMISSION_PROFILE),
  /** The project skills a person enabled on this lane (D-118), each pinned to
   *  the digest they were shown. Defaulted empty: no skill is ever carried
   *  because nobody said anything. A fork starts empty, like the profile —
   *  trust is granted to a lane by a person, never inherited. */
  enabledSkills: EnabledSkillsSchema.default([]),
  /** The project MCP servers a person enabled on this lane (D-119), pinned
   *  the same way. Defaulted empty, and a fork starts empty. */
  enabledMcpServers: EnabledMcpServersSchema.default([])
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

// --- Sessions (D-083) --------------------------------------------------------
// Parallel conversations inside one workstream. A session owns its direction
// thread, its executions, and its own harness continuity — and nothing else:
// no branch, no worktree, no workspace, no lease. Sessions take turns in the
// workstream's single workspace; the serialization is the control plane's.

/** A title is the session's own first words, truncated — never a form field. */
export const SESSION_TITLE_MAX = 80;

/**
 * One pattern of a chat's file scope (D-097): a repository-relative path
 * glob — `server/**`, `src/*.ts`, `docs/README.md`. Forward slashes, no
 * leading `./`, never absolute, never `..`. `**` crosses directories, `*`
 * stays within one.
 */
export const ScopePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (pattern) =>
      !pattern.startsWith("/") &&
      !pattern.startsWith("./") &&
      !/(^|\/)\.\.(\/|$)/.test(pattern) &&
      !pattern.includes("\\"),
    "a scope pattern is a repository-relative path with forward slashes"
  );

/** A chat's declared file ownership (D-097): the paths its write turns may
 *  change. Bounded — a scope of forty patterns is a scope of none. */
export const SessionScopeSchema = z.array(ScopePatternSchema).min(1).max(40);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

export const SessionSchema = z.object({
  /** `csn_` — `ses_` was already the auth session's prefix (ARCHITECTURE.md). */
  sessionId: z.string().startsWith("csn_"),
  workstreamId: z.string().startsWith("wst_"),
  /** Null until the session's first direction names it (D-083). */
  title: z.string().max(SESSION_TITLE_MAX).nullable(),
  createdBy: z.string().startsWith("usr_"),
  createdByLogin: z.string().min(1),
  createdAt: z.string().datetime(),
  /** The files this chat owns (D-097), set by the baton holder. Null means
   *  unscoped: its write turns take the whole workspace exclusively, exactly
   *  as before scopes existed. A scoped chat's write turns may run in
   *  parallel with other scoped chats whose patterns are provably disjoint,
   *  may write only inside the scope — enforced at the runner — and
   *  checkpoint only their own paths. */
  scope: SessionScopeSchema.nullable()
});
export type Session = z.infer<typeof SessionSchema>;

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
  workstreamCount: z.number().int().positive().default(1),
  /** Where the mission's attention-demanding state actually is (D-093): the
   *  lane whose own state decided the mission's word, and the conversation
   *  whose execution is blocked, so the needs-attention lens can name the
   *  exact background chat instead of only the mission. Null whenever the
   *  mission is not asking for a person; sessionTitle is null for a session
   *  its first direction has not yet titled, and both session fields are null
   *  where the attention has no execution behind it (a failed workspace). The
   *  room's own detail response leaves this null — there the rail tree's
   *  "· needs you" already points at the row itself. */
  attention: z
    .object({
      workstreamId: z.string().startsWith("wst_"),
      workstreamName: z.string().min(1),
      sessionId: z.string().startsWith("csn_").nullable(),
      sessionTitle: z.string().nullable()
    })
    .nullable(),
  /** When the last durable event landed (D-120) — the card's "1h" and the
   *  board's within-column order. Null for a mission with no events yet, and
   *  on the detail path, which does not fill the board fields. */
  lastActivityAt: z.string().datetime().nullable().default(null),
  /** Where the running work is (D-120): the first running lane in creation
   *  order and the chat whose turn it is — the running mirror of `attention`,
   *  so a card can say what is happening without opening the room. Null when
   *  nothing runs, and on the detail path. */
  working: z
    .object({
      workstreamId: z.string().startsWith("wst_"),
      workstreamName: z.string().min(1),
      sessionId: z.string().startsWith("csn_").nullable(),
      sessionTitle: z.string().nullable()
    })
    .nullable()
    .default(null),
  /** The baton, stated only where it is one fact: the single-lane mission's
   *  lease holder (PRODUCT.md#control's derived display). A mission holding
   *  several lanes has several batons, so this stays null rather than lying
   *  with one name (D-120). */
  controllerLogin: z.string().nullable().default(null),
  /** What the mission's work has touched so far (D-120): distinct changed
   *  paths, and the summed per-turn line arithmetic — churn, stated as churn,
   *  never presented as a net diff. Null when nothing was ever committed. */
  churn: z
    .object({
      filesChanged: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative()
    })
    .nullable()
    .default(null),
  /** Verification at the lanes' current heads only (D-120): checks proving a
   *  revision a lane has moved past are history, not this tally. Null when no
   *  check has run against any current head. */
  checks: z
    .object({
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative()
    })
    .nullable()
    .default(null),
  /** How the mission's work ended, when it has (D-121). A closed mission's
   *  primary state is its stored outcome — the one place the projection reads
   *  a stored word, because a terminal state is a fact a person made, not a
   *  derivation. All three null while the mission is open. */
  closedOutcome: MissionOutcomeSchema.nullable().default(null),
  closedAt: z.string().datetime().nullable().default(null),
  closedByLogin: z.string().nullable().default(null)
});
export type Mission = z.infer<typeof MissionSchema>;

/** Ending a mission's work (D-121). */
export const CloseMissionInputSchema = z.object({
  outcome: MissionOutcomeSchema,
  /** For a cancellation: what was abandoned and why, in the person's own
   *  words — recorded on the event and in the receipt. Optional, bounded. */
  reason: z.string().trim().max(500).optional()
});
export type CloseMissionInput = z.infer<typeof CloseMissionInputSchema>;

/**
 * The mission's receipt (D-121): a deterministic projection of durable state,
 * snapshotted when the mission closes with the event range it covers — same
 * events, same receipt, and always re-derivable (ARCHITECTURE.md#persistence).
 * Bounded everywhere: a receipt is the record's summary, not the record.
 */
export const ReceiptSnapshotSchema = z.object({
  goal: z.string().max(500),
  successCriteria: z.string().max(5000),
  outcome: MissionOutcomeSchema,
  closedByLogin: z.string().min(1),
  closedAt: z.string().datetime(),
  reason: z.string().max(500).nullable(),
  participants: z
    .array(
      z
        .object({
          login: z.string().min(1),
          // Inlined rather than MissionRoleSchema, which is declared later in
          // this module; a contract test pins the two vocabularies together.
          role: z.enum(["mission_admin", "operator", "contributor", "viewer"])
        })
        .strict()
    )
    .max(50),
  directionsApplied: z.number().int().nonnegative(),
  /** Every recorded decision, verbatim, newest last — superseded ones kept,
   *  because the receipt answers how the result was produced. */
  decisions: z
    .array(
      z
        .object({
          workstreamName: z.string().min(1),
          checkpointSha: z.string().nullable(),
          rationale: z.string().max(4000),
          acceptedRisks: z.string().max(4000).nullable(),
          decidedByLogin: z.string().min(1),
          decidedAt: z.string().datetime(),
          superseded: z.boolean(),
          /** The visual evidence the decider chose (D-122), by exact id, so
           *  reopening the receipt reconstructs the same set. Defaulted for
           *  snapshots stored before artifacts existed. */
          artifactIds: z.array(z.string()).max(20).default([])
        })
        .strict()
    )
    .max(20),
  changes: z
    .object({
      filesChanged: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative()
    })
    .strict(),
  /** The ledger's final rows: name, outcome, origin, and the revision each
   *  proved — current or not at close, stated per row. */
  checks: z
    .array(
      z
        .object({
          name: z.string().max(200),
          outcome: z.string().max(20),
          origin: z.string().max(20),
          checkpointSha: z.string().nullable(),
          currentAtClose: z.boolean()
        })
        .strict()
    )
    .max(100),
  /** The mission's visual evidence at close (D-122): the frozen references —
   *  ids, digests, provenance — never the blobs and never a signed URL.
   *  Reopening the receipt reconstructs this exact set, and viewing any of it
   *  mints a fresh temporary grant then. Defaulted for snapshots from before
   *  artifacts existed. */
  artifacts: z
    .array(
      z
        .object({
          artifactId: z.string().min(1),
          kind: z.string().max(20),
          label: z.string().max(120),
          state: z.string().max(20),
          sha256: z.string().max(64),
          capturedAt: z.string().datetime(),
          revisionSha: z.string().nullable(),
          /** Whether a verified thumbnail exists to load — an interrupted
           *  recording may honestly have none. Defaulted for older snapshots. */
          hasThumbnail: z.boolean().default(false),
          /** Where it was evidence at close, in words. */
          attachedTo: z.array(z.string().max(200)).max(20)
        })
        .strict()
    )
    .max(50)
    .default([]),
  /** What remains uncertain, in words — the section a receipt must never
   *  omit (PRODUCT.md#domain-model, Receipt). */
  remainingUncertain: z.array(z.string().max(300)).max(50),
  pullRequest: z
    .object({ number: z.number().int().positive(), state: z.string().max(20) })
    .strict()
    .nullable(),
  /** The event-log range this projects (ARCHITECTURE.md#event-model). */
  eventRange: z.object({ fromSeq: z.number().int(), toSeq: z.number().int() }).strict()
});
export type ReceiptSnapshot = z.infer<typeof ReceiptSnapshotSchema>;

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
  /** End a mission's work (D-121): complete it — result accepted, receipt
   *  snapshotted — or cancel it. Mission Admin's alone, like archival, and a
   *  different act from archival: closing ends, filing away hides nothing
   *  and ends nothing. */
  "mission.close",
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
  /** Publish and steward the mission's pull request: push the branch, open
   *  the draft, request reviewers, mark it ready. Never merge — no capability
   *  grants that, because no verb for it exists anywhere (D-099). */
  "pr.manage",
  /** Follow a moved base (D-144): merge the base branch's new tip into every
   *  lane and move the pin. A decision about what the mission is based on,
   *  not an operating verb on any one lane, so it is held by role (Mission
   *  Admin, Operator) and never granted by the baton — the `approach.create`
   *  reasoning. Distinct from `workspace.sync`, PRODUCT.md's per-lane act of
   *  applying a remote mission-branch update. */
  "base.sync",
  "workspace.command",
  /** Answering a harness approval. Lease-held only — a Mission Admin who is not
   *  the controller cannot answer for them (PRODUCT.md#roles-and-capabilities). */
  "approval.respond",
  /** Set a lane's permission profile (D-115). A policy act, not an operating
   *  one — it decides what gets asked, where the baton decides who answers —
   *  so it is held by role (Mission Admin, Operator) and never granted by the
   *  baton, like `approach.create`. One further tier is judged server-side:
   *  `dont_ask` is Mission Admin's alone (ADMIN_ONLY_PERMISSION_PROFILES). */
  "policy.set",
  /** Enable or disable a project's skills on a lane (D-118). The same kind of
   *  act as `policy.set` — it decides what the harness is handed, not who
   *  answers — so it is held by role (Mission Admin, Operator) and never
   *  granted by the baton. Enabling pins the exact digest the person was
   *  shown; a skill grants nothing, and every tool call still asks. */
  "skills.set",
  /** Enable or disable a project's MCP servers on a lane (D-119). A server is
   *  new tool surface — a program this machine runs, or a host it connects
   *  to — so the tier is higher than a skill's: Mission Admin's alone, never
   *  an Operator's, never the baton's. Every call an enabled server's tools
   *  make still reaches the router, where no profile short of `dont_ask`
   *  answers one by policy. */
  "mcp.set",
  /** Declare a turn dead after a stop went unanswered (D-111). Held by the
   *  controller and by Mission Admin — the escalation PRODUCT.md#control has
   *  always named, implemented as exactly that: an explicit, logged act that
   *  is refused while the ordinary Stop still has a claim to work. */
  "force_interrupt",
  /** Capture visual evidence — a screenshot or recording — from the lane's
   *  live Preview (D-122). An act on the lane's workspace, tiered exactly as
   *  `workspace.command` is: Mission Admin, Operator, and the lease holder.
   *  An agent-requested capture additionally rides the approval machinery —
   *  it is never a hidden capability (D-123). */
  "artifact.capture",
  /** Attach or detach an artifact as evidence beside a check or the tracked
   *  pull request (D-122). Changing what the record presents as evidence is
   *  the `review.approve` kind of act: Mission Admin and Operator, never the
   *  baton. The artifact itself stays immutable either way. */
  "artifact.attach",
  "control.request",
  "control.offer",
  "control.accept",
  "control.revoke"
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/** Per-participant connection state (PRODUCT.md#presence-and-connection).
 *  Projected from the participant's own last read of the mission, never
 *  stored as a word: connected while their client is polling, reconnecting
 *  in the window where the machine is plausibly coming back, offline past
 *  it — the same recovery window the runner's liveness uses (D-091). */
export const ParticipantConnectionSchema = z.enum(["connected", "reconnecting", "offline"]);
export type ParticipantConnection = z.infer<typeof ParticipantConnectionSchema>;

export const ParticipantSchema = z.object({
  userId: z.string().startsWith("usr_"),
  login: z.string().min(1),
  name: z.string().nullable(),
  role: MissionRoleSchema,
  joinedAt: z.string().datetime(),
  isController: z.boolean(),
  connection: ParticipantConnectionSchema
});
export type Participant = z.infer<typeof ParticipantSchema>;

// --- Artifact primitives, defined here because direction carries them ------
//
// The artifact section proper is further down (D-022, D-122); these are its
// vocabulary, lifted above the first schema that needs them — a direction may
// carry attached images (D-150), and a schema cannot reference one declared
// after it.

/**
 * `attachment` (D-150) is the one kind a person *supplies* rather than Novus
 * capturing: an image handed to the room with a direction. It shares the whole
 * artifact lifecycle — promised digest, store-verified bytes, expiring view
 * grants — because a picture the agent acted on is evidence exactly as a
 * captured one is, and it must survive the laptop that sent it.
 */
export const ArtifactKindSchema = z.enum(["screenshot", "recording", "attachment", "transcript"]);

/** What a *capture* may produce (D-122). Deliberately narrower than the kind
 *  vocabulary: an attachment is supplied, never captured, so the capture
 *  routes refuse the word by type rather than by a check somebody could
 *  forget to write. */
export const CaptureKindSchema = z.enum(["screenshot", "recording"]);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * The artifact's lifecycle. `pending` and `uploading` are never evidence;
 * `failed` never pretends otherwise; `interrupted` is a recording whose bytes
 * are real but whose ending was not its own Stop — playable, and marked.
 */
export const ArtifactStateSchema = z.enum([
  "pending",
  "uploading",
  "available",
  "interrupted",
  "failed"
]);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;

/** Who caused the capture: a person's own click, or a coding agent's request
 *  routed through the approval machinery (D-123). Never ambiguous. */
export const ArtifactInitiatorSchema = z.enum(["person", "agent"]);
export type ArtifactInitiator = z.infer<typeof ArtifactInitiatorSchema>;

/** Where an artifact's bytes came from. `preview` is the validated loopback
 *  Preview of the lane's own running application (D-098) — the only surface
 *  Novus captures. `upload` is a person's own file, which Novus never
 *  captured and never claims to have (D-150); an enum so a further source is
 *  a deliberate widening, never a free string. */
export const ArtifactCaptureSourceSchema = z.enum(["preview", "upload"]);

/** The allowed blob types, closed. PNG is what `capturePage` produces; WebM
 *  is what Chromium's own recorder produces and replays (D-123). */
export const ARTIFACT_MIME_TYPES = [
  "image/png",
  "video/webm",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf"
] as const;
export const ArtifactMimeSchema = z.enum(ARTIFACT_MIME_TYPES);

/**
 * What a person may attach to a direction (D-150, widened by D-151) — a closed
 * set, and every member of it is a format the harness **was observed to
 * actually read**, not one a document claims it supports.
 *
 * The four image types travel as image content blocks; PDF travels as a
 * document block. Anything else a person picks is converted to PNG first or
 * refused by name — never handed over hoping. That rule is not caution: HEIC
 * passed straight through does not error, it makes the model answer *wrongly
 * and confidently* about a picture it could not decode, which is worse than
 * any refusal.
 */
export const ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf"
] as const;
export const AttachmentMimeSchema = z.enum(ATTACHMENT_MIME_TYPES);
export type AttachmentMime = z.infer<typeof AttachmentMimeSchema>;

/**
 * How one attachment reaches the harness (D-153).
 *
 * `image` and `document` are **inlined**: the bytes go into the turn's own
 * message as content blocks, the model reads them directly, and nothing is
 * written to disk. `file` is everything else — an mp3, a video, a CSV, an
 * archive — for which there is no content block to inline into, so it is
 * **staged in the worktree** and its path is named to the agent, which then
 * uses its own tools on it.
 *
 * The split is not a preference. It is the difference between what the model
 * can parse and what a shell command has to open, and the second road exists
 * because the first one simply stops at five formats.
 */
export const AttachmentFormSchema = z.enum(["image", "document", "file"]);
export type AttachmentForm = z.infer<typeof AttachmentFormSchema>;

/** MIME types are open for attachments — a person may hand over any file, and
 *  enumerating the world is not possible. Bounded and shaped, never free. */
export const MimeTypeSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/, "must be a MIME type");

export function attachmentForm(mime: string): AttachmentForm {
  if (mime === "application/pdf") return "document";
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime) ? "image" : "file";
}

export const MAX_SCREENSHOT_BYTES = 20_000_000;
export const MAX_RECORDING_BYTES = 200_000_000;
export const MAX_THUMBNAIL_BYTES = 1_000_000;
/**
 * The ceiling on one attached image *after* the client has resized it
 * (D-150). The resize happens before the upload rather than after, so a phone
 * screenshot costs the store, the wire, and the harness's context what a
 * readable image costs and not what the camera produced.
 */
export const MAX_ATTACHMENT_BYTES = 5_000_000;
/**
 * A PDF's own ceiling (D-151). Higher than an image's because a document is
 * not resizable — there is no "smaller but still readable" for a contract or a
 * form, so the choice is carry it or refuse it — and lower than the API's own
 * 32MB because every page becomes tokens the turn pays for.
 */
export const MAX_DOCUMENT_BYTES = 10_000_000;
/**
 * A staged file's ceiling (D-153). Much higher than either inlined form, and
 * for the opposite reason: these bytes never enter the harness's context —
 * they sit on disk until the agent chooses to open them — so what bounds them
 * is the store and the wire, not tokens. Large enough for a phone video, which
 * is the thing people will actually attach.
 */
export const MAX_FILE_BYTES = 50_000_000;
/** The longest edge an attachment is scaled down to before upload. */
export const MAX_ATTACHMENT_EDGE = 1568;
/** How many images one direction may carry. Bounded because every one of them
 *  is re-read into the harness's context on the turn it belongs to. */
export const MAX_DIRECTION_ATTACHMENTS = 4;
/** A recording stops itself at this bound, stated in the interface (D-123). */
export const MAX_RECORDING_MS = 5 * 60_000;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");

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

/**
 * One image carried by a direction (D-150), as the room reads it. The bytes
 * live in the artifact store; this is the address and the facts a reader needs
 * to decide whether to open it.
 */
export const DirectionAttachmentSchema = z.object({
  artifactId: z.string().startsWith("art_"),
  /** What the artifact is (D-173/D-175): `attachment` for a person's own
   *  file, `transcript` for a sibling chat's projected record — the trace
   *  renders them differently, and a label prefix is not an identity.
   *  Defaulted for rows written before the vocabulary widened. */
  kind: ArtifactKindSchema.default("attachment"),
  /** Open, not an enum (D-153): a person may attach any file, and the four
   *  inlined image types plus PDF are a subset rather than the whole world. */
  mimeType: MimeTypeSchema,
  byteSize: z.number().int().positive(),
  /** The person's own filename, shown as the image's name. */
  label: z.string().min(1).max(120),
  /** Only an `available` attachment was ever handed to the harness. One that
   *  failed its digest check is still listed — silently dropping it would make
   *  the record claim the turn saw something it did not. */
  state: ArtifactStateSchema
});
export type DirectionAttachment = z.infer<typeof DirectionAttachmentSchema>;

/** One image the composer is holding, uploaded and ready to be submitted with
 *  the words (D-150). `resized` is stated rather than hidden: a person who
 *  attached a 12-megapixel screenshot should know a smaller one was sent. */
export const PreparedAttachmentSchema = DirectionAttachmentSchema.omit({
  state: true,
  kind: true
}).extend({
  /** How this one will travel (D-153): inlined into the message, or staged in
   *  the worktree for the agent's own tools. The composer says which. */
  form: AttachmentFormSchema,
  resized: z.boolean(),
  /** The format this was decoded from, when the harness could not read the
   *  original (D-151) — "HEIC", "TIFF", "BMP". Null when it was carried as
   *  it was. Stated in the interface: a person should know their photo was
   *  converted, not discover it. */
  convertedFrom: z.string().max(20).nullable().default(null)
});
export type PreparedAttachment = z.infer<typeof PreparedAttachmentSchema>;

export const DirectionSchema = z.object({
  directionId: z.string().startsWith("dir_"),
  workstreamId: z.string().startsWith("wst_"),
  /** The conversation this belongs to. Never null: a submission that names no
   *  session lands in the workstream's first, so nothing that predates
   *  sessions changes (D-083). */
  sessionId: z.string().startsWith("csn_"),
  authorUserId: z.string().startsWith("usr_"),
  authorLogin: z.string().min(1),
  body: z.string().min(1),
  state: DirectionStateSchema,
  ordinal: z.number().int(),
  submittedAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable(),
  resolutionReason: z.string().nullable(),
  consumedByExecutionId: z.string().nullable(),
  /** Images this direction was submitted with (D-150), oldest first. Ids and
   *  their facts, never bytes: viewing one mints its own expiring grant like
   *  every other artifact read. Empty for every direction that carried none,
   *  which is every direction written before this existed. */
  attachments: z.array(DirectionAttachmentSchema).max(MAX_DIRECTION_ATTACHMENTS).default([])
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
  workstreamId: z.string().startsWith("wst_").optional(),
  /** Which conversation this is for. Absent means the lane's first session.
   *  A session that does not belong to the resolved lane is answered "no such
   *  mission", exactly as a foreign lane is (D-083). */
  sessionId: z.string().startsWith("csn_").optional(),
  /** Creates a new session from this direction's own words and lands the
   *  direction in it — sessions are words-first, like missions (D-077, D-083).
   *  Refused when `sessionId` is also named: one direction, one target. */
  newSession: z.boolean().default(false),
  /** Run this chat's turn alongside the workspace's, read-only, right now
   *  (D-095) — instead of queueing behind the write turn. Baton holder only:
   *  an alongside turn spends the host machine's quota exactly as an
   *  immediate dispatch does. The turn may not change the worktree — every
   *  permission request it raises is denied by policy — and it records no
   *  checkpoint. */
  alongside: z.boolean().default(false),
  /** Images to hand the harness with these words (D-150). Each must already be
   *  an `available` attachment of this mission, uploaded and digest-verified
   *  before the direction is submitted — a direction is never held open
   *  waiting for bytes. Ids only: the wire carries no image data. */
  attachmentIds: z
    .array(z.string().startsWith("art_"))
    .max(MAX_DIRECTION_ATTACHMENTS)
    .default([])
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

/** What an execution may do to the worktree (D-095). `write` is the ordinary
 *  turn — exclusive per lane, checkpointed, its approvals routed to the baton
 *  holder. `read` runs alongside a write turn: it may look and speak but not
 *  change — every permission request is denied by policy, no checkpoint is
 *  captured, and it is never the lane's safe transfer boundary. Containment
 *  outranks trust: a read turn is denied whatever the lane's permission
 *  profile says (D-115). */
export const ExecutionAccessSchema = z.enum(["write", "read"]);
export type ExecutionAccess = z.infer<typeof ExecutionAccessSchema>;

export const ExecutionSchema = z.object({
  executionId: z.string().startsWith("exe_"),
  workstreamId: z.string().startsWith("wst_"),
  /** The session whose turn this was. Never null: executions from before
   *  sessions are migrated onto their lane's first (D-083). */
  sessionId: z.string().startsWith("csn_"),
  access: ExecutionAccessSchema,
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
  /** The permission profile this turn ran under, pinned at dispatch (D-115) —
   *  part of the turn's durable record, so a receipt can say what supervision
   *  the work had. Defaulted: every pre-profile turn ran asking. */
  permissionProfile: PermissionProfileSchema.default(DEFAULT_PERMISSION_PROFILE),
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
  /** The visual artifacts the decider chose as the evidence that mattered
   *  (D-122), frozen with the rationale — preserved in the decision and the
   *  terminal receipt snapshot, never editable afterwards. */
  artifactIds: z.array(z.string().startsWith("art_")).max(20).default([]),
  decidedAt: z.string().datetime(),
  /** When a later decision replaced this one. Reversals stay in the record. */
  supersededAt: z.string().datetime().nullable()
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RecordDecisionInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  rationale: z.string().trim().min(1, "Say why you chose this.").max(MAX_RATIONALE),
  acceptedRisks: z.string().trim().max(MAX_ACCEPTED_RISKS).optional(),
  /** The visual evidence this decides on, chosen by the recorder (D-122).
   *  Only artifacts that are actually evidence — available or interrupted —
   *  of this mission may be named; anything else is refused in words. */
  artifactIds: z.array(z.string().startsWith("art_")).max(20).default([])
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

// --- The tracked pull request (D-099) ----------------------------------------
// The row D-075 promised: it starts existing when a request is actually
// opened, and from then on the mission tracks it — state, reviews,
// mergeability — to a resolution that happens on GitHub, by humans. Novus
// opens drafts, requests review, and marks ready; there is no merge verb in
// this file, in any route, or in any runner command, deliberately.

export const PullRequestStateSchema = z.enum([
  /** Opened as a draft — the only way Novus opens one. */
  "draft",
  /** Marked ready for review, by a person, through pr.manage. */
  "ready",
  /** Merged on GitHub. Novus observed it; nothing here performed it. */
  "merged",
  /** Closed on GitHub without merging. */
  "closed"
]);
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

/** What the host says about merging cleanly. `unknown` while it is still
 *  computing — an honest third state, never collapsed into either answer. */
export const MergeableStateSchema = z.enum(["unknown", "clean", "conflict"]);
export type MergeableState = z.infer<typeof MergeableStateSchema>;

/** One review comment thread, ingested from the host (D-099) and — since
 *  D-100 — resolvable from Novus: the host's own thread id travels so the
 *  resolve verb can name it. Bounded like every ingested claim. */
export const ReviewThreadSchema = z.object({
  /** The host's thread identifier, for resolution. Null on a comment the
   *  host exposes without one. */
  threadId: z.string().max(200).nullable().default(null),
  author: z.string().max(120),
  body: z.string().max(2_000),
  /** The file the comment anchors to, when it anchors to one. */
  path: z.string().max(300).nullable(),
  /** The line it anchors to, when it anchors to one. */
  line: z.number().int().positive().nullable().default(null),
  state: z.enum(["open", "resolved"]),
  url: z.string().max(600).nullable(),
  postedAt: z.string().max(40)
});
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;

// --- Merge readiness and completion (D-100) ----------------------------------
// The Conductor-shaped gate: one aggregated projection of everything that
// usually decides whether a request is ready, each unmet item a named
// blocker. Completion verbs are explicit human acts GitHub performs
// underneath; the two-tier rule is the honesty — what the host itself cannot
// do is refused, everything else is stated and deliberately accepted.

export const HostCheckSchema = z.object({
  name: z.string().max(200),
  status: z.enum(["pending", "passed", "failed", "skipped"]),
  /** Whether the host's branch protection requires it. A failing required
   *  check is a host-tier refusal, never an acceptable blocker. */
  required: z.boolean().default(false),
  /** The host's own bucket: a check run, a commit status, or a deployment. */
  kind: z.enum(["check", "status", "deployment"]).default("check"),
  url: z.string().max(600).nullable().default(null)
});
export type HostCheck = z.infer<typeof HostCheckSchema>;

export const ReviewDecisionSchema = z.enum([
  /** Nothing recorded either way. */
  "none",
  "approved",
  "changes_requested",
  /** The host requires a review nobody has given yet. */
  "review_required"
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

export const MergeReadinessSchema = z.object({
  checks: z.array(HostCheckSchema).max(50),
  reviewDecision: ReviewDecisionSchema,
  approvals: z.number().int().nonnegative().max(100),
  changesRequested: z.number().int().nonnegative().max(100),
  /** How far the branch is behind its base — what Update branch fixes. */
  behindBy: z.number().int().nonnegative().nullable(),
  aheadBy: z.number().int().nonnegative().nullable(),
  /** The repository's own allowed methods, read from the host, never
   *  assumed. Merge offers exactly these. */
  allowedMergeMethods: z.array(MergeMethodSchema).max(3),
  syncedAt: z.string().datetime().nullable()
});
export type MergeReadiness = z.infer<typeof MergeReadinessSchema>;

/** How one file changed — shared by checkpoint evidence (D-037) and the
 *  pull request's own file list (D-100). */
export const FileChangeStateSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type FileChangeState = z.infer<typeof FileChangeStateSchema>;

/** One changed file of the pull request as the host reports it, with its
 *  bounded patch for the in-house diff (D-100). */
export const PullFileSchema = z.object({
  path: z.string().max(300),
  changeState: FileChangeStateSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(12_000).nullable()
});
export type PullFile = z.infer<typeof PullFileSchema>;

export const PullCommitSchema = z.object({
  sha: z.string().max(64),
  message: z.string().max(400),
  author: z.string().max(120)
});
export type PullCommit = z.infer<typeof PullCommitSchema>;

export const PullFilesResponseSchema = z.object({
  files: z.array(PullFileSchema).max(150),
  commits: z.array(PullCommitSchema).max(100)
});
export type PullFilesResponse = z.infer<typeof PullFilesResponseSchema>;

export const MergeInputSchema = z.object({
  pullRequestId: z.string().startsWith("pr_"),
  method: MergeMethodSchema,
  /** Deliberate acceptance of the stated non-host blockers. Absent or false,
   *  a merge with blockers outstanding is refused with them named — never
   *  performed silently (D-100). */
  acknowledgeBlockers: z.boolean().default(false)
});
export type MergeInput = z.infer<typeof MergeInputSchema>;

export const PullCommentInputSchema = z.object({
  pullRequestId: z.string().startsWith("pr_"),
  body: z.string().trim().min(1, "Say something.").max(2_000),
  /** Anchors an inline comment; absent means a conversation comment. */
  path: z.string().max(300).optional(),
  line: z.number().int().positive().optional()
});
export type PullCommentInput = z.infer<typeof PullCommentInputSchema>;

export const PullMetadataInputSchema = z.object({
  pullRequestId: z.string().startsWith("pr_"),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(20_000).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional()
});
export type PullMetadataInput = z.infer<typeof PullMetadataInputSchema>;

export const PullRequestSchema = z.object({
  pullRequestId: z.string().startsWith("pr_"),
  missionId: z.string().startsWith("msn_"),
  workstreamId: z.string().startsWith("wst_"),
  /** The decision this publishes. A pull request without one cannot exist:
   *  publishing is what a decision becomes, never a shortcut around one. */
  decisionId: z.string().startsWith("dec_"),
  number: z.number().int().positive(),
  url: z.string().max(600),
  state: PullRequestStateSchema,
  mergeable: MergeableStateSchema,
  title: z.string().min(1).max(300),
  /** Exactly what was sent, snapshotted at publication — the record of the
   *  receipt that travelled, where the *prepared* projection stays live for
   *  the un-opened case (D-075, D-099). */
  body: z.string().min(1).max(20_000),
  baseRef: z.string().min(1).max(300),
  headRef: z.string().min(1).max(300),
  /** The revision the remote branch served when this was opened — the
   *  remote-head guarantee's receipt (D-099). */
  headSha: ShaSchema.nullable(),
  requestedReviewers: z.array(z.string().max(120)).max(15),
  reviewThreads: z.array(ReviewThreadSchema).max(50),
  labels: z.array(z.string().max(100)).max(20).default([]),
  /** The aggregated gate (D-100), refreshed by the same poll that carries
   *  everything else the host says. Null until the first refresh. */
  readiness: MergeReadinessSchema.nullable().default(null),
  /** Visual artifacts attached to this request (D-122). Shown on the Novus
   *  PR page; the exact ids are preserved on the tracked record, and nothing
   *  becomes publicly reachable because a pull request exists. */
  artifactIds: z.array(z.string().startsWith("art_")).max(20).default([]),
  createdBy: z.string().startsWith("usr_"),
  createdByLogin: z.string().min(1),
  /** Who merged it on the host, as the host reports them. */
  mergedBy: z.string().max(120).nullable(),
  mergedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  lastSyncedAt: z.string().datetime().nullable()
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Where the mission branch stands on the remote — the push half of the
 *  remote-head guarantee, read from the one push command in flight or the
 *  workstream's recorded remote head (D-099). */
export const BranchPushSchema = z.object({
  state: z.enum(["none", "pending", "completed", "failed"]),
  /** The revision the remote is known to serve, null until a push landed. */
  remoteHeadSha: ShaSchema.nullable(),
  failureReason: z.string().max(400).nullable()
});
export type BranchPush = z.infer<typeof BranchPushSchema>;

export const RequestReviewInputSchema = z.object({
  pullRequestId: z.string().startsWith("pr_"),
  reviewers: z
    .array(z.string().trim().min(1).max(120))
    .min(1, "Name at least one reviewer.")
    .max(15)
});
export type RequestReviewInput = z.infer<typeof RequestReviewInputSchema>;

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
// FileChangeStateSchema lives above the pull-request block that also uses it.

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
  files: z.array(FileChangeSchema),
  /** Paths a scoped turn changed outside its scope, uncommitted (D-097). */
  driftPaths: z.array(z.string()).default([])
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
  /** Visual artifacts attached beside this check as supporting evidence
   *  (D-122). Supporting only: an attachment never changes the outcome. */
  artifactIds: z.array(z.string().startsWith("art_")).max(20).default([]),
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

// --- Artifacts: durable visual evidence (D-022, D-122) -----------------------
// A screenshot or recording captured from the approved Preview surface,
// preserved with its provenance. The durable database stores metadata and
// relationships; the bytes live in the artifact store behind D-022's
// S3-compatible interface, referenced by object keys that never cross this
// wire — a client is handed a short-lived viewing URL on request and nothing
// durable. An artifact is immutable once available: attaching it to a check,
// decision, receipt, or pull request changes the relationship, not the blob.



/** Where an artifact is being used as evidence. Decisions carry their chosen
 *  artifact ids on the decision row itself; checks and pull requests carry
 *  attachment rows. Both are served here so one list answers "where is this
 *  evidence used?". */
export const ArtifactAttachmentRefSchema = z.object({
  kind: z.enum(["check", "decision", "pull_request"]),
  id: z.string().min(1),
  /** The target said in words — a check's name, a PR's number — resolved
   *  server-side for display. */
  label: z.string().max(200)
});
export type ArtifactAttachmentRef = z.infer<typeof ArtifactAttachmentRefSchema>;

export const ArtifactSchema = z.object({
  artifactId: z.string().startsWith("art_"),
  missionId: z.string().startsWith("msn_"),
  /** The lane whose preview was captured. Null only if a future kind has no
   *  lane; every preview capture has one. */
  workstreamId: z.string().startsWith("wst_").nullable(),
  /** The conversation this capture is honestly attributable to. A person's
   *  own click belongs to no chat and stays null — never assigned to the most
   *  recent one. */
  sessionId: z.string().startsWith("csn_").nullable(),
  /** The execution that requested it, for an agent-requested capture. Null
   *  for a person's own capture. */
  executionId: z.string().nullable(),
  kind: ArtifactKindSchema,
  /** Closed for a capture — a screenshot is a PNG and a recording is WebM —
   *  and open for an attachment, which is whatever a person handed over
   *  (D-153). One field, so the strictness lives where it can be enforced:
   *  the capture routes take `ArtifactMimeSchema` on the way in. */
  mimeType: MimeTypeSchema,
  byteSize: z.number().int().positive(),
  /** The blob's content digest, promised at begin and verified by the store
   *  before the artifact may read as evidence. The blob is immutable; this is
   *  how a reader knows it has not changed since capture. */
  sha256: Sha256Schema,
  state: ArtifactStateSchema,
  failureReason: z.string().max(300).nullable(),
  /** Why a recording is marked interrupted, when it is — the process exited,
   *  the preview went down, the app quit. */
  interruptionReason: z.string().max(300).nullable(),
  /** A concise generated name — "Screenshot · web" — never a filename. */
  label: z.string().min(1).max(120),
  capturedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  /** The person who captured it, for `initiator: person`. Null for an
   *  agent-requested capture, whose actor is the execution. */
  createdByLogin: z.string().nullable(),
  initiator: ArtifactInitiatorSchema,
  captureSource: ArtifactCaptureSourceSchema,
  /** The live run process whose page was captured, and its declared name. */
  processId: z.string().startsWith("prc_").nullable(),
  processName: z.string().max(120).nullable(),
  /** The validated loopback origin the preview was showing. Never carries
   *  credentials — the preview bridge refuses them before a view exists. */
  origin: z.string().max(300).nullable(),
  /** The process's declared readiness at capture (D-045): `ready` is the
   *  declared signal's answer, everything else is stated as itself. */
  readiness: ProcessReadinessSchema.nullable(),
  /** The worktree's HEAD at the moment of capture — a fact read from git on
   *  the machine that held both the pixels and the tree. Null when the tree
   *  could not be read. */
  revisionSha: z.string().nullable(),
  /** True when uncommitted changes were present at capture: the revision
   *  alone would then overstate what the running app was built from. */
  revisionDirty: z.boolean(),
  /** The recorded checkpoint matching `revisionSha`, when one exists. */
  checkpointId: z.string().startsWith("ckp_").nullable(),
  /** Environment attribution, composed server-side from the enrolled runner —
   *  the same claim discipline as a check's (D-037). */
  environment: z.string().min(1),
  /** Playback length for recordings; null for screenshots and for a
   *  recording whose duration was never learned. */
  durationMs: z.number().int().nonnegative().nullable(),
  hasThumbnail: z.boolean(),
  /** What the redaction set could and could not do here: textual metadata
   *  passed the known-secret redaction; the pixels themselves were never
   *  scanned, and nothing claims they were (ARCHITECTURE.md#secret-placement). */
  redaction: z.literal("metadata_only"),
  /** Everywhere this artifact is currently evidence, resolved server-side. */
  attachments: z.array(ArtifactAttachmentRefSchema).max(50).default([])
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** The provenance a capture binds at the moment it happens. Claims from the
 *  machine that performed the capture, validated and bounded server-side. */
export const ArtifactProvenanceSchema = z.object({
  sessionId: z.string().startsWith("csn_").optional(),
  processId: z.string().startsWith("prc_"),
  processName: z.string().min(1).max(120),
  origin: z.string().min(1).max(300),
  readiness: ProcessReadinessSchema,
  revisionSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  revisionDirty: z.boolean(),
  durationMs: z.number().int().nonnegative().max(24 * 60 * 60_000).optional()
});
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const BeginArtifactInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_").optional(),
  kind: CaptureKindSchema,
  mimeType: ArtifactMimeSchema,
  byteSize: z.number().int().positive(),
  sha256: Sha256Schema,
  /** The thumbnail or poster frame, uploaded beside the blob and verified the
   *  same way. Absent when none could be produced. */
  thumbnail: z
    .object({ byteSize: z.number().int().positive().max(MAX_THUMBNAIL_BYTES), sha256: Sha256Schema })
    .optional(),
  capturedAt: z.string().datetime(),
  /** For a recording that ended without its own Stop: created already marked. */
  interrupted: z.boolean().default(false),
  interruptionReason: z.string().max(300).optional(),
  provenance: ArtifactProvenanceSchema
});
export type BeginArtifactInput = z.infer<typeof BeginArtifactInputSchema>;

/**
 * A person attaching an image to a direction (D-150). Deliberately *not*
 * `BeginArtifactInput`: that shape demands capture provenance — a process, a
 * validated origin, a readiness — and an attachment has none of it. Novus did
 * not photograph anything here; somebody handed it a file, and the record says
 * so rather than inventing a producer.
 */
export const BeginAttachmentInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_").optional(),
  /** The conversation this image was attached in. The direction it rides on
   *  belongs to one, so unlike a person's own capture this is never null. */
  sessionId: z.string().startsWith("csn_").optional(),
  mimeType: MimeTypeSchema,
  /** Bounded per form (D-151, D-153): images, documents and staged files each
   *  have their own ceiling, and the narrower one is checked at the route,
   *  which is where the MIME and the size are finally judged together. */
  byteSize: z.number().int().positive().max(MAX_FILE_BYTES),
  sha256: Sha256Schema,
  /** The person's own name for the file, kept only as a label. It is never a
   *  path, never a key, and never used to address anything. */
  filename: z.string().min(1).max(120),
  /** Present when these bytes are a rendered transcript of one of this lane's
   *  own conversations (D-173): the source session. The row lands as kind
   *  `transcript` with its sessionId pointing at that source — so "View in
   *  conversation" on the artifact opens the chat it was projected from —
   *  and the label is derived server-side from the source's own title, never
   *  from the client's filename. Only `text/markdown` may claim this. */
  transcriptOf: z.string().startsWith("csn_").optional()
});
export type BeginAttachmentInput = z.infer<typeof BeginAttachmentInputSchema>;

/** The runner's begin (agent-requested capture): the same claim plus the
 *  execution that asked, whose approval routing authorized the act (D-123). */
export const BeginRunnerArtifactInputSchema = BeginArtifactInputSchema.extend({
  executionId: z.string().startsWith("exe_"),
  /** The routed approval that authorized this capture, when one was issued as
   *  a card; a profile-decided answer has no card and sends none. */
  approvalId: z.string().startsWith("apr_").optional()
}).omit({ workstreamId: true });
export type BeginRunnerArtifactInput = z.infer<typeof BeginRunnerArtifactInputSchema>;

/** One short-lived signed upload. Never stored, never logged, never an event
 *  (D-022): it exists to carry these bytes and then expire. */
export const ArtifactUploadGrantSchema = z.object({
  url: z.string().min(1),
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime()
});
export type ArtifactUploadGrant = z.infer<typeof ArtifactUploadGrantSchema>;

/** What begins an attachment: the row as the room will read it, and the one
 *  short-lived grant that carries its bytes to the store. No thumbnail —
 *  an attached image is its own thumbnail. */
export const BeginAttachmentResponseSchema = z.object({
  artifact: ArtifactSchema,
  upload: ArtifactUploadGrantSchema
});
export type BeginAttachmentResponse = z.infer<typeof BeginAttachmentResponseSchema>;

export const BeginArtifactResponseSchema = z.object({
  artifact: ArtifactSchema,
  upload: ArtifactUploadGrantSchema,
  thumbnailUpload: ArtifactUploadGrantSchema.nullable()
});
export type BeginArtifactResponse = z.infer<typeof BeginArtifactResponseSchema>;

export const CompleteArtifactInputSchema = z.object({
  outcome: z.enum(["uploaded", "failed"]),
  failureReason: z.string().max(300).optional()
});
export type CompleteArtifactInput = z.infer<typeof CompleteArtifactInputSchema>;

/** Temporary viewing access, generated only when an authorized participant
 *  asks and never persisted (D-022). The URL outlives nothing. */
export const ArtifactViewResponseSchema = z.object({
  url: z.string().min(1),
  /** Open, not the capture enum (D-153 widened attachments to any file; the
   *  closed enum here made an mp4 attachment's view fail its parse). */
  mimeType: MimeTypeSchema,
  expiresAt: z.string().datetime(),
  thumbnailUrl: z.string().nullable()
});
export type ArtifactViewResponse = z.infer<typeof ArtifactViewResponseSchema>;

/** Attach or detach an immutable artifact as evidence beside a check or a
 *  tracked pull request. Decisions choose their artifacts at record time
 *  instead (RecordDecisionInput), so the chosen set is frozen with the
 *  rationale rather than editable after the fact. */
export const AttachArtifactInputSchema = z.object({
  target: z.object({
    kind: z.enum(["check", "pull_request"]),
    id: z.string().min(1).max(60)
  })
});
export type AttachArtifactInput = z.infer<typeof AttachArtifactInputSchema>;

/** The machine-local state of an in-flight preview recording (D-123): what
 *  the preview head says while pixels are being captured. Never durable —
 *  the artifact row exists only once the recording finalizes. */
export const RecordingStatusSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  workstreamId: z.string().startsWith("wst_"),
  state: z.enum(["recording", "finalizing"]),
  startedAt: z.string().datetime(),
  processName: z.string().max(120),
  /** The stated bound the recording stops itself at. */
  maxDurationMs: z.number().int().positive()
});
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;

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
  declaredAt: z.string().datetime().nullable(),
  /** The project's skills, as the runner last read them from the worktree
   *  (D-118) — the manifest a person reviews and enables from, published on
   *  the same event as the declared commands. Never the bodies: a name, what
   *  it says it is, and the digest an approval would pin. */
  skills: z.array(ProjectSkillSchema).max(MAX_PROJECT_SKILLS).default([]),
  /** The project's MCP servers, as the runner last read `.mcp.json` (D-119) —
   *  the same review-then-enable manifest, one tier up. */
  mcpServers: z.array(McpServerSchema).max(MAX_MCP_SERVERS).default([])
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

// --- The preview surface (D-098) ---------------------------------------------
// The embedded, interactive view of a running local application, inside the
// window instead of handed to an external browser. Same gates as D-045 —
// loopback `http`/`https` only, no credentials, no control characters, and
// only an address a **live** process of this workstream actually reported —
// enforced in the Electron main process, which also owns the embedded view's
// navigation outright: the top frame may go nowhere but the approved origin.
// This is not a browser. No address-bar verb exists on this bridge, and the
// renderer can only name a URL the room already showed it.

/** Where the embedded view sits, in the window's own CSS pixels — the
 *  renderer measures the rectangle it reserved and the main process places
 *  the native view over exactly that. */
export const PreviewBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0).max(20_000),
  height: z.number().finite().min(0).max(20_000)
});
export type PreviewBounds = z.infer<typeof PreviewBoundsSchema>;

/**
 * What the embedded page itself is doing. Deliberately not the application's
 * readiness: a page can render while the declared readiness signal is still
 * unanswered, and readiness stays the process's own declared fact (D-045).
 * `ready` here claims one thing only — the page loaded — never that the
 * application is correct.
 */
export const PreviewPhaseSchema = z.enum([
  /** The view exists and the page is loading. */
  "loading",
  /** The page finished loading. A fact about one HTTP response, nothing more. */
  "ready",
  /** The page could not load — the address did not answer. */
  "unreachable",
  /** The embedded page's own renderer died. */
  "crashed",
  /** The process that reported this address has ended; the view is down and
   *  the surface says so rather than showing a page nothing is serving. */
  "stopped"
]);
export type PreviewPhase = z.infer<typeof PreviewPhaseSchema>;

export const PreviewStatusSchema = z.object({
  workstreamId: z.string().startsWith("wst_"),
  /** The validated address the view is showing, rebuilt from parsed parts. */
  url: LoopbackUrl,
  /** The approved origin; the top frame can navigate nowhere else. */
  origin: z.string().max(300),
  /** The live run process that reported this address — the preview's identity
   *  is that process's, and it opens for no other reason (D-045, D-098). */
  processId: z.string().startsWith("prc_"),
  processName: z.string().min(1),
  phase: PreviewPhaseSchema,
  /** The phase in words where there are any — a load error's description, or
   *  how the process ended. Sanitized like all process reporting. */
  detail: z.string().max(400).nullable()
});
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

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

/**
 * The room's live signal (D-149): the mission moved, to this sequence, with
 * this event kind. An **address, never content** — a watcher re-reads the
 * mission through the same authorized projection every other reader passes, so
 * nothing here can widen what a person may see. The kind rides along only so a
 * client can decide how urgently to re-read; it is never rendered on its own.
 */
export const MissionChangeSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  seq: z.number().int().nonnegative(),
  kind: z.string()
});
export type MissionChange = z.infer<typeof MissionChangeSchema>;

// --- Opening the workspace elsewhere (D-159) ---------------------------------
// A lane's checkout is a real directory on the machine that holds it, and the
// tools a person already uses live outside Novus. This opens it in one of
// them. The renderer names a **lane**, never a path: the worktree is resolved
// in the main process and the application comes from a closed list, so there
// is no input here that could name another directory or another program.

export const OpenTargetSchema = z.enum([
  "finder",
  "terminal",
  "iterm",
  "cursor",
  "vscode",
  "zed",
  "copy-path"
]);
export type OpenTarget = z.infer<typeof OpenTargetSchema>;

/** One entry the room may offer, as this machine actually found it. */
export const OpenTargetOptionSchema = z.object({
  id: OpenTargetSchema,
  label: z.string().min(1).max(40),
  /** The application's **own** icon, read off this machine's copy of it and
   *  inlined as a data URL (D-159 amended). Not an asset Novus ships: an app's
   *  icon is the thing a person recognizes before they read anything, and a
   *  bundled copy would go stale the moment the app is redesigned. Null for
   *  the entries that are not applications — Copy path — and whenever the icon
   *  could not be read, which is a reason to show the row without one rather
   *  than to drop it. */
  icon: z.string().max(200_000).nullable().default(null)
});
export type OpenTargetOption = z.infer<typeof OpenTargetOptionSchema>;

export const OpenWorkspaceInputSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  workstreamId: z.string().startsWith("wst_"),
  target: OpenTargetSchema
});
export type OpenWorkspaceInput = z.infer<typeof OpenWorkspaceInputSchema>;

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
  bytes: z.number().int().nonnegative(),
  /** A data: URI when the file is a bitmap the pane can show — png, jpeg,
   *  gif, webp and kin (D-146). Null for everything else; text stays the
   *  text's own field. */
  image: z.string().nullable().default(null)
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
  createdAt: z.string().datetime(),
  /** When an unanswered offer lapses (D-092). Set at creation, enforced by the
   *  sweep and by the accept route, and rendered as DESIGN.md's countdown
   *  text. Only an `open` offer expires: once accepted, the grant is durable
   *  and completes at the boundary regardless (PRODUCT.md#control). */
  expiresAt: z.string().datetime()
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
  "run_verification",
  /** Push the mission branch to the repository host, up to the decided
   *  checkpoint — the remote-head guarantee's working half (D-099). The
   *  credential is minted per operation, write-scoped, and never stored.
   *  There is deliberately no merge command: this vocabulary can put a
   *  branch on a host and can never combine one with another. */
  "push_branch",
  /** Give back a lane's checkout once its mission has ended (D-155). The
   *  machine stops what is running there, removes its staged attachments, and
   *  removes the worktree — but **never the branch**, which is the record the
   *  receipt and any pull request point at, and never a worktree still holding
   *  uncommitted work, which it reports instead. */
  "release_workspace"
]);
export type RunnerCommandKind = z.infer<typeof RunnerCommandKindSchema>;

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
    payload: z
      .object({
        harness: BOUNDED_LINE,
        model: BOUNDED_LINE,
        effort: BOUNDED_LINE,
        /** The profile this turn was dispatched under (D-115) — echoed by the
         *  runner exactly as model and effort are, so the trace's machinery
         *  line can say what supervision the turn ran with. Defaulted so an
         *  older runner's report still validates as what it was: manual. */
        permissionProfile: PermissionProfileSchema.default(DEFAULT_PERMISSION_PROFILE),
        /** The enabled skills this turn actually carried (D-118), by name —
         *  the audit of what the harness was handed, stated by the runner
         *  that composed it. Defaulted empty for older runners. */
        skills: z.array(SkillNameSchema).max(MAX_PROJECT_SKILLS).default([]),
        /** Enabled skills this turn could NOT carry, each with the reason in
         *  words — the worktree's bytes no longer match the approved digest,
         *  the file is gone, or it stopped being a regular file. A drop is
         *  news a person acts on, so it is on the record, never silent. */
        skillsDropped: z
          .array(z.object({ name: SkillNameSchema, reason: BOUNDED_LINE }).strict())
          .max(MAX_PROJECT_SKILLS)
          .default([]),
        /** The enabled MCP servers this turn actually carried, and the ones
         *  it could not, under exactly the skills' rules (D-119). */
        mcpServers: z.array(SkillNameSchema).max(MAX_MCP_SERVERS).default([]),
        mcpServersDropped: z
          .array(z.object({ name: SkillNameSchema, reason: BOUNDED_LINE }).strict())
          .max(MAX_MCP_SERVERS)
          .default([])
      })
      .strict()
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
        parentToolUseId: PARENT_TOOL_USE_ID,
        /**
         * The tool call's *own* id, as the harness stated it (D-107). This is
         * the missing half of the worker join: a subagent's events carry
         * `parentToolUseId`, and until this field existed the id they pointed
         * at appeared nowhere else in the log, so parent and child could never
         * be connected after the fact. Null when the harness gave the call no
         * id. Recording it grants nothing — a worker still has no branch,
         * controller, checkpoint, or workstream (D-071).
         */
        toolUseId: BOUNDED_LINE.nullable().default(null)
      })
      .strict()
  }),
  z.object({
    /**
     * One of the harness's own workers finished: the tool result of the Task
     * call that spawned it came back on the stream (D-107). `toolUseId` is the
     * spawning call's own id — the same value its children carried as
     * `parentToolUseId` — `failed` is the result's own error flag, and
     * `report` is what the worker handed back, bounded like all harness text.
     * This is the only lifecycle fact the harness exposes about a worker's
     * end; Novus records it and invents nothing beyond it.
     */
    kind: z.literal("harness.worker.ended"),
    payload: z
      .object({
        toolUseId: BOUNDED_LINE,
        failed: z.boolean(),
        report: BOUNDED_TEXT.nullable().default(null)
      })
      .strict()
  }),
  z.object({
    kind: z.literal("harness.usage"),
    payload: HarnessUsageSchema
  }),
  z.object({
    /**
     * The turn's pulse (D-114, D-073's revisit clause). Emitted by the runner
     * every few minutes while the harness process is alive, so a long quiet
     * tool call can be told from a machine that died: fresh heartbeats mean
     * "alive, saying nothing", none mean nobody is there. Liveness only —
     * the stall watch never counts it as progress, and it carries nothing.
     */
    kind: z.literal("execution.heartbeat"),
    payload: z.object({}).strict()
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
    /** Parallel scoped work has drained but the worktree is not clean
     *  (D-097): unattributed changes — drift, or a person's own edits — sit
     *  uncommitted, so the integration checks will not run against a tree
     *  that no recorded revision describes. A person settles the paths
     *  (commit them with an unscoped turn, or revert them) and the next
     *  drain integrates. */
    kind: z.literal("integration.blocked"),
    payload: z
      .object({ paths: z.array(z.string().max(300)).max(50).default([]) })
      .strict()
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
        files: z.array(RunnerFileChangeSchema).max(150).default([]),
        /** Paths that changed during a scoped turn but lie outside its scope
         *  (D-097): observed, reported, and deliberately NOT committed by this
         *  checkpoint — attributing them to this chat would be a guess. They
         *  wait in the worktree for a person or an unscoped turn, and they
         *  block the integration pass until settled. Masked, bounded. */
        driftPaths: z.array(z.string().max(300)).max(50).default([])
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
    /** The mission branch landed on the repository host (D-099): the branch,
     *  and the exact revision the remote now serves. Only success reports —
     *  a failed push settles its command as failed with the reason, and the
     *  remote head simply does not move. */
    kind: z.literal("workspace.pushed"),
    payload: z
      .object({
        branch: BOUNDED_LINE,
        sha: z.string().regex(/^[0-9a-f]{40}$/)
      })
      .strict()
  }),
  z.object({
    /** A lane's checkout given back after its mission ended (D-155), or the
     *  honest reason it was not. `kept` is not a failure: uncommitted work is
     *  somebody's, and a cleanup that deletes it to tidy up is worse than one
     *  that leaves a directory behind and says so. */
    kind: z.literal("workspace.released"),
    payload: z
      .object({
        outcome: z.enum(["released", "kept", "absent"]),
        /** Why it was kept, in words a person can act on. */
        reason: BOUNDED_LINE.nullable().default(null),
        /** How many files were left uncommitted, when that is the reason. */
        uncommitted: z.number().int().nonnegative().default(0),
        /** Staged attachments removed with it — always removed, because the
         *  store already holds them durably. */
        attachmentsRemoved: z.number().int().nonnegative().default(0)
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
    payload: z
      .object({
        commands: z.array(DeclaredCommandSchema).max(60),
        /** The worktree's own `.claude/skills`, read at the same moment
         *  (D-118). Defaulted so an older runner's report still validates as
         *  what it was: a project with nothing published to enable. */
        skills: z.array(ProjectSkillSchema).max(MAX_PROJECT_SKILLS).default([]),
        /** And the worktree's own `.mcp.json` (D-119), same rule. */
        mcpServers: z.array(McpServerSchema).max(MAX_MCP_SERVERS).default([])
      })
      .strict()
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
  z.object({
    /**
     * The lane's permission profile answered a harness question itself
     * (D-115): allowed under `accept_edits`, `auto`, or `dont_ask`, denied
     * under `plan`. Recorded-and-nothing-else — no approvals row, no
     * `needs_approval`, no boundary — because nothing is waiting; it exists
     * so the receipt can say what the policy granted and refused on a
     * person's standing instruction, act by act. The summary is the same
     * bounded, path-masked, value-redacted sentence a card would have
     * carried (D-052); the raw tool input travels nowhere, exactly as it
     * never does. D-095's read-turn denials and D-097's scope verdicts keep
     * their recorded silence — this event belongs to the profile alone.
     */
    kind: z.literal("approval.policy"),
    payload: z
      .object({
        requestId: BOUNDED_LINE,
        toolName: BOUNDED_LINE,
        decision: z.enum(["allowed", "denied"]),
        profile: PermissionProfileSchema,
        summary: z.string().max(MAX_APPROVAL_SUMMARY)
      })
      .strict()
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
          /** The vendor refused for money reasons — a spending or usage
           *  limit, an empty credit balance. Distinct from `authentication`
           *  because "sign in again" is the wrong sentence for a paid-up
           *  machine that ran out of budget (D-109). */
          "billing",
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
  /** Every session of every lane, in creation order. The room filters to the
   *  lane it is reading and shows session chrome only when that lane has more
   *  than one (D-083). */
  sessions: z.array(SessionSchema),
  /** The comparison the Decision Room reads, and nothing that ranks them. */
  approaches: z.array(ApproachSummarySchema),
  /** Files more than one approach changed. Empty with one lane. */
  contested: z.array(ContestedPathSchema),
  /** Every decision this mission has recorded, oldest first; the last one that
   *  is not superseded is the current one. */
  decisions: z.array(DecisionSchema),
  /** What would be published, if a decision has been recorded (D-075). */
  preparedPullRequest: PreparedPullRequestSchema.nullable(),
  /** The snapshotted receipt, present exactly while the mission is closed
   *  (D-121). Stored at close with its event range and always re-derivable;
   *  the terminal room renders from this, not from a recomputation. */
  receipt: ReceiptSnapshotSchema.nullable().default(null),
  /** Where the lane's pinned base stands against its branch (D-139): computed
   *  by the control plane for GitHub repositories, null for local ones — the
   *  machine holding the checkout answers those over the bridge. */
  baseStatus: BaseStatusSchema.nullable().default(null),
  /** The tracked pull request, once one was actually opened (D-099). At most
   *  one that is not closed per workstream; the detail carries the selected
   *  lane's. */
  pullRequest: PullRequestSchema.nullable().default(null),
  /** Where the selected lane's branch stands on the remote — the push half
   *  of publishing (D-099). */
  branchPush: BranchPushSchema.nullable().default(null),
  events: z.array(EventSchema),
  participants: z.array(ParticipantSchema),
  directions: z.array(DirectionSchema),
  executions: z.array(ExecutionSchema),
  control: ControlSnapshotSchema,
  checkpoints: z.array(CheckpointSchema),
  checks: z.array(VerificationCheckSchema),
  /** Every artifact this mission holds, newest last — metadata only, bounded;
   *  bytes are fetched through a temporary viewing grant on request (D-122). */
  artifacts: z.array(ArtifactSchema).default([]),
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
export const CreatedPullRequestSchema = z.object({ pullRequest: PullRequestSchema });
export const MergedResponseSchema = z.object({ sha: z.string().nullable() });

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
  z.object({
    state: z.literal("signed_in"),
    user: UserSchema,
    org: OrganizationSchema,
    /**
     * The signed-in person's own picture as a `data:` URI, resolved by the
     * main process *before* it says signed_in (D-105). It rides along here so
     * the first frame the shell paints already has the face: a picture that
     * arrives a beat after the initials is a flicker in the corner of the
     * window every single launch. Null means there is none to show.
     */
    avatar: z.string().nullable().default(null)
  }),
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
  workstreamId: z.string().startsWith("wst_").optional(),
  /** Which session to direct. Absent means the lane's first (D-083). */
  sessionId: z.string().startsWith("csn_").optional(),
  /** Creates a session from these words and directs it (D-083). */
  newSession: z.boolean().default(false),
  /** Run this chat's turn alongside the workspace's, read-only (D-095). */
  alongside: z.boolean().default(false),
  /** Images this direction carries (D-150), already uploaded. Bounded here as
   *  well as at the control plane: the bridge is a validation boundary in its
   *  own right, and a field it does not name is a field it silently drops. */
  attachmentIds: z
    .array(z.string().startsWith("art_"))
    .max(MAX_DIRECTION_ATTACHMENTS)
    .default([])
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
  system: {
    /** The build a person is running, for the settings About page (D-174). */
    version(): Promise<IpcResult<{ app: string; electron: string }>>;
  };
  /**
   * The face a person already has. Everyone in a mission signed in with
   * GitHub, so their picture is theirs and Novus stores none of it: the main
   * process fetches it by login and hands back a `data:` URI, which is why the
   * renderer's `img-src` stays `'self' data:` (D-105). Null means there is no
   * picture to show — offline, unknown login, anything — and the mark falls
   * back to initials.
   */
  people: {
    avatar(login: string): Promise<IpcResult<string | null>>;
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
    baseLocal(localId: string, ref?: string): Promise<IpcResult<BaseRevision>>;
    /** The repository's branches for the base picker (D-139): GitHub answers
     *  through the control plane, a local repository through this machine's
     *  own git. Default first, then by name. */
    branches(input: {
      provider: "github" | "local";
      providerRepoId: string;
    }): Promise<IpcResult<BranchInfo[]>>;
    /** Where a local mission's pinned base stands (D-139): this machine reads
     *  its own checkout; the control plane cannot see it. */
    baseStatusLocal(input: {
      localId: string;
      ref: string;
      sha: string;
    }): Promise<IpcResult<BaseStatus>>;
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
    /** Watches one mission for changes (D-149), replacing any mission this
     *  window was watching. The connection is the main process's; what crosses
     *  the bridge is the signal, never a credential. A room that cannot open
     *  one is not broken — `onChanged` simply stays quiet and the room's own
     *  slow re-read carries it. */
    watch(missionId: string): Promise<IpcResult<null>>;
    /** Stops watching. Called when the room closes; the main process also
     *  drops the connection on its own when the window goes. */
    unwatch(): Promise<IpcResult<null>>;
    /** Fires when the watched mission moves. The listener re-reads through
     *  `get`; the signal itself carries no room data. */
    onChanged(listener: (change: MissionChange) => void): () => void;
    /** Watches every mission this person participates in, on one connection
     *  (D-179) — the rail's live signal, replacing its timed sweep. Idempotent:
     *  a second call keeps the one connection. */
    watchAll(): Promise<IpcResult<null>>;
    unwatchAll(): Promise<IpcResult<null>>;
    /** Fires when any of this person's missions moves. The listener re-reads
     *  the one mission the address names; the signal carries no data. */
    onAnyChanged(listener: (change: MissionChange) => void): () => void;
    /** Opens this machine's file picker for an image, returning the chosen
     *  path or null (D-150). The path is the main process's to read; the
     *  renderer only hands it back to `attachImage`. */
    pickImage(): Promise<IpcResult<string | null>>;
    /** Prepares and uploads one file, returning the attachment a direction
     *  can then carry (D-150). Resizing, sniffing, conversion, hashing, the
     *  upload grant, and the store's verification all happen in the main
     *  process — the renderer never holds bytes, a digest, or a credential. */
    attachImage(input: {
      missionId: string;
      workstreamId?: string;
      sessionId?: string;
      path: string;
    }): Promise<IpcResult<PreparedAttachment>>;
    /** Attaches whatever image the system clipboard is holding (D-152), for
     *  paste. Answers `null` when the clipboard holds no image, which is not
     *  an error — most pastes are text and the composer takes those as words. */
    attachClipboardImage(input: {
      missionId: string;
      workstreamId?: string;
      sessionId?: string;
    }): Promise<IpcResult<PreparedAttachment | null>>;
    /** Uploads a rendered transcript of one of this lane's own conversations,
     *  for a new chat to continue from (D-173). The renderer projects the
     *  markdown — the one feed derivation is the one projection — and the
     *  main process bounds, hashes, and uploads it like any attachment; the
     *  row lands as kind `transcript`, labelled server-side from the source
     *  chat's own title. */
    attachTranscript(input: {
      missionId: string;
      workstreamId?: string;
      sourceSessionId: string;
      markdown: string;
    }): Promise<IpcResult<PreparedAttachment>>;
    /** The filesystem path behind a dropped `File` (D-152). Electron stopped
     *  putting it on the object itself, and the renderer may not resolve one
     *  on its own, so the bridge answers and the main process does the
     *  reading — the same division as the picker. */
    pathForDroppedFile(file: File): string | null;
    retryBranch(workstreamId: string): Promise<IpcResult<Workstream>>;
    /** Follows a moved base (D-144): this machine merges the base branch's
     *  tip into every lane's worktree — all lanes or none — and the control
     *  plane moves the pin. Refused in words while any lane's turn runs, and
     *  on conflict, with the conflicting lane and paths named. */
    syncBase(missionId: string): Promise<
      IpcResult<{ baseSha: string; lanes: { workstreamId: string; headSha: string }[] }>
    >;
    /** Submits attributed direction. Whether it runs now or queues for the
     *  controller is the server's decision, reflected in the returned state. */
    direct(input: {
      missionId: string;
      body: string;
      model: ModelId;
      effort: Effort;
      /** The lane this is for; absent means the mission's first (D-074). */
      workstreamId?: string;
      /** The session this is for; absent means the lane's first (D-083). */
      sessionId?: string;
      /** Creates a session from these words and directs it (D-083). */
      newSession?: boolean;
      /** Run this chat alongside the workspace's turn, read-only (D-095).
       *  Baton holder only; the server refuses anyone else in words. */
      alongside?: boolean;
      /** Images to hand the harness with these words (D-150), already
       *  uploaded through `attachImage`. */
      attachmentIds?: string[];
    }): Promise<
      IpcResult<{
        directionId: string;
        /** The session the direction actually landed in — the named one, the
         *  lane's first, or the one `newSession` just created. */
        sessionId: string;
        dispatched: boolean;
        deferred: string | null;
      }>
    >;
    resolveDirection(input: {
      directionId: string;
      action: "apply" | "reject" | "supersede";
      reason?: string;
    }): Promise<IpcResult<null>>;
    /** Declares or clears a chat's file scope (D-097). Baton holder only —
     *  a scope is standing write authority inside its patterns, and standing
     *  authority is the baton's to grant. Null clears it. */
    setSessionScope(input: {
      missionId: string;
      sessionId: string;
      scope: SessionScope | null;
    }): Promise<IpcResult<null>>;
    /** Sets a lane's permission profile (D-115). `policy.set` — Mission Admin
     *  or Operator, never the baton — with `dont_ask` refused in words for
     *  anyone but a Mission Admin; the server judges both, and the
     *  acknowledged sentence a person confirmed for a dangerous profile is
     *  recorded on the event. Applies from the next dispatched turn: a
     *  running turn keeps the profile it started under. */
    setPermissionProfile(input: {
      missionId: string;
      workstreamId: string;
      profile: PermissionProfile;
      /** The warning sentence the person confirmed, for profiles that warn —
       *  recorded verbatim on `policy.changed`, the D-100 acknowledgement
       *  pattern. Null for profiles that need none. */
      acknowledged?: string | null;
    }): Promise<IpcResult<null>>;
    /** Sets a lane's enabled project skills (D-118) — the whole set, each
     *  entry pinned to the digest the person was shown. `skills.set` —
     *  Mission Admin or Operator, never the baton. The server refuses an
     *  entry the published manifest does not carry at that exact digest:
     *  what is approved is what was reviewed. Applies from the next
     *  dispatched turn. */
    setEnabledSkills(input: {
      missionId: string;
      workstreamId: string;
      skills: EnabledSkill[];
    }): Promise<IpcResult<null>>;
    /** Sets a lane's enabled MCP servers (D-119) — the whole set, digest-
     *  pinned like skills. `mcp.set` — Mission Admin alone. */
    setEnabledMcpServers(input: {
      missionId: string;
      workstreamId: string;
      servers: EnabledMcpServer[];
    }): Promise<IpcResult<null>>;
    cancelDirection(directionId: string): Promise<IpcResult<null>>;
    /** Stops the named lane's running turn. The lane travels on the wire so a
     *  Stop pressed in an Alternative can never land on the mission's first
     *  lane (D-080, D-083); absent means the lane the mission started with.
     *  The session travels too (D-095): a lane can hold a write turn and a
     *  read-alongside turn at once, and the stop means the conversation on
     *  screen; absent means the lane's write turn. */
    stop(missionId: string, workstreamId?: string, sessionId?: string): Promise<IpcResult<null>>;
    /** Declares a wedged turn dead after its stop went unanswered (D-111).
     *  The server enforces the grace and the capability; this is a way to
     *  ask, never a grant (AGENTS.md rule 13). */
    forceInterrupt(missionId: string, workstreamId?: string, sessionId?: string): Promise<IpcResult<null>>;
    /**
     * Answers one harness approval (D-056). Asking is all this is: the server
     * checks `approval.respond` against the current lease, and a request that
     * has already been settled is refused rather than answered twice.
     */
    /** Files a mission away. Refused while its execution is running or an
     *  approval is waiting — an archived mission must not be one still doing
     *  something. Never deletes: no branch, no worktree, no history (D-063). */
    archive(missionId: string): Promise<IpcResult<null>>;
    /** Ends a mission's work (D-121): complete — result accepted, receipt
     *  snapshotted — or cancel. The server judges `mission.close`, the
     *  running/waiting refusals, and completion's own gates (a standing
     *  decision, no open pull request). */
    close(missionId: string, input: CloseMissionInput): Promise<IpcResult<null>>;
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
    /** Records a decision. Writes a record; publishes nothing. `artifactIds`
     *  names the visual evidence the decider chose (D-122). */
    decide(input: {
      missionId: string;
      workstreamId: string;
      rationale: string;
      acceptedRisks?: string;
      artifactIds?: string[];
    }): Promise<IpcResult<{ decisionId: string }>>;
    /** Asks for a revision instead, which withdraws the current decision. */
    requestRevision(input: {
      missionId: string;
      workstreamId: string;
      reason: string;
    }): Promise<IpcResult<null>>;
  };
  /**
   * Durable visual evidence (D-122, D-123). The renderer asks; the main
   * process is the capture authority — it captures only the embedded preview
   * it already validated, and the renderer supplies no URL, window, path,
   * or key. Viewing bytes rides the `novus-artifact:` protocol, which the
   * main process serves through freshly minted, expiring grants.
   */
  artifacts: {
    /** Captures a screenshot of the lane's live Preview. Refused in words
     *  when no valid preview is on screen. */
    capture(input: { missionId: string; workstreamId?: string }): Promise<IpcResult<Artifact>>;
    /** Starts recording the lane's live Preview (D-123). One recording at a
     *  time; it stops itself at the stated bound. */
    startRecording(input: { missionId: string; workstreamId?: string }): Promise<IpcResult<null>>;
    /** Stops the recording and preserves it as evidence. */
    stopRecording(): Promise<IpcResult<Artifact>>;
    /** Abandons the recording: no artifact, nothing durable, temp removed. */
    cancelRecording(): Promise<IpcResult<null>>;
    /** The machine-local recording state, for the preview head's words. */
    recordingStatus(): Promise<IpcResult<RecordingStatus | null>>;
    onRecording(listener: (status: RecordingStatus | null) => void): () => void;
    /** Attaches an artifact beside a check or the tracked pull request. */
    attach(input: {
      artifactId: string;
      target: { kind: "check" | "pull_request"; id: string };
    }): Promise<IpcResult<null>>;
    detach(input: {
      artifactId: string;
      target: { kind: "check" | "pull_request"; id: string };
    }): Promise<IpcResult<null>>;
    /** Opens the artifact's bytes with the machine's own default app (D-165):
     *  fetched to the app's swept temp corner and handed to `shell.openPath`
     *  under a viewer-only allowlist — refused in words for anything else. */
    openLocal(artifactId: string): Promise<IpcResult<null>>;
    /** Reveals the same fetched file in the OS file manager (D-165). */
    revealLocal(artifactId: string): Promise<IpcResult<null>>;
  };
  /**
   * Publishing a decision as a pull request, and stewarding it (D-099).
   * Every verb is a server request gated on `pr.manage`; there is no merge
   * verb here, on the server, or in the runner vocabulary — merging happens
   * on GitHub, by humans, and Novus tracks it.
   */
  pulls: {
    /** Pushes the mission branch to the host, up to the decided checkpoint —
     *  the remote-head guarantee (D-099). Enqueued to the runner holding the
     *  worktree; progress is read from the mission detail's branchPush. */
    push(input: { missionId: string; workstreamId?: string }): Promise<IpcResult<null>>;
    /** Opens the draft pull request from the current decision. Refused in
     *  words until the remote head equals the decided checkpoint. */
    create(input: {
      missionId: string;
      workstreamId?: string;
    }): Promise<IpcResult<{ pullRequest: PullRequest }>>;
    requestReview(input: { pullRequestId: string; reviewers: string[] }): Promise<IpcResult<null>>;
    /** Marks the draft ready for review. A person's act, like every other. */
    markReady(pullRequestId: string): Promise<IpcResult<null>>;
    /**
     * Completion (D-100): explicit human acts GitHub performs underneath,
     * each gated on pr.manage and event-recorded with what was accepted.
     * A merge with non-host blockers outstanding is refused with them named
     * unless `acknowledgeBlockers` is true; a merge the host itself cannot
     * perform is refused outright. Nothing here is ever automatic.
     */
    merge(input: MergeInput): Promise<IpcResult<{ sha: string | null }>>;
    /** Brings the branch up to date with its base, host-side. */
    updateBranch(pullRequestId: string): Promise<IpcResult<null>>;
    /** Closes without merging. */
    close(pullRequestId: string): Promise<IpcResult<null>>;
    /** Deletes the remote branch — offered only after merge or close, and
     *  only ever on this explicit ask (D-100). */
    deleteBranch(pullRequestId: string): Promise<IpcResult<null>>;
    /** The request's own commits and changed files with bounded patches,
     *  fetched on demand for the in-house diff. */
    files(pullRequestId: string): Promise<IpcResult<PullFilesResponse>>;
    /** An inline or conversation comment, authored by the App and attributed
     *  in the body as "{login} via Novus" until user-token identity exists. */
    comment(input: PullCommentInput): Promise<IpcResult<null>>;
    /** Resolves one review thread on the host. */
    resolveThread(input: { pullRequestId: string; threadId: string }): Promise<IpcResult<null>>;
    /** Title, description, labels — host-patched, event-recorded. */
    setMetadata(input: PullMetadataInput): Promise<IpcResult<null>>;
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
     * The embedded preview surface (D-098). Local, like the terminal: the
     * page it shows is served by a process on this machine, so there is no
     * control-plane route and nothing for a remote participant to reach. The
     * main process validates the address against the workstream's own live
     * processes, owns the view, and confines its navigation to the approved
     * origin; the renderer only reserves the rectangle and reads the status.
     */
    preview: {
      /** Shows the embedded view for an address a live run process of this
       *  workstream reported. Reopening with the same address reuses the
       *  existing view and its state; it never restarts anything. */
      open(input: {
        missionId: string;
        workstreamId?: string;
        url: string;
      }): Promise<IpcResult<PreviewStatus>>;
      /** Reloads the page. The process is not touched. */
      reload(): Promise<IpcResult<null>>;
      /** Discards the view. The process is never stopped by this. */
      close(): Promise<IpcResult<null>>;
      /** The current embedded preview, if one exists. */
      status(): Promise<IpcResult<PreviewStatus | null>>;
      onStatus(listener: (status: PreviewStatus | null) => void): () => void;
    };
    /**
     * The workspace's own files (D-048). Local, like the terminal: the worktree
     * is on this machine, every path is resolved against it and refused if it
     * leaves, and what comes back is shown rather than reported.
     */
    /** What this machine can open a checkout in (D-159) — Finder and Copy
     *  path always, plus whichever editors and terminals are installed. Empty
     *  off macOS, where nothing is wired yet. */
    openTargets(): Promise<IpcResult<OpenTargetOption[]>>;
    /** Opens one lane's checkout in one of them, or copies its path. The
     *  renderer names the lane; the path is the main process's to resolve, so
     *  no window can name a directory of its own. */
    openWorkspaceIn(input: OpenWorkspaceInput): Promise<IpcResult<null>>;
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
