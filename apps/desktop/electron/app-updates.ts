import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventEmitter } from "node:events";
import { UpdatePrefsInputSchema, type UpdatePrefsInput, type UpdateState, type UpdateStatus } from "@novus/contracts";

/**
 * The update channel (D-250): a packaged Novus asks GitHub Releases for a
 * newer build — at launch, then every six hours — when the person allows it,
 * downloads one in the background, and installs it only when the person
 * restarts for it from Settings → About. A development build never asks.
 *
 * The updater is injected as the few members electron-updater exposes that
 * Novus uses, so the standing a person reads is tested against a fake and
 * the real one is wired once, in main. Nothing here decides anything about
 * signing: until the app is signed, macOS refuses to apply what was
 * downloaded, and the state says `failed` with the updater's own words.
 */

/** electron-updater's surface as Novus uses it. */
export interface UpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdatePrefs {
  automatic: boolean;
}

export interface UpdatePrefsStore {
  load(): UpdatePrefs;
  save(prefs: UpdatePrefs): void;
}

const DEFAULT_PREFS: UpdatePrefs = { automatic: true };

/** The person's switch, kept as one small JSON file under userData. */
export function fileUpdatePrefs(path: string): UpdatePrefsStore {
  return {
    load: () => {
      try {
        if (!existsSync(path)) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { automatic?: unknown };
        return { automatic: typeof parsed.automatic === "boolean" ? parsed.automatic : DEFAULT_PREFS.automatic };
      } catch {
        return { ...DEFAULT_PREFS };
      }
    },
    save: (prefs) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(prefs, null, 2), { mode: 0o600 });
    }
  };
}

/** The first check waits for the window to be up and the person to be in. */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface AppUpdates {
  status(): UpdateStatus;
  setPrefs(input: UpdatePrefsInput): UpdateStatus;
  /** Asks the channel now; the answer arrives through the standing. */
  check(): Promise<UpdateStatus>;
  install(): { ok: true } | { ok: false; message: string };
  /** Begins the automatic checks, when they are on and the build is packaged. */
  start(): void;
  dispose(): void;
}

export interface AppUpdatesDeps {
  /** Null in a development build, where nothing is ever checked. */
  updater: UpdaterLike | null;
  packaged: boolean;
  version: string;
  repository: string;
  store: UpdatePrefsStore;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  log?: (line: string) => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "The update channel failed.";

export function createAppUpdates(deps: AppUpdatesDeps): AppUpdates {
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const enabled = deps.packaged && deps.updater !== null;
  let prefs = deps.store.load();
  let state: UpdateState = enabled ? "idle" : "off";
  let available: string | null = null;
  let progress: number | null = null;
  let error: string | null = null;
  let checkedAt: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const status = (): UpdateStatus => ({
    channel: { provider: "github", repository: deps.repository },
    packaged: deps.packaged,
    automatic: prefs.automatic,
    state,
    current: deps.version,
    available,
    progress,
    error,
    checkedAt
  });

  const updater = deps.updater;
  if (enabled && updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => {
      state = "checking";
      error = null;
    });
    updater.on("update-available", (info: { version?: string }) => {
      state = "available";
      available = typeof info?.version === "string" ? info.version : available;
      progress = null;
      checkedAt = now().toISOString();
      deps.log?.(`[updates] ${available ?? "a newer build"} is available; downloading`);
    });
    updater.on("update-not-available", () => {
      state = "up_to_date";
      available = null;
      progress = null;
      checkedAt = now().toISOString();
    });
    updater.on("download-progress", (report: { percent?: number }) => {
      state = "downloading";
      progress = typeof report?.percent === "number" ? Math.max(0, Math.min(100, Math.round(report.percent))) : progress;
    });
    updater.on("update-downloaded", (info: { version?: string }) => {
      state = "ready";
      available = typeof info?.version === "string" ? info.version : available;
      progress = 100;
      deps.log?.(`[updates] ${available ?? "a newer build"} is downloaded; restart to update`);
    });
    updater.on("error", (failure: unknown) => {
      state = "failed";
      error = describe(failure);
      checkedAt = now().toISOString();
      deps.log?.(`[updates] failed: ${error}`);
    });
  }

  const stopTimer = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };

  const check = async (): Promise<UpdateStatus> => {
    if (!enabled || !updater || disposed) return status();
    if (state === "checking" || state === "downloading") return status();
    try {
      await updater.checkForUpdates();
    } catch (failure) {
      state = "failed";
      error = describe(failure);
      checkedAt = now().toISOString();
    }
    return status();
  };

  const schedule = (delayMs: number) => {
    stopTimer();
    if (!enabled || !prefs.automatic || disposed) return;
    timer = setTimer(() => {
      timer = null;
      void check().finally(() => schedule(CHECK_EVERY_MS));
    }, delayMs);
  };

  return {
    status,
    setPrefs: (input) => {
      const parsed = UpdatePrefsInputSchema.parse(input);
      prefs = { automatic: parsed.automatic ?? prefs.automatic };
      deps.store.save(prefs);
      if (prefs.automatic) schedule(timer ? CHECK_EVERY_MS : 0);
      else stopTimer();
      return status();
    },
    check,
    install: () => {
      if (!enabled || !updater) return { ok: false, message: "A development build is not updated this way." };
      if (state !== "ready") return { ok: false, message: "No update is ready to install." };
      updater.quitAndInstall();
      return { ok: true };
    },
    start: () => schedule(FIRST_CHECK_DELAY_MS),
    dispose: () => {
      disposed = true;
      stopTimer();
    }
  };
}
