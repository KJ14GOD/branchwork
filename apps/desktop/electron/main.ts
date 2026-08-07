import { BrowserWindow, app, ipcMain, shell } from "electron";
import { join } from "node:path";
import {
  APPROACH_INTENT_MAX,
  CreateMissionInputSchema,
  DirectionResolutionSchema,
  ForgetSecretInputSchema,
  IpcDirectInputSchema,
  ListWorkspaceFilesInputSchema,
  MAX_ACCEPTED_RISKS,
  MAX_RATIONALE,
  MissionRoleSchema,
  OpenPreviewInputSchema,
  OpenTerminalInputSchema,
  PrepareLocalFilesInputSchema,
  ReadWorkspaceFileInputSchema,
  RespondApprovalInputSchema,
  SaveWorkspaceSettingsInputSchema,
  SupplySecretInputSchema,
  TerminalRenameInputSchema,
  TerminalResizeInputSchema,
  TerminalWriteInputSchema,
  WorkspaceCommandInputSchema,
  WriteWorkspaceFileInputSchema,
  type IpcAuthStatus,
  type IpcResult
} from "@novus/contracts";
import { z } from "zod";
import { ApiError, ControlPlaneClient } from "./api-client";
import { TOKEN_BG } from "./design-tokens";
import { probeHarnesses } from "./harness-probe";
import {
  ensureLocalBranch,
  pathForLocalRepo,
  pickLocalRepository,
  repositoriesOnThisMachine,
  resolveLocalBase
} from "./local-repos";
import { startRunnerAgent, type RunnerAgent } from "./runner-agent";
import { consentedFilePaths, recordFileConsents } from "./workspace-consents";
import {
  closeTerminal,
  forgetSecret,
  inspectWorkspace,
  listFiles,
  listTerminals,
  onProcessLog,
  onTerminalOutput,
  openPreview,
  openTerminal,
  prepareLocalFiles,
  processLogsFor,
  readFile,
  renameTerminal,
  repositoryLabel,
  resizeTerminal,
  saveWorkspaceSettings,
  secretsFor,
  shutdownTerminals,
  supplySecret,
  terminalScrollback,
  writeFile,
  writeTerminal,
  type WorkspaceTarget
} from "./workspace";
import { SessionStore } from "./session-store";

// Test hooks (see DECISIONS.md D-027): both refuse to exist in packaged builds.
const AUTO_VISIT = process.env.NOVUS_AUTH_AUTOVISIT === "1" && !app.isPackaged;
/** Test-only: which deterministic fake identity this client signs in as, so an
 *  end-to-end run can be two different people on two desktops. */
const FAKE_IDENTITY = !app.isPackaged ? process.env.NOVUS_FAKE_IDENTITY : undefined;
if (process.env.NOVUS_USER_DATA_DIR && !app.isPackaged) {
  app.setPath("userData", process.env.NOVUS_USER_DATA_DIR);
}

const controlPlaneUrl = process.env.NOVUS_CP_URL ?? "http://127.0.0.1:4460";
const store = new SessionStore();
const api = new ControlPlaneClient(controlPlaneUrl, () => store.load());

let window: BrowserWindow | null = null;
let authStatus: IpcAuthStatus = { state: "signed_out" };
let pollTimer: NodeJS.Timeout | null = null;
let runner: RunnerAgent | null = null;

function setAuthStatus(next: IpcAuthStatus): void {
  authStatus = next;
  window?.webContents.send("novus:auth-changed", authStatus);
  if (next.state === "signed_in") startRunner();
  else void stopRunner();
}

/**
 * This machine is a runner. It registers itself for every local workstream it
 * can actually reach, polls for the commands it is authorized to run, and
 * reports what happened — under a credential the renderer never sees (D-035).
 */
function startRunner(): void {
  if (runner) return;
  runner = startRunnerAgent({ api, controlPlaneUrl, getToken: () => store.load() });
}

async function stopRunner(): Promise<void> {
  const current = runner;
  runner = null;
  if (current) await current.shutdown("signed out");
}

/** Where this machine remembers which Git-ignored paths were consented per
 *  repository. Computed lazily: userData is only settled once the app is ready. */
