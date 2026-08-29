import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * Following a moved base, through the interface (D-144).
 *
 * The whole promise, driven the way a person meets it: the base branch moves
 * on while a mission stands on its pin, the room says so in words, and Sync —
 * a person's explicit act on those words — merges the new base into the
 * lane's worktree and clears the warning. A merge and never a rebase, so the
 * lane's own commits keep their SHAs; and where the lane's work collides with
 * what the base gained, the act refuses with the file named and nothing
 * moves.
 *
 * Screenshots are supporting evidence. The assertions are the test.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4501;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_sync";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
let localId: string;
let missionId: string;
let workstreamId: string;
let worktree: string;
let app: ElectronApplication;
let page: Page;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

const commit = (cwd: string, message: string): void => {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", message]);
};

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

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
    body: "{}"
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

async function launch(): Promise<void> {
  const launched = await electron.launch({
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
  app = launched;
  page = await launched.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await launched.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await new Promise((settle) => setTimeout(settle, 250));
}

/** Signs in on first launch; a relaunch remembers the session and lands in
 *  the shell directly, so this waits for whichever room appears. */
async function signIn(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await page.getByTestId("project-shell").count()) > 0) return;
    if ((await page.getByTestId("setup").count()) > 0) break;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

/** Opens the mission's room after a relaunch: the project disclosed, the
 *  mission row clicked only when it is not already the active one. */
async function openMission(): Promise<void> {
  const row = page.getByTestId("project-row").filter({ hasText: repoName });
  await row.waitFor({ timeout: 30_000 });
  const twisty = page.locator(".side-parent").filter({ has: row }).getByTestId("project-twisty");
  await expect
    .poll(
      async () => {
        if ((await twisty.getAttribute("aria-expanded")) !== "true") await row.click();
        return twisty.getAttribute("aria-expanded");
      },
      { timeout: 30_000, interval: 500 }
    )
    .toBe("true");
  const mission = page.getByTestId("mission-row").first();
  await mission.waitFor({ timeout: 30_000 });
  if (!((await mission.getAttribute("class")) ?? "").includes("active-mission")) {
    await mission.click();
  }
  await page.getByTestId("state-line").waitFor({ timeout: 30_000 });
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-sync-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
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

  localRepoDir = mkdtempSync(join(tmpdir(), "novus-sync-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# sync fixture\n\none\ntwo\nthree\n");
  commit(localRepoDir, "fixture");
  const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  localId = randomUUID();
  const token = await mintToken();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepoDir }));

  await launch();
  await signIn();

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("stand on this base while it moves");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });

  missionId = await page.evaluate(async (repositoryId) => {
    const result = await window.novus.missions.list();
    if (!result.ok) throw new Error(result.message);
    return (
      result.value.find((mission) => mission.repository?.providerRepoId === repositoryId)?.missionId ?? ""
    );
  }, localId);
  expect(missionId).toMatch(/^msn_/);
  workstreamId = await page.evaluate(async (mission) => {
    const result = await window.novus.missions.get(mission);
    if (!result.ok) throw new Error(result.message);
    return result.value.workstream?.workstreamId ?? "";
  }, missionId);
  expect(workstreamId).toMatch(/^wst_/);
  worktree = join(userDataDir, "worktrees", workstreamId);
  expect(existsSync(worktree)).toBe(true);

  // The drift check runs when the room mounts; the base moves between
  // launches so each case meets a fresh check rather than waiting out the
  // interval.
  await app.close();
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("following a moved base", () => {
  it(
    "says the base moved, and Sync merges it into the lane and clears the words",
    async () => {
      // Two commits land on main after the mission pinned it.
      writeFileSync(join(localRepoDir, "base-news.txt"), "fresh from main\n");
      commit(localRepoDir, "base gains a file");
      appendFileSync(join(localRepoDir, "base-news.txt"), "and more\n");
      commit(localRepoDir, "base gains more");
      const tip = git(localRepoDir, ["rev-parse", "HEAD"]);

      await launch();
      await signIn();
      await openMission();

      // The drift is words on the workspace row, and Sync is an action on
      // those words — not a dialog, not a page.
      await page.getByTestId("base-drift").waitFor({ timeout: 60_000 });
      expect(await page.getByTestId("base-drift").innerText()).toMatch(/base moved — 2 commits ahead/);
      const sync = page.getByTestId("base-sync");
      expect(await sync.innerText()).toBe("Sync");
      await shot(page, "167-base-drift-sync-action.png");

      const laneHeadBefore = git(worktree, ["rev-parse", "HEAD"]);
      await sync.click();

      // The pin moved, so the warning has nothing left to say.
      await expect
        .poll(() => page.getByTestId("base-drift").count(), { timeout: 30_000 })
        .toBe(0);
      expect(await page.getByTestId("action-error").count()).toBe(0);

      // A merge, never a rebase: the lane's old head is still an ancestor of
      // its new one, and what the base gained is now in the worktree.
      const laneHeadAfter = git(worktree, ["rev-parse", "HEAD"]);
      expect(laneHeadAfter).not.toBe(laneHeadBefore);
      git(worktree, ["merge-base", "--is-ancestor", laneHeadBefore, laneHeadAfter]);
      git(worktree, ["merge-base", "--is-ancestor", tip, laneHeadAfter]);
      expect(existsSync(join(worktree, "base-news.txt"))).toBe(true);
      await shot(page, "168-base-synced.png");
      await app.close();
    },
    240_000
  );

  it(
    "refuses a conflicting sync with the file named, and nothing moves",
    async () => {
      // The lane and the base now edit the same line of the same file.
      writeFileSync(join(worktree, "README.md"), "# sync fixture\n\nthe lane's line\ntwo\nthree\n");
      commit(worktree, "the lane edits the readme");
      writeFileSync(join(localRepoDir, "README.md"), "# sync fixture\n\nthe base's line\ntwo\nthree\n");
      commit(localRepoDir, "the base edits the same line");

      await launch();
      await signIn();
      await openMission();

      await page.getByTestId("base-drift").waitFor({ timeout: 60_000 });
      const laneHead = git(worktree, ["rev-parse", "HEAD"]);
      await page.getByTestId("base-sync").click();

      // Refused in words, with the colliding file named; the drift words
      // stand because nothing moved — resolving this is the lane's own work.
      await page.getByTestId("action-error").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("action-error").innerText()).toMatch(/conflicts in README\.md/);
      expect(git(worktree, ["rev-parse", "HEAD"])).toBe(laneHead);
      expect(await page.getByTestId("base-drift").count()).toBe(1);
      await shot(page, "169-base-sync-conflict.png");
    },
    240_000
  );
});
