import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Lent accounts, in a real window (D-217). A person's own claude.ai
 * connectors are lent — not excluded — and lending is their own machine-local
 * choice: chosen at first run, changed in Settings.
 *
 * The connector list is faked (`NOVUS_FAKE_CONNECTORS`) so the flow can be
 * driven without this machine's own account — the spawn/argv decision it
 * feeds is unit-proven in `test/execution*.test.ts`, and a live connector
 * tool call through a real account is honestly out of a headless run's reach.
 * What this proves is the product a person touches: the page appears only
 * when there is something to lend, a toggle sticks, and Settings agrees.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4499;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_connectors";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

const FAKE_CONNECTORS = JSON.stringify([
  { name: "claude.ai Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", state: "connected" },
  { name: "claude.ai Google Drive", url: "https://drivemcp.googleapis.com/mcp/v1", state: "connected" },
  { name: "claude.ai Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", state: "needs_auth" }
]);

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${CP_URL}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error("control plane never became healthy");
}

beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-connectors-e2e-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({
    connectionString: "postgres://novus:novus@127.0.0.1:5433/novus"
  });
  if ((await admin.query(`select 1 from pg_database where datname='${DB_NAME}'`)).rowCount === 0) {
    await admin.query(`create database ${DB_NAME}`);
  }
  await admin.end();
  const scrub = new pg.default.Pool({ connectionString: DB_URL });
  await scrub.query("drop schema public cascade; create schema public;");
  await scrub.end();

  controlPlane = spawn(
    process.execPath,
    ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")],
    {
      env: {
        ...process.env,
        NOVUS_FAKE_GITHUB: "1",
        NOVUS_CP_PORT: String(CP_PORT),
        NOVUS_DATABASE_URL: DB_URL
      },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_CONNECTORS: FAKE_CONNECTORS,
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGKILL");
});

describe("lending a person's own accounts (D-217)", () => {
  it("offers a lend page only after connecting, lends one, and Settings remembers it", async () => {
    await page.getByTestId("sign-in-button").click();
    await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });

    // With accounts present, the door reads Next and leads to the lend page —
    // it is never a dead Finish that hides the choice.
    const door = page.getByTestId("finish-setup");
    expect((await door.textContent())?.trim()).toBe("Next");
    await door.click();

    // The lend page: every connector, off until chosen, an unreachable one
    // stated rather than offered.
    await page.getByTestId("setup-lend").waitFor({ timeout: 10_000 });
    await page.getByTestId("connector-Gmail").waitFor({ timeout: 10_000 });
    expect(await page.getByTestId("connector-Google Drive").count()).toBe(1);
    // Calendar needs auth, so it is present but not lendable.
    expect(await page.getByTestId("connector-Google Calendar").textContent()).toContain("unavailable");

    // Lend Gmail.
    await page.getByTestId("lend-Gmail-on").click();
    expect(await page.getByTestId("lend-Gmail-on").getAttribute("aria-pressed")).toBe("true");
    // Let the first-run rise (D-148, 400ms + stagger) settle so the evidence
    // shows the page a person reads, not a frame mid-entrance.
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(evidenceDir, "222-lend-accounts.png") });

    await page.getByTestId("lend-finish").click();
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });

    // Settings → Agents remembers the lend, machine-locally.
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 });
    await page.getByTestId("settings-page-agents").click();
    const gmailRow = page.getByTestId("connector-Gmail");
    await gmailRow.waitFor({ timeout: 10_000 });
    expect(await gmailRow.getByTestId("lend-Gmail-on").getAttribute("aria-pressed")).toBe("true");
    // And Drive, which was never lent, is off.
    expect(
      await page.getByTestId("connector-Google Drive").getByTestId("lend-Google Drive-off").getAttribute("aria-pressed")
    ).toBe("true");
    await page.screenshot({ path: join(evidenceDir, "223-settings-lent-accounts.png") });

    // The raw-computer-use opt-in lives on the same page, off by default
    // (D-218): the machine's own switch, with its consequence stated.
    expect(await page.getByTestId("computer-use-off").getAttribute("aria-pressed")).toBe("true");
    await page.screenshot({ path: join(evidenceDir, "225-computer-use-opt-in.png") });

    // Turning it on reveals the macOS Accessibility row — granted or a Grant
    // access button, whichever this machine is (D-218). Written to the test's
    // own isolated state, so the real machine is untouched.
    await page.getByTestId("computer-use-on").click();
    await page.locator('[data-testid="computer-use-accessibility"], .settings-card-value:has-text("granted")').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.screenshot({ path: join(evidenceDir, "226-computer-use-on-accessibility.png") });
    // Leave it off, as it began.
    await page.getByTestId("computer-use-off").click();
  }, 120_000);
});
