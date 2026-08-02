import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// The project-first shell (D-032) exercised through the actual Electron app:
// sign in → add a GitHub project from the lazily-fetched available list →
// the "+" tab shows repo · base ref · short SHA → the first chat message
// creates the mission with a derived goal → the composer then states honestly
// that agents only run on local repositories. A second walk registers a real
// local git repository directly with the control plane, maps it into the
// app's machine-local store, and drives a full fake-harness turn through the
// chat room — then relaunches and proves the conversation reconstructs from
// the server. Screenshots land in e2e/evidence/.

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4491;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e";

// The fake provider's head SHA is deterministic (repo-provider.ts).
const DEMO_HEAD_SHA = createHash("sha1").update("demo-app@main").digest("hex");

let controlPlane: ChildProcess;
let userDataDir: string;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${CP_URL}/health`);
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
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** Completes the gated fake-GitHub auth flow directly over HTTP: the same
 *  user and org the app signs in as, so test-registered repositories are
 *  visible to the app. */
async function mintToken(): Promise<string> {
  const startRes = await fetch(`${CP_URL}/auth/github/start`, { method: "POST" });
  const { state, authorizeUrl } = (await startRes.json()) as { state: string; authorizeUrl: string };
  await fetch(authorizeUrl, { redirect: "follow" });
  const claimRes = await fetch(`${CP_URL}/auth/github/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  const claim = (await claimRes.json()) as { token?: string };
  if (!claim.token) throw new Error("auth claim did not return a token");
  return claim.token;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
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