function consentStorePath(): string {
  return join(app.getPath("userData"), "local-file-consents.json");
}

/**
 * Runs the project's declared setup in a lane that was just forked, without
 * holding the IPC response open. The declared list only exists once the runner
 * has enrolled the lane and published the configuration, so this waits for it;
 * a lane whose setup never appears or fails is left in the "Workspace needs
 * setup" state it would have been in anyway.
 */
async function autoRunSetup(missionId: string, workstreamId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  try {
    while (Date.now() < deadline) {
      const detail = await api.getMission(missionId, workstreamId);
      const readiness = detail.workspace?.readiness;
      // Someone — a person, or a second desktop — got there first.
      if (readiness === "ready" || readiness === "configuring") return;
      if (detail.workspace?.declared.some((command) => command.kind === "setup")) {
        await api.workspaceCommand(missionId, { kind: "setup", workstreamId });
        runner?.pollNow();
        return;
      }
      await new Promise((settle) => setTimeout(settle, 2000));
    }
  } catch (error) {
    console.warn("[approach] setup did not auto-run:", error);
  }
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(error: unknown): IpcResult<never> {
  if (error instanceof ApiError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: "unexpected", message: "Something went wrong on this machine." };
}

/** Wraps a control-plane call as an IPC result, with one shape for every verb. */
async function call<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

const MissionIdSchema = z.string().startsWith("msn_");
/** A mission, or a mission with the lane being read (D-080): a bare id keeps
 *  meaning the lane the mission started with, so nothing that never forked
 *  changes shape. */
const MissionTargetSchema = z.union([
  z.string().startsWith("msn_").transform((missionId) => ({
    missionId,
    workstreamId: undefined as string | undefined
  })),
  z.object({
    missionId: z.string().startsWith("msn_"),
    workstreamId: z.string().startsWith("wst_").optional()
  })
]);

async function restoreSession(): Promise<void> {
  if (!store.load()) return;
  try {
    const me = await api.me();
    setAuthStatus({ state: "signed_in", user: me.user, org: me.org });
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") store.clear();
    // Offline: stay signed_out visually; the surface shows the offline notice on data load.
  }
}

async function beginSignIn(): Promise<IpcResult<null>> {
  try {
    const { state, authorizeUrl } = await api.startAuth(FAKE_IDENTITY);
    setAuthStatus({ state: "waiting_for_browser" });
    if (AUTO_VISIT) {
      await fetch(authorizeUrl, { redirect: "follow" });
    } else {
      await shell.openExternal(authorizeUrl);
    }
    const startedAt = Date.now();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (Date.now() - startedAt > 3 * 60 * 1000) {
        if (pollTimer) clearInterval(pollTimer);
        setAuthStatus({ state: "failed", message: "Sign-in timed out. Try again." });
        return;
      }
      try {
        const claim = await api.claimAuth(state);
        if (!claim) return; // browser leg still pending
        if (pollTimer) clearInterval(pollTimer);
        store.save(claim.token);
        setAuthStatus({ state: "signed_in", user: claim.user, org: claim.org });
      } catch (error) {
        if (pollTimer) clearInterval(pollTimer);
        setAuthStatus({
          state: "failed",
          message: error instanceof ApiError && error.code === "offline"
            ? "Can't reach Novus. Check your connection and try again."
            : "Sign-in didn't complete. Try again."
        });
      }
    }, 1200);
    return ok(null);
  } catch (error) {
    console.error("sign-in start failed:", error);
    const message =
      error instanceof ApiError && error.code === "offline"
        ? "Can't reach Novus. Check your connection and try again."
        : error instanceof ApiError && error.code === "auth_unconfigured"
          ? "GitHub sign-in isn't configured: add the OAuth app credentials to .env and restart."
          : "Sign-in couldn't start. Try again.";
    setAuthStatus({ state: "failed", message });
    return fail(error);
  }
}

