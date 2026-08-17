import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

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

let controlPlane: ChildProcess;
let userDataDir: string;

/**
 * Opens a project in the rail so its missions are disclosed.
 *
 * The row *toggles*, and the shell selects a project on mount, so a plain
 * click is as likely to close it as to open it. Since D-055 the rail is the
 * only place missions are listed, so every test that names one goes through
 * here rather than assuming a click means open.
 */
async function openProject(target: Page, name: string): Promise<void> {
  const row = target.getByTestId("project-row").filter({ hasText: name });
  await row.waitFor({ timeout: 30_000 });
  // Disclosure is per project and the row's click is a toggle (D-077).
  // This helper used to treat "some mission row somewhere" as "this project
  // is disclosed", which held only while the list outran the restore path's
  // own disclosure of open-tab projects; D-120's heavier list flipped that
  // race and the helper skipped the click a collapsed project needed. The
  // twisty's aria-expanded is the per-project fact, so ask it.
  const twisty = target
    .locator(".side-parent")
    .filter({ has: row })
    .getByTestId("project-twisty");
  // Converge rather than one-shot: the restore path discloses open-tab
  // projects asynchronously, so a single read-then-click can race it and
  // toggle *closed* the very disclosure it wanted — the D-120 helper
  // family's race, from the other side. Clicking until the per-project fact
  // reads open is idempotent whichever side of the race this lands on.
  await expect
    .poll(
      async () => {
        if ((await twisty.getAttribute("aria-expanded")) === "true") return "true";
        await row.click();
        await new Promise((settle) => setTimeout(settle, 400));
        return twisty.getAttribute("aria-expanded");
      },
      { timeout: 30_000 }
    )
    .toBe("true");
}

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

/** Direct SQL, for the one fact a passing run cannot manufacture: a check whose
 *  revision the workstream has already moved past. What is written here is read
 *  back through the server's own projection, so the room renders a real
 *  `VerificationCheck` with the staleness the server derived. */
async function sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: DB_URL });
  try {
    return (await pool.query(text, params)).rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}

/** Records one verification check the way a runner eventually will. */
async function recordCheck(input: {
  missionId: string;
  name: string;
  origin: "harness" | "participant" | "external" | "automatic";
  outcome: "passed" | "failed";
  command: string;
  checkpointSha: string | null;
  exitCode: number;
  durationMs: number;
  byCreator: boolean;
}): Promise<void> {
  const rows = await sql("select org_id, created_by from missions where mission_id = $1", [
    input.missionId
  ]);
  const mission = rows[0];
  if (!mission) throw new Error(`no such mission: ${input.missionId}`);
  await sql(
    `insert into verification_checks
       (chk_id, org_id, mission_id, exe_id, name, category, outcome, origin, requested_by, command,
        exit_code, output, truncated, environment, started_at, completed_at, duration_ms,
        checkpoint_sha, observed_at)
     values ($1, $2, $3, null, $4, 'test', $5, $6, $7, $8, $9, null, false, 'local worktree',
             now() - interval '1 minute', now(), $10, $11, now())`,
    [
      `chk_${randomUUID().replace(/-/g, "")}`,
      mission.org_id,
      input.missionId,
      input.name,
      input.outcome,
      input.origin,
      input.byCreator ? mission.created_by : null,
      input.command,
      input.exitCode,
      input.durationMs,
      input.checkpointSha
    ]
  );
}

/** The mission the workspace-runtime tests build on, created by the first of
 *  them and read by the ones that follow. */
