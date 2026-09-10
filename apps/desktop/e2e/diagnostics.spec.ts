import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countCrashReports, LOG_NAME } from "../electron/diagnostics";

/**
 * A crash leaves a file behind (D-250): the real app in a real window, its
 * renderer killed the way a crash kills it, and then — a minidump in the
 * crash-report folder the About page names, a line in the main process's
 * log saying which process died and why, and the count the bridge reports
 * to the About page. No control plane is needed: the setup room is enough
 * of a page to crash, and the diagnostics are the main process's own.
 * Playwright's page does not survive the dead renderer, so what is asserted
 * is what is on disk: the folder the bridge names and the log it keeps.
 */

const desktopRoot = resolve(__dirname, "..");

let app: ElectronApplication;
let userDataDir: string;

beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "novus-diagnostics-"));
  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: "http://127.0.0.1:4499",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_CONNECTORS: "[]",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

afterAll(async () => {
  await app.close().catch(() => undefined);
});

describe("what a crash leaves behind (D-250)", () => {
  it("writes a minidump and a log line, where the About page says they are", async () => {
    const paths = await app.evaluate(({ app: electronApp }) => ({
      crashReports: electronApp.getPath("crashDumps"),
      logs: `${electronApp.getPath("userData")}/logs`
    }));
    expect(countCrashReports(paths.crashReports)).toBe(0);

    // The renderer dies the way a crash kills it; the main process lives on.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
    });
    await expect.poll(() => countCrashReports(paths.crashReports), { timeout: 30_000, interval: 500 }).toBeGreaterThan(0);
    const logFile = join(paths.logs, LOG_NAME);
    await expect.poll(() => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""), { timeout: 10_000 }).toMatch(
      /renderer gone \((crashed|killed|oom|abnormal-exit), exit -?\d+\)/
    );

    // The About page's count is this same walk over this same folder
    // (`diagnostics.test.ts`); Playwright's page does not survive the dead
    // renderer, so the bridge is not asked again here.
    expect(countCrashReports(paths.crashReports)).toBeGreaterThan(0);
  }, 90_000);
});
