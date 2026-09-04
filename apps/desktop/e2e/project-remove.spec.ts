import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Removing a project from the rail, in a real window (D-235). The rail's own
 * control opens one dialog that first refuses in words — a mission is still
 * listed — and offers to archive it; once nothing is listed the same dialog
 * removes the project, the row leaves the rail, the archived mission stays
 * under Archived, and registering the same folder again brings the same
 * project back.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4502;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_project_remove";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;
let repoName: string;
let localId: string;
let headSha: string;
let token: string;

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
  const { token: minted } = (await claimed.json()) as { token?: string };
  if (!minted) throw new Error("auth claim did not return a token");
  return minted;
}

async function connectedLocalNames(): Promise<string[]> {
  const listed = await fetch(`${CP_URL}/repositories/local`, { headers: { authorization: `Bearer ${token}` } });
  expect(listed.ok).toBe(true);
  const body = (await listed.json()) as { repositories: { name: string }[] };
  return body.repositories.map((repo) => repo.name);
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-project-remove-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-remove-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# remove fixture\n");
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  localId = randomUUID();
  token = await mintToken();
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
      NOVUS_FAKE_CONNECTORS: "[]",
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
  await page.getByTestId("project-row").filter({ hasText: repoName }).waitFor({ timeout: 30_000 });

  // One mission whose fake turn runs to completion, so the project lists a
  // mission that is neither working nor waiting — archivable, and in the way.
  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page.getByTestId("new-mission-dialog").getByTestId("composer-input").fill("prepare this workspace");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("removing a project (D-235)", () => {
  it(
    "refuses in words while a mission is listed, archives them from the same dialog, then removes the project — and the folder comes back on registration",
    async () => {
      const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
      expect(await page.getByTestId("mission-tab").count()).toBe(1);

      // The rail's own control, on hover like the mission row's Archive — and
      // taking its width only now, so the name keeps its room until then.
      await projectRow.hover();
      await page.getByTestId("project-remove").waitFor({ state: "visible", timeout: 10_000 });
      await page.screenshot({ path: join(evidenceDir, "236-project-row-hover-remove.png") });
      await page.getByTestId("project-remove").click();
      const dialog = page.getByTestId("remove-project-dialog");
      await dialog.waitFor({ timeout: 20_000 });
      await expect
        .poll(async () => (await dialog.getByTestId("remove-project-sentence").textContent()) ?? "")
        .toContain("1 mission is still listed here");
      expect(await dialog.getByTestId("remove-project-confirm").count()).toBe(0);
      await page.screenshot({ path: join(evidenceDir, "237-remove-project-still-listed.png") });

      // Archive it from here: the mission's tab closes, the dialog moves on.
      await dialog.getByTestId("remove-project-archive-all").click();
      await dialog.getByTestId("remove-project-confirm").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("remove-project-error").count()).toBe(0);
      expect(await page.getByTestId("mission-tab").count()).toBe(0);
      const sentence = (await dialog.getByTestId("remove-project-sentence").textContent()) ?? "";
      expect(sentence).toContain("The folder stays on this Mac");
      expect(sentence).toContain("1 archived mission stays in the record");

      // Remove: the row leaves the rail, the archived mission does not.
      await dialog.getByTestId("remove-project-confirm").click();
      await expect
        .poll(async () => page.getByTestId("project-row").filter({ hasText: repoName }).count(), {
          timeout: 30_000
        })
        .toBe(0);
      expect(await page.getByTestId("remove-project-dialog").count()).toBe(0);
      await page.getByTestId("open-archived").waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidenceDir, "238-project-removed.png") });
      expect(await connectedLocalNames()).not.toContain(repoName);

      // The record kept the mission, under Archived, naming its project.
      await page.getByTestId("open-archived").click();
      await page.getByTestId("archived-dialog").waitFor({ timeout: 20_000 });
      const filed = page.getByTestId("archived-row").filter({ hasText: "prepare this workspace" });
      await filed.waitFor({ timeout: 20_000 });
      expect((await filed.textContent()) ?? "").toContain(repoName);
      await page.getByTestId("archived-close").click();

      // Connecting the same folder again is the way back: the same row,
      // reconnected, and the rail lists it once more.
      const again = await fetch(`${CP_URL}/repositories/local`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
      });
      expect(again.ok).toBe(true);
      expect(await connectedLocalNames()).toContain(repoName);
      // The rail learns of it on its slow sweep — the 45-second poll that reads
      // what no mission event describes — so the wait is that sweep's.
      await expect
        .poll(async () => page.getByTestId("project-row").filter({ hasText: repoName }).count(), {
          timeout: 70_000
        })
        .toBe(1);
    },
    240_000
  );
});
