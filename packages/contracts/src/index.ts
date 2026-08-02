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

export const MissionSchema = z.object({
  missionId: z.string().startsWith("msn_"),
  orgId: z.string().startsWith("org_"),
  goal: z.string().min(1).max(500),
  successCriteria: z.string().min(1).max(5000),
  primaryState: MissionStateSchema,
  createdBy: z.string().startsWith("usr_"),
  createdByLogin: z.string().min(1),
  createdAt: z.string().datetime()
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
  successCriteria: z.string().trim().min(1, "State what success looks like").max(5000)
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
  events: z.array(EventSchema)
});
export type MissionDetailResponse = z.infer<typeof MissionDetailResponseSchema>;

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

export const IpcResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), code: z.string(), message: z.string() })
  ]);

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };
