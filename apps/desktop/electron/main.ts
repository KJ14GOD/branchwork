import {
  BrowserWindow,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  type WebContents
} from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openableExtensionOf, openRefusalFor } from "./artifact-open";
import { createNotifier, type NotificationPrefs, type Notifier } from "./notifications";
import { discoverConnectors, setConnectorLent } from "./connectors";
import { computerUseEnabled, setComputerUseEnabled } from "./computer-use";
import { accessibilityTrusted, requestAccessibility, screenRecordingGranted } from "./computer-use-native";
import {
  AttachmentRefused,
  prepareAttachment,
  prepareClipboardImage,
  sha256Of,
  type PreparedFile
} from "./attachment-upload";
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
  OpenWorkspaceInputSchema,
  OpenPreviewInputSchema,
  CloseMissionInputSchema,
  EnabledMachineMcpServersSchema,
  EnabledMcpServersSchema,
  EXTENSION_LABEL_NAME_MAX,
  ExtensionLabelColorSchema,
  ExtensionSourceSchema,
  LendConnectorInputSchema,
  MAX_LABELS_PER_EXTENSION,
  SkillNameSchema,
  EnabledSkillsSchema,
  EnabledGlobalSkillsSchema,
  EnabledSlashCommandsSchema,
  OpenTerminalInputSchema,
  MergeInputSchema,
  PullCommentInputSchema,
  PullMetadataInputSchema,
  PrepareLocalFilesInputSchema,
  ReadWorkspaceFileInputSchema,
  PermissionProfileSchema,
  RespondApprovalInputSchema,
  SaveWorkspaceSettingsInputSchema,
  SessionScopeSchema,
  SecretNameSchema,
  SupplySecretInputSchema,
  TerminalRenameInputSchema,
  TerminalResizeInputSchema,
  TerminalWriteInputSchema,
  WorkspaceCommandInputSchema,
  WriteWorkspaceFileInputSchema,
  type ArtifactViewResponse,
  type IpcAuthStatus,
  attachmentForm,
  type IpcResult,
  type PreparedAttachment
} from "@novus/contracts";
import { z } from "zod";
import { ApiError, ControlPlaneClient } from "./api-client";
import { avatarFor } from "./avatars";
import { TOKEN_BG } from "./design-tokens";
import { probeHarnesses } from "./harness-probe";
import { amendPathFromLoginShell } from "./workspace-env";
import {
  listLocalBranches,
  localBaseStatus,
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
  searchFiles,
  listTerminals,
  onProcessLog,
  onTerminalOutput,
  openPreview,
  openTerminal,
  addLocalSecretName,
  deleteLocalWorkspaceFile,
  prepareLocalFiles,
  processLogsFor,
  readFile,
  fileDiff as workspaceFileDiff,
  renameTerminal,
  repositoryLabel,
  resizeTerminal,
  saveWorkspaceSettings,
  secretsFor,
  shutdownTerminals,
  supplySecret,
  terminalScrollback,
  writeLocalWorkspaceFile,
  writeFile,
  writeTerminal,
  worktreeFor,
  type WorkspaceTarget
} from "./workspace";
import { OpenRefused, applicationIcon, installedApplications, openWith } from "./workspace-open";
import { resolvePreviewTarget } from "./preview-policy";
import {
  browsePreview,
  browsePreviewHistory,
  closeEmbeddedPreview,
  closeEmbeddedPreviewTab,
  newEmbeddedPreviewTab,
  selectEmbeddedPreviewTab,
  embeddedPreviewStatus,
  noteProcessChunk,
  onEmbeddedPreviewStatus,
  openEmbeddedPreview,
  registerPreviewWebviewHooks,
  reloadEmbeddedPreview
} from "./workspace-preview";
import {
  cancelRecording,
  initializeRecorder,
  onRecordingStatus,
  recordingStatus,
  stopRecording
} from "./artifact-recording";
import { SessionStore } from "./session-store";

// The main process logs diagnostics with console.*, and those writes go to
// whatever stdio spawned this app. When that pipe is gone — the launching
// terminal closed, `pnpm dev`'s parent exited — a write raises EPIPE, and an
// unhandled stream error crashes the whole main process with Electron's
// uncaught-exception dialog. Found by the owner in live use 2026-08-08: the
// runner outbox warned about a delivery problem into a dead pipe and the app
// died for it. A diagnostic must never be load-bearing: swallow the stream
// error and keep running.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => undefined);
}

// Test hooks (see DECISIONS.md D-027): both refuse to exist in packaged builds.
const AUTO_VISIT = process.env.NOVUS_AUTH_AUTOVISIT === "1" && !app.isPackaged;
/** Test-only: which deterministic fake identity this client signs in as, so an
 *  end-to-end run can be two different people on two desktops. */
const FAKE_IDENTITY = !app.isPackaged ? process.env.NOVUS_FAKE_IDENTITY : undefined;
if (process.env.NOVUS_USER_DATA_DIR && !app.isPackaged) {
  app.setPath("userData", process.env.NOVUS_USER_DATA_DIR);
}

/**
 * Which control plane this client speaks to (D-222). A Finder launch carries
 * no environment, so a packaged app reads the deployment's address from one
 * plain file a person writes once — `{userData}/control-plane.url`, holding a
 * single http(s) URL. NOVUS_CP_URL still wins where an environment exists,
 * and the loopback default still serves the local-first deployment.
 */
function configuredControlPlaneUrl(): string | null {
  try {
    const raw = readFileSync(join(app.getPath("userData"), "control-plane.url"), "utf8").trim();
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null; // Absent or unreadable: the default stands.
  }
}
const controlPlaneUrl =
  process.env.NOVUS_CP_URL ?? configuredControlPlaneUrl() ?? "http://127.0.0.1:4460";
const store = new SessionStore();
const api = new ControlPlaneClient(controlPlaneUrl, () => store.load());

// The artifact protocol (D-122): how the renderer's <img> and <video> read
// evidence bytes. Registered before ready, as Electron requires; the handler
// itself is installed at ready. Every request is authorized here, in this
// process — the renderer never sees a signed URL, and the isolated preview
// sessions never get this scheme at all.
protocol.registerSchemesAsPrivileged([
  { scheme: "novus-artifact", privileges: { stream: true } }
]);

