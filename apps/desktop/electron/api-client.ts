import {
  ApiErrorSchema,
  AuthClaimResponseSchema,
  AuthStartResponseSchema,
  AvailableRepositoriesResponseSchema,
  BaseRevisionSchema,
  CreateMissionResponseSchema,
  CreatedInvitationSchema,
  FileDiffResponseSchema,
  InvitationListResponseSchema,
  MeResponseSchema,
  MissionDetailResponseSchema,
  MissionListResponseSchema,
  OkResponseSchema,
  RedeemInvitationResponseSchema,
  RegisterRunnerResponseSchema,
  RetryBranchResponseSchema,
  SubmitDirectionResponseSchema,
  type ApprovalDecision,
  type AuthClaimResponse,
  type AuthStartResponse,
  type AvailableRepository,
  type BaseRevision,
  type CreateMissionInput,
  type Effort,
  type Invitation,
  type MeResponse,
  type Mission,
  type MissionDetailResponse,
  type MissionRole,
  type ModelId,
  type RegisterRunnerResponse,
  type Workstream
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

  startAuth(as?: string): Promise<AuthStartResponse> {
    return this.request("POST", "/auth/github/start", AuthStartResponseSchema, as ? { as } : {}, {
      auth: false
    });
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

  async availableRepositories(): Promise<AvailableRepository[]> {
    const body = await this.request("GET", "/repositories/available", AvailableRepositoriesResponseSchema);
    return body.repositories;
  }

  baseRevision(providerRepoId: string, ref?: string): Promise<BaseRevision> {
    const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
    return this.request(
      "GET",
      `/repositories/available/${encodeURIComponent(providerRepoId)}/base${query}`,
      BaseRevisionSchema
    );
  }

  createMission(input: CreateMissionInput): Promise<{ mission: Mission; workstream: Workstream }> {
    return this.request("POST", "/missions", CreateMissionResponseSchema, input);
  }

  async registerLocalRepo(input: {
    localId: string;
    name: string;
    defaultBranch: string;
    headSha: string;
  }): Promise<unknown> {
    return this.request("POST", "/repositories/local", z.object({}).passthrough(), input);
  }

  async localRepositories(): Promise<unknown[]> {
    const body = await this.request(
      "GET",
      "/repositories/local",
      z.object({ repositories: z.array(z.unknown()) })
    );
    return body.repositories;
  }

  async reportBranch(
    workstreamId: string,
    report: { status: "created" | "failed"; error?: string | null }
  ): Promise<Workstream> {
    const body = await this.request(
      "POST",
      `/workstreams/${encodeURIComponent(workstreamId)}/branch/report`,
      RetryBranchResponseSchema,
      report
    );
    return body.workstream;
  }

  async retryBranch(workstreamId: string): Promise<Workstream> {
    const body = await this.request(
      "POST",
      `/workstreams/${encodeURIComponent(workstreamId)}/branch/retry`,
      RetryBranchResponseSchema
    );
    return body.workstream;
  }

  getMission(missionId: string): Promise<MissionDetailResponse> {
    return this.request("GET", `/missions/${encodeURIComponent(missionId)}`, MissionDetailResponseSchema);
  }

  // --- Direction ------------------------------------------------------------

  submitDirection(
    missionId: string,
    input: { body: string; model: ModelId; effort: Effort }
  ): Promise<z.infer<typeof SubmitDirectionResponseSchema>> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/direction`,
      SubmitDirectionResponseSchema,
      input
    );
  }

  async resolveDirection(
    directionId: string,
    input: { action: "apply" | "reject" | "supersede"; reason?: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/directions/${encodeURIComponent(directionId)}/resolve`,
      OkResponseSchema,
      input
    );
  }

  async cancelDirection(directionId: string): Promise<void> {
    await this.request("POST", `/directions/${encodeURIComponent(directionId)}/cancel`, OkResponseSchema, {});
  }

  async stopExecution(missionId: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/execution/stop`,
      OkResponseSchema,
      {}
    );
  }

  // --- Harness approvals (D-056) --------------------------------------------
  // Asking, never deciding: the server checks `approval.respond` against the
  // current lease and refuses a request that is already settled.

  async respondApproval(
    approvalId: string,
    input: { decision: ApprovalDecision; reason?: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/approvals/${encodeURIComponent(approvalId)}/respond`,
      OkResponseSchema,
      input
    );
  }

  // --- Evidence -------------------------------------------------------------

  fileDiff(changeId: string): Promise<z.infer<typeof FileDiffResponseSchema>> {
    return this.request("GET", `/file-changes/${encodeURIComponent(changeId)}`, FileDiffResponseSchema);
  }

  // --- Invitations ----------------------------------------------------------

  createInvitation(
    missionId: string,
    role: MissionRole
  ): Promise<z.infer<typeof CreatedInvitationSchema>> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/invitations`,
      CreatedInvitationSchema,
      { role }
    );
  }

  async listInvitations(missionId: string): Promise<Invitation[]> {
    const body = await this.request(
      "GET",
      `/missions/${encodeURIComponent(missionId)}/invitations`,
      InvitationListResponseSchema
    );
    return body.invitations;
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    await this.request(
      "POST",
      `/invitations/${encodeURIComponent(invitationId)}/revoke`,
      OkResponseSchema,
      {}
    );
  }

  redeemInvitation(token: string): Promise<z.infer<typeof RedeemInvitationResponseSchema>> {
    return this.request("POST", "/invitations/redeem", RedeemInvitationResponseSchema, { token });
  }

  // --- Control --------------------------------------------------------------

  private async controlPost(path: string, body: unknown = {}): Promise<void> {
    await this.request("POST", path, OkResponseSchema, body);
  }

  requestControl(missionId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/request`);
  }
  withdrawControlRequest(missionId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/request/withdraw`);
  }
  declineControlRequest(requestId: string): Promise<void> {
    return this.controlPost(`/control/requests/${encodeURIComponent(requestId)}/decline`);
  }
  offerControl(missionId: string, toUserId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/offer`, { toUserId });
  }
  withdrawOffer(offerId: string): Promise<void> {
    return this.controlPost(`/control/offers/${encodeURIComponent(offerId)}/withdraw`);
  }
  acceptOffer(offerId: string): Promise<void> {
    return this.controlPost(`/control/offers/${encodeURIComponent(offerId)}/accept`);
  }
  declineOffer(offerId: string): Promise<void> {
    return this.controlPost(`/control/offers/${encodeURIComponent(offerId)}/decline`);
  }
  revokeControl(missionId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/revoke`);
  }

  // --- Workspace commands ---------------------------------------------------
  // Remotely invokable, so the server authorizes them (D-042). The desktop
  // only asks; it never decides.

  async workspaceCommand(
    missionId: string,
    input: { kind: "setup" | "run" | "verification"; name?: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workspace/command`,
      OkResponseSchema,
      input
    );
  }

  async workspaceStop(missionId: string, name: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workspace/stop`,
      OkResponseSchema,
      { name }
    );
  }

  // --- Runner registration --------------------------------------------------

  /** Issues this machine's runner credential. Called from the main process
   *  only; the credential never crosses the IPC bridge. */
  registerRunner(workstreamId: string, label: string): Promise<RegisterRunnerResponse> {
    return this.request(
      "POST",
      `/workstreams/${encodeURIComponent(workstreamId)}/runner`,
      RegisterRunnerResponseSchema,
      { workstreamId, label }
    );
  }
}