describe("the project-first shell", () => {
  it("adds a GitHub project, creates a mission from the first message, and states execution honestly", async () => {
    const { app, page } = await launchApp();

    // Sign in through the setup room.
    await page.getByTestId("setup").waitFor();
    await page.getByTestId("sign-in-button").click();
    await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
    await page.getByTestId("finish-setup").click();
    await page.getByTestId("project-shell").waitFor();

    // No projects yet; GitHub repositories are fetched only on Add project.
    await page.getByTestId("no-projects").waitFor();
    await page.getByTestId("add-project").click();
    await page.getByTestId("menu-github").click();
    const demoRepo = page.getByTestId("gh-repo").filter({ hasText: "novus/demo-app" });
    await demoRepo.waitFor();
    await demoRepo.click();

    // The "+" tab: no form — a quiet repo · ref · sha line and the composer.
    const baseLine = page.getByTestId("draft-base");
    await baseLine.waitFor();
    const baseText = (await baseLine.textContent()) ?? "";
    expect(baseText).toContain("novus/demo-app");
    expect(baseText).toContain("main");
    expect(baseText).toContain(DEMO_HEAD_SHA.slice(0, 8));
    expect(baseText).not.toContain(DEMO_HEAD_SHA); // abbreviated
    await page.screenshot({ path: join(evidenceDir, "10-first-message.png") });

    // The first message creates the mission; the goal derives from it.
    const message =
      "Rotate the API signing keys so every service verifies with the new key and the old key is revoked cleanly.";
    await page.getByTestId("composer-input").fill(message);
    await page.keyboard.press("Enter");

    const tab = page.getByTestId("ws-tab");
    await tab.waitFor({ timeout: 20_000 });
    expect(await tab.textContent()).toContain("Rotate the API signing keys");

    const goal = (await page.getByTestId("room-goal").textContent()) ?? "";
    expect(goal.length).toBeLessThanOrEqual(80);
    expect(message.startsWith(goal)).toBe(true); // word-truncated prefix

    // Honesty: GitHub missions get no local agent; the composer says so.
    const note = page.getByTestId("composer-disabled");
    await note.waitFor();
    expect(await note.textContent()).toContain("Agents run on local repositories for now");
    expect(await page.getByTestId("composer-input").isDisabled()).toBe(true);

    // The durable history renders as system lines in the feed.
    await page.getByTestId("sys-line").first().waitFor({ timeout: 10_000 });

    // The repository continuity block lives in the inspector, not the canvas.
    await page.getByTestId("inspector-toggle").click();
    await page.getByTestId("ws-branch").waitFor();
    expect(await page.getByTestId("ws-base").getAttribute("title")).toBe(DEMO_HEAD_SHA);
    await page.keyboard.press("Escape");

    await app.close();
  });

  it("runs a full fake-harness turn on a local repository and reconstructs the conversation after relaunch", async () => {
    // A real local git repository, made in the test.
    const localRepoDir = mkdtempSync(join(tmpdir(), "novus-local-repo-"));
    const repoName = basename(localRepoDir);
    git(localRepoDir, ["init", "-b", "main"]);
    writeFileSync(join(localRepoDir, "README.md"), "# demo\n");
    git(localRepoDir, ["add", "-A"]);
    git(localRepoDir, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

    // Register it with the control plane directly (the app's folder picker is
    // a native dialog Playwright cannot drive), then map localId → path in the
    // app's machine-local store before launch.
    const localId = randomUUID();
    const token = await mintToken();
    const register = await fetch(`${CP_URL}/repositories/local`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
    });
    expect(register.ok).toBe(true);
    writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepoDir }));

    // First launch: session restored from the previous test's sign-in.
    const first = await launchApp();
    await first.page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    const projectRow = first.page.getByTestId("project-row").filter({ hasText: repoName });
    await projectRow.waitFor();
    await projectRow.click();

    const baseLine = first.page.getByTestId("draft-base");
    await baseLine.waitFor();
    const baseText = (await baseLine.textContent()) ?? "";
    expect(baseText).toContain(repoName);
    expect(baseText).toContain(headSha.slice(0, 8));

    // The first message creates the mission AND starts the fake turn.
    await first.page.getByTestId("composer-input").fill("add a fake turn file");
    await first.page.keyboard.press("Enter");

    await first.page
      .getByTestId("msg-user")
      .filter({ hasText: "add a fake turn file" })
      .waitFor({ timeout: 20_000 });
    await first.page
      .getByTestId("msg-agent")
      .filter({ hasText: "Working on: add a fake turn file" })
      .waitFor({ timeout: 20_000 });
    await first.page.getByTestId("tool-line").filter({ hasText: "Write" }).waitFor({ timeout: 20_000 });
    await first.page.getByTestId("msg-agent").filter({ hasText: "Done." }).waitFor({ timeout: 20_000 });
    await first.page.getByTestId("checkpoint-line").waitFor({ timeout: 20_000 });
    await first.page
      .getByTestId("sys-line")
      .filter({ hasText: "Turn completed" })
      .waitFor({ timeout: 20_000 });

    // The composer re-enables once the turn completes.
    await first.page.getByTestId("working").waitFor({ state: "detached", timeout: 10_000 });
    expect(await first.page.getByTestId("composer-input").isDisabled()).toBe(false);

    await first.page.screenshot({ path: join(evidenceDir, "9-project-shell.png") });
    await first.app.close();

    // Relaunch: the entire conversation reconstructs from the server.
    const second = await launchApp();
    await second.page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    const row = second.page.getByTestId("project-row").filter({ hasText: repoName });
    await row.waitFor();
    await row.click();

    const tab = second.page.getByTestId("ws-tab").filter({ hasText: "add a fake turn file" });
    await tab.waitFor({ timeout: 20_000 });
    await second.page
      .getByTestId("msg-user")
      .filter({ hasText: "add a fake turn file" })
      .waitFor({ timeout: 20_000 });
    await second.page.getByTestId("msg-agent").filter({ hasText: "Done." }).waitFor();
    await second.page.getByTestId("checkpoint-line").waitFor();
    await second.page
      .getByTestId("sys-line")
      .filter({ hasText: "Turn completed" })
      .waitFor();
    await second.app.close();
  });
});