let window: BrowserWindow | null = null;
/** The mission this window is watching live (D-149), and how to stop. */
let watched: { missionId: string; stop: () => void } | null = null;
/** The one all-missions connection (D-179) — the rail's live signal. */
let watchedAll: { stop: () => void } | null = null;
let authStatus: IpcAuthStatus = { state: "signed_out" };
let pollTimer: NodeJS.Timeout | null = null;
let runner: RunnerAgent | null = null;
let notifier: Notifier | null = null;

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
  // The notifier speaks only while the person is elsewhere (D-180): the
  // window's own focus is the gate, the mission's goal is the body, and the
  // click brings them back to the mission that asked.
  if (!notifier) {
    notifier = createNotifier({
      userDataPath: app.getPath("userData"),
      isFocused: () => window?.isFocused() ?? false,
      show: (title, body, onClick) => {
        const note = new Notification({ title, body });
        note.on("click", onClick);
        note.show();
      },
      open: (missionId) => {
        if (window) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          window.webContents.send("novus:open-mission", missionId);
        }
      },
      missionWords: async (missionId) => {
        const detail = await api.getMission(missionId);
        return detail.mission.goal;
      }
    });
  }
  runner = startRunnerAgent({
    api,
    controlPlaneUrl,
    getToken: () => store.load(),
    notify: (note) => notifier?.notify(note),
    onAgentScreenshot: (view) => window?.webContents.send("novus:agent-screenshot", view)
  });
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

/**
 * Signed in, with the person's face already in hand (D-105). The picture is
 * resolved *before* the status is announced — from this machine's own copy
 * when it holds one, so a relaunch never waits — because a face that arrives
 * after the first frame is a flicker in the corner of every launch.
 */
async function signedIn(
  user: { userId: string; login: string; name: string | null },
  org: { orgId: string; name: string }
): Promise<IpcAuthStatus> {
  return { state: "signed_in", user, org, avatar: await avatarFor(user.login) };
}

