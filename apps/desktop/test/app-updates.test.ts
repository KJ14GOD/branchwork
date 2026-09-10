import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_EVERY_MS, FIRST_CHECK_DELAY_MS, createAppUpdates, fileUpdatePrefs, type UpdaterLike } from "../electron/app-updates";

/**
 * The update channel's standing (D-250) over a fake updater that speaks
 * electron-updater's events: what the About page reads at each step, that a
 * development build never asks, and that nothing installs without the
 * person's restart.
 */

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checks = 0;
  installed = 0;
  failWith: Error | null = null;
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    if (this.failWith) throw this.failWith;
    this.emit("checking-for-update");
    return null;
  }
  quitAndInstall(): void {
    this.installed += 1;
  }
}

const memoryPrefs = (automatic = true) => {
  let prefs = { automatic };
  return { load: () => prefs, save: (next: { automatic: boolean }) => (prefs = next), current: () => prefs };
};

/** Timers a test drives by hand. */
function fakeTimers() {
  const pending: { run: () => void; ms: number; id: NodeJS.Timeout }[] = [];
  let next = 1;
  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      const id = next as unknown as NodeJS.Timeout;
      next += 1;
      pending.push({ run, ms, id });
      return id;
    },
    clearTimer: (id: NodeJS.Timeout) => {
      const at = pending.findIndex((entry) => entry.id === id);
      if (at !== -1) pending.splice(at, 1);
    },
    fire: async () => {
      const entry = pending.shift();
      if (!entry) throw new Error("nothing scheduled");
      entry.run();
      await new Promise((settle) => setTimeout(settle, 0));
    }
  };
}

describe("the update channel's standing (D-250)", () => {
  it("walks a build from available to ready, and installs only when asked", async () => {
    const updater = new FakeUpdater();
    const updates = createAppUpdates({
      updater,
      packaged: true,
      version: "0.0.1",
      repository: "KJ14GOD/branchwork",
      store: memoryPrefs(),
      now: () => new Date("2026-09-10T12:00:00Z")
    });
    // The updater is held to Novus's terms: download by itself, install only on request.
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updates.status()).toMatchObject({ state: "idle", packaged: true, automatic: true, current: "0.0.1", available: null });

    const checked = await updates.check();
    expect(updater.checks).toBe(1);
    expect(checked.state).toBe("checking");
    updater.emit("update-available", { version: "0.0.2" });
    expect(updates.status()).toMatchObject({ state: "available", available: "0.0.2", checkedAt: "2026-09-10T12:00:00.000Z" });
    updater.emit("download-progress", { percent: 41.6 });
    expect(updates.status()).toMatchObject({ state: "downloading", progress: 42 });
    // Nothing installs while it is still coming down.
    expect(updates.install()).toEqual({ ok: false, message: "No update is ready to install." });
    updater.emit("update-downloaded", { version: "0.0.2" });
    expect(updates.status()).toMatchObject({ state: "ready", progress: 100, available: "0.0.2" });
    expect(updater.installed).toBe(0);
    expect(updates.install()).toEqual({ ok: true });
    expect(updater.installed).toBe(1);
  });

  it("reads up to date, and keeps the channel's own words when it fails", async () => {
    const updater = new FakeUpdater();
    const updates = createAppUpdates({ updater, packaged: true, version: "0.0.1", repository: "r", store: memoryPrefs() });
    await updates.check();
    updater.emit("update-not-available", {});
    expect(updates.status()).toMatchObject({ state: "up_to_date", available: null, error: null });
    expect(updates.status().checkedAt).not.toBeNull();

    updater.failWith = new Error("Could not get code signature for running application");
    const failed = await updates.check();
    expect(failed).toMatchObject({ state: "failed", error: "Could not get code signature for running application" });
    updater.failWith = null;
    updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(updates.status().error).toBe("net::ERR_INTERNET_DISCONNECTED");
  });

  it("never asks in a development build, and says so on install", async () => {
    const updates = createAppUpdates({ updater: null, packaged: false, version: "0.0.1", repository: "r", store: memoryPrefs() });
    expect(updates.status()).toMatchObject({ state: "off", packaged: false });
    expect((await updates.check()).state).toBe("off");
    expect(updates.install()).toEqual({ ok: false, message: "A development build is not updated this way." });
    const timers = fakeTimers();
    const unpackaged = createAppUpdates({
      updater: new FakeUpdater(),
      packaged: false,
      version: "0.0.1",
      repository: "r",
      store: memoryPrefs(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    });
    unpackaged.start();
    expect(timers.pending).toHaveLength(0);
  });

  it("checks after launch and every six hours while the switch is on, and stops when it is off", async () => {
    const updater = new FakeUpdater();
    const timers = fakeTimers();
    const store = memoryPrefs();
    const updates = createAppUpdates({
      updater,
      packaged: true,
      version: "0.0.1",
      repository: "r",
      store,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    });
    updates.start();
    expect(timers.pending.map((entry) => entry.ms)).toEqual([FIRST_CHECK_DELAY_MS]);
    await timers.fire();
    expect(updater.checks).toBe(1);
    expect(timers.pending.map((entry) => entry.ms)).toEqual([CHECK_EVERY_MS]);

    updates.setPrefs({ automatic: false });
    expect(store.current()).toEqual({ automatic: false });
    expect(timers.pending).toHaveLength(0);
    expect(updates.status().automatic).toBe(false);

    updates.setPrefs({ automatic: true });
    expect(timers.pending.map((entry) => entry.ms)).toEqual([0]);
    updates.dispose();
    expect(timers.pending).toHaveLength(0);
  });

  it("keeps the switch in one small file, and reads the default when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-updates-"));
    const store = fileUpdatePrefs(join(dir, "updates.json"));
    expect(store.load()).toEqual({ automatic: true });
    store.save({ automatic: false });
    expect(fileUpdatePrefs(join(dir, "updates.json")).load()).toEqual({ automatic: false });
    rmSync(dir, { recursive: true, force: true });
  });
});