function registerIpc(): void {
  ipcMain.handle("novus:auth:status", () => authStatus);

  ipcMain.handle("novus:setup:probe", async () => {
    try {
      return ok(await probeHarnesses());
    } catch {
      return ok({
        claudeCode: { installed: false, version: null, account: null },
        codex: { installed: false, version: null, account: null }
      });
    }
  });

  ipcMain.handle("novus:auth:start", () => beginSignIn());

  ipcMain.handle("novus:auth:signout", async () => {
    await stopRunner();
    try {
      await api.signOut();
    } catch {
      /* revocation is server-side best effort; local credential always clears */
    }
    store.clear();
    setAuthStatus({ state: "signed_out" });
    return ok(null);
  });

  ipcMain.handle("novus:missions:list", (_event, raw: unknown) =>
    call(() => api.listMissions(raw === "archived" ? "archived" : undefined))
  );
  ipcMain.handle("novus:repos:available", () => call(() => api.availableRepositories()));

  ipcMain.handle("novus:repos:base", async (_event, raw: unknown) => {
    const parsed = z
      .object({ providerRepoId: z.string().min(1), ref: z.string().min(1).optional() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed repository reference." };
    return call(() => api.baseRevision(parsed.data.providerRepoId, parsed.data.ref));
  });

  ipcMain.handle("novus:missions:retry-branch", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("wst_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed workstream id." };
    return call(async () => {
      let workstream = await api.retryBranch(parsed.data);
      // An approach's branch is this machine's to cut when the checkout is
      // here (D-080): the server deliberately does nothing for it, so a retry
      // that stopped at the server would retry nothing.
      if (workstream.branchStatus !== "created" && workstream.originSha) {
        const detail = await api.getMission(workstream.missionId, workstream.workstreamId);
        const repoId = detail.mission.repository?.providerRepoId;
        if (repoId && pathForLocalRepo(repoId) !== null) {
          const result = await ensureLocalBranch(
            repoId,
            workstream.missionBranch,
            workstream.originSha
          );
          workstream = await api.reportBranch(
            workstream.workstreamId,
            result.ok ? { status: "created" } : { status: "failed", error: result.error }
          );
          runner?.discoverNow();
        }
      }
      return workstream;
    });
  });

  ipcMain.handle("novus:repos:add-local", async () => {
    const picked = await pickLocalRepository();
    if ("cancelled" in picked) return ok(null);
    if ("error" in picked) return { ok: false, code: "invalid_repo", message: picked.error };
    try {
      await api.registerLocalRepo(picked);
      return ok({
        providerRepoId: picked.localId,
        name: picked.name,
        defaultBranch: picked.defaultBranch,
        provider: "local"
      });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:repos:local-list", async () => {
    try {
      const repositories = await api.localRepositories();
      return ok(
        (repositories as { providerRepoId: string; name: string; defaultBranch: string }[]).map((repo) => ({
          ...repo,
          onThisMachine: pathForLocalRepo(repo.providerRepoId) !== null
        }))
      );
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:repos:checked-out-here", () => ok(repositoriesOnThisMachine()));

  ipcMain.handle("novus:repos:base-local", async (_event, raw: unknown) => {
    const parsed = z.string().uuid().safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed repository id." };
    const base = await resolveLocalBase(parsed.data);
    if ("error" in base) return { ok: false, code: "local_git", message: base.error };
    return ok(base);
  });

  ipcMain.handle("novus:missions:create", async (_event, raw: unknown) => {
    const parsed = CreateMissionInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid mission." };
    }
    try {
      const created = await api.createMission(parsed.data);
      // Local branches are this machine's job: create the ref, report the
      // outcome as a claim, and hand the renderer the settled workstream.
      if (parsed.data.provider === "local") {
        const result = await ensureLocalBranch(
          parsed.data.providerRepoId,
          created.workstream.missionBranch,
          parsed.data.baseSha
        );
        created.workstream = await api.reportBranch(
          created.workstream.workstreamId,
          result.ok ? { status: "created" } : { status: "failed", error: result.error }
        );
      }
      // Register this machine as the workstream's runner right away, so the
      // first direction has somewhere to run.
      runner?.discoverNow();
      return ok(created);
    } catch (error) {
      return fail(error);
    }
  });

  // --- Approaches, and the decision between them (D-074, D-075) -------------
  // The renderer asks; the control plane decides. `approach.create` and
  // `review.approve` are role-held capabilities checked server-side, so nothing
  // below is what stops somebody forking or choosing.

  ipcMain.handle("novus:approaches:create", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        fromWorkstreamId: z.string().startsWith("wst_"),
        intent: z.string().trim().min(1).max(APPROACH_INTENT_MAX),
        name: z.string().trim().min(1).max(80).optional(),
        expectedOriginSha: z.string().min(7).max(64).optional()
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "Say how this approach should differ." };
    }
    try {
      let workstream = await api.createApproach(parsed.data.missionId, {
        fromWorkstreamId: parsed.data.fromWorkstreamId,
        intent: parsed.data.intent,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.expectedOriginSha
          ? { expectedOriginSha: parsed.data.expectedOriginSha }
          : {})
      });
      // The approach's branch is cut where the checkout is — a folder the user
      // picked and a GitHub repository the runner fetched are the same entry in
      // the machine-local map (D-025, D-032). The provider is never asked: the
      // origin is a checkpoint committed in this checkout, which the provider
      // has never seen (D-080).
      const detail = await api.getMission(parsed.data.missionId);
      const repoId = detail.mission.repository?.providerRepoId;
      if (repoId && pathForLocalRepo(repoId) !== null && workstream.originSha) {
        const result = await ensureLocalBranch(
          repoId,
          workstream.missionBranch,
          workstream.originSha
        );
        workstream = await api.reportBranch(
          workstream.workstreamId,
          result.ok ? { status: "created" } : { status: "failed", error: result.error }
        );
      }
      // So the new lane gets its own runner enrolment and its own worktree
      // without waiting for the next discovery tick.
      runner?.discoverNow();
      // The sibling's workspace setup carries over (D-074): files this person
      // already consented to for this repository go through `prepareLocalFiles`
      // again — every per-file validation re-runs, so a path that stopped
      // being ignored is refused now — and the declared setup is run once the
      // runner enrols the lane. Neither is fatal: a lane they could not reach
      // is exactly what "Workspace needs setup" already says.
      if (repoId && pathForLocalRepo(repoId) !== null) {
        const consented = consentedFilePaths(consentStorePath(), repoId);
        if (consented.length > 0) {
          try {
            await prepareLocalFiles(
              await targetFor(parsed.data.missionId, workstream.workstreamId),
              consented
            );
          } catch (error) {
            console.warn("[approach] consented files did not carry over:", error);
          }
        }
        void autoRunSetup(parsed.data.missionId, workstream.workstreamId);
      }
      return ok({ workstream });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:approaches:decide", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_"),
        rationale: z.string().trim().min(1).max(MAX_RATIONALE),
        acceptedRisks: z.string().trim().max(MAX_ACCEPTED_RISKS).optional()
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "Say why you chose this." };
    }
    try {
      const decisionId = await api.recordDecision(parsed.data.missionId, {
        workstreamId: parsed.data.workstreamId,
        rationale: parsed.data.rationale,
        ...(parsed.data.acceptedRisks ? { acceptedRisks: parsed.data.acceptedRisks } : {})
      });
      return ok({ decisionId });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:approaches:request-revision", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_"),
        reason: z.string().trim().min(1).max(MAX_RATIONALE)
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "Say what needs to change." };
    }
    try {
      await api.requestRevision(parsed.data.missionId, {
        workstreamId: parsed.data.workstreamId,
        reason: parsed.data.reason
      });
      return ok(null);
    } catch (error) {
      return fail(error);
    }
  });

  // --- Direction and execution ---------------------------------------------
  // The renderer asks; the control plane decides. It authorizes the direction,
  // records it, and — only when the author holds the lease — enqueues a
  // command for the host runner. Nothing here starts a process.

  ipcMain.handle("novus:missions:direct", async (_event, raw: unknown) => {
    const parsed = IpcDirectInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed direction." };
    const input = parsed.data;
    const result = await call(() =>
      api.submitDirection(input.missionId, {
        body: input.body,
        model: input.model,
        effort: input.effort,
        // Carried through, so a competing approach can actually be worked
        // rather than every direction landing on the mission's first lane —
        // and the session with it, for the same reason one level down (D-083).
        ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.newSession ? { newSession: true } : {})
      })
    );
    if (!result.ok) return result;
    runner?.pollNow();
    return ok({
      directionId: result.value.direction.directionId,
      // Where the words actually landed: the named session, the lane's first,
      // or the one `newSession` just created — the renderer selects it.
      sessionId: result.value.direction.sessionId,
      dispatched: result.value.dispatched,
      deferred: result.value.deferred
    });
  });

  ipcMain.handle("novus:missions:resolve-direction", async (_event, raw: unknown) => {
    const parsed = z
      .object({ directionId: z.string().startsWith("dir_") })
      .and(DirectionResolutionSchema)
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed resolution." };
    const result = await call(async () => {
      await api.resolveDirection(parsed.data.directionId, {
        action: parsed.data.action,
        reason: parsed.data.reason
      });
      return null;
    });
    runner?.pollNow();
    return result;
  });

  ipcMain.handle("novus:missions:cancel-direction", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("dir_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed direction id." };
    return call(async () => {
      await api.cancelDirection(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:missions:stop", async (_event, raw: unknown) => {
    // The lane rides along (D-080, D-083): a Stop pressed while reading an
    // Alternative must stop the Alternative's turn, not the first lane's.
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_").optional()
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    const result = await call(async () => {
      await api.stopExecution(parsed.data.missionId, parsed.data.workstreamId);
      return null;
    });
    runner?.pollNow();
    return result;
  });

  // The controller's answer to a harness permission question (D-056). Asking is
  // all this does: the server checks `approval.respond` against the current
  // lease, so a participant who is no longer the controller — including one who
  // was when the question appeared — is refused there rather than here.
  // Filing a mission away is the server's decision — `mission.archive`, and
  // refused outright while the mission is still working (D-063).
  ipcMain.handle("novus:missions:archive", async (_event, raw: unknown) => {
    const parsed = MissionIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () => {
      await api.archiveMission(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:missions:restore", async (_event, raw: unknown) => {
    const parsed = MissionIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () => {
      await api.restoreMission(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:missions:respond-approval", async (_event, raw: unknown) => {
    const parsed = z
      .object({ approvalId: z.string().startsWith("apr_") })
      .and(RespondApprovalInputSchema)
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed answer." };
    const result = await call(async () => {
      await api.respondApproval(parsed.data.approvalId, {
        decision: parsed.data.decision,
        reason: parsed.data.reason
      });
      return null;
    });
    // The turn is blocked on this, so the runner asks for its commands now
    // rather than at the next tick.
    runner?.pollNow();
    return result;
  });

  ipcMain.handle("novus:missions:get", async (_event, raw: unknown) => {
    // A bare id, or an id with the lane being read (D-080): the room asks for
    // the lane it is showing, and everything lane-scoped comes back for it.
    const parsed = z
      .union([
        MissionIdSchema.transform((missionId) => ({ missionId, workstreamId: undefined as string | undefined })),
        z.object({
          missionId: MissionIdSchema,
          workstreamId: z.string().startsWith("wst_").optional()
        })
      ])
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(() => api.getMission(parsed.data.missionId, parsed.data.workstreamId));
  });

  // --- Control --------------------------------------------------------------

  const controlVerb = <T>(schema: z.ZodType<T>, fn: (value: T) => Promise<void>) =>
    async (_event: unknown, raw: unknown): Promise<IpcResult<null>> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
      const result = await call(async () => {
        await fn(parsed.data);
        return null;
      });
      runner?.pollNow();
      return result;
    };

  ipcMain.handle("novus:control:request", controlVerb(MissionIdSchema, (id) => api.requestControl(id)));
  ipcMain.handle(
    "novus:control:withdraw-request",
    controlVerb(MissionIdSchema, (id) => api.withdrawControlRequest(id))
  );
  ipcMain.handle(
    "novus:control:decline-request",
    controlVerb(z.string().startsWith("crq_"), (id) => api.declineControlRequest(id))
  );
  ipcMain.handle(
    "novus:control:offer",
    controlVerb(
      z.object({ missionId: MissionIdSchema, toUserId: z.string().startsWith("usr_") }),
      (input) => api.offerControl(input.missionId, input.toUserId)
    )
  );
  ipcMain.handle(
    "novus:control:withdraw-offer",
    controlVerb(z.string().startsWith("hof_"), (id) => api.withdrawOffer(id))
  );
  ipcMain.handle(
    "novus:control:accept-offer",
    controlVerb(z.string().startsWith("hof_"), (id) => api.acceptOffer(id))
  );
  ipcMain.handle(
    "novus:control:decline-offer",
    controlVerb(z.string().startsWith("hof_"), (id) => api.declineOffer(id))
  );
  ipcMain.handle("novus:control:revoke", controlVerb(MissionIdSchema, (id) => api.revokeControl(id)));

  // --- Invitations ----------------------------------------------------------

  ipcMain.handle("novus:invites:create", async (_event, raw: unknown) => {
    const parsed = z
      .object({ missionId: MissionIdSchema, role: MissionRoleSchema })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed invitation." };
    return call(() => api.createInvitation(parsed.data.missionId, parsed.data.role));
  });

  ipcMain.handle("novus:invites:list", async (_event, raw: unknown) => {
    const parsed = MissionIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(() => api.listInvitations(parsed.data));
  });

  ipcMain.handle("novus:invites:revoke", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("inv_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed invitation id." };
    return call(async () => {
      await api.revokeInvitation(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:invites:redeem", async (_event, raw: unknown) => {
    const parsed = z.string().min(32).max(200).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "That doesn't look like an invitation." };
    const result = await call(() => api.redeemInvitation(parsed.data));
    runner?.discoverNow();
    return result;
  });

  // --- Workspace runtime ----------------------------------------------------
  // Inspecting a project, writing its configuration, and supplying its local
  // files are acts by the person sitting at this machine, so they are local.
  // Running a declared command is remotely invokable, so it goes through the
  // control plane and is authorized there (D-042).

  /**
   * Resolves which workstream a request means, and refuses when this machine is
   * not the one holding that repository.
   *
   * The question is *where the checkout is*, not which provider it came from. A
   * GitHub repository the runner fetched is recorded in the same machine-local
   * map a folder the user picked lives in (D-025, D-032), so from here on the
   * two are the same thing and asking about the provider would refuse a
   * workspace that plainly exists.
   */
  const targetFor = async (missionId: string, workstreamId?: string): Promise<WorkspaceTarget> => {
    // Lane-scoped (D-080): the detail comes back computed for the named lane,
    // so a terminal, file listing, or setup on the Alternative acts in the
    // Alternative's worktree and nowhere else. The control plane refuses a
    // lane that is not this mission's, so there is no way to borrow the
    // default lane's workspace under another lane's name.
    const detail = await api.getMission(missionId, workstreamId);
    const repository = detail.mission.repository;
    const workstream = detail.workstream;
    if (!repository || !workstream) {
      throw new ApiError("no_workspace", "This mission has no workstream yet.", 409);
    }
    if (pathForLocalRepo(repository.providerRepoId) === null) {
      throw new ApiError(
        "not_this_machine",
        repository.provider === "github"
          ? "Novus has not fetched this repository onto this machine yet."
          : "This repository lives on another machine, so its workspace can only be prepared there.",
        409
      );
    }
    return {
      missionId,
      workstreamId: workstream.workstreamId,
      localId: repository.providerRepoId,
      missionBranch: workstream.missionBranch,
      // `name` is `owner/name` for a GitHub repository and the folder's own
      // name for one on this Mac; both end in what the project is called.
      repositoryLabel: repositoryLabel(repository.name)
    };
  };

  ipcMain.handle("novus:workspace:inspect", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () =>
      inspectWorkspace(await targetFor(parsed.data.missionId, parsed.data.workstreamId))
    );
  });

  ipcMain.handle("novus:workspace:save", async (_event, raw: unknown) => {
    const parsed = SaveWorkspaceSettingsInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed settings." };
    const result = await call(async () => {
      await saveWorkspaceSettings(
        await targetFor(parsed.data.missionId, parsed.data.workstreamId),
        parsed.data.scope,
        parsed.data.settings
      );
      return null;
    });
    // Confirmed configuration is published immediately rather than at the next
    // discovery tick, so the Run control offers what was just saved — to every
    // participant, not only the person who saved it (D-043).
    if (result.ok) runner?.republish(parsed.data.missionId);
    return result;
  });

  ipcMain.handle("novus:workspace:prepare-local-files", async (_event, raw: unknown) => {
    const parsed = PrepareLocalFilesInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed file list." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const prepared = await prepareLocalFiles(target, parsed.data.paths);
      // What actually landed is remembered per repository, so a lane forked
      // later starts with the same files without asking again. Best-effort:
      // the copies above already happened, so a store that cannot be written
      // must not turn them into a reported failure.
      try {
        recordFileConsents(consentStorePath(), target.localId, prepared);
      } catch (error) {
        console.warn("[workspace] could not remember file consents:", error);
      }
      return prepared;
    });
  });

  ipcMain.handle("novus:workspace:command", async (_event, raw: unknown) => {
    const parsed = z
      .object({ missionId: MissionIdSchema })
      .and(WorkspaceCommandInputSchema)
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed command." };
    const result = await call(async () => {
      await api.workspaceCommand(parsed.data.missionId, {
        kind: parsed.data.kind,
        name: parsed.data.name,
        ...(parsed.data.workstreamId ? { workstreamId: parsed.data.workstreamId } : {})
      });
      return null;
    });
    runner?.pollNow();
    return result;
  });

  // --- Secret values, the runtime dock, and local previews ------------------
  // All local, exactly like inspect and prepare-local-files: a value is
  // supplied by the person sitting at the machine that has it, a process's
  // output belongs to the machine that produced it, and a preview is opened by
  // the operating system that is running the server (D-044, D-045).

  ipcMain.handle("novus:workspace:secrets", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () =>
      secretsFor(await targetFor(parsed.data.missionId, parsed.data.workstreamId))
    );
  });

  ipcMain.handle("novus:workspace:supply-secret", async (_event, raw: unknown) => {
    const parsed = SupplySecretInputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_input",
        message: parsed.error.issues[0]?.message ?? "That value cannot be stored."
      };
    }
    return call(async () =>
      supplySecret(
        await targetFor(parsed.data.missionId, parsed.data.workstreamId),
        parsed.data.name,
        parsed.data.value
      )
    );
  });

  ipcMain.handle("novus:workspace:forget-secret", async (_event, raw: unknown) => {
    const parsed = ForgetSecretInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed variable name." };
    return call(async () =>
      forgetSecret(await targetFor(parsed.data.missionId, parsed.data.workstreamId), parsed.data.name)
    );
  });

  ipcMain.handle("novus:workspace:logs", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () =>
      processLogsFor((await targetFor(parsed.data.missionId, parsed.data.workstreamId)).workstreamId)
    );
  });

  ipcMain.handle("novus:workspace:list-files", async (_event, raw: unknown) => {
    const parsed = ListWorkspaceFilesInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed folder." };
    return call(async () =>
      listFiles(await targetFor(parsed.data.missionId, parsed.data.workstreamId), parsed.data.path)
    );
  });

  ipcMain.handle("novus:workspace:read-file", async (_event, raw: unknown) => {
    const parsed = ReadWorkspaceFileInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed path." };
    return call(async () =>
      readFile(await targetFor(parsed.data.missionId, parsed.data.workstreamId), parsed.data.path)
    );
  });

  ipcMain.handle("novus:workspace:write-file", async (_event, raw: unknown) => {
    const parsed = WriteWorkspaceFileInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed edit." };
    return call(async () => {
      await writeFile(
        await targetFor(parsed.data.missionId, parsed.data.workstreamId),
        parsed.data.path,
        parsed.data.text
      );
      return null;
    });
  });

  ipcMain.handle("novus:workspace:open-preview", async (_event, raw: unknown) => {
    const parsed = OpenPreviewInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed preview address." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      // `shell.openExternal` and nothing else: no shell command is involved in
      // opening a preview, here or anywhere.
      await openPreview(target.workstreamId, parsed.data.url, async (url) => {
        await shell.openExternal(url);
      });
      return null;
    });
  });

  // Process output goes to this window and stops there, exactly like terminal
  // output: it is never an event, never reported, and never evidence.
  onProcessLog((chunk) => window?.webContents.send("novus:process-log", chunk));

  ipcMain.handle("novus:workspace:stop", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        name: z.string().min(1).max(80)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    const result = await call(async () => {
      await api.workspaceStop(parsed.data.missionId, parsed.data.name, parsed.data.workstreamId);
      return null;
    });
    runner?.pollNow();
    return result;
  });

  // --- The interactive terminal (D-042) -------------------------------------
  // Local only. These channels reach `workspace.ts` directly and never the
  // control plane: there is no shell verb in the runner protocol, so an
  // interactive shell on this machine is unreachable from anywhere else by
  // construction. `targetFor` above already refuses a workstream whose
  // repository is not on this machine, which is the same refusal the room
  // states in words rather than hiding the control.

  ipcMain.handle("novus:terminal:list", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () =>
      listTerminals((await targetFor(parsed.data.missionId, parsed.data.workstreamId)).workstreamId)
    );
  });

  ipcMain.handle("novus:terminal:open", async (_event, raw: unknown) => {
    const parsed = OpenTerminalInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal request." };
    return call(async () =>
      openTerminal(await targetFor(parsed.data.missionId, parsed.data.workstreamId), {
        name: parsed.data.name,
        kind: parsed.data.kind,
        cols: parsed.data.cols,
        rows: parsed.data.rows
      })
    );
  });

  ipcMain.handle("novus:terminal:scrollback", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("trm_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal id." };
    return call(async () => terminalScrollback(parsed.data));
  });

  ipcMain.handle("novus:terminal:write", async (_event, raw: unknown) => {
    const parsed = TerminalWriteInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal input." };
    return call(async () => {
      writeTerminal(parsed.data.sessionId, parsed.data.data);
      return null;
    });
  });

  ipcMain.handle("novus:terminal:resize", async (_event, raw: unknown) => {
    const parsed = TerminalResizeInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal size." };
    return call(async () => {
      resizeTerminal(parsed.data.sessionId, parsed.data.cols, parsed.data.rows);
      return null;
    });
  });

  ipcMain.handle("novus:terminal:rename", async (_event, raw: unknown) => {
    const parsed = TerminalRenameInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal name." };
    return call(async () => renameTerminal(parsed.data.sessionId, parsed.data.name));
  });

  ipcMain.handle("novus:terminal:close", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("trm_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed terminal id." };
    return call(async () => {
      await closeTerminal(parsed.data);
      return null;
    });
  });

  // Raw output goes to this window and stops there: it is never an event, never
  // reported to the control plane, and never evidence (D-041).
  onTerminalOutput((chunk) => window?.webContents.send("novus:terminal-output", chunk));

  // --- Evidence -------------------------------------------------------------

  ipcMain.handle("novus:evidence:file-diff", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("chg_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed change id." };
    return call(() => api.fileDiff(parsed.data));
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    // Above DESIGN.md's 1200px threshold, so the app opens into the full shell
    // rather than the band where the sidebar collapses to an overlay.
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "Novus",
    backgroundColor: TOKEN_BG,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    window = null;
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await restoreSession();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// An agent must never outlive the app that started it. Quitting kills every
// in-flight turn, records the interruption as an explicit outcome, and flushes
// the outbox — a room never hangs on "running" forever, and no orphan process
// is left behind (D-034).
// An interactive terminal is held to the same rule for the same reason: a PTY
// this process opened must not survive it, so quitting kills every session and
// its whole process tree before the app exits.
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  const exit = () => app.exit(0);
  Promise.allSettled([
    shutdownTerminals(),
    runner?.shutdown("The host desktop closed while the agent was working.") ?? Promise.resolve()
  ]).then(exit, exit);
});

app.on("window-all-closed", () => {
  app.quit();
});
