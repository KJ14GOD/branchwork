import {
  BranchInfoSchema,
  ApiErrorSchema,
  ArtifactSchema,
  ArtifactViewResponseSchema,
  AuthClaimResponseSchema,
  AuthStartResponseSchema,
  AvailableRepositoriesResponseSchema,
  BaseRevisionSchema,
  BeginArtifactResponseSchema,
  CreateMissionResponseSchema,
  ExtensionLabelSchema,
  CreatedApproachSchema,
  CreatedInvitationSchema,
  FileDiffResponseSchema,
  InvitationListResponseSchema,
  MeResponseSchema,
  BeginAttachmentResponseSchema,
  MissionChangeSchema,
  MissionDetailResponseSchema,
  MissionListResponseSchema,
  OkResponseSchema,
  CreatedPullRequestSchema,
  MergedResponseSchema,
  PullFilesResponseSchema,
  RecordedDecisionSchema,
  RedeemInvitationResponseSchema,
  RegisterRunnerResponseSchema,
  RetryBranchResponseSchema,
  SubmitDirectionResponseSchema,
  type ApprovalDecision,
  type Artifact,
  type ArtifactViewResponse,
  type AuthClaimResponse,
  type AuthStartResponse,
  type BeginArtifactResponse,
  type BeginAttachmentResponse,
  type AvailableRepository,
  type BaseRevision,
  type CreateMissionInput,
  type Effort,
  type Invitation,
  type MeResponse,
  type Mission,
  type DirectionContextRef,
  type MissionChange,
  type MissionDetailResponse,
  type MergeMethod,
  type MissionRole,
  type ModelId,
  type RegisterRunnerResponse,
  SyncBaseResponseSchema,
  type SyncBaseRequest,
  type SyncBaseResponse,
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

  // Generic over the *schema*, not over its output type. `z.ZodType<T>` fixes
  // input and output to the same shape, so any contract carrying a `.default()`
  // — where the parsed value is narrower than the accepted one — resolved to two
  // incompatible copies of the same named type at the call site.
  private async request<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
    opts: { auth?: boolean } = { auth: true }
  ): Promise<z.infer<S>> {
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

  async listMissions(filter?: "active" | "archived"): Promise<Mission[]> {
    const body = await this.request(
      "GET",
      filter === "archived" ? "/missions?filter=archived" : "/missions",
      MissionListResponseSchema
    );
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

  listBranches(providerRepoId: string): Promise<{ branches: import("@novus/contracts").BranchInfo[] }> {
    return this.request(
      "GET",
      `/repositories/available/${encodeURIComponent(providerRepoId)}/branches`,
      z.object({ branches: z.array(BranchInfoSchema) })
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

  /**
   * Watches one mission's live stream (D-149) until the returned function is
   * called. `onChange` fires per signal; `onLive` fires when the server has
   * confirmed the connection, so a room can say it is live rather than assume.
   *
   * A dropped connection re-dials with backoff and says so through `onLive`.
   * Nothing here is load-bearing for correctness: every signal only ever means
   * *re-read*, so a stream that is down costs latency, never truth — which is
   * why the room keeps a slow re-read of its own underneath this.
   */
  watchMission(
    missionId: string,
    handlers: { onChange: (change: MissionChange) => void; onLive?: (live: boolean) => void }
  ): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let attempts = 0;
    let retryTimer: NodeJS.Timeout | null = null;

    const scheduleRetry = (): void => {
      if (stopped || retryTimer) return;
      attempts += 1;
      const delay = Math.min(500 * 2 ** (attempts - 1), 15_000);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      controller = new AbortController();
      let response: Response;
      try {
        response = await fetch(
          `${this.baseUrl}/missions/${encodeURIComponent(missionId)}/stream`,
          {
            headers: {
              accept: "text/event-stream",
              ...(this.getToken() ? { authorization: `Bearer ${this.getToken()}` } : {})
            },
            signal: controller.signal
          }
        );
      } catch {
        handlers.onLive?.(false);
        scheduleRetry();
        return;
      }
      if (!response.ok || !response.body) {
        handlers.onLive?.(false);
        // A refusal is not a transport failure: 401 and 404 mean this window
        // may not watch this mission, and re-dialing would only repeat the
        // refusal. The room's own re-read still governs what it shows.
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          stopped = true;
          return;
        }
        scheduleRetry();
        return;
      }
      attempts = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (frame.startsWith("event: ready")) handlers.onLive?.(true);
            if (frame.startsWith("event: change")) {
              const index = frame.indexOf("data: ");
              if (index !== -1) {
                const parsed = MissionChangeSchema.safeParse(
                  JSON.parse(frame.slice(index + 6)) as unknown
                );
                if (parsed.success) handlers.onChange(parsed.data);
              }
            }
            split = buffer.indexOf("\n\n");
          }
          // A frame larger than any address could be is a wire nobody should
          // keep reading from.
          if (buffer.length > 64 * 1024) buffer = "";
        }
      } catch {
        // Abort at teardown, or the connection died. Both land here.
      }
      handlers.onLive?.(false);
      scheduleRetry();
    };

    void run();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      controller?.abort();
    };
  }

  /**
   * Watches every mission this person participates in, on one connection
   * (D-179) — the rail's live signal, replacing its five-second sweep. Same
   * contract as `watchMission`: a signal only ever means *re-read*, so a
   * stream that is down costs latency, never truth, and a slow re-read
   * underneath still carries it.
   */
  watchAllMissions(
    handlers: { onChange: (change: MissionChange) => void; onLive?: (live: boolean) => void }
  ): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let attempts = 0;
    let retryTimer: NodeJS.Timeout | null = null;

    const scheduleRetry = (): void => {
      if (stopped || retryTimer) return;
      attempts += 1;
      const delay = Math.min(500 * 2 ** (attempts - 1), 15_000);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      controller = new AbortController();
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/streams/missions`, {
          headers: {
            accept: "text/event-stream",
            ...(this.getToken() ? { authorization: `Bearer ${this.getToken()}` } : {})
          },
          signal: controller.signal
        });
      } catch {
        handlers.onLive?.(false);
        scheduleRetry();
        return;
      }
      if (!response.ok || !response.body) {
        handlers.onLive?.(false);
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          stopped = true;
          return;
        }
        scheduleRetry();
        return;
      }
      attempts = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (frame.startsWith("event: ready")) handlers.onLive?.(true);
            if (frame.startsWith("event: change")) {
              const index = frame.indexOf("data: ");
              if (index !== -1) {
                const parsed = MissionChangeSchema.safeParse(
                  JSON.parse(frame.slice(index + 6)) as unknown
                );
                if (parsed.success) handlers.onChange(parsed.data);
              }
            }
            split = buffer.indexOf("\n\n");
          }
          if (buffer.length > 64 * 1024) buffer = "";
        }
      } catch {
        // Abort at teardown, or the connection died. Both land here.
      }
      handlers.onLive?.(false);
      scheduleRetry();
    };

    void run();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      controller?.abort();
    };
  }

  getMission(missionId: string, workstreamId?: string): Promise<MissionDetailResponse> {
    const query = workstreamId ? `?workstream=${encodeURIComponent(workstreamId)}` : "";
    return this.request(
      "GET",
      `/missions/${encodeURIComponent(missionId)}${query}`,
      MissionDetailResponseSchema
    );
  }

  // --- Direction ------------------------------------------------------------

  submitDirection(
    missionId: string,
    input: {
      body: string;
      model: ModelId;
      effort: Effort;
      workstreamId?: string;
      sessionId?: string;
      newSession?: boolean;
      alongside?: boolean;
      /** Images this direction carries (D-150), already uploaded. */
      attachmentIds?: string[];
      /** Pinned references — files and checks (D-182). */
      context?: DirectionContextRef[];
    }
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

  async setSessionScope(
    missionId: string,
    sessionId: string,
    scope: string[] | null
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/sessions/${encodeURIComponent(sessionId)}/scope`,
      OkResponseSchema,
      { scope }
    );
  }

  async setPermissionProfile(
    missionId: string,
    workstreamId: string,
    profile: string,
    acknowledged: string | null
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/policy`,
      OkResponseSchema,
      { profile, acknowledged }
    );
  }

  async setEnabledSkills(
    missionId: string,
    workstreamId: string,
    skills: { name: string; digest: string }[]
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/skills`,
      OkResponseSchema,
      { skills }
    );
  }

  async setEnabledSlashCommands(
    missionId: string,
    workstreamId: string,
    commands: { name: string; digest: string }[]
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/commands`,
      OkResponseSchema,
      { commands }
    );
  }

  async setEnabledGlobalSkills(
    missionId: string,
    workstreamId: string,
    skills: { name: string; digest: string }[]
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/global-skills`,
      OkResponseSchema,
      { skills }
    );
  }

  async setEnabledMachineMcpServers(
    missionId: string,
    workstreamId: string,
    servers: { name: string; digest: string }[],
    acknowledged: string
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/machine-mcp`,
      OkResponseSchema,
      { servers, acknowledged }
    );
  }

  async createExtensionLabel(
    missionId: string,
    input: { name: string; color: string }
  ): Promise<import("@novus/contracts").ExtensionLabel> {
    const body = await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/extension-labels`,
      z.object({ label: ExtensionLabelSchema }),
      input
    );
    return body.label;
  }

  async updateExtensionLabel(
    missionId: string,
    labelId: string,
    input: { name?: string; color?: string }
  ): Promise<import("@novus/contracts").ExtensionLabel> {
    const body = await this.request(
      "PATCH",
      `/missions/${encodeURIComponent(missionId)}/extension-labels/${encodeURIComponent(labelId)}`,
      z.object({ label: ExtensionLabelSchema }),
      input
    );
    return body.label;
  }

  async deleteExtensionLabel(missionId: string, labelId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/missions/${encodeURIComponent(missionId)}/extension-labels/${encodeURIComponent(labelId)}`,
      OkResponseSchema
    );
  }

  async setExtensionLabels(
    missionId: string,
    input: { source: string; name: string; labelIds: string[] }
  ): Promise<void> {
    await this.request(
      "PUT",
      `/missions/${encodeURIComponent(missionId)}/extension-labels/assignments`,
      OkResponseSchema,
      input
    );
  }

  async closeMission(
    missionId: string,
    input: { outcome: "completed" | "cancelled"; reason?: string }
  ): Promise<void> {
    await this.request("POST", `/missions/${encodeURIComponent(missionId)}/close`, OkResponseSchema, input);
  }

  async setEnabledMcpServers(
    missionId: string,
    workstreamId: string,
    servers: { name: string; digest: string }[]
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workstreams/${encodeURIComponent(workstreamId)}/mcp`,
      OkResponseSchema,
      { servers }
    );
  }

  async stopExecution(missionId: string, workstreamId?: string, sessionId?: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/execution/stop`,
      OkResponseSchema,
      {
        ...(workstreamId ? { workstreamId } : {}),
        ...(sessionId ? { sessionId } : {})
      }
    );
  }

  /** Declare a wedged turn dead after its stop went unanswered (D-111). The
   *  server refuses it in words while the ordinary stop still has a claim. */
  async forceInterrupt(missionId: string, workstreamId?: string, sessionId?: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/execution/force-interrupt`,
      OkResponseSchema,
      {
        ...(workstreamId ? { workstreamId } : {}),
        ...(sessionId ? { sessionId } : {})
      }
    );
  }

  // --- Harness approvals (D-056) --------------------------------------------
  // Asking, never deciding: the server checks `approval.respond` against the
  // current lease and refuses a request that is already settled.

  async archiveMission(missionId: string): Promise<void> {
    await this.request("POST", `/missions/${encodeURIComponent(missionId)}/archive`, OkResponseSchema, {});
  }

  async restoreMission(missionId: string): Promise<void> {
    await this.request("POST", `/missions/${encodeURIComponent(missionId)}/restore`, OkResponseSchema, {});
  }

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

  // --- Approaches and the decision between them (D-074, D-075) --------------

  async createApproach(
    missionId: string,
    input: { fromWorkstreamId: string; intent: string; name?: string; expectedOriginSha?: string }
  ): Promise<Workstream> {
    const body = await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/approaches`,
      CreatedApproachSchema,
      input
    );
    return body.workstream;
  }

  async recordDecision(
    missionId: string,
    input: { workstreamId: string; rationale: string; acceptedRisks?: string; artifactIds?: string[] }
  ): Promise<string> {
    const body = await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/decision`,
      RecordedDecisionSchema,
      input
    );
    return body.decisionId;
  }

  // --- Images attached to a direction (D-150) --------------------------------

  /** Begins one attachment: the promise in, the row and its upload grant out.
   *  The bytes travel to the store directly, never through this client. */
  beginAttachment(missionId: string, input: unknown): Promise<BeginAttachmentResponse> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/attachments`,
      BeginAttachmentResponseSchema,
      input
    );
  }

  // --- Durable visual evidence (D-122) --------------------------------------

  beginArtifact(missionId: string, input: unknown): Promise<BeginArtifactResponse> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/artifacts`,
      BeginArtifactResponseSchema,
      input
    );
  }

  async completeArtifact(
    artifactId: string,
    outcome: "uploaded" | "failed",
    failureReason?: string
  ): Promise<Artifact> {
    const body = await this.request(
      "POST",
      `/artifacts/${encodeURIComponent(artifactId)}/complete`,
      z.object({ artifact: ArtifactSchema }),
      { outcome, ...(failureReason ? { failureReason } : {}) }
    );
    return body.artifact;
  }

  /** A fresh temporary viewing grant (D-022). Never cached past its expiry
   *  and never handed to the renderer — the artifact protocol spends it. */
  viewArtifact(artifactId: string): Promise<ArtifactViewResponse> {
    return this.request(
      "POST",
      `/artifacts/${encodeURIComponent(artifactId)}/view`,
      ArtifactViewResponseSchema,
      {}
    );
  }

  async attachArtifact(
    artifactId: string,
    target: { kind: "check" | "pull_request"; id: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/artifacts/${encodeURIComponent(artifactId)}/attach`,
      OkResponseSchema,
      { target }
    );
  }

  async detachArtifact(
    artifactId: string,
    target: { kind: "check" | "pull_request"; id: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/artifacts/${encodeURIComponent(artifactId)}/detach`,
      OkResponseSchema,
      { target }
    );
  }

  async requestRevision(
    missionId: string,
    input: { workstreamId: string; reason: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/revision`,
      OkResponseSchema,
      input
    );
  }

  // --- Publishing a decision (D-099) ----------------------------------------

  /** Records a completed base sync (D-144): the merges already happened in
   *  the worktrees; this moves every lane's pin, or refuses in words. */
  async syncBase(missionId: string, body: SyncBaseRequest): Promise<SyncBaseResponse> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/base-sync`,
      SyncBaseResponseSchema,
      body
    );
  }

  async pushBranch(missionId: string, workstreamId?: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/pull-request/push`,
      OkResponseSchema,
      workstreamId ? { workstreamId } : {}
    );
  }

  async createPullRequest(
    missionId: string,
    workstreamId?: string
  ): Promise<z.infer<typeof CreatedPullRequestSchema>> {
    return this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/pull-request`,
      CreatedPullRequestSchema,
      workstreamId ? { workstreamId } : {}
    );
  }

  async requestReview(pullRequestId: string, reviewers: string[]): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/request-review`,
      OkResponseSchema,
      { reviewers }
    );
  }

  async markPullRequestReady(pullRequestId: string): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/ready`,
      OkResponseSchema
    );
  }

  async mergePullRequest(
    pullRequestId: string,
    input: { method: MergeMethod; acknowledgeBlockers: boolean }
  ): Promise<{ sha: string | null }> {
    return this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/merge`,
      MergedResponseSchema,
      input
    );
  }

  async updatePullBranch(pullRequestId: string): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/update-branch`,
      OkResponseSchema
    );
  }

  async closePullRequest(pullRequestId: string): Promise<void> {
    await this.request("POST", `/pull-requests/${encodeURIComponent(pullRequestId)}/close`, OkResponseSchema);
  }

  async deletePullBranch(pullRequestId: string): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/delete-branch`,
      OkResponseSchema
    );
  }

  pullFiles(pullRequestId: string): Promise<z.infer<typeof PullFilesResponseSchema>> {
    return this.request(
      "GET",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/files`,
      PullFilesResponseSchema
    );
  }

  async pullComment(
    pullRequestId: string,
    input: { body: string; path?: string; line?: number }
  ): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/comment`,
      OkResponseSchema,
      input
    );
  }

  async resolvePullThread(pullRequestId: string, threadId: string): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/resolve-thread`,
      OkResponseSchema,
      { threadId }
    );
  }

  async setPullMetadata(
    pullRequestId: string,
    input: { title?: string; body?: string; labels?: string[] }
  ): Promise<void> {
    await this.request(
      "POST",
      `/pull-requests/${encodeURIComponent(pullRequestId)}/metadata`,
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
  releaseControl(missionId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/release`);
  }
  revokeControl(missionId: string): Promise<void> {
    return this.controlPost(`/missions/${encodeURIComponent(missionId)}/control/revoke`);
  }

  // --- Workspace commands ---------------------------------------------------
  // Remotely invokable, so the server authorizes them (D-042). The desktop
  // only asks; it never decides.

  async workspaceCommand(
    missionId: string,
    input: { kind: "setup" | "run" | "verification"; name?: string; workstreamId?: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workspace/command`,
      OkResponseSchema,
      input
    );
  }

  async workspaceStop(missionId: string, name: string, workstreamId?: string): Promise<void> {
    await this.request(
      "POST",
      `/missions/${encodeURIComponent(missionId)}/workspace/stop`,
      OkResponseSchema,
      workstreamId ? { name, workstreamId } : { name }
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
