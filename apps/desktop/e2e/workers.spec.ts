import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * The harness's workers in a real window (D-107): a turn that spawns two of
 * them shows the Workers rollup inside its technical disclosure — states in
 * words — and choosing one opens its own view on the canvas, with Back to
 * chat returning to the conversation. Driven end to end through the fake
 * harness, whose worker lines are the real CLI's shapes through the real
 * parser, so what this spec proves is the production join.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4496;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_workers";
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
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-workers-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-workers-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# workers fixture\n");
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
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the harness's workers in the room (D-107)", () => {
  it(
    "shows workers as their own rows, steps in with Enter, and steps out with Esc",
    async () => {
      // Workers sit on the trace itself as quiet rows — not buried in the
      // disclosure (D-108): purpose, last activity, state as a word.
      const rows = page.getByTestId("worker-row");
      await rows.first().waitFor({ timeout: 10_000 });
      expect(await rows.count()).toBe(2);
      const rollup = page.getByTestId("worker-rollup");
      expect(await rollup.textContent()).toContain("Research the repository");
      expect(await rollup.textContent()).toContain("done");
      expect(await rollup.textContent()).toContain("failed");
      await page.screenshot({ path: join(evidenceDir, "120-workers-rollup.png") });

      // Enter steps in, the CLI way: focus the row, press Enter.
      await rows.filter({ hasText: "Research the repository" }).focus();
      await page.keyboard.press("Enter");
      const inspector = page.getByTestId("worker-inspector");
      await inspector.waitFor({ timeout: 10_000 });
      expect(await inspector.textContent()).toContain("Research the repository");
      expect(await page.getByTestId("worker-report").textContent()).toContain(
        "Three call sites documented."
      );
      expect(await page.getByTestId("worker-step").count()).toBeGreaterThan(0);
      await page.screenshot({ path: join(evidenceDir, "121-worker-inspector.png") });

      // Esc steps out: the conversation returns, transcript intact.
      await page.keyboard.press("Escape");
      await page.getByTestId("chat").waitFor({ timeout: 10_000 });
      await page
        .getByTestId("trace-outcome")
        .filter({ hasText: "Turn completed" })
        .waitFor({ timeout: 10_000 });

      // The failed worker states its failure in its own view; the button
      // works too, and so does Back to chat.
      await page.getByTestId("worker-row").filter({ hasText: "Run API tests" }).click();
      await page.getByTestId("worker-failure").waitFor({ timeout: 10_000 });
      expect(await page.getByTestId("worker-failure").textContent()).toContain(
        "The tests could not start."
      );
      await page.getByTestId("worker-back").click();
      await page.getByTestId("chat").waitFor({ timeout: 10_000 });
    },
    120_000
  );
});
