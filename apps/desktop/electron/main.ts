import { BrowserWindow, app, ipcMain, shell } from "electron";
import { join } from "node:path";
import { CreateMissionInputSchema, type IpcAuthStatus, type IpcResult } from "@novus/contracts";
import { z } from "zod";
import { ApiError, ControlPlaneClient } from "./api-client";
import { TOKEN_BG } from "./design-tokens";
import { probeHarnesses } from "./harness-probe";
import { ensureLocalBranch, pathForLocalRepo, pickLocalRepository, resolveLocalBase } from "./local-repos";
import { isRunning, runDirection, stopAllExecutions, stopExecution, type ReportedEvent } from "./execution";
import { SessionStore } from "./session-store";

// Test hooks (see DECISIONS.md D-027): both refuse to exist in packaged builds.
const AUTO_VISIT = process.env.NOVUS_AUTH_AUTOVISIT === "1" && !app.isPackaged;
if (process.env.NOVUS_USER_DATA_DIR && !app.isPackaged) {
  app.setPath("userData", process.env.NOVUS_USER_DATA_DIR);
}

const controlPlaneUrl = process.env.NOVUS_CP_URL ?? "http://127.0.0.1:4460";
const store = new SessionStore();
const api = new ControlPlaneClient(controlPlaneUrl, () => store.load());

let window: BrowserWindow | null = null;
let authStatus: IpcAuthStatus = { state: "signed_out" };
let pollTimer: NodeJS.Timeout | null = null;

function setAuthStatus(next: IpcAuthStatus): void {
  authStatus = next;
  window?.webContents.send("novus:auth-changed", authStatus);
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(error: unknown): IpcResult<never> {
  if (error instanceof ApiError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: "unexpected", message: "Something went wrong on this machine." };
}

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
    const { state, authorizeUrl } = await api.startAuth();
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
    try {
      await api.signOut();
    } catch {
      /* revocation is server-side best effort; local credential always clears */
    }
    store.clear();
    setAuthStatus({ state: "signed_out" });
    return ok(null);
  });

  ipcMain.handle("novus:missions:list", async () => {
    try {
      return ok(await api.listMissions());
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:repos:available", async () => {
    try {
      return ok(await api.availableRepositories());
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:repos:base", async (_event, raw: unknown) => {
    const parsed = z
      .object({ providerRepoId: z.string().min(1), ref: z.string().min(1).optional() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed repository reference." };
    try {
      return ok(await api.baseRevision(parsed.data.providerRepoId, parsed.data.ref));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novus:missions:retry-branch", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("wst_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed workstream id." };
    try {
      return ok(await api.retryBranch(parsed.data));
    } catch (error) {
      return fail(error);
    }
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
      return ok(created);
    } catch (error) {
      return fail(error);
    }
  });

  // Reported claims leave this machine strictly in order. Two in-flight
  // reports race for the same event sequence on the server (max(seq)+1) and
  // the loser is dropped — a checkpoint emitted immediately before completion
  // was lost exactly that way. A per-mission chain serializes them.
  const reportChains = new Map<string, Promise<void>>();
  const reportInOrder = (missionId: string, event: ReportedEvent): void => {
    const prev = reportChains.get(missionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await api.reportEvents(missionId, [event]);
      } catch (error) {
        console.error("event report failed:", error instanceof Error ? error.message : error);
      }
    });
    reportChains.set(missionId, next);
    void next.finally(() => {
      if (reportChains.get(missionId) === next) reportChains.delete(missionId);
    });
  };

  // The renderer names the mission and the words; it never names the branch
  // or the repository. Those come from server state (ARCHITECTURE.md: the
  // client originates no authority).
  const DirectSchema = z.object({
    missionId: z.string().startsWith("msn_"),
    body: z.string().trim().min(1).max(4000),
    // Allowlisted: these become CLI flags, so nothing arbitrary may pass.
    model: z
      .enum([
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001"
      ])
      .default("claude-fable-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high")
  });

  ipcMain.handle("novus:missions:direct", async (_event, raw: unknown) => {
    const parsed = DirectSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed direction." };
    const input = parsed.data;
    if (isRunning(input.missionId)) {
      return { ok: false, code: "busy", message: "The agent is already working. Wait for this turn to finish." };
    }
    let detail: Awaited<ReturnType<typeof api.getMission>>;
    try {
      detail = await api.getMission(input.missionId);
    } catch (error) {
      return fail(error);
    }
    const repository = detail.mission.repository;
    const workstream = detail.workstream;
    if (!repository || !workstream || repository.provider !== "local") {
      return { ok: false, code: "not_executable", message: "Agents run on local repositories for now." };
    }

    try {
      await api.submitDirection(input.missionId, input.body);
    } catch (error) {
      return fail(error);
    }
    // The turn streams in the background; the room's poll renders it live.
    void runDirection({
      missionId: input.missionId,
      localId: repository.providerRepoId,
      missionBranch: workstream.missionBranch,
      direction: input.body,
      model: input.model,
      effort: input.effort,
      emit: (event) => reportInOrder(input.missionId, event)
    }).catch((error) => {
      reportInOrder(input.missionId, {
        kind: "execution.failed",
        payload: { error: error instanceof Error ? error.message : "unknown" }
      });
    });
    return ok(null);
  });

  ipcMain.handle("novus:missions:stop", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("msn_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return ok(stopExecution(parsed.data));
  });

  ipcMain.handle("novus:missions:running", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("msn_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    return ok(isRunning(parsed.data));
  });

  ipcMain.handle("novus:missions:get", async (_event, raw: unknown) => {
    const parsed = z.string().startsWith("msn_").safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: "Malformed mission id." };
    try {
      return ok(await api.getMission(parsed.data));
    } catch (error) {
      return fail(error);
    }
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
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

// An agent must never outlive the app that started it: kill in-flight turns
// and record the interruption so a room never hangs on "started" forever.
app.on("before-quit", (event) => {
  const interrupted = stopAllExecutions();
  if (interrupted.length === 0) return;
  event.preventDefault();
  Promise.all(
    interrupted.map((missionId) =>
      api
        .reportEvents(missionId, [
          { kind: "execution.stopped", payload: { reason: "Novus quit while the agent was working." } }
        ])
        .catch(() => undefined)
    )
  ).finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  app.quit();
});
