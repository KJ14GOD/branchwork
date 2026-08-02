import { BrowserWindow, app, ipcMain, shell } from "electron";
import { join } from "node:path";
import { CreateMissionInputSchema, type IpcAuthStatus, type IpcResult } from "@novus/contracts";
import { z } from "zod";
import { ApiError, ControlPlaneClient } from "./api-client";
import { TOKEN_BG } from "./design-tokens";
import { probeHarnesses } from "./harness-probe";
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

  ipcMain.handle("novus:missions:create", async (_event, raw: unknown) => {
    const parsed = CreateMissionInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid mission." };
    }
    try {
      return ok(await api.createMission(parsed.data));
    } catch (error) {
      return fail(error);
    }
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

app.on("window-all-closed", () => {
  app.quit();
});
