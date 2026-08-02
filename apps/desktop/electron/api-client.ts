import {
  ApiErrorSchema,
  AuthClaimResponseSchema,
  AuthStartResponseSchema,
  MeResponseSchema,
  MissionDetailResponseSchema,
  MissionListResponseSchema,
  MissionSchema,
  type AuthClaimResponse,
  type AuthStartResponse,
  type CreateMissionInput,
  type MeResponse,
  type Mission,
  type MissionDetailResponse
} from "@novus/contracts";
import { z } from "zod";

/** Typed control-plane client. Runs only in the main process. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null
  ) {}

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    opts: { auth?: boolean } = { auth: true }
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(opts.auth !== false && this.getToken() ? { authorization: `Bearer ${this.getToken()}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError("offline", "Can't reach Novus.", 0);
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status);
      throw new ApiError("server_error", `Unexpected response (${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError("bad_response", "The server answered in an unexpected shape.", response.status);
    return parsed.data;
  }

  startAuth(): Promise<AuthStartResponse> {
    return this.request("POST", "/auth/github/start", AuthStartResponseSchema, undefined, { auth: false });
  }

  /** Returns null while the browser leg is still pending. */
  async claimAuth(state: string): Promise<AuthClaimResponse | null> {
    const PendingSchema = z.object({ pending: z.literal(true) });
    const result = await this.request(
      "POST",
      "/auth/github/claim",
      z.union([AuthClaimResponseSchema, PendingSchema]),
      { state },
      { auth: false }
    );
    return "pending" in result ? null : result;
  }

  me(): Promise<MeResponse> {
    return this.request("GET", "/me", MeResponseSchema);
  }

  signOut(): Promise<{ ok: boolean }> {
    return this.request("POST", "/auth/signout", z.object({ ok: z.boolean() }));
  }

  async listMissions(): Promise<Mission[]> {
    const body = await this.request("GET", "/missions", MissionListResponseSchema);
    return body.missions;
  }

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const body = await this.request("POST", "/missions", z.object({ mission: MissionSchema }), input);
    return body.mission;
  }

  getMission(missionId: string): Promise<MissionDetailResponse> {
    return this.request("GET", `/missions/${missionId}`, MissionDetailResponseSchema);
  }
}
