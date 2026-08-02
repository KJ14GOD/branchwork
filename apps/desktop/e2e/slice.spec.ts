import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The complete slice exercised through the actual Electron desktop app:
// launch → sign in (real flows/sessions; gated fake GitHub upstream) →
// empty Missions → pick a repository → see the resolved base → create a
// mission → the mission branch exists → relaunch → everything reconstructed
// from PostgreSQL. A second walk exercises the branch-failure retry path on
// the deterministically flaky repository. Screenshots land in e2e/evidence/.

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4491;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e";

// The fake provider's head SHA is deterministic (repo-provider.ts).
const DEMO_HEAD_SHA = createHash("sha1").update("demo-app@main").digest("hex");

let controlPlane: ChildProcess;
let userDataDir: string;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CP_PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("control plane never became healthy");
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: `http://127.0.0.1:${CP_PORT}`,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-e2e-"));

  const admin = await import("pg").then((pg) => new pg.default.Pool({
    connectionString: "postgres://novus:novus@127.0.0.1:5433/novus"
  }));
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_e2e'");
  if (exists.rowCount === 0) await admin.query("create database novus_e2e");
  await admin.end();
  const scrub = await import("pg").then((pg) => new pg.default.Pool({ connectionString: DB_URL }));
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
});

afterAll(() => {
  controlPlane?.kill("SIGTERM");
});

describe("vertical slice through the desktop app", () => {
  it("signs in, creates a mission from a repository, and reconstructs it after a full relaunch", async () => {
    // --- First launch: sign in and create ---
    const first = await launchApp();
    await first.page.getByTestId("setup").waitFor();
    await first.page.screenshot({ path: join(evidenceDir, "1-sign-in.png") });

    await first.page.getByTestId("sign-in-button").click();
    await first.page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
    await first.page.screenshot({ path: join(evidenceDir, "1b-setup-connected.png") });
    await first.page.getByTestId("finish-setup").click();
    await first.page.getByTestId("missions").waitFor();
    await first.page.getByTestId("empty").waitFor();
    await first.page.screenshot({ path: join(evidenceDir, "2-missions-empty.png") });

    // --- Repository first, then the resolved base, then the goal ---
    await first.page.getByTestId("new-mission").click();
    const demoRepo = first.page.getByTestId("repo-row").filter({ hasText: "novus/demo-app" });
    await demoRepo.waitFor();
    await demoRepo.click();

    const base = first.page.getByTestId("base-revision");
    await base.waitFor();
    await expect(base.getAttribute("title")).resolves.toBe(DEMO_HEAD_SHA);
    const baseText = await base.textContent();
    expect(baseText).toContain("main");
    expect(baseText).toContain(DEMO_HEAD_SHA.slice(0, 8));
    expect(baseText).not.toContain(DEMO_HEAD_SHA); // abbreviated, full SHA via title

    await first.page.getByTestId("goal-input").fill("Rotate the API signing keys");
    await first.page
      .getByTestId("criteria-input")
      .fill("Every service verifies with the new key; the old key is revoked and its revocation is recorded.");
    await first.page.screenshot({ path: join(evidenceDir, "3-create-mission.png") });

    await first.page.getByTestId("create-submit").click();
    await first.page.getByTestId("mission-view").waitFor();
    await expect(
      first.page.getByTestId("mission-goal").textContent()
    ).resolves.toBe("Rotate the API signing keys");

    // The workstream allocated a real branch from the recorded base.
    const branch = await first.page.getByTestId("ws-branch").textContent();
    expect(branch).toMatch(/^novus\/m-/);
    await expect(
      first.page.getByTestId("ws-branch-status").textContent()
    ).resolves.toContain("✓ Branch created");
    await expect(
      first.page.getByTestId("ws-base").getAttribute("title")
    ).resolves.toBe(DEMO_HEAD_SHA);
    await first.page.getByTestId("event-row").first().waitFor();
    await first.page.screenshot({ path: join(evidenceDir, "5-mission-repo.png") });
    await first.app.close();

    // --- Second launch: session restored, mission reconstructed from Postgres ---
    const second = await launchApp();
    await second.page.getByTestId("missions").waitFor({ timeout: 30_000 });
    const row = second.page.getByTestId("mission-row");
    await row.waitFor();
    await expect(row.textContent()).resolves.toContain("Rotate the API signing keys");
    await expect(second.page.getByTestId("row-repo").textContent()).resolves.toBe("novus/demo-app");

    await row.click();
    await second.page.getByTestId("mission-view").waitFor();
    await expect(
      second.page.getByTestId("mission-criteria").textContent()
    ).resolves.toContain("Every service verifies with the new key");

    // Identical branch and base state, rebuilt from the database.
    await expect(second.page.getByTestId("ws-branch").textContent()).resolves.toBe(branch);
    await expect(
      second.page.getByTestId("ws-base").getAttribute("title")
    ).resolves.toBe(DEMO_HEAD_SHA);
    await expect(
      second.page.getByTestId("ws-branch-status").textContent()
    ).resolves.toContain("✓ Branch created");
    await second.page.getByTestId("event-row").first().waitFor();
    await second.page.screenshot({ path: join(evidenceDir, "4-mission-reconstructed.png") });
    await second.app.close();
  });

  it("surfaces a failed branch honestly and recovers through Retry", async () => {
    const { app, page } = await launchApp();
    await page.getByTestId("missions").waitFor({ timeout: 30_000 });
    await page.getByTestId("new-mission").click();

    // flaky/payments deterministically fails its first branch creation.
    const flaky = page.getByTestId("repo-row").filter({ hasText: "flaky/payments" });
    await flaky.waitFor();
    await flaky.click();
    await page.getByTestId("base-revision").waitFor();
    await page.getByTestId("goal-input").fill("Harden the payment retry queue");
    await page
      .getByTestId("criteria-input")
      .fill("Failed charges retry with backoff and never double-charge.");
    await page.getByTestId("create-submit").click();

    await page.getByTestId("mission-view").waitFor();
    const error = page.getByTestId("branch-error");
    await error.waitFor();
    await expect(error.textContent()).resolves.toContain("timed out");
    await page.screenshot({ path: join(evidenceDir, "6-branch-retry.png") });

    await page.getByTestId("retry-branch").click();
    await page
      .getByTestId("ws-branch-status")
      .filter({ hasText: "✓ Branch created" })
      .waitFor({ timeout: 15_000 });
    await app.close();
  });
});
