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

export const MissionStateSchema = z.enum(["new_mission"]);
// The full canonical vocabulary is PRODUCT.md's mission state model; this slice
// only ever produces "new_mission" and the schema widens as states become real.

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
    id: z.string().min(1)
  }),
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
export const MissionDetailResponseSchema = z.object({
  mission: MissionSchema,
  /** Null only for missions created before repository connection existed. */
  workstream: WorkstreamSchema.nullable(),
  events: z.array(EventSchema)
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

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() })
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// --- Desktop IPC boundary (renderer <-> main) ------------------------------
// The renderer never sees session credentials; these are the only shapes that
// cross the context bridge. Every handler validates its input with these.

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

export const IpcResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), code: z.string(), message: z.string() })
  ]);

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };
