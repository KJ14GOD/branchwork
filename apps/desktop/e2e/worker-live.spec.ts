import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * A worker watched while it is still working (D-107's "updating as the room's
 * ordinary poll delivers new events" — owner-reported as untrue).
 *
 * The distinction this spec exists to hold: `workers.spec.ts` opens a worker
 * whose turn is already over, where a frozen view and a live one look exactly
 * alike. Here the harness is paced so the inspector is opened *between* a
 * worker's own steps, and what is asserted is that the view grows on its own —
 * no click, no reopening, no navigation.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4497;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_worker_live";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;
/** Slow enough to open a worker between its own lines, short enough that the
 *  whole turn still fits in one test's patience. */
const PACE_MS = 4_000;

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;
let repoName: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

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

async function mintToken(): Promise<string> {
  const started = await fetch(`${CP_URL}/auth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const { state, authorizeUrl } = (await started.json()) as { state: string; authorizeUrl: string };
  await fetch(authorizeUrl, { redirect: "follow" });
  const claimed = await fetch(`${CP_URL}/auth/github/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  const { token } = (await claimed.json()) as { token?: string };
  if (!token) throw new Error("auth claim did not return a token");
  return token;
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-worker-live-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-worker-live-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# worker live fixture\n");
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  const localId = randomUUID();
  const token = await mintToken();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepoDir }));

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_HARNESS_PACE_MS: String(PACE_MS),
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });

  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("delegate the research [fake-workers]");
  await page.keyboard.press("Enter");
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("a worker watched while it works (D-107)", () => {
  it(
    "grows the open inspector as the worker's own steps arrive",
    async () => {
      // Opened as soon as the spawn row exists — which is before either
      // worker has done anything, so an inspector that never updates shows an
      // empty timeline for the rest of the turn.
      const row = page.getByTestId("worker-row").filter({ hasText: "Research the repository" });
      await row.first().waitFor({ timeout: 90_000 });
      await row.first().click();
      const inspector = page.getByTestId("worker-inspector");
      await inspector.waitFor({ timeout: 15_000 });

      const steps = () => page.getByTestId("worker-step").count();
      const before = await steps();

      // Nothing is clicked, nothing is reopened: the only thing that happens
      // between these two counts is time and the room's own reads.
      //
      // The window is deliberately tighter than the room's 30s fallback read.
      // A worker that only grew on that timer would pass a generous poll while
      // reading as frozen to a person watching it — "eventually" is not the
      // claim D-107 makes. At this pace the next step is ~4s away, so this
      // asserts the live signal is what delivers it.
      await expect
        .poll(steps, { timeout: 15_000, interval: 500 })
        .toBeGreaterThan(before);

      // And the end lands in the same open view — the report the worker
      // handed back appears without the reader going anywhere.
      await expect
        .poll(async () => (await page.getByTestId("worker-report").count()) > 0, {
          timeout: 90_000,
          interval: 500
        })
        .toBe(true);
      expect(await page.getByTestId("worker-report").textContent()).toContain(
        "Three call sites documented."
      );
      await page.screenshot({ path: join(evidenceDir, "217-worker-live-inspector.png") });
    },
    240_000
  );
});