let runtimeMissionId = "";
let runtimeRepoName = "";

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
    // Two steps from the top lands on the third row, whatever the freshest-
    // first grouping put there (D-139): the assertion is about the keyboard
    // moving the selection, never about fixture order.
    const thirdRowText = await page.getByTestId("repo-row").nth(2).textContent();
    expect(await active.textContent()).toBe(thirdRowText);
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

    // Picking a repository asks a question, not a place (D-077, D-078): one
    // small dialog with the project's name and the real composer. No draft
    // tab, no form, no base machinery on screen.
    const askDialog = page.getByTestId("new-mission-dialog");
    await askDialog.waitFor();
    expect(await page.getByTestId("ask-project").textContent()).toContain("novus/demo-app");

    // A GitHub project is directable from here: the composer inside the ask is
    // live, because a runner fetches the repository into its own area and
    // works it like any other checkout (D-025, D-032).
    const askInput = askDialog.getByTestId("composer-input");
    expect(await askInput.isDisabled()).toBe(false);
    expect(await askDialog.getByTestId("composer-no-capability").count()).toBe(0);
    await page.screenshot({ path: join(evidenceDir, "10-first-message.png") });
    // Enter with nothing, Esc, or a click outside closes it and nothing
    // happens anywhere (D-077).
    await page.keyboard.press("Escape");
    await askDialog.waitFor({ state: "detached" });

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
    // Starting a mission is a question (D-077): the + on the project row opens
    // the ask-dialog, which embeds the real composer (D-078).
    await projectRow.hover();
    await first.page.getByTestId("repo-new-mission").click();
    await first.page.getByTestId("new-mission-dialog").waitFor();

    const input = first.page.getByTestId("new-mission-dialog").getByTestId("composer-input");
    await input.fill("add a fake turn file");
    await first.page.keyboard.press("Enter");
    await first.page
      .getByTestId("new-mission-dialog")
      .waitFor({ state: "detached", timeout: 30_000 });

    // The room's composer sits at one row before anything is typed and grows
    // with content (DESIGN.md prohibited pattern 9) — checked here because the
    // ask-dialog styles the same composer tall on purpose (D-078).
    const roomInput = first.page.getByTestId("composer-input");
    await roomInput.waitFor({ timeout: 30_000 });
    const idleHeight = (await roomInput.boundingBox())?.height ?? 0;
    expect(idleHeight).toBeGreaterThan(0);
    await roomInput.fill("a draft\nsecond line\nthird line\nfourth line");
    const grownHeight = (await roomInput.boundingBox())?.height ?? 0;
    expect(grownHeight).toBeGreaterThan(idleHeight);
    await roomInput.fill("");

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

    // The room's composer is back to one row and empty.
    await first.page.getByTestId("working").waitFor({ state: "detached", timeout: 20_000 });
    expect(await roomInput.inputValue()).toBe("");
    expect((await roomInput.boundingBox())?.height ?? 0).toBe(idleHeight);

    // Authority is rendered from the server's own snapshot. The room header
    // keeps who holds the baton; who is here lives in the panel's own header.
    const controller = first.page.getByTestId("controller");
    await controller.waitFor();
    // Control is *named*, not marked (D-047): the sentence is the signature,
    // and the filled square that used to sit beside it said nothing this does
    // not — it was just the loudest thing in the window.
    expect(await controller.textContent()).toContain("baton");
    expect(await first.page.getByTestId("baton").count()).toBe(0);

    // The state line names a PRODUCT.md state and what happens next.
    const stateLine = first.page.getByTestId("state-line");
    await stateLine.waitFor();
    const stateText = (await stateLine.textContent()) ?? "";
    expect(stateText.length).toBeGreaterThan(0);

    await first.page.screenshot({ path: join(evidenceDir, "9-project-shell.png") });

    // Verification is honest when nothing ran.
    await first.page.getByTestId("panel-toggle").click();
    await first.page.getByTestId("inspector").waitFor();
    await first.page.getByTestId("inspector-tab-verification").click();
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

    // Overview holds the machinery the header must never carry. The workspace
    // drawer opens on it already; clicking the tab again would fold it away.
    await first.page.getByTestId("ws-branch").waitFor();
    expect(await first.page.getByTestId("ws-base").textContent()).toContain(headSha.slice(0, 8));
    await first.page.screenshot({ path: join(evidenceDir, "17-inspector-overview.png") });

    // Escape closes the panel. It is docked rather than modal, so focus is not
    // yanked back to a trigger — it stays where the reader left it.
    await first.page.keyboard.press("Escape");
    await first.page.getByTestId("inspector").waitFor({ state: "detached" });

    // Narrow: single column, nothing clipped, nothing below the fold.
    await resizeWindow(first.app, 860, 700);
    await first.page.getByTestId("state-line").waitFor();
    await first.page.getByTestId("composer-input").waitFor();
    await first.page.screenshot({ path: join(evidenceDir, "18-room-narrow.png") });
    await resizeWindow(first.app, 1440, 900);

    // The evidence panel is docked, not modal: opening it leaves the trace
    // visible beside it, and one control in the top bar both opens and closes.
    const panel = first.page.getByTestId("inspector");
    const panelToggle = first.page.getByTestId("panel-toggle");
    expect(await panel.count()).toBe(0);
    await panelToggle.click();
    await panel.waitFor({ timeout: 10_000 });
    expect(await first.page.getByTestId("msg-user").first().isVisible()).toBe(true);
    expect(await first.page.getByTestId("inspector-scrim").count()).toBe(0);
    await first.page.screenshot({ path: join(evidenceDir, "19-panel-docked.png") });
    await panelToggle.click();
    await panel.waitFor({ state: "detached", timeout: 10_000 });

    // The panel has no identity header of its own (D-066): who holds the baton
    // is the room's sentence, said once beneath the mission title, and who is
    // here is read in Overview. A second copy at the top of the panel competed
    // with the panel's own subject.
    await panelToggle.click();
    await panel.waitFor({ timeout: 10_000 });
    expect(await first.page.getByTestId("panel-controller").count()).toBe(0);
    await first.page.getByTestId("controller").waitFor();
    await first.page.getByTestId("participant-list").waitFor();
    await first.page.getByTestId("inspector-tab-changes").click();
    await first.page.getByTestId("inspector-changes").waitFor();
    await first.page.getByTestId("inspector-close").click();
    await panel.waitFor({ state: "detached", timeout: 10_000 });

    // Identity sits at the foot of the rail, not in the top-right corner.
    await first.page.getByTestId("sign-out").waitFor();

    // Disclosure is the whole project row, not only the arrow beside it.
    const missionRows = first.page.getByTestId("mission-row");
    expect(await missionRows.count()).toBeGreaterThan(0);
    await first.page.getByTestId("project-row").filter({ hasText: repoName }).click();
    await expect.poll(async () => missionRows.count(), { timeout: 10_000 }).toBe(0);
    await first.page.getByTestId("project-row").filter({ hasText: repoName }).click();
    await expect.poll(async () => missionRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    // And the arrow alone still works, independently of selection.
    await first.page.getByTestId("project-twisty").first().click();
    await expect.poll(async () => missionRows.count(), { timeout: 10_000 }).toBe(0);
    await first.page.getByTestId("project-twisty").first().click();
    await expect.poll(async () => missionRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    await first.app.close();

    // Relaunch: the entire conversation reconstructs from the server.
    const second = await launchApp();
    await second.page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await openProject(second.page, repoName);

    const tab = second.page.getByTestId("mission-row").filter({ hasText: "add a fake turn file" });
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

/**
 * The workspace runtime's interface (D-040 … D-042).
 *
 * Everything here runs against a real project on this machine: a real
 * inspection of a real worktree, a real `.novus/settings.toml`, and a real
 * gitignored file that is copied only after that one file is confirmed. The
 * one synthetic part is the stale check, because staleness is a fact about a
 * revision the workstream has moved past; it is written to the database and
 * read back through the server's own projection, so what the ledger renders is
 * a real `VerificationCheck`.
 */
describe("the workspace runtime", () => {
  it("proposes what the project says, copies a named file only on consent, then offers the declared commands", async () => {
    // A real project: a manifest with scripts, a lockfile that names the
    // package manager, and one gitignored file it needs to run.
    const repoDir = mkdtempSync(join(tmpdir(), "novus-runtime-repo-"));
    runtimeRepoName = basename(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    writeFileSync(
      join(repoDir, "package.json"),
      `${JSON.stringify(
        {
          name: "demo-web",
          packageManager: "pnpm@10.12.1",
          scripts: { dev: "sleep 45", test: "echo ok", lint: "echo ok" }
        },
        null,
        2
      )}\n`
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(repoDir, ".gitignore"), ".env\n");
    writeFileSync(join(repoDir, ".env.example"), "TOKEN=\n");
    writeFileSync(join(repoDir, "README.md"), "# demo-web\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const headSha = git(repoDir, ["rev-parse", "HEAD"]);
    // Ignored, and on this machine only: its name may be shown, its contents
    // may not (D-041).
    writeFileSync(join(repoDir, ".env"), "TOKEN=super-secret-value\n");

    const localId = randomUUID();
    const token = await mintToken();
    const registered = await fetch(`${CP_URL}/repositories/local`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId, name: runtimeRepoName, defaultBranch: "main", headSha })
    });
    expect(registered.ok).toBe(true);
    // The earlier repository is still on this machine; only this one is added.
    const mapPath = join(userDataDir, "local-repos.json");
    let mapping: Record<string, string> = {};
    try {
      mapping = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string>;
    } catch {
      /* first repository on this machine */
    }
    writeFileSync(mapPath, JSON.stringify({ ...mapping, [localId]: repoDir }));

    const { app, page } = await launchApp();
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    const projectRow = page.getByTestId("project-row").filter({ hasText: runtimeRepoName });
    await projectRow.waitFor({ timeout: 20_000 });
    // One real turn, so the ledger has an actual revision to prove later —
    // asked through the ask-dialog (D-077).
    const parentRow = page.locator(".side-parent", { has: projectRow });
    await parentRow.hover();
    await parentRow.getByTestId("repo-new-mission").click();
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 20_000 });
    await page
      .getByTestId("new-mission-dialog")
      .getByTestId("composer-input")
      .fill("add a fake turn file");
    await page.keyboard.press("Enter");
    expect(await page.getByTestId("send-error").count()).toBe(0);
    await page.getByTestId("new-mission-dialog").waitFor({ state: "detached", timeout: 30_000 });
    await page
      .getByTestId("trace-outcome")
      .filter({ hasText: "Turn completed" })
      .waitFor({ timeout: 60_000 });
    runtimeMissionId = await page.evaluate(async (id) => {
      const result = await window.novus.missions.list();
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value.find((mission) => mission.repository?.providerRepoId === id)?.missionId ?? "";
    }, localId);
    expect(runtimeMissionId).toMatch(/^msn_/);

    // A second workstream with no execution — what a room looks like before
    // anything has said how this project installs, runs, or verifies itself.
    const freshGoal = "Prepare the runtime";
    const freshMissionId = await page.evaluate(
      async (args) => {
        const base = await window.novus.repos.baseLocal(args.localId);
        if (!base.ok) throw new Error(`${base.code}: ${base.message}`);
        const created = await window.novus.missions.create({
          goal: args.goal,
          successCriteria: "The project says how to install, run, and verify itself",
          provider: "local",
          providerRepoId: args.localId,
          baseRef: base.value.ref,
          baseSha: base.value.sha,
          creationKey: args.creationKey
        });
        if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
        return created.value.mission.missionId;
      },
      { localId, goal: freshGoal, creationKey: randomUUID() }
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await openProject(page, runtimeRepoName);
    // The active mission's row toggles its tree since D-134 (amended), so
    // "make sure it is open" must not blind-click an already-active row.
    const missionRow = page.getByTestId("mission-row").filter({ hasText: freshGoal });
    if (!(((await missionRow.getAttribute("class")) ?? "").includes("active-mission"))) {
      await missionRow.click();
    }

    // --- The state names what is missing, and offers one action -------------
    const stateLine = page.getByTestId("state-line");
    await expect
      .poll(async () => (await stateLine.textContent()) ?? "", { timeout: 30_000 })
      .toContain("Workspace needs setup");
    await page.getByTestId("state-setup").waitFor();
    expect(await page.getByTestId("state-setup").textContent()).toBe("Set up workspace");
    // Exactly one action in the line: the state has one next step, not two.
    expect(await page.getByTestId("state-action").count()).toBe(0);
    expect(await page.getByTestId("stop").count()).toBe(0);

    // --- Nothing is declared yet, so nothing in the menu is invokable -------
    const runControl = page.getByTestId("run-control");
    await runControl.click();
    await page.getByTestId("run-menu").waitFor();
    await expect
      .poll(async () => page.getByTestId("run-suggested").count(), { timeout: 20_000 })
      .toBe(4);
    expect(await page.getByTestId("run-item").count()).toBe(0);
    const suggestions = await page.getByTestId("run-suggested").allTextContents();
    expect(suggestions[0]).toContain("pnpm install");
    expect(suggestions.join(" ")).toContain("suggested");
    // A suggestion never runs: it opens the dialog, where a person confirms it.
    await page.getByTestId("run-suggested").first().click();

    const dialog = page.getByTestId("workspace-setup");
    await dialog.waitFor();
    await page.getByTestId("setup-detected").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("setup-project-type").textContent()).toContain("Node.js (pnpm)");
    expect(await page.getByTestId("setup-command").inputValue()).toBe("pnpm install");
    const runCommands = page.getByTestId("setup-run-command");
    expect(await runCommands.count()).toBe(1);
    expect(await runCommands.first().inputValue()).toBe("pnpm run dev");
    const verifyCommands = page.getByTestId("setup-verify-command");
    expect(await verifyCommands.count()).toBe(2);

    // Filenames and three facts — never a byte of what is in them (D-041).
    const fileRow = page.getByTestId("local-file");
    expect(await fileRow.count()).toBe(1);
    const fileText = (await fileRow.textContent()) ?? "";
    expect(fileText).toContain(".env");
    expect(fileText).toContain("Git ignores it");
    expect(fileText).toContain("not in the workspace yet");
    expect((await dialog.textContent()) ?? "").not.toContain("super-secret-value");
    await page.screenshot({ path: join(evidenceDir, "40-workspace-setup.png") });

    // Opening it ran nothing: no configuration written, no file copied, no
    // process, no execution.
    // Worktrees are keyed by workstream, not mission (D-074).
    const freshWorkstreamId = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return result.value.workstream?.workstreamId ?? "";
    }, freshMissionId);
    expect(freshWorkstreamId).toMatch(/^wst_/);
    const worktree = join(userDataDir, "worktrees", freshWorkstreamId);
    expect(existsSync(join(worktree, ".novus", "settings.toml"))).toBe(false);
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    const afterOpen = await page.evaluate(async (id) => {
      const result = await window.novus.missions.get(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return {
        processes: result.value.processes.length,
        executions: result.value.executions.length,
        state: result.value.state
      };
    }, freshMissionId);
    expect(afterOpen.processes).toBe(0);
    expect(afterOpen.executions).toBe(0);
    expect(afterOpen.state).toBe("workspace_needs_setup");

    // --- One file, one confirmation -----------------------------------------
    await page.getByTestId("file-supply").click();
    const confirm = page.getByTestId("file-confirm");
    await confirm.waitFor();
    expect(await confirm.textContent()).toContain("reads its name, never its contents");
    await page.screenshot({ path: join(evidenceDir, "41-local-file-consent.png") });
    // Asking is not consenting: still nothing has moved.
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    await page.getByTestId("file-confirm-yes").click();
    await page.getByTestId("file-copied").waitFor({ timeout: 20_000 });
    // The copy is real, and it happened on this machine only.
    expect(readFileSync(join(worktree, ".env"), "utf8")).toContain("super-secret-value");

    // --- Editable before saving, and only saving writes anything ------------
    await runCommands.first().fill("sleep 45");
    await verifyCommands.first().fill("echo verified");
    await page.getByTestId("scope-shared").click();
    await page.getByTestId("setup-save").click();
    await page.getByTestId("setup-saved").waitFor({ timeout: 20_000 });
    const written = readFileSync(join(worktree, ".novus", "settings.toml"), "utf8");
    expect(written).toContain("sleep 45");
    expect(written).toContain("echo verified");
    await page.getByTestId("setup-close").click();
    await dialog.waitFor({ state: "detached" });

    // --- Now the Run control offers exactly what the project declared -------
    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor();
    await expect.poll(async () => page.getByTestId("run-item").count(), { timeout: 20_000 }).toBe(4);
    expect(await page.getByTestId("run-suggested").count()).toBe(0);
    const declared = await page.getByTestId("run-item").allTextContents();
    expect(declared[0]).toContain("Setup");
    expect(declared[1]).toContain("dev");
    expect(declared[1]).toContain("default");
    expect(declared.join(" ")).toContain("echo verified");
    // Every one of them is a capability-gated request, not a local action.
    expect(await page.locator('[data-testid="run-item"][data-capability="workspace.command"]').count()).toBe(4);
    expect(await page.locator('[data-testid="run-item"][data-permitted="true"]').count()).toBe(4);
    await page.screenshot({ path: join(evidenceDir, "42-run-control.png") });

    // --- A live run collapses the control to that command and Stop ----------
    await page.getByTestId("run-item").nth(1).click();
    const live = page.getByTestId("run-live");
    await live.waitFor({ timeout: 45_000 });
    expect(await live.textContent()).toContain("dev");
    // Open preview appears only when the process itself reported an address.
    // This one did, because Novus allocated it a port and said so.
    const reportedPreview = await page.evaluate(async (id) => {
      const result = await window.novus.missions.get(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value.processes.find((process) => process.kind === "run")?.previewUrl ?? null;
    }, freshMissionId);
    expect(reportedPreview).toContain("http://localhost:");
    expect(await page.getByTestId("open-preview").count()).toBe(1);
    await expect
      .poll(async () => (await stateLine.textContent()) ?? "", { timeout: 30_000 })
      .toContain("App running");
    await page.screenshot({ path: join(evidenceDir, "44-project-running.png") });

    // Stopping it is the same capability, and the control comes back.
    const stopRun = page.getByTestId("stop-run");
    expect(await stopRun.getAttribute("data-capability")).toBe("workspace.command");
    await stopRun.click();
    await page.getByTestId("run-control").waitFor({ timeout: 45_000 });

    // --- Verification is honest before anything has run ---------------------
    await page.getByTestId("panel-toggle").click();
    await page.getByTestId("inspector-tab-verification").click();
    const runVerification = page.getByTestId("run-verification");
    await runVerification.waitFor();
    expect(await runVerification.getAttribute("data-capability")).toBe("workspace.command");
    expect(await runVerification.getAttribute("data-permitted")).toBe("true");
    expect(await page.getByTestId("checks-empty").textContent()).toContain("No checks observed");

    await app.close();
  });

  it("dims a stale check, says what it proved, and keeps it out of the passing tally", async () => {
    expect(runtimeMissionId).toMatch(/^msn_/);
    const rows = await sql(
      `select sha from checkpoints
        where mission_id = $1 and sha is not null
        order by created_at desc limit 1`,
      [runtimeMissionId]
    );
    const currentSha = rows[0]?.sha as string | undefined;
    expect(currentSha).toBeTruthy();

    // A check that proved a revision the workstream has moved past.
    await recordCheck({
      missionId: runtimeMissionId,
      name: "unit tests",
      origin: "participant",
      outcome: "passed",
      command: "pnpm test",
      checkpointSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      exitCode: 0,
      durationMs: 8_420,
      byCreator: true
    });

    const { app, page } = await launchApp();
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    // A relaunch reopens the missions this machine left open, so the room is
    // whichever one was last being read. The mission this test is about is
    // named rather than assumed — and named inside its own project, because
    // two repositories here were given the same first direction.
    await openProject(page, runtimeRepoName);
    await page
      .locator(".side-group", {
        has: page.getByTestId("project-row").filter({ hasText: runtimeRepoName })
      })
      .getByTestId("mission-row")
      .filter({ hasText: "add a fake turn file" })
      .click();
    const stateLine = page.getByTestId("state-line");
    // Everything that was proved is history, and the room says exactly that.
    await expect
      .poll(async () => (await stateLine.textContent()) ?? "", { timeout: 30_000 })
      .toContain("Verification stale");

    // Now one that proves the revision that is actually there.
    await recordCheck({
      missionId: runtimeMissionId,
      name: "typecheck",
      origin: "harness",
      outcome: "passed",
      command: "pnpm typecheck",
      checkpointSha: currentSha ?? null,
      exitCode: 0,
      durationMs: 3_100,
      byCreator: false
    });
    await expect
      .poll(async () => (await stateLine.textContent()) ?? "", { timeout: 30_000 })
      .toContain("Ready for review");
    // Two checks are recorded; exactly one of them counts.
    expect(await stateLine.textContent()).toContain("1 check passed");

    await page.getByTestId("panel-toggle").click();
    await page.getByTestId("inspector-tab-verification").click();
    await page.getByTestId("ledger").waitFor({ timeout: 15_000 });
    await expect.poll(async () => page.getByTestId("ledger-entry").count(), { timeout: 15_000 }).toBe(2);

    const stale = page.locator('[data-testid="ledger-entry"][data-stale="true"]');
    expect(await stale.count()).toBe(1);
    const staleText = (await stale.textContent()) ?? "";
    expect(staleText).toContain("unit tests");
    expect(staleText).toContain("since changed");
    expect(staleText).toContain("deadbeef");
    // Origin and cost are on the row, not implied.
    expect(staleText).toContain("Run by");
    expect(staleText).toContain("exit 0");
    const current = page.locator('[data-testid="ledger-entry"][data-stale="false"]');
    expect(await current.textContent()).toContain("Observed from Claude Code");

    // The summary counts the current one only.
    const summary = (await page.getByTestId("checks-summary").textContent()) ?? "";
    expect(summary).toContain("1 check passed");
    expect(summary).toContain("1 proved an earlier revision");

    // Dimmed, not merely labelled — and resolved against the tokens themselves
    // rather than their current values, so this keeps its meaning if a token
    // changes and fails if the row stops reading from one (DESIGN.md#tokens).
    const tokenColor = (token: string) =>
      page.evaluate((name) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      }, token);
    const faint = await tokenColor("--text-3");
    const verified = await tokenColor("--ok");

    const colorOf = (row: typeof stale, part: string) =>
      row.locator(part).evaluate((element) => getComputedStyle(element).color);

    expect(await colorOf(stale, ".ledger-name")).toBe(faint);
    expect(await colorOf(stale, ".ledger-outcome")).toBe(faint);
    // Sage is for verified evidence only, so a stale pass must not wear it.
    expect(await colorOf(stale, ".ledger-outcome")).not.toBe(verified);
    expect(await colorOf(current, ".ledger-outcome")).toBe(verified);

    await page.screenshot({ path: join(evidenceDir, "43-verification-ledger.png") });
    await app.close();
  });

  it("disables a declared command for a participant without the capability, and says where a workspace can be prepared", async () => {
    expect(runtimeMissionId).toMatch(/^msn_/);
    const token = await mintToken();
    const invited = await fetch(`${CP_URL}/missions/${runtimeMissionId}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: "contributor" })
    });
    expect(invited.ok).toBe(true);
    const invitation = (await invited.json()) as { token: string };

    // A second person, on a machine with no checkout of this repository.
    const mayaDir = mkdtempSync(join(tmpdir(), "novus-e2e-maya-"));
    const { app, page } = await launchApp({ dataDir: mayaDir, identity: "maya" });
    await page.getByTestId("setup").waitFor();
    await page.getByTestId("sign-in-button").click();
    await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
    await page.getByTestId("finish-setup").click();
    await page.getByTestId("project-shell").waitFor();
    await page.getByTestId("join-mission").click();
    await page.getByTestId("join-token").fill(invitation.token);
    await page.getByTestId("join-submit").click();
    await page.getByTestId("join-dialog").waitFor({ state: "detached", timeout: 20_000 });

    const projectRow = page.getByTestId("project-row").filter({ hasText: runtimeRepoName });
    await projectRow.waitFor({ timeout: 20_000 });
    await projectRow.click();

    // The action stays visible and disabled, and names the capability it needs
    // (DESIGN.md#transient-states; AGENTS.md rule 13 — the server enforces it
    // regardless of what this button looks like).
    await page.getByTestId("panel-toggle").click();
    await page.getByTestId("inspector-tab-verification").click();
    const runVerification = page.getByTestId("run-verification");
    await runVerification.waitFor();
    await expect
      .poll(async () => runVerification.getAttribute("data-permitted"), { timeout: 20_000 })
      .toBe("false");
    expect(await runVerification.isDisabled()).toBe(true);
    expect(await runVerification.getAttribute("title")).toContain("workspace.command");

    // And the workspace itself can only be prepared where the repository is.
    await page.getByTestId("inspector-close").click();
    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu-setup").click();
    const elsewhere = page.getByTestId("setup-elsewhere");
    await elsewhere.waitFor();
    const elsewhereText = (await elsewhere.textContent()) ?? "";
    expect(elsewhereText).toContain("only be prepared on the machine that holds the repository");
    expect(elsewhereText).toContain("not access to that machine");
    // Nothing to write from here, so there is no control offering to.
    expect(await page.getByTestId("setup-save").count()).toBe(0);
    // Named for what it actually shows. The local-file consent frame needs a
    // real proposal, so it belongs to the change that lands the runner half.
    await page.screenshot({ path: join(evidenceDir, "41-workspace-elsewhere.png") });

    await app.close();
  });
});
