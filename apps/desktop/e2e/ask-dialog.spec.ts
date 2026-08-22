import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * The ask dialog's own controls (D-201). Starting a mission is a question
 * (D-077), and the question's foot is the real composer's — so what a person
 * can decide before the first turn is decided here: which answer policy it
 * runs under, and which files it carries.
 *
 * The profile is proven end to end, because it needs no native dialog: chosen
 * in the ask, read back off the lane the mission created. Attaching is proven
 * as far as a headless run honestly can — the control is there, and the file
 * picker it opens is the operating system's own.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4498;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_ask";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

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
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-ask-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-ask-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# ask fixture\n");
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
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

async function openAsk(): Promise<void> {
  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
}

describe("what can be decided before the first turn (D-201)", () => {
  it(
    "carries the chosen answer policy onto the lane it creates",
    async () => {
      await openAsk();
      const ask = page.getByTestId("new-mission-dialog");

      // Both controls exist here now: attaching, and the policy chip. Before
      // this slice the ask's foot was model, effort, and send alone.
      await expect.poll(async () => ask.getByTestId("attach-image").count()).toBe(1);
      const policyChip = ask.getByTestId("policy-chip");
      await policyChip.waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(evidenceDir, "218-ask-dialog-controls.png") });

      // Choose Plan — the one profile whose effect is unmistakable — and let
      // the words create the mission.
      await policyChip.click();
      await ask.getByTestId("policy-plan").click();
      const goal = "survey the fixture under plan";
      await ask.getByTestId("composer-input").fill(goal);
      await page.keyboard.press("Enter");
      await ask.waitFor({ state: "detached", timeout: 30_000 });

      // Read it back off the lane itself: the profile is the server's now, not
      // a choice the dialog only remembered.
      const profile = await page.evaluate(async (wanted) => {
        const missions = await window.novus.missions.list();
        if (!missions.ok) return `list failed: ${missions.message}`;
        const mine = missions.value.find((mission) => mission.goal.includes(wanted.slice(0, 12)));
        if (!mine) return "mission not found";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const detail = await window.novus.missions.get(mine.missionId);
          if (detail.ok && detail.value.workstream) {
            const held = detail.value.workstream.permissionProfile;
            if (held === "plan") return held;
          }
          await new Promise((settle) => setTimeout(settle, 500));
        }
        return "never became plan";
      }, goal);
      expect(profile).toBe("plan");
    },
    240_000
  );
});
