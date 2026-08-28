import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * A person's own hands on the workspace (D-226), driven end to end: a fresh
 * repository that needs an ignored `.env` nobody's machine has, prepared
 * entirely from inside Novus — a secret variable declared from the dialog and
 * its value supplied into this machine's credential store, and the `.env`
 * itself typed in and written, then removed. Tracked paths refuse in words:
 * the person's hands reach ignored files only, so the mission record never
 * carries an unattributed change.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4498;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_localfiles";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
let localId: string;
let app: ElectronApplication;
let page: Page;

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

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-localfiles-"));

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

  // The friend's-repo shape: git ignores `.env`, an example names what it
  // wants, and no `.novus/` declares anything — the machine arrives with
  // nothing but the checkout.
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-localfiles-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# needs a key\n");
  writeFileSync(join(localRepoDir, ".gitignore"), ".env\n");
  writeFileSync(join(localRepoDir, ".env.example"), "ANTHROPIC_API_KEY=\n");
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
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
    .fill("prepare this workspace");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("a person's own hands on the workspace (D-226)", () => {
  it(
    "declares a secret from the dialog, supplies its value, writes the .env, and removes it — tracked paths refused",
    async () => {
      // --- The Run menu's own door into the dialog --------------------------
      await page.getByTestId("run-control").click();
      await page.getByTestId("run-menu").waitFor({ timeout: 20_000 });
      await page.getByTestId("run-menu-setup").click();
      const dialog = page.getByTestId("workspace-setup");
      await dialog.waitFor({ timeout: 20_000 });
      await page.getByTestId("setup-detected").waitFor({ timeout: 20_000 });

      // --- A secret name is declared right here, no commit anywhere ---------
      await page.getByTestId("secrets-empty").waitFor();
      await page.getByTestId("secret-add-name").fill("ANTHROPIC_API_KEY");
      await page.getByTestId("secret-add").click();
      const secretRow = page.getByTestId("secret-row");
      await secretRow.waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("secret-state").textContent()).toBe("not supplied");

      // --- And its value is supplied into this machine's own store ----------
      await page.getByTestId("secret-supply").click();
      await page.getByTestId("secret-input").fill("sk-ant-e2e-not-a-real-key");
      await page.getByTestId("secret-save").click();
      await expect
        .poll(async () => page.getByTestId("secret-state").textContent(), { timeout: 20_000 })
        .toBe("supplied on this machine");
      // The value shows nowhere — not even masked (D-044).
      expect((await dialog.textContent()) ?? "").not.toContain("sk-ant-e2e");

      // --- The .env itself is typed in and written --------------------------
      await page.getByTestId("new-file-path").fill(".env");
      await page.getByTestId("new-file-content").fill("ANTHROPIC_API_KEY=sk-ant-e2e-not-a-real-key\n");
      await page.getByTestId("new-file-write").click();
      const fileRow = page.getByTestId("local-file").filter({ hasText: ".env" });
      await fileRow.waitFor({ timeout: 20_000 });
      await expect
        .poll(async () => (await fileRow.textContent()) ?? "", { timeout: 20_000 })
        .toContain("already in the workspace");
      await page.getByTestId("setup-new-file").scrollIntoViewIfNeeded();
      await shot(page, "110-own-hands-on-the-workspace.png");

      // --- A tracked path refuses in words, and nothing lands ---------------
      await page.getByTestId("new-file-path").fill("README.md");
      await page.getByTestId("new-file-content").fill("overwritten");
      await page.getByTestId("new-file-write").click();
      const refusal = page.getByTestId("new-file-error");
      await refusal.waitFor({ timeout: 20_000 });
      expect((await refusal.textContent()) ?? "").toContain("does not ignore");

      // --- And the person can take the file back out ------------------------
      await page.getByTestId("file-remove").click();
      try {
        await expect
          .poll(async () => page.getByTestId("local-file").filter({ hasText: ".env" }).count(), {
            timeout: 20_000
          })
          .toBe(0);
      } catch (error) {
        // The row staying has exactly one honest explanation on screen: the
        // refusal. Surface it instead of a bare count mismatch.
        const said = await page
          .getByTestId("new-file-error")
          .textContent()
          .catch(() => null);
        throw new Error(`the .env row never left; the dialog says: ${said ?? "(no refusal shown)"}`, {
          cause: error
        });
      }
    },
    240_000
  );
});