async function restoreSession(): Promise<void> {
  if (!store.load()) return;
  try {
    const me = await api.me();
    setAuthStatus(await signedIn(me.user, me.org));
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
        setAuthStatus(await signedIn(claim.user, claim.org));
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

  ipcMain.handle("novus:people:avatar", async (_event, raw: unknown) => {
    const parsed = z.string().min(1).max(39).safeParse(raw);
    if (!parsed.success) return ok(null);
    return ok(await avatarFor(parsed.data));
  });

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

  ipcMain.handle("novus:missions:sync-base", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("msn_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () => {
      const agent = runner;
      if (!agent) throw new ApiError("sync_refused", "This machine's runner is not running.", 409);
      return agent.syncMovedBase(parsed.data);
    });
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
    const parsed = z
      .union([z.string().uuid(), z.object({ localId: z.string().uuid(), ref: z.string().min(1).optional() })])
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed repository id." };
    const input = typeof parsed.data === "string" ? { localId: parsed.data, ref: undefined } : parsed.data;
    const base = await resolveLocalBase(input.localId, input.ref);
    if ("error" in base) return { ok: false, code: "local_git", message: base.error };
    return ok(base);
  });

  ipcMain.handle("novus:repos:branches", async (_event, raw: unknown) => {
    const parsed = z
      .object({ provider: z.enum(["github", "local"]), providerRepoId: z.string().min(1) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed repository reference." };
    if (parsed.data.provider === "local") {
      const branches = await listLocalBranches(parsed.data.providerRepoId);
      if ("error" in branches) return { ok: false, code: "local_git", message: branches.error };
      return ok(branches);
    }
    return call(async () => (await api.listBranches(parsed.data.providerRepoId)).branches);
  });

  ipcMain.handle("novus:repos:base-status-local", async (_event, raw: unknown) => {
    const parsed = z
      .object({ localId: z.string().uuid(), ref: z.string().min(1), sha: z.string().min(1) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed base reference." };
    const status = await localBaseStatus(parsed.data.localId, parsed.data.ref, parsed.data.sha);
    if ("error" in status) return { ok: false, code: "local_git", message: status.error };
    return ok(status);
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
        acceptedRisks: z.string().trim().max(MAX_ACCEPTED_RISKS).optional(),
        // The visual evidence the decider chose (D-122); the server refuses
        // anything that is not this mission's completed evidence.
        artifactIds: z.array(z.string().startsWith("art_")).max(20).optional()
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: "Say why you chose this." };
    }
    try {
      const decisionId = await api.recordDecision(parsed.data.missionId, {
        workstreamId: parsed.data.workstreamId,
        rationale: parsed.data.rationale,
        ...(parsed.data.acceptedRisks ? { acceptedRisks: parsed.data.acceptedRisks } : {}),
        ...(parsed.data.artifactIds?.length ? { artifactIds: parsed.data.artifactIds } : {})
      });
      return ok({ decisionId });
    } catch (error) {
      return fail(error);
    }
  });

  // --- Durable visual evidence (D-122, D-123) --------------------------------
  // The renderer asks; this process is the capture authority. Everything it
  // supplies is the lane — never a URL, a window, a path, or a key.

  ipcMain.handle("novus:artifacts:capture", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed capture request." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const agent = runner;
      if (!agent) throw new ApiError("capture_refused", "This machine's runner is not running.", 409);
      return agent.captureScreenshot(parsed.data.missionId, target.workstreamId);
    });
  });

  ipcMain.handle("novus:artifacts:start-recording", async (_event, raw: unknown) => {
    const parsed = MissionTargetSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed recording request." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const agent = runner;
      if (!agent) throw new ApiError("recording_refused", "This machine's runner is not running.", 409);
      await agent.startRecording(parsed.data.missionId, target.workstreamId);
      return null;
    });
  });

  ipcMain.handle("novus:artifacts:stop-recording", async () => {
    return call(() => stopRecording());
  });

  ipcMain.handle("novus:artifacts:cancel-recording", async () => {
    return call(async () => {
      await cancelRecording();
      return null;
    });
  });

  ipcMain.handle("novus:artifacts:recording-status", async () => {
    return call(async () => recordingStatus());
  });

  ipcMain.handle("novus:notifications:get", async () => {
    return ok(
      notifier?.prefs() ??
        ({ turns: true, needsYou: true } satisfies NotificationPrefs)
    );
  });

  ipcMain.handle("novus:notifications:set", async (_event, raw: unknown) => {
    const parsed = z
      .object({ turns: z.boolean(), needsYou: z.boolean() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed preferences." };
    notifier?.setPrefs(parsed.data);
    return ok(parsed.data);
  });

  ipcMain.handle("novus:system:version", async () => {
    return ok({ app: app.getVersion(), electron: process.versions.electron });
  });

  // Lent accounts (D-217): the machine's own claude.ai connectors, enumerated
  // by the CLI and cached, plus the person's own On/Off. Both machine-local.
  ipcMain.handle("novus:connectors:list", async () => {
    return ok(await discoverConnectors(app.getPath("userData")));
  });
  ipcMain.handle("novus:connectors:setLent", async (_event, raw: unknown) => {
    const parsed = LendConnectorInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed connector." };
    return ok(setConnectorLent(app.getPath("userData"), parsed.data.name, parsed.data.lent));
  });

  // Raw computer use opt-in (D-218): machine-local, off by default. The agent
  // never reads or writes this — it is the owner's own switch.
  ipcMain.handle("novus:computer:enabled", async () => {
    return ok({ enabled: computerUseEnabled(app.getPath("userData")) });
  });
  ipcMain.handle("novus:computer:set-enabled", async (_event, raw: unknown) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    setComputerUseEnabled(app.getPath("userData"), parsed.data.enabled);
    // Turning it off is a live cut-off too: the driver re-reads the opt-in on
    // every act, so any turn's next computer action is refused at once.
    return ok({ enabled: parsed.data.enabled });
  });

  // Cut off the agent's computer use for a lane mid-turn (D-218): stops the
  // next act and takes the cursor down, without ending the turn. A person's
  // own act; it only stops, so it grants nothing.
  ipcMain.handle("novus:computer:stop", async (_event, raw: unknown) => {
    const parsed = z.object({ workstreamId: z.string().startsWith("wst_") }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    return call(async () => {
      runner?.stopComputerUse(parsed.data.workstreamId);
      return null;
    });
  });

  // Accessibility status for the computer-use card (D-218): whether this Mac
  // has granted Novus synthetic-input permission, and a prompt that opens
  // System Settings. Only the owner can flip the OS switch.
  ipcMain.handle("novus:computer:accessibility", async () => {
    return ok({ trusted: accessibilityTrusted() });
  });
  ipcMain.handle("novus:computer:request-accessibility", async () => {
    return ok({ trusted: requestAccessibility() });
  });

  // macOS Screen Recording permission — what computer_screenshot needs
  // (separate from Accessibility). Read it, and open the right settings pane.
  ipcMain.handle("novus:computer:screen-recording", async () => {
    return ok({ granted: screenRecordingGranted() });
  });
  ipcMain.handle("novus:computer:open-screen-recording", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
    return ok(null);
  });

  ipcMain.handle("novus:artifacts:open-local", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("art_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed artifact id." };
    return call(async () => {
      const path = await fetchArtifactToDisk(parsed.data);
      const failure = await shell.openPath(path);
      if (failure) throw new ApiError("open_failed", failure, 500);
      return null;
    });
  });

  ipcMain.handle("novus:artifacts:reveal-local", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("art_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed artifact id." };
    return call(async () => {
      shell.showItemInFolder(await fetchArtifactToDisk(parsed.data));
      return null;
    });
  });

  ipcMain.handle("novus:artifacts:attach", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        artifactId: z.string().startsWith("art_"),
        target: z.object({ kind: z.enum(["check", "pull_request"]), id: z.string().min(1).max(60) })
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed attachment." };
    return call(async () => {
      await api.attachArtifact(parsed.data.artifactId, parsed.data.target);
      return null;
    });
  });

  ipcMain.handle("novus:artifacts:detach", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        artifactId: z.string().startsWith("art_"),
        target: z.object({ kind: z.enum(["check", "pull_request"]), id: z.string().min(1).max(60) })
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed attachment." };
    return call(async () => {
      await api.detachArtifact(parsed.data.artifactId, parsed.data.target);
      return null;
    });
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

  // --- Publishing a decision (D-099) -----------------------------------------
  // Every verb is a control-plane request gated on pr.manage. There is no
  // merge handler here, on the server, or in the runner vocabulary.

  ipcMain.handle("novus:pulls:push", async (_event, raw: unknown) => {
    const parsed = z
      .object({ missionId: MissionIdSchema, workstreamId: z.string().startsWith("wst_").optional() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed push request." };
    const result = await call(async () => {
      await api.pushBranch(parsed.data.missionId, parsed.data.workstreamId);
      return null;
    });
    runner?.pollNow();
    return result;
  });

  ipcMain.handle("novus:pulls:create", async (_event, raw: unknown) => {
    const parsed = z
      .object({ missionId: MissionIdSchema, workstreamId: z.string().startsWith("wst_").optional() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    return call(() => api.createPullRequest(parsed.data.missionId, parsed.data.workstreamId));
  });

  ipcMain.handle("novus:pulls:request-review", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        pullRequestId: z.string().startsWith("pr_"),
        reviewers: z.array(z.string().trim().min(1).max(120)).min(1).max(15)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Name at least one reviewer." };
    return call(async () => {
      await api.requestReview(parsed.data.pullRequestId, parsed.data.reviewers);
      return null;
    });
  });

  ipcMain.handle("novus:pulls:mark-ready", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("pr_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed pull request id." };
    return call(async () => {
      await api.markPullRequestReady(parsed.data);
      return null;
    });
  });

  // Completion and in-house review (D-100). The server enforces the two-tier
  // merge gate; nothing here decides anything.

  ipcMain.handle("novus:pulls:merge", async (_event, raw: unknown) => {
    const parsed = MergeInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed merge request." };
    return call(() =>
      api.mergePullRequest(parsed.data.pullRequestId, {
        method: parsed.data.method,
        acknowledgeBlockers: parsed.data.acknowledgeBlockers
      })
    );
  });

  ipcMain.handle("novus:pulls:update-branch", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("pr_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed pull request id." };
    return call(async () => {
      await api.updatePullBranch(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:pulls:close", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("pr_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed pull request id." };
    return call(async () => {
      await api.closePullRequest(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:pulls:delete-branch", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("pr_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed pull request id." };
    return call(async () => {
      await api.deletePullBranch(parsed.data);
      return null;
    });
  });

  ipcMain.handle("novus:pulls:files", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("pr_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed pull request id." };
    return call(() => api.pullFiles(parsed.data));
  });

  ipcMain.handle("novus:pulls:comment", async (_event, raw: unknown) => {
    const parsed = PullCommentInputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_input",
        message: parsed.error.issues[0]?.message ?? "Say something."
      };
    }
    return call(async () => {
      await api.pullComment(parsed.data.pullRequestId, {
        body: parsed.data.body,
        ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
        ...(parsed.data.line !== undefined ? { line: parsed.data.line } : {})
      });
      return null;
    });
  });

  ipcMain.handle("novus:pulls:resolve-thread", async (_event, raw: unknown) => {
    const parsed = z
      .object({ pullRequestId: z.string().startsWith("pr_"), threadId: z.string().min(1).max(200) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed thread id." };
    return call(async () => {
      await api.resolvePullThread(parsed.data.pullRequestId, parsed.data.threadId);
      return null;
    });
  });

  ipcMain.handle("novus:pulls:set-metadata", async (_event, raw: unknown) => {
    const parsed = PullMetadataInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed metadata." };
    return call(async () => {
      await api.setPullMetadata(parsed.data.pullRequestId, {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        ...(parsed.data.labels !== undefined ? { labels: parsed.data.labels } : {})
      });
      return null;
    });
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
        ...(input.newSession ? { newSession: true } : {}),
        ...(input.alongside ? { alongside: true } : {}),
        ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.context.length > 0 ? { context: input.context } : {})
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

  ipcMain.handle("novus:missions:set-session-scope", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        sessionId: z.string().startsWith("csn_"),
        scope: SessionScopeSchema.nullable()
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_scope",
        message: parsed.error.issues[0]?.message ?? "That scope is not a valid pattern list."
      };
    }
    const result = await call(async () => {
      await api.setSessionScope(parsed.data.missionId, parsed.data.sessionId, parsed.data.scope);
      return null;
    });
    runner?.pollNow();
    return result;
  });

  ipcMain.handle("novus:missions:set-permission-profile", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges policy.set,
    // the Mission Admin tier for dont_ask, and the acknowledgement — this
    // handler only refuses shapes that could never be a request.
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        profile: PermissionProfileSchema,
        acknowledged: z.string().max(500).nullable().default(null)
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_profile",
        message: "That is not a permission profile Novus offers."
      };
    }
    return call(async () => {
      await api.setPermissionProfile(
        parsed.data.missionId,
        parsed.data.workstreamId,
        parsed.data.profile,
        parsed.data.acknowledged
      );
      return null;
    });
  });

  ipcMain.handle("novus:missions:set-enabled-skills", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges skills.set
    // and the published-manifest match — this handler only refuses shapes
    // that could never be a request (D-118).
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        skills: EnabledSkillsSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_skills",
        message: "That is not a set of skills Novus can enable."
      };
    }
    return call(async () => {
      await api.setEnabledSkills(parsed.data.missionId, parsed.data.workstreamId, parsed.data.skills);
      return null;
    });
  });

  ipcMain.handle("novus:missions:set-enabled-slash-commands", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges skills.set
    // and the published-manifest match — this handler only refuses shapes
    // that could never be a request (D-187).
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        commands: EnabledSlashCommandsSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_commands",
        message: "That is not a set of slash commands Novus can enable."
      };
    }
    return call(async () => {
      await api.setEnabledSlashCommands(
        parsed.data.missionId,
        parsed.data.workstreamId,
        parsed.data.commands
      );
      return null;
    });
  });

  ipcMain.handle("novus:missions:set-enabled-global-skills", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges skills.set
    // and the published-manifest match — this handler only refuses shapes
    // that could never be a request (D-191).
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        skills: EnabledGlobalSkillsSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_skills",
        message: "That is not a set of machine skills Novus can enable."
      };
    }
    return call(async () => {
      await api.setEnabledGlobalSkills(
        parsed.data.missionId,
        parsed.data.workstreamId,
        parsed.data.skills
      );
      return null;
    });
  });

  ipcMain.handle("novus:missions:set-enabled-machine-mcp", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges both keys
    // — mcp.set and machine ownership — and records the acknowledgement.
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        servers: EnabledMachineMcpServersSchema,
        acknowledged: z.string().min(1).max(400)
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_servers",
        message: "That is not a set of machine servers Novus can enable."
      };
    }
    return call(async () => {
      await api.setEnabledMachineMcpServers(
        parsed.data.missionId,
        parsed.data.workstreamId,
        parsed.data.servers,
        parsed.data.acknowledged
      );
      return null;
    });
  });

  // Extension labels (D-195). Asking is all these are: the server judges
  // `skills.set` and every uniqueness and ownership rule.
  ipcMain.handle("novus:labels:create", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        name: z.string().min(1).max(EXTENSION_LABEL_NAME_MAX),
        color: ExtensionLabelColorSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_label", message: "A label needs a name and a colour." };
    }
    return call(async () =>
      api.createExtensionLabel(parsed.data.missionId, {
        name: parsed.data.name,
        color: parsed.data.color
      })
    );
  });

  ipcMain.handle("novus:labels:update", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        labelId: z.string().startsWith("lbl_"),
        name: z.string().min(1).max(EXTENSION_LABEL_NAME_MAX).optional(),
        color: ExtensionLabelColorSchema.optional()
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_label", message: "Say a new name, a new colour, or both." };
    }
    return call(async () =>
      api.updateExtensionLabel(parsed.data.missionId, parsed.data.labelId, {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.color === undefined ? {} : { color: parsed.data.color })
      })
    );
  });

  ipcMain.handle("novus:labels:delete", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        labelId: z.string().startsWith("lbl_")
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "bad_id", message: "Malformed id." };
    return call(async () => {
      await api.deleteExtensionLabel(parsed.data.missionId, parsed.data.labelId);
      return null;
    });
  });

  ipcMain.handle("novus:labels:assign", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        source: ExtensionSourceSchema,
        name: SkillNameSchema,
        labelIds: z.array(z.string().startsWith("lbl_")).max(MAX_LABELS_PER_EXTENSION)
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_assignment", message: "That is not a label set Novus can apply." };
    }
    return call(async () => {
      await api.setExtensionLabels(parsed.data.missionId, {
        source: parsed.data.source,
        name: parsed.data.name,
        labelIds: parsed.data.labelIds
      });
      return null;
    });
  });

  ipcMain.handle("novus:missions:close", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges
    // mission.close, the running/waiting refusals, and completion's gates.
    const parsed = z
      .object({ missionId: z.string().startsWith("msn_"), input: CloseMissionInputSchema })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_close", message: "Say how the mission ends." };
    }
    return call(async () => {
      await api.closeMission(parsed.data.missionId, parsed.data.input);
      return null;
    });
  });

  /**
   * Saves the receipt outside Novus (D-220). The renderer already holds the
   * deterministic markdown projection of the stored snapshot; this side owns
   * only the OS save dialog and the write — no network, no recomputation.
   * The size bound mirrors the snapshot's own: a receipt is the record's
   * summary, and a megabyte of "summary" is a bug, not an export.
   */
  ipcMain.handle("novus:missions:export-receipt", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        content: z.string().min(1).max(4_000_000),
        // Markdown for people, JSON for systems (D-234); the renderer chose
        // the bytes, this only chooses the name.
        format: z.enum(["markdown", "json"]).default("markdown")
      })
      .safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_export", message: "Nothing to export." };
    }
    const json = parsed.data.format === "json";
    const fileName = `receipt-${parsed.data.missionId}.${json ? "json" : "md"}`;
    try {
      // Test seam: the e2e cannot drive a native dialog, so a declared
      // directory stands in for the person's choice — same write, same result.
      const e2eDir = process.env.NOVUS_E2E_EXPORT_DIR;
      if (e2eDir) {
        const target = join(e2eDir, fileName);
        writeFileSync(target, parsed.data.content, "utf8");
        return { ok: true, value: { path: target } };
      }
      const chosen = await dialog.showSaveDialog({
        title: "Export receipt",
        defaultPath: join(app.getPath("downloads"), fileName),
        filters: json ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "Markdown", extensions: ["md"] }]
      });
      if (chosen.canceled || !chosen.filePath) return { ok: true, value: null };
      writeFileSync(chosen.filePath, parsed.data.content, "utf8");
      return { ok: true, value: { path: chosen.filePath } };
    } catch (error) {
      return {
        ok: false,
        code: "export_failed",
        message: error instanceof Error ? error.message : "The receipt could not be written."
      };
    }
  });

  ipcMain.handle("novus:missions:set-enabled-mcp", async (_event, raw: unknown) => {
    // Asking is all this is (AGENTS.md rule 13): the server judges mcp.set —
    // Mission Admin's alone — and the published-manifest match (D-119).
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_"),
        servers: EnabledMcpServersSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_servers",
        message: "That is not a set of MCP servers Novus can enable."
      };
    }
    return call(async () => {
      await api.setEnabledMcpServers(parsed.data.missionId, parsed.data.workstreamId, parsed.data.servers);
      return null;
    });
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
        workstreamId: z.string().startsWith("wst_").optional(),
        // And the conversation (D-095): with a read turn alongside, the lane
        // holds two live turns and the stop means the one on screen.
        sessionId: z.string().startsWith("csn_").optional()
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    const result = await call(async () => {
      await api.stopExecution(parsed.data.missionId, parsed.data.workstreamId, parsed.data.sessionId);
      return null;
    });
    runner?.pollNow();
    return result;
  });

  ipcMain.handle("novus:missions:force-interrupt", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_").optional(),
        sessionId: z.string().startsWith("csn_").optional()
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return call(async () => {
      await api.forceInterrupt(parsed.data.missionId, parsed.data.workstreamId, parsed.data.sessionId);
      return null;
    });
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

  // The room's live connection (D-149). One at a time: a window shows one
  // mission, and the stream follows it. The credential stays here — the
  // renderer receives the signal, never the connection.
  // Attaching an image to a direction (D-150). The whole act is the main
  // process's: the renderer names a file it picked, and never holds bytes, a
  // digest, a grant, or the session credential that mints one.
  /** One upload path, whichever way the file arrived: picker, paste, or drop.
   *  `read` produces the prepared bytes; everything after it is identical, so
   *  the three entry points cannot drift in what they verify (D-152). */
  const uploadAttachment = async (
    target: { missionId: string; workstreamId?: string; sessionId?: string; transcriptOf?: string },
    read: () => Promise<PreparedFile>
  ): Promise<IpcResult<PreparedAttachment>> => {
    const prepared = await read();
    const begun = await api.beginAttachment(target.missionId, {
      ...(target.workstreamId ? { workstreamId: target.workstreamId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.transcriptOf ? { transcriptOf: target.transcriptOf } : {}),
      mimeType: prepared.mimeType,
      byteSize: prepared.bytes.byteLength,
      sha256: sha256Of(prepared.bytes),
      filename: prepared.filename
    });
    const artifactId = begun.artifact.artifactId;
    try {
      const put = await fetch(begun.upload.url, {
        method: begun.upload.method,
        headers: begun.upload.headers,
        body: new Uint8Array(prepared.bytes)
      });
      if (!put.ok) throw new Error(`The artifact store refused the upload (${put.status}).`);
    } catch (error) {
      // The row must say what happened rather than linger as almost-evidence.
      const reason = error instanceof Error ? error.message.slice(0, 300) : "The upload did not complete.";
      await api.completeArtifact(artifactId, "failed", reason).catch(() => undefined);
      throw error;
    }
    const artifact = await api.completeArtifact(artifactId, "uploaded");
    return ok({
      artifactId: artifact.artifactId,
      label: artifact.label,
      // The prepared type, not the row's: an artifact may be a recording,
      // which an attachment never is, and the row echoes what was sent anyway.
      mimeType: prepared.mimeType,
      form: attachmentForm(prepared.mimeType),
      byteSize: artifact.byteSize,
      resized: prepared.resized,
      convertedFrom: prepared.convertedFrom
    });
  };

  /** Paste (D-152). An empty clipboard image is `null`, not an error: most
   *  pastes are text, and the composer takes those as words. */
  ipcMain.handle("novus:missions:attach-clipboard", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        sessionId: z.string().startsWith("csn_").optional()
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed attachment." };
    const image = clipboard.readImage();
    if (image.isEmpty()) return ok(null);
    try {
      return await uploadAttachment(parsed.data, async () =>
        prepareClipboardImage(image.toPNG())
      );
    } catch (error) {
      if (error instanceof AttachmentRefused) {
        return { ok: false, code: "invalid_attachment", message: error.message };
      }
      return fail(error);
    }
  });

  /** A rendered transcript for a new chat to continue from (D-173). The
   *  renderer projects the markdown — the one feed derivation is the one
   *  projection — and this side only bounds, hashes, and uploads it; the
   *  control plane derives the kind, the label, and the source linkage. */
  ipcMain.handle("novus:missions:attach-transcript", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        sourceSessionId: z.string().startsWith("csn_"),
        markdown: z.string().min(1).max(2_000_000)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed transcript." };
    try {
      return await uploadAttachment(
        {
          missionId: parsed.data.missionId,
          ...(parsed.data.workstreamId ? { workstreamId: parsed.data.workstreamId } : {}),
          transcriptOf: parsed.data.sourceSessionId
        },
        async () => ({
          bytes: Buffer.from(parsed.data.markdown, "utf8"),
          mimeType: "text/markdown",
          // Never used: the control plane labels a transcript from the source
          // chat's own title. Present because every prepared file has a name.
          filename: "transcript.md",
          resized: false,
          convertedFrom: null
        })
      );
    } catch (error) {
      if (error instanceof AttachmentRefused) {
        return { ok: false, code: "invalid_attachment", message: error.message };
      }
      return fail(error);
    }
  });

  ipcMain.handle("novus:missions:attach-image", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        sessionId: z.string().startsWith("csn_").optional(),
        path: z.string().min(1).max(4096)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed attachment." };
    try {
      return await uploadAttachment(parsed.data, () => prepareAttachment(parsed.data.path));
    } catch (error) {
      if (error instanceof AttachmentRefused) {
        return { ok: false, code: "invalid_attachment", message: error.message };
      }
      return fail(error);
    }
  });

  /** The file picker for an attachment. Opened by the main process, which is
   *  the only party that may read a path the renderer names. */
  /** What this machine can open a checkout in (D-159). Detected rather than
   *  declared: a menu full of applications that are not installed is worse
   *  than a short one. */
  ipcMain.handle("novus:workspace:open-targets", async () => {
    if (process.platform !== "darwin") return ok([]);
    // The application's own icon, read off this machine's copy of it — an app
    // is recognized by its icon before its name is read, and a bundled copy
    // would go stale the moment the app is redesigned. A failure here drops
    // the icon, never the row.
    const iconFor = async (path: string): Promise<string | null> => {
      const bytes = await applicationIcon(path);
      return bytes === null ? null : `data:image/png;base64,${bytes.toString("base64")}`;
    };
    const found = installedApplications();
    const entries = await Promise.all(
      found.map(async (entry) => ({
        id: entry.id,
        label: entry.label,
        icon: await iconFor(entry.paths.find((path) => existsSync(path)) ?? entry.paths[0] ?? "")
      }))
    );
    return ok([...entries, { id: "copy-path" as const, label: "Copy path", icon: null }]);
  });

  /**
   * Opens one lane's checkout elsewhere (D-159).
   *
   * The renderer names a **lane**; the path is resolved here. That is the
   * whole security story: no window can name a directory, the application
   * comes from a closed list, and nothing is passed to a shell.
   */
  ipcMain.handle("novus:workspace:open-in", async (_event, raw: unknown) => {
    const parsed = OpenWorkspaceInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    const worktree = worktreeFor(app.getPath("userData"), parsed.data.workstreamId);
    if (!existsSync(worktree)) {
      return {
        ok: false,
        code: "not_here",
        message: "This lane's workspace is not on this machine."
      };
    }
    try {
      if (parsed.data.target === "copy-path") {
        clipboard.writeText(worktree);
        return ok(null);
      }
      if (parsed.data.target === "finder") {
        const failure = await shell.openPath(worktree);
        if (failure) return { ok: false, code: "open_failed", message: failure };
        return ok(null);
      }
      const application = installedApplications().find((entry) => entry.id === parsed.data.target);
      if (!application) {
        return {
          ok: false,
          code: "not_installed",
          message: "That application is not installed on this machine."
        };
      }
      await openWith(application.application, worktree);
      return ok(null);
    } catch (error) {
      if (error instanceof OpenRefused) {
        return { ok: false, code: "open_failed", message: error.message };
      }
      return fail(error);
    }
  });

  ipcMain.handle("novus:missions:pick-image", async () => {
    const chosen = await dialog.showOpenDialog({
      title: "Attach files",
      properties: ["openFile"],
      // Any file (D-153): images and PDFs are read by the model itself,
      // everything else is staged in the worktree for the agent's own tools.
      // "All files" leads, because a leading named group grays out every
      // other file in the dialog — an mp3 looked *disabled*, when nothing
      // refuses it. The named groups remain for narrowing on purpose.
      filters: [
        { name: "All files", extensions: ["*"] },
        {
          name: "Images and PDFs",
          extensions: [
            "png", "jpg", "jpeg", "gif", "webp",
            // Converted to PNG before upload (D-151); offered because these
            // are what a Mac's own screenshots and photos actually are.
            "heic", "heif", "tif", "tiff", "bmp",
            "pdf"
          ]
        },
        {
          name: "Audio and video",
          extensions: ["mp3", "m4a", "wav", "aac", "flac", "ogg", "mp4", "mov", "m4v", "webm", "avi", "mkv"]
        }
      ]
    });
    if (chosen.canceled || chosen.filePaths.length === 0) return ok(null);
    return ok(chosen.filePaths[0] ?? null);
  });

  ipcMain.handle("novus:missions:watch", async (_event, raw: unknown) => {
    const parsed = MissionIdSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    if (watched?.missionId === parsed.data) return ok(null);
    watched?.stop();
    const stop = api.watchMission(parsed.data, {
      onChange: (change) => window?.webContents.send("novus:mission-changed", change)
    });
    watched = { missionId: parsed.data, stop };
    return ok(null);
  });

  ipcMain.handle("novus:missions:unwatch", async () => {
    watched?.stop();
    watched = null;
    return ok(null);
  });

  ipcMain.handle("novus:missions:watch-all", async () => {
    if (watchedAll) return ok(null);
    const stop = api.watchAllMissions({
      onChange: (change) => window?.webContents.send("novus:mission-any-changed", change)
    });
    watchedAll = { stop };
    return ok(null);
  });

  ipcMain.handle("novus:missions:unwatch-all", async () => {
    watchedAll?.stop();
    watchedAll = null;
    return ok(null);
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
  ipcMain.handle("novus:control:release", controlVerb(MissionIdSchema, (id) => api.releaseControl(id)));
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
      baseSha: workstream.baseSha,
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

  // A person's own local file (D-226): typed contents into a gitignored path
  // — the `.env` that exists nowhere on this machine yet. Local, like every
  // supply act: contents never cross to the control plane and are never read
  // back. The write module refuses tracked paths in words.
  ipcMain.handle("novus:workspace:write-local-file", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        path: z.string().min(1).max(300),
        content: z.string().max(1_048_576)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed file." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const outcome = await writeLocalWorkspaceFile(target, parsed.data.path, parsed.data.content);
      if (!outcome.done) throw new ApiError("file_refused", outcome.refusedBecause, 409);
      return null;
    });
  });

  ipcMain.handle("novus:workspace:delete-local-file", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        path: z.string().min(1).max(300)
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed path." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const outcome = await deleteLocalWorkspaceFile(target, parsed.data.path);
      if (!outcome.done) throw new ApiError("file_refused", outcome.refusedBecause, 409);
      return null;
    });
  });

  // Declaring a secret *name* from the dialog (D-226): written into the
  // machine-local settings layer, so a friend's repository needs no commit
  // for this Mac to know it wants a key. The value still only travels
  // through supply-secret.
  ipcMain.handle("novus:workspace:add-secret-name", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        name: SecretNameSchema
      })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_input",
        message: "A secret name is an environment variable name: letters, digits, underscores."
      };
    }
    const result = await call(async () =>
      addLocalSecretName(
        await targetFor(parsed.data.missionId, parsed.data.workstreamId),
        parsed.data.name
      )
    );
    if (result.ok) runner?.republish(parsed.data.missionId);
    return result;
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

  ipcMain.handle("novus:workspace:search-files", async (_event, raw: unknown) => {
    const parsed = z
      .object({
        missionId: MissionIdSchema,
        workstreamId: z.string().startsWith("wst_").optional(),
        query: z.string().max(200),
        limit: z.number().int().min(1).max(20_000).optional()
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed search." };
    return call(async () =>
      searchFiles(
        await targetFor(parsed.data.missionId, parsed.data.workstreamId),
        parsed.data.query,
        parsed.data.limit
      )
    );
  });

  ipcMain.handle("novus:workspace:read-file", async (_event, raw: unknown) => {
    const parsed = ReadWorkspaceFileInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed path." };
    return call(async () =>
      readFile(await targetFor(parsed.data.missionId, parsed.data.workstreamId), parsed.data.path)
    );
  });

  ipcMain.handle("novus:workspace:file-diff", async (_event, raw: unknown) => {
    const parsed = ReadWorkspaceFileInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed path." };
    return call(async () =>
      workspaceFileDiff(await targetFor(parsed.data.missionId, parsed.data.workstreamId), parsed.data.path)
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

  // The embedded preview surface (D-098). Every verb is local, and every gate
  // stays in this process: the address is validated against the workstream's
  // own live processes here, and the view's navigation is confined here — the
  // renderer only reserves a rectangle and reads what happened.

  ipcMain.handle("novus:preview:open", async (_event, raw: unknown) => {
    const parsed = OpenPreviewInputSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed preview request." };
    return call(async () => {
      const target = await targetFor(parsed.data.missionId, parsed.data.workstreamId);
      const resolved = resolvePreviewTarget(
        parsed.data.url,
        processLogsFor(target.workstreamId)
      );
      return openEmbeddedPreview(target.workstreamId, resolved);
    });
  });

  ipcMain.handle("novus:preview:reload", async () => {
    return call(async () => {
      reloadEmbeddedPreview();
      return null;
    });
  });

  // The person's own browsing (D-224): the address bar and the history
  // controls. Local acts on this machine's one surface; the address policy
  // (http/https, credential-free) is decided in the main process.
  ipcMain.handle("novus:preview:navigate", async (_event, raw: unknown) => {
    const parsed = z.object({ url: z.string().max(2000) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed address." };
    const result = browsePreview(parsed.data.url);
    if (!result.ok) return { ok: false, code: "preview_refused", message: result.refusal };
    return { ok: true, value: null };
  });

  // The surface's own tabs (D-225): registered here first, so the attach
  // gate admits an element only for a tab the main process already holds.
  ipcMain.handle("novus:preview:new-tab", async (_event, raw: unknown) => {
    const parsed = z.object({ url: z.string().max(2000).optional() }).safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed address." };
    const result = newEmbeddedPreviewTab(parsed.data.url);
    if (!result.ok) return { ok: false, code: "preview_refused", message: result.refusal };
    return { ok: true, value: null };
  });

  ipcMain.handle("novus:preview:select-tab", async (_event, raw: unknown) => {
    const parsed = z.object({ tabId: z.string().max(40) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    return call(async () => {
      selectEmbeddedPreviewTab(parsed.data.tabId);
      return null;
    });
  });

  ipcMain.handle("novus:preview:close-tab", async (_event, raw: unknown) => {
    const parsed = z.object({ tabId: z.string().max(40) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    const result = closeEmbeddedPreviewTab(parsed.data.tabId);
    if (!result.ok) return { ok: false, code: "preview_refused", message: result.refusal };
    return { ok: true, value: null };
  });

  ipcMain.handle("novus:preview:back", async () => {
    return call(async () => {
      browsePreviewHistory("back");
      return null;
    });
  });

  ipcMain.handle("novus:preview:forward", async () => {
    return call(async () => {
      browsePreviewHistory("forward");
      return null;
    });
  });

  ipcMain.handle("novus:preview:close", async () => {
    return call(async () => {
      closeEmbeddedPreview();
      return null;
    });
  });

  ipcMain.handle("novus:preview:status", async () => {
    return call(async () => embeddedPreviewStatus());
  });

  // Cut off the agent's browsing for a lane mid-turn (D-218). A person's own
  // act on their own machine's preview; it only *stops* the agent, so it
  // grants nothing and needs no capability — a stray lane id is a no-op.
  ipcMain.handle("novus:preview:stop-browsing", async (_event, raw: unknown) => {
    const parsed = z.object({ workstreamId: z.string().startsWith("wst_") }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed request." };
    return call(async () => {
      runner?.stopBrowsing(parsed.data.workstreamId);
      return null;
    });
  });

  onEmbeddedPreviewStatus((status) => window?.webContents.send("novus:preview-status", status));

  // Process output goes to this window and stops there, exactly like terminal
  // output: it is never an event, never reported, and never evidence.
  onProcessLog((chunk) => {
    // The preview hears it first: a stopped process must take its page down
    // before anything else reads the room.
    noteProcessChunk(chunk);
    window?.webContents.send("novus:process-log", chunk);
  });

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
      webSecurity: true,
      // Chromium's own PDF viewer, for the artifact view's in-app documents
      // (D-165 amended): a plugin, not a plugin system — nothing else loads.
      plugins: true,
      // The preview's element (D-163): a webview may exist, and only under
      // the will-attach gate registered below — address and partition against
      // the standing approval, attributes replaced with the locked-down set.
      webviewTag: true
    }
  });
  window.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
  registerPreviewWebviewHooks(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    window = null;
    // Nothing left to tell: the stream's only listener is gone (D-149).
    watched?.stop();
    watched = null;
  });
}

/** Short-lived viewing grants, cached only until they expire — a grant is
 *  spent on bytes, never stored (D-022). */
const artifactViewCache = new Map<string, { view: ArtifactViewResponse; expiresAtMs: number }>();

/**
 * Opening an artifact with the machine's own default application (D-165):
 * the bytes land in Novus's 0700 temp corner, `shell.openPath` — never
 * openExternal, never anything the allowlist calls executable — and the
 * corner is swept on quit. Reveal shows the same file in the file manager.
 */
const openTempDir = () => join(app.getPath("temp"), "novus-open");

async function fetchArtifactToDisk(artifactId: string): Promise<string> {
  const view = await api.viewArtifact(artifactId);
  const extension = openableExtensionOf(view.mimeType);
  if (extension === null) throw new ApiError("not_openable", openRefusalFor(view.mimeType), 409);
  const dir = openTempDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${artifactId}.${extension}`);
  if (!existsSync(path)) {
    const upstream = await fetch(view.url);
    if (!upstream.ok) throw new ApiError("unavailable", "The artifact store did not serve the bytes.", 502);
    writeFileSync(path, Buffer.from(await upstream.arrayBuffer()), { mode: 0o600 });
  }
  return path;
}

/** Serves `novus-artifact://{artifactId}/{blob|thumb}` for the app's own
 *  window. Authorization happens here per request: the session asks the
 *  control plane for a fresh grant, which enforces mission access — a person
 *  who cannot read the mission gets a 404, not pixels. */
async function serveArtifactBytes(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const artifactId = url.hostname;
    const variant = url.pathname.replace(/^\//, "") || "blob";
    if (!artifactId.startsWith("art_") || (variant !== "blob" && variant !== "thumb")) {
      return new Response("Not found", { status: 404 });
    }
    const cached = artifactViewCache.get(artifactId);
    let view = cached && cached.expiresAtMs > Date.now() + 5_000 ? cached.view : null;
    if (!view) {
      view = await api.viewArtifact(artifactId);
      artifactViewCache.set(artifactId, { view, expiresAtMs: Date.parse(view.expiresAt) || 0 });
    }
    const target = variant === "thumb" ? view.thumbnailUrl : view.url;
    if (!target) return new Response("Not found", { status: 404 });
    // The range rides through (D-165 amended): video seeking is a range
    // request, and a proxy that flattens 206 to 200 cannot be scrubbed.
    const range = request.headers.get("range");
    const upstream = await fetch(target, range ? { headers: { range } } : undefined);
    if (!upstream.ok || upstream.body === null) {
      artifactViewCache.delete(artifactId);
      return new Response("Unavailable", { status: 502 });
    }
    const headers: Record<string, string> = {
      "content-type": variant === "thumb" ? "image/png" : view.mimeType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=300"
    };
    for (const name of ["content-range", "content-length"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    const status = error instanceof ApiError && error.status === 404 ? 404 : 502;
    return new Response("Unavailable", { status });
  }
}

/** The capture session's name: the hidden recorder page lives in it, and its
 *  display-media ask is answered with the preview contents alone (D-123). */
const CAPTURE_PARTITION = "capture";

app.on("will-quit", () => {
  // The opened-files corner holds copies only; the artifacts remain the truth.
  rmSync(openTempDir(), { recursive: true, force: true });
});

app.whenReady().then(async () => {
  // A Finder launch inherits launchd's bare PATH (D-222, owner-hit: Codex
  // "not found" and turns unable to spawn an nvm-installed CLI). Fold the
  // login shell's PATH in before anything probes or spawns.
  try {
    await amendPathFromLoginShell();
  } catch (error) {
    console.warn("[novus] could not resolve the login shell's PATH:", error);
  }
  protocol.handle("novus-artifact", serveArtifactBytes);
  // The recorder (D-123): a hidden Novus-owned page that encodes the preview's
  // frames. Everything privileged stays here — the page can name no source,
  // and its messages are accepted only from its own capture session.
  initializeRecorder({
    userDataPath: app.getPath("userData"),
    preloadPath: join(__dirname, "recorder-preload.js"),
    createRecorderWindow: async (preloadPath, partition) => {
      const recorder = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: preloadPath,
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      });
      // A file: page, because `about:blank` is not a secure context and
      // `navigator.mediaDevices` does not exist there. The page is Novus's
      // own and empty; the preload is its whole behavior.
      const recorderPage = join(app.getPath("userData"), "recorder.html");
      writeFileSync(recorderPage, "<!doctype html><title>Novus recorder</title>", { mode: 0o600 });
      await recorder.loadFile(recorderPage);
      return {
        // `executeJavaScript(..., true)` carries the user gesture Chromium
        // requires for getDisplayMedia; the exposed functions are the
        // preload's own and take nothing but a frame rate.
        start: (frameRate) => {
          if (!recorder.isDestroyed()) {
            void recorder.webContents
              .executeJavaScript(`__novusRecorder.start(${Math.floor(frameRate)})`, true)
              .catch(() => undefined);
          }
        },
        stop: () => {
          if (!recorder.isDestroyed()) {
            void recorder.webContents
              .executeJavaScript("__novusRecorder.stop()", true)
              .catch(() => undefined);
          }
        },
        destroy: () => {
          if (!recorder.isDestroyed()) recorder.destroy();
        }
      };
    },
    setDisplayMediaSource: (partition, contents) => {
      const captureSession = session.fromPartition(partition);
      if (contents === null) {
        captureSession.setDisplayMediaRequestHandler(null);
        return;
      }
      captureSession.setDisplayMediaRequestHandler((_request, callback) => {
        // The preview view's own frames, and nothing else this page could
        // ever name: no windows, no screens, no picker.
        callback({ video: (contents as WebContents).mainFrame });
      });
    },
    onRecorderMessage: (channel, listener) => {
      const wrapped = (event: Electron.IpcMainEvent, payload: unknown) => {
        // Only the recorder's own session may speak on these channels — the
        // app window's renderer forging a chunk must land nowhere.
        if (event.sender.session !== session.fromPartition(CAPTURE_PARTITION)) return;
        listener(payload);
      };
      ipcMain.on(channel, wrapped);
      return () => ipcMain.removeListener(channel, wrapped);
    }
  });
  onRecordingStatus((status) => window?.webContents.send("novus:recording-status", status));
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
