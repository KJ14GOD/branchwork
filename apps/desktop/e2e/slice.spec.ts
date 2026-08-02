import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// The Mission Room (D-032) exercised through the actual Electron app:
// sign in → Add project as a real dialog over 120+ repositories with search,
// keyboard navigation and focus restoration → the "+" tab shows repo · base
// ref · short SHA → the first chat message creates the mission → a full
// harness turn renders as ONE direction trace (author → direction → grouped
// harness speech → collapsed technical activity → checkpoint → outcome) →
// Changes and Verification answer honestly, including "No checks observed" →
// relaunch reconstructs the conversation from the server.
// Screenshots land in e2e/evidence/.

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

async function launchApp(options: { dataDir?: string; identity?: string } = {}): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_USER_DATA_DIR: options.dataDir ?? userDataDir,
      ...(options.identity ? { NOVUS_FAKE_IDENTITY: options.identity } : {})
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // The full shell starts at 1200px (DESIGN.md#responsive); the app's own
  // default window is narrower than that, so every scenario states the size it
  // is proving instead of inheriting one.
  await resizeWindow(app, 1440, 900);
  return { app, page };
}

/** The room is a resizable window, so the responsive rules are proved by
 *  resizing the real window rather than a browser viewport. */
async function resizeWindow(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await new Promise((r) => setTimeout(r, 250));
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
        // The picker has to be proved at a real repository count, not at three.
        NOVUS_FAKE_REPO_COUNT: "120",
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

describe("the Mission Room", () => {
  it("picks a project from 120+ repositories with search, keys, and restored focus", async () => {
    const { app, page } = await launchApp();

    // Sign in through the setup room.
    await page.getByTestId("setup").waitFor();
    await page.getByTestId("sign-in-button").click();
    await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
    await page.getByTestId("finish-setup").click();
    await page.getByTestId("project-shell").waitFor();

    // No projects yet; repositories are fetched only when the dialog opens.
    await page.getByTestId("no-projects").waitFor();
    await page.getByTestId("add-project").click();
    await page.getByTestId("add-project-dialog").waitFor();
    await page.getByTestId("repo-row").first().waitFor();

    // A real repository count, not a demo-sized one.
    const rowCount = await page.getByTestId("repo-row").count();
    expect(rowCount).toBeGreaterThan(100);
    await page.screenshot({ path: join(evidenceDir, "12-add-project-1440.png") });

    // The search field already has focus: type without clicking anything.
    await page.keyboard.type("billing-002");
    await expect
      .poll(async () => page.getByTestId("repo-row").count(), { timeout: 5_000 })
      .toBe(1);
    expect(await page.getByTestId("repo-row").first().textContent()).toContain("billing-002");

    // Keyboard navigation moves the active option; the header and the actions
    // never scroll away.
    for (let i = 0; i < "billing-002".length; i += 1) await page.keyboard.press("Backspace");
    await expect.poll(async () => page.getByTestId("repo-row").count()).toBeGreaterThan(100);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const active = page.locator('[data-testid="repo-row"][aria-selected="true"]');
    expect(await active.count()).toBe(1);
    expect(await active.textContent()).toContain("payments");
    await page.keyboard.press("End");
    expect(await page.locator('[data-testid="repo-row"][aria-selected="true"]').count()).toBe(1);
    await page.keyboard.press("Home");
    expect(await page.locator('[data-testid="repo-row"][aria-selected="true"]').textContent()).toContain(
      "demo-app"
    );
    // The search field is still reachable and the primary action is still there.
    await page.getByTestId("open-repository").waitFor();
    await page.getByTestId("repo-search").waitFor();

    // Narrow windows: header, results, and actions all survive.
    await resizeWindow(app, 1000, 700);
    await page.getByTestId("repo-search").waitFor();
    await page.getByTestId("open-repository").waitFor();
    await page.screenshot({ path: join(evidenceDir, "13-add-project-1000.png") });
    await resizeWindow(app, 760, 600);
    await page.getByTestId("repo-search").waitFor();
    await page.getByTestId("open-repository").waitFor();
    await page.screenshot({ path: join(evidenceDir, "14-add-project-760.png") });
    await resizeWindow(app, 1440, 900);

    // Escape closes the dialog and returns focus to what opened it.
    await page.keyboard.press("Escape");
    await page.getByTestId("add-project-dialog").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "add-project"
    );

    // Reopen and pick by typing + Enter.
    await page.getByTestId("add-project").click();
    await page.getByTestId("repo-search").waitFor();
    await page.keyboard.type("demo-app");
    await expect.poll(async () => page.getByTestId("repo-row").count(), { timeout: 5_000 }).toBe(1);
    await page.keyboard.press("Enter");

    // The "+" tab: no form — a quiet pinned base line and the composer.
    const baseLine = page.getByTestId("draft-base");
    await baseLine.waitFor();
    const baseText = (await baseLine.textContent()) ?? "";
    expect(baseText).toContain("novus/demo-app");
    expect(baseText).toContain("main");
    expect(baseText).toContain(DEMO_HEAD_SHA.slice(0, 8));
    expect(baseText).not.toContain(DEMO_HEAD_SHA); // abbreviated

    // The composer is gated on the server's capability and nothing else;
    // whether any machine can run the work is the state line's business.
    const draftInput = page.getByTestId("composer-input");
    expect(await draftInput.isDisabled()).toBe(false);
    expect(await draftInput.getAttribute("placeholder")).toBe("Direct Claude Code…");
    expect(await page.getByTestId("state-line").textContent()).toContain(
      "no machine has this repository checked out"
    );
    await page.screenshot({ path: join(evidenceDir, "10-first-message.png") });

    await app.close();
  });

  it("renders a full turn as one direction trace, with evidence and an honest ledger", async () => {
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

    // The composer sits at one row before anything is typed, and returns to
    // that height after it submits (DESIGN.md prohibited pattern 9).
    const input = first.page.getByTestId("composer-input");
    const idleHeight = (await input.boundingBox())?.height ?? 0;
    expect(idleHeight).toBeGreaterThan(0);
    await input.fill("add a fake turn file\nsecond line\nthird line\nfourth line");
    const grownHeight = (await input.boundingBox())?.height ?? 0;
    expect(grownHeight).toBeGreaterThan(idleHeight);
    await input.fill("add a fake turn file");
    await first.page.keyboard.press("Enter");

    // The first message creates the mission and runs it. This machine enrols as
    // the workstream's runner moments after the mission exists, and the control
    // plane dispatches the direction the controller already authorized rather
    // than leaving it queued for nobody.
    const trace = first.page.getByTestId("direction-trace");
    await trace.first().waitFor({ timeout: 20_000 });
    await first.page
      .getByTestId("msg-user")
      .filter({ hasText: "add a fake turn file" })
      .waitFor({ timeout: 20_000 });
    await first.page
      .getByTestId("msg-agent")
      .filter({ hasText: "Working on: add a fake turn file" })
      .waitFor({ timeout: 20_000 });
    await first.page
      .getByTestId("trace-outcome")
      .filter({ hasText: "Turn completed" })
      .waitFor({ timeout: 30_000 });

    // Consecutive harness speech groups under ONE harness identity.
    expect(await first.page.getByTestId("harness-mark").count()).toBe(1);
    expect(await first.page.getByTestId("msg-agent").count()).toBe(1);
    expect(await first.page.getByTestId("msg-agent").textContent()).toContain("Done.");

    // Tool calls are collapsed, not confetti; expanding shows them.
    const technical = first.page.getByTestId("technical-activity");
    await technical.waitFor();
    expect(await first.page.getByTestId("tool-line").isVisible().catch(() => false)).toBe(false);
    await technical.locator("summary").click();
    await first.page.getByTestId("tool-line").filter({ hasText: "Write" }).waitFor({ timeout: 10_000 });
    await technical.locator("summary").click();

    // Setup collapsed to one subordinate row, never centred debug fragments.
    const setupRow = first.page.getByTestId("setup-row");
    await setupRow.waitFor();
    expect(await setupRow.textContent()).toContain("Workspace ready");
    expect(await setupRow.textContent()).toContain(headSha.slice(0, 8));

    await first.page.getByTestId("checkpoint-line").waitFor({ timeout: 20_000 });

    // The composer is back to one row and empty.
    await first.page.getByTestId("working").waitFor({ state: "detached", timeout: 20_000 });
    expect(await input.inputValue()).toBe("");
    expect((await input.boundingBox())?.height ?? 0).toBe(idleHeight);

    // Authority is rendered from the server's own snapshot.
    const controller = first.page.getByTestId("controller");
    await controller.waitFor();
    expect(await controller.textContent()).toContain("baton");
    await first.page.getByTestId("participant-stack").waitFor();
    expect(await first.page.getByTestId("baton").count()).toBeGreaterThan(0);

    // The state line names a PRODUCT.md state and what happens next.
    const stateLine = first.page.getByTestId("state-line");
    await stateLine.waitFor();
    const stateText = (await stateLine.textContent()) ?? "";
    expect(stateText.length).toBeGreaterThan(0);

    await first.page.screenshot({ path: join(evidenceDir, "9-project-shell.png") });

    // Verification is honest when nothing ran.
    await first.page.getByTestId("open-verification").click();
    await first.page.getByTestId("inspector").waitFor();
    const empty = first.page.getByTestId("checks-empty");
    await empty.waitFor();
    expect(await empty.textContent()).toContain("No checks observed");
    await first.page.screenshot({ path: join(evidenceDir, "16-verification-empty.png") });

    // Changes: the file the turn actually wrote, and its real diff.
    await first.page.getByTestId("inspector-tab-changes").click();
    await first.page.getByTestId("inspector-changes").waitFor();
    const changeRows = first.page.getByTestId("change-row");
    await changeRows.first().waitFor({ timeout: 10_000 });
    await changeRows.first().click();
    await first.page.getByTestId("diff").waitFor({ timeout: 10_000 });
    await first.page.screenshot({ path: join(evidenceDir, "15-changes-diff.png") });

    // Overview holds the machinery the header must never carry.
    await first.page.getByTestId("inspector-tab-overview").click();
    await first.page.getByTestId("ws-branch").waitFor();
    expect(await first.page.getByTestId("ws-base").textContent()).toContain(headSha.slice(0, 8));
    await first.page.screenshot({ path: join(evidenceDir, "17-inspector-overview.png") });

    // Escape closes the drawer and focus returns to its trigger.
    await first.page.keyboard.press("Escape");
    await first.page.getByTestId("inspector").waitFor({ state: "detached" });
    expect(await first.page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "open-overview"
    );

    // Narrow: single column, nothing clipped, nothing below the fold.
    await resizeWindow(first.app, 860, 700);
    await first.page.getByTestId("state-line").waitFor();
    await first.page.getByTestId("composer-input").waitFor();
    await first.page.screenshot({ path: join(evidenceDir, "18-room-narrow.png") });
    await resizeWindow(first.app, 1440, 900);

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
      .getByTestId("trace-outcome")
      .filter({ hasText: "Turn completed" })
      .waitFor();
    await second.app.close();
  });
});
