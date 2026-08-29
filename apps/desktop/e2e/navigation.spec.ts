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
 * The working set, through the interface.
 *
 * The projects rail lists every mission of every project, once (D-055). This
 * suite is about the other list — the missions somebody currently has *open* —
 * and about the ways a mission gets started. The faults it exists to catch are
 * the ones only a real window shows: a second tab for a mission that is already
 * open, a close that quietly stops a harness, a relaunch that will not start
 * because one restored mission has since been deleted, a `+` that collapses the
 * row it sits on, and a strip that pushes the shell sideways when the window
 * gets narrow.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4496;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_navigation";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let app: ElectronApplication;
let page: Page;
let alphaName = "";
let betaName = "";
let alphaId = "";
let betaId = "";
/** The mission a real harness turn runs in, created through the composer. */
let runningMissionId = "";
const RUNNING_GOAL = "a turn that keeps running";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

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

async function mintToken(as?: string): Promise<string> {
  const started = await fetch(`${CP_URL}/auth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(as ? { as } : {})
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

/** Direct SQL, for the one fact this suite cannot manufacture by running
 *  anything: a check that failed against the revision the worktree is on, which
 *  is what puts a mission into the rail's attention lens. It is written the way
 *  a runner writes one and read back through the server's own projection. */
async function sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: DB_URL });
  try {
    return (await pool.query(text, params)).rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}

async function launch(dataDir: string, paceMs?: number): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_CONNECTORS: "[]",
      NOVUS_USER_DATA_DIR: dataDir,
      ...(paceMs ? { NOVUS_FAKE_HARNESS_PACE_MS: String(paceMs) } : {})
    }
  });
  const window = await launched.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await resizeWindow(launched, 1440, 900);
  return { app: launched, page: window };
}

/** The room is a resizable window, so the responsive rules are proved by
 *  resizing the real window rather than a browser viewport. */
async function resizeWindow(target: ElectronApplication, width: number, height: number): Promise<void> {
  await target.evaluate(async ({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await new Promise((settle) => setTimeout(settle, 300));
}

async function signIn(target: Page): Promise<void> {
  await target.getByTestId("setup").waitFor({ timeout: 30_000 });
  await target.getByTestId("sign-in-button").click();
  await target.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await target.getByTestId("finish-setup").click();
  await target.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

/** One project's own block in the rail: its row, its missions, and its New
 *  mission. Scoped, because more than one project can be open at once and an
 *  unscoped `mission-row` then means "somebody's mission". */
const projectGroup = (target: Page, name: string) =>
  target.locator(".side-group", {
    has: target.getByTestId("project-row").filter({ hasText: name })
  });

/**
 * Opens a project in the rail so its missions are disclosed.
 *
 * The row *toggles*, and the shell selects a project on mount, so a plain click
 * is as likely to close it as to open it.
 */
async function openProject(target: Page, name: string): Promise<void> {
  const group = projectGroup(target, name);
  await group.waitFor({ timeout: 30_000 });
  if ((await group.getByTestId("mission-row").count()) === 0) {
    await group.getByTestId("project-row").click();
  }
  await group.getByTestId("mission-row").first().waitFor({ timeout: 30_000 });
}

/** A repository on this machine, registered with the control plane and mapped
 *  into the app's own machine-local store. */
async function makeRepo(token: string, mapping: Record<string, string>): Promise<{
  name: string;
  localId: string;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "novus-nav-repo-"));
  const name = basename(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]);
  const localId = randomUUID();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  mapping[localId] = dir;
  return { name, localId, dir };
}

/** Creates a mission without going through the room, so a test about tabs is
 *  not also a test about harnesses. */
async function seedMission(target: Page, localId: string, goal: string): Promise<string> {
  return target.evaluate(
    async (args) => {
      const base = await window.novus.repos.baseLocal(args.localId);
      if (!base.ok) throw new Error(`${base.code}: ${base.message}`);
      const created = await window.novus.missions.create({
        goal: args.goal,
        successCriteria: `${args.goal} — seeded by the working-set suite`,
        provider: "local",
        providerRepoId: args.localId,
        baseRef: base.value.ref,
        baseSha: base.value.sha,
        creationKey: args.creationKey
      });
      if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
      return created.value.mission.missionId;
    },
    { localId, goal, creationKey: randomUUID() }
  );
}

const storageKey = (target: Page) =>
  target.evaluate(async () => {
    const status = await window.novus.auth.status();
    if (status.state !== "signed_in") throw new Error("not signed in");
    return `novus-open-missions:${status.user.userId}`;
  });

/** Closes every open mission, so a test starts from a working set it chose. */
async function closeEveryTab(target: Page): Promise<void> {
  for (let guard = 0; guard < 30; guard += 1) {
    const closes = target.getByTestId("mission-tab-close");
    if ((await closes.count()) === 0) return;
    await closes.first().click();
  }
  throw new Error("the working set would not empty");
}

const tabLabels = (target: Page): Promise<string[]> =>
  target.getByTestId("mission-tab-open").allInnerTexts();

async function missionIdByGoal(target: Page, goal: string): Promise<string> {
  return target.evaluate(async (wanted) => {
    const result = await window.novus.missions.list();
    if (!result.ok) throw new Error(result.message);
    return result.value.find((mission) => mission.goal === wanted)?.missionId ?? "";
  }, goal);
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-nav-"));

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

  // Two real repositories on this machine, so "missions from two projects at
  // once" is two projects and not a fixture pretending to be.
  const token = await mintToken();
  const mapping: Record<string, string> = {};
  const alpha = await makeRepo(token, mapping);
  const beta = await makeRepo(token, mapping);
  alphaName = alpha.name;
  betaName = beta.name;
  alphaId = alpha.localId;
  betaId = beta.localId;
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify(mapping));

  // ~2s a line: long enough that a turn is still running when a tab is closed.
  const launched = await launch(userDataDir, 2_000);
  app = launched.app;
  page = launched.page;
  await signIn(page);

  await seedMission(page, alphaId, "Alpha one");
  await seedMission(page, alphaId, "Alpha two");
  await seedMission(page, betaId, "Beta one");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the missions a person has open", () => {
  it("opens two from one project and one from another, reuses a tab, and never mirrors the rail", async () => {
    await closeEveryTab(page);
    // With every tab closed and missions existing, the canvas is the Home
    // board (D-120) — the old no-mission-open empty state survives only for
    // a project with no missions anywhere.
    await page.getByTestId("home-board").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("mission-strip").count()).toBe(0);

    // Two missions of one project, open at the same time.
    await openProject(page, alphaName);
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await page.getByTestId("mission-strip").waitFor({ timeout: 20_000 });
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha two" }).click();
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 20_000 }).toBe(2);
    expect((await tabLabels(page)).join("|")).toContain("Alpha one");
    expect((await tabLabels(page)).join("|")).toContain("Alpha two");

    // Every tab names its project, whether or not a second project is open
    // (D-066): a label that appears and disappears as siblings come and go
    // makes a tab's meaning depend on its neighbours.
    expect(await page.locator(".mission-tab-project").count()).toBe(
      await page.getByTestId("mission-tab").count()
    );

    // Selecting a mission that is already open moves to its tab rather than
    // making a second one.
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await expect
      .poll(async () => page.locator('[data-testid="mission-tab"][data-active="true"]').innerText(), {
        timeout: 20_000
      })
      .toContain("Alpha one");
    expect((await tabLabels(page)).length).toBe(2);
    // The room does not restate the goal (D-127): the active tab above is the
    // canvas's naming, and the room's own presence is its state line.
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });

    // The rail is not this list and this list is not the rail: every mission is
    // in the rail exactly once, open or not.
    expect(
      await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).count()
    ).toBe(1);
    expect(await projectGroup(page, alphaName).getByTestId("mission-row").count()).toBe(2);

    // A mission from a different project, open beside them. Now a tab says
    // which project it is in, because that has become a live question.
    await openProject(page, betaName);
    await projectGroup(page, betaName).getByTestId("mission-row").filter({ hasText: "Beta one" }).click();
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 20_000 }).toBe(3);
    await expect
      .poll(async () => page.locator(".mission-tab-project").count(), { timeout: 20_000 })
      .toBe(3);
    const projectsNamed = await page.locator(".mission-tab-project").allInnerTexts();
    expect(projectsNamed.join("|")).toContain(betaName.slice(0, 12));

    // Mission tabs are not file tabs: nothing has opened a file, so the room
    // carries no strip of its own (D-048, D-055).
    expect(await page.locator(".tabbar").count()).toBe(0);
    expect(await page.getByTestId("room-tab").count()).toBe(0);

    await shot(page, "63-working-set-two-projects.png");

    // ⌃⇥ moves you INTO the next project (D-212, as the owner locked it in):
    // Beta one is on screen; one press lands in Alpha — wrapping, since Alpha
    // is first — on the room last read there, which was Alpha one.
    const selectedProject = () =>
      page.locator('[data-testid="project-row"][aria-current="true"]').innerText();
    const activeLabel = () =>
      page.locator('[data-testid="mission-tab"][data-active="true"]').innerText();
    await expect.poll(selectedProject, { timeout: 20_000 }).toContain(betaName.slice(0, 12));
    // Fold Alpha first, so the press also has to disclose it.
    await projectGroup(page, alphaName).getByTestId("project-twisty").click();
    await expect
      .poll(() => projectGroup(page, alphaName).getByTestId("project-twisty").getAttribute("aria-expanded"))
      .toBe("false");
    await page.keyboard.press("Control+Tab");
    await expect.poll(activeLabel, { timeout: 10_000 }).toContain("Alpha one");
    await expect.poll(selectedProject, { timeout: 10_000 }).toContain(alphaName.slice(0, 12));
    await expect
      .poll(() => projectGroup(page, alphaName).getByTestId("project-twisty").getAttribute("aria-expanded"))
      .toBe("true");
    // ⌘1–9 aim at the project you are in: ⌘2 is Alpha's second mission.
    await page.keyboard.press("Meta+2");
    await expect.poll(activeLabel, { timeout: 10_000 }).toContain("Alpha two");
    expect((await tabLabels(page)).length).toBe(3);

    // A project with no room open gets its first mission opened: close Beta
    // one's tab, then walk back to Beta and land in it anyway.
    const betaTab = page.getByTestId("mission-tab").filter({ hasText: "Beta one" });
    await betaTab.hover();
    await betaTab.getByTestId("mission-tab-close").click();
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 10_000 }).toBe(2);
    await page.keyboard.press("Control+Shift+Tab");
    await expect.poll(activeLabel, { timeout: 10_000 }).toContain("Beta one");
    await expect.poll(selectedProject, { timeout: 10_000 }).toContain(betaName.slice(0, 12));
    expect((await tabLabels(page)).length).toBe(3);

    // The chord is on the Keyboard page like every other, labelled ⌃⇥ — the
    // one modifier a Tab chord can honestly be, since ⌘⇥ is the platform's.
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 });
    await page.locator(".settings-nav-item").filter({ hasText: "Keyboard" }).click();
    const pane = page.getByTestId("settings-pane");
    await expect.poll(() => pane.textContent(), { timeout: 10_000 }).toContain("next project in the rail");
    expect(await pane.textContent()).toContain("⌃⇥");
    expect(await pane.textContent()).toContain("⌃⇧⇥");
    await shot(page, "201-settings-keyboard.png");
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 10_000 });
  }, 180_000);

  it("closes a tab without stopping the mission, which keeps running and keeps its state in the rail", async () => {
    await closeEveryTab(page);
    await openProject(page, alphaName);
    // Starting a mission is a question, not a place (D-077): the + on the
    // repository row opens the ask-dialog, and the words create the mission.
    const alphaParent = page.locator(".side-parent", {
      has: page.getByTestId("project-row").filter({ hasText: alphaName })
    });
    await alphaParent.hover();
    await alphaParent.getByTestId("repo-new-mission").click();
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
    await page.getByTestId("new-mission-dialog").getByTestId("composer-input").fill(RUNNING_GOAL);
    await page.keyboard.press("Enter");
    await page.getByTestId("new-mission-dialog").waitFor({ state: "detached", timeout: 30_000 });

    // The harness is genuinely working before anything is closed.
    await page
      .getByTestId("msg-agent")
      .filter({ hasText: `Working on: ${RUNNING_GOAL}` })
      .waitFor({ timeout: 90_000 });
    runningMissionId = await missionIdByGoal(page, RUNNING_GOAL);
    expect(runningMissionId).toMatch(/^msn_/);

    const readMission = (id: string) =>
      page.evaluate(async (mission) => {
        const result = await window.novus.missions.get(mission);
        if (!result.ok) return null;
        return {
          state: result.value.state,
          events: result.value.events.length,
          executions: result.value.executions.map((execution) => execution.state)
        };
      }, id);

    const beforeClose = await readMission(runningMissionId);
    expect(beforeClose?.executions.at(-1)).toMatch(/requested|starting|running/);

    // Close the room. This is the whole act being tested.
    await page
      .getByTestId("mission-tab")
      .filter({ hasText: RUNNING_GOAL.slice(0, 14) })
      .getByTestId("mission-tab-close")
      .click();
    await expect
      .poll(async () => (await tabLabels(page)).join("|"), { timeout: 20_000 })
      .not.toContain(RUNNING_GOAL.slice(0, 14));

    // Nothing was stopped: the execution is still alive and still producing
    // events with no room open on it anywhere.
    const duringClose = await readMission(runningMissionId);
    expect(duringClose?.executions.at(-1)).toMatch(/requested|starting|running/);
    await expect
      .poll(async () => (await readMission(runningMissionId))?.events ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(beforeClose?.events ?? 0);

    // And the rail never stopped listing it.
    expect(
      await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: RUNNING_GOAL.slice(0, 14) }).count()
    ).toBe(1);

    // It runs to completion while closed, and reopening finds the finished turn
    // rather than a room that was frozen when its tab went away.
    await expect
      .poll(async () => (await readMission(runningMissionId))?.executions.at(-1) ?? "", {
        timeout: 120_000
      })
      .toBe("completed");
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: RUNNING_GOAL.slice(0, 14) }).click();
    await page
      .getByTestId("trace-outcome")
      .filter({ hasText: "Turn completed" })
      .waitFor({ timeout: 30_000 });

    // The rail also keeps *reporting* a mission whose tab is closed. A failed
    // check against the revision the worktree is on is what a mission needing
    // somebody looks like, and the attention lens is where the rail says so.
    const checkpoints = await sql(
      `select sha from checkpoints where mission_id = $1 and sha is not null
        order by created_at desc limit 1`,
      [runningMissionId]
    );
    const currentSha = checkpoints[0]?.sha as string | undefined;
    expect(currentSha).toBeTruthy();
    const mission = (
      await sql("select org_id from missions where mission_id = $1", [runningMissionId])
    )[0];
    await sql(
      `insert into verification_checks
         (chk_id, org_id, mission_id, exe_id, name, category, outcome, origin, requested_by, command,
          exit_code, output, truncated, environment, started_at, completed_at, duration_ms,
          checkpoint_sha, observed_at)
       values ($1, $2, $3, null, 'unit', 'test', 'failed', 'participant', null, 'pnpm test',
               1, null, false, 'local worktree', now() - interval '1 minute', now(), 900, $4, now())`,
      [`chk_${randomUUID().replace(/-/g, "")}`, mission?.org_id, runningMissionId, currentSha]
    );

    await closeEveryTab(page);
    await expect
      .poll(async () => page.getByTestId("attention-row").allInnerTexts(), { timeout: 60_000 })
      .toContainEqual(expect.stringContaining(RUNNING_GOAL.slice(0, 14)));
    await shot(page, "64-attention-with-no-tab-open.png");
  }, 300_000);

  it("restores the open missions across a relaunch, and drops the ones the server refuses", async () => {
    await closeEveryTab(page);
    await openProject(page, alphaName);
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha two" }).click();
    await openProject(page, betaName);
    await projectGroup(page, betaName).getByTestId("mission-row").filter({ hasText: "Beta one" }).click();
    // Come back to the middle one, so the *selection* has something to restore.
    await page.getByTestId("mission-tab-open").filter({ hasText: "Alpha two" }).click();
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 20_000 }).toBe(3);

    await app.close();
    const relaunched = await launch(userDataDir, 2_000);
    app = relaunched.app;
    page = relaunched.page;
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });

    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 30_000 }).toBe(3);
    expect((await tabLabels(page)).join("|")).toContain("Beta one");
    await expect
      .poll(async () => page.locator('[data-testid="mission-tab"][data-active="true"]').innerText(), {
        timeout: 20_000
      })
      .toContain("Alpha two");
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });
    await shot(page, "65-restored-working-set.png");

    // Now the two ways a restored mission can be unopenable. One never existed;
    // the other exists and belongs to somebody else's organization, which this
    // server answers for identically and deliberately — a mission you cannot
    // see does not exist for you.
    const otherToken = await mintToken("maya");
    const available = (await (
      await fetch(`${CP_URL}/repositories/available`, {
        headers: { authorization: `Bearer ${otherToken}` }
      })
    ).json()) as { repositories: { providerRepoId: string }[] };
    const otherRepo = available.repositories[0]?.providerRepoId;
    expect(otherRepo).toBeTruthy();
    const otherBase = (await (
      await fetch(`${CP_URL}/repositories/available/${encodeURIComponent(otherRepo!)}/base`, {
        headers: { authorization: `Bearer ${otherToken}` }
      })
    ).json()) as { ref: string; sha: string };
    const otherMission = (await (
      await fetch(`${CP_URL}/missions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({
          goal: "Somebody else's mission",
          successCriteria: "It is not visible from this account",
          provider: "github",
          providerRepoId: otherRepo,
          baseRef: otherBase.ref,
          baseSha: otherBase.sha,
          creationKey: randomUUID()
        })
      })
    ).json()) as { mission?: { missionId: string } };
    expect(otherMission.mission?.missionId).toMatch(/^msn_/);

    const key = await storageKey(page);
    const alphaOneId = await missionIdByGoal(page, "Alpha one");
    const missing = `msn_${randomUUID().replace(/-/g, "")}`;
    await page.evaluate(
      (args) => {
        localStorage.setItem(
          args.key,
          JSON.stringify({
            missions: [
              { missionId: args.missing, projectKey: args.projectKey },
              { missionId: args.alphaOneId, projectKey: args.projectKey },
              { missionId: args.otherId, projectKey: args.projectKey }
            ],
            activeMissionId: args.missing
          })
        );
      },
      {
        key,
        missing,
        alphaOneId,
        otherId: otherMission.mission?.missionId ?? "",
        projectKey: `local:${alphaId}`
      }
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    // The shell renders. That is half the assertion: a restored mission the
    // server refuses must not be able to take the window down with it.
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 30_000 }).toBe(1);
    expect((await tabLabels(page))[0]).toContain("Alpha one");
    // Polled, not read instantly: the tab restores before the room's first
    // detail fetch lands, and a room still loading for a poll tick is
    // loading, not failure. The room announces itself by its state line
    // (D-127: the goal is the tab's and the rail's to name).
    await page.getByTestId("state-line").waitFor({ timeout: 30_000 });
    await shot(page, "66-restored-minus-the-refused.png");
  }, 300_000);
});

describe("starting a mission", () => {
  it("reveals a + on a repository row on hover and on keyboard focus, and never collapses the row", async () => {
    await closeEveryTab(page);
    await openProject(page, alphaName);

    const row = page.getByTestId("project-row").filter({ hasText: alphaName });
    const plus = page
      .locator(".side-parent", { has: page.getByTestId("project-row").filter({ hasText: alphaName }) })
      .getByTestId("repo-new-mission");
    await plus.waitFor({ timeout: 20_000 });

    // Named for what it does, in the repository it does it in.
    expect(await plus.getAttribute("aria-label")).toBe(`New mission in ${alphaName}`);
    expect(await plus.getAttribute("title")).toBe(`New mission in ${alphaName}`);

    const opacity = () => plus.evaluate((element) => getComputedStyle(element).opacity);
    /** Away from the rail entirely, so "not hovered" means it. */
    const lookAway = () => page.mouse.move(1_200, 820);

    // Quiet until asked for.
    await lookAway();
    await expect.poll(opacity, { timeout: 10_000 }).toBe("0");

    // On hover. The pointer is re-placed on each poll: the rail re-reads the
    // mission list on a timer, and a row replaced under a stationary pointer
    // does not always re-acquire :hover.
    await expect
      .poll(
        async () => {
          await row.hover();
          return opacity();
        },
        { timeout: 15_000 }
      )
      .toBe("1");

    // And on the keyboard, which is the half a hover-only control never has:
    // it is the next stop after the row itself, and it stays visible while it
    // holds focus rather than disappearing under the pointer that left.
    await row.focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "repo-new-mission"
    );
    await lookAway();
    await expect.poll(opacity, { timeout: 10_000 }).toBe("1");
    await shot(page, "67-repository-row-new-mission.png");

    // Pressing it asks the question and does nothing else (D-077): the row it
    // sits on is still open, and the missions it was showing are still showing.
    const missionsBefore = await projectGroup(page, alphaName).getByTestId("mission-row").count();
    expect(missionsBefore).toBeGreaterThan(0);
    const tabsBefore = (await tabLabels(page)).length;
    await plus.click();
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
    expect(await projectGroup(page, alphaName).getByTestId("mission-row").count()).toBe(missionsBefore);

    // Esc leaves nothing behind anywhere: no draft, no tab, no row.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.getByTestId("new-mission-dialog").count(), { timeout: 20_000 })
      .toBe(0);
    expect((await tabLabels(page)).length).toBe(tabsBefore);
  }, 180_000);

  it("starts one from the strip and from ⌘T, and the words create the mission (D-077)", async () => {
    await closeEveryTab(page);
    await openProject(page, alphaName);
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await expect.poll(async () => (await tabLabels(page)).length, { timeout: 20_000 }).toBe(1);

    // The strip's own + asks the question, in the repository the person is in.
    await page.getByTestId("strip-new-mission").click();
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("ask-project").innerText()).toContain(alphaName);
    // Nothing durable was created by asking, and Esc leaves nothing behind.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.getByTestId("new-mission-dialog").count(), { timeout: 20_000 })
      .toBe(0);
    expect((await tabLabels(page)).length).toBe(1);

    // ⌘T is the same act.
    const before = await page.evaluate(async () => {
      const result = await window.novus.missions.list();
      return result.ok ? result.value.length : -1;
    });
    await page.keyboard.press("Meta+t");
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });

    // The words create the mission and open its room, in a tab named by the
    // goal they derive — and a tab label is short, so this is what it carries.
    await page
      .getByTestId("new-mission-dialog")
      .getByTestId("composer-input")
      .fill("a mission started from the strip");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await tabLabels(page)).join("|"), { timeout: 60_000 })
      .toContain("a mission s");
    expect((await tabLabels(page)).length).toBe(2);
    const after = await page.evaluate(async () => {
      const result = await window.novus.missions.list();
      return result.ok ? result.value.length : -1;
    });
    expect(after).toBe(before + 1);
    await shot(page, "68-draft-became-a-mission.png");
  }, 240_000);

  it("dismissing the ask leaves nothing behind, and the empty state offers the way in", async () => {
    await closeEveryTab(page);
    await openProject(page, betaName);

    const before = await page.evaluate(async () => {
      const result = await window.novus.missions.list();
      return result.ok ? result.value.length : -1;
    });

    // The empty state asks for nothing to be hovered.
    await closeEveryTab(page);
    // Nothing left behind: no draft, no tab, no row — and since D-120 the
    // canvas with nothing open is the Home board rather than an empty page,
    // so "nothing open" is asserted as the strip's absence over the board.
    await page.getByTestId("home-board").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("mission-strip").count()).toBe(0);
    await shot(page, "69-nothing-open.png");
    // The way in from here is the rail's own + (D-077, D-120): the board is
    // missions that exist, and starting one stays the repository row's act.
    const betaRow = page.getByTestId("project-row").filter({ hasText: betaName });
    await betaRow.hover();
    await projectGroup(page, betaName).getByTestId("repo-new-mission").click();
    await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });

    // Esc closes it and nothing happened anywhere: no draft, no tab, no row,
    // no mission (D-077).
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.getByTestId("new-mission-dialog").count(), { timeout: 20_000 })
      .toBe(0);
    expect((await tabLabels(page)).length).toBe(0);
    const after = await page.evaluate(async () => {
      const result = await window.novus.missions.list();
      return result.ok ? result.value.length : -1;
    });
    expect(after).toBe(before);
  }, 180_000);
});

describe("mission tabs and file tabs, told apart", () => {
  it("keeps each mission's open files to itself, and forgets them when its tab closes", async () => {
    expect(runningMissionId).toMatch(/^msn_/);
    await closeEveryTab(page);
    await openProject(page, alphaName);
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: RUNNING_GOAL.slice(0, 14) }).click();
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });

    // A file opens over this mission's canvas, and adds no mission tab: opening
    // a file is not opening a room.
    const missionTabsBefore = (await tabLabels(page)).length;
    if ((await page.getByTestId("inspector").count()) === 0) {
      await page.getByTestId("panel-toggle").click();
    }
    await page.getByTestId("inspector").waitFor({ timeout: 20_000 });
    await page.getByTestId("inspector-tab-files").click();
    await page.getByTestId("file-tree").waitFor({ timeout: 30_000 });
    await page.getByTestId("tree-row").filter({ hasText: "README.md" }).first().click();
    await page.getByTestId("file-view").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("file-tab").count()).toBe(1);
    expect((await tabLabels(page)).length).toBe(missionTabsBefore);
    // A pin made here is this room's (D-215): the open file's own "Add to
    // chat" pins it onto the composer. The inspector hands the pin to the
    // shell as an ask, and the ask used to outlive its delivery — every room
    // that mounted afterwards replayed it, so the pin reappeared in whatever
    // mission was opened next. Owner-hit, across two missions.
    await page.getByTestId("file-add-to-chat").click();
    await page.getByTestId("composer-context").waitFor({ timeout: 10_000 });
    await page.getByTestId("inspector-close").click();
    await shot(page, "70-file-tabs-inside-a-mission-tab.png");

    // Another mission is another room, and it has no files open — and no
    // pin it never made.
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });
    await expect.poll(async () => page.getByTestId("file-tab").count(), { timeout: 20_000 }).toBe(0);
    expect(await page.locator(".tabbar").count()).toBe(0);
    expect(await page.getByTestId("composer-context").count()).toBe(0);

    // Going back restores exactly what that mission had open, including which
    // canvas was showing.
    await page.getByTestId("mission-tab-open").filter({ hasText: RUNNING_GOAL.slice(0, 14) }).click();
    await expect.poll(async () => page.getByTestId("file-tab").count(), { timeout: 20_000 }).toBe(1);
    await page.getByTestId("file-view").waitFor({ timeout: 20_000 });
    // The pin is where it was made — not lost, and not anywhere else.
    await page.getByTestId("composer-context").waitFor({ timeout: 10_000 });

    // The rule for closing (see project-shell.tsx): a mission tab's file view is
    // local view state, so closing the tab discards it. Reopening the mission
    // opens its trace, which is what the room is for.
    await page
      .getByTestId("mission-tab")
      .filter({ hasText: RUNNING_GOAL.slice(0, 14) })
      .getByTestId("mission-tab-close")
      .click();
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: RUNNING_GOAL.slice(0, 14) }).click();
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("file-tab").count()).toBe(0);
    expect(await page.locator(".tabbar").count()).toBe(0);
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });
  }, 240_000);
});

describe("the strip at three window widths", () => {
  it("scrolls sideways rather than breaking the shell", async () => {
    await closeEveryTab(page);
    // Every mission of both projects, open at once: the widest working set this
    // suite can build, which is the case the narrow window has to survive.
    for (const name of [alphaName, betaName]) {
      await openProject(page, name);
      const rows = projectGroup(page, name).getByTestId("mission-row");
      const count = await rows.count();
      for (let index = 0; index < count; index += 1) await rows.nth(index).click();
    }
    const openCount = (await tabLabels(page)).length;
    expect(openCount).toBeGreaterThanOrEqual(4);

    const shellOverflow = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
    const stripScrolls = () =>
      page.evaluate(() => {
        const strip = document.querySelector(".mission-strip-scroll");
        if (!strip) return null;
        return {
          scrollWidth: strip.scrollWidth,
          clientWidth: strip.clientWidth,
          overflowX: getComputedStyle(strip).overflowX
        };
      });

    for (const [width, height, name] of [
      [1440, 900, "71-strip-wide.png"],
      [1000, 700, "72-strip-medium.png"],
      [760, 600, "73-strip-narrow.png"]
    ] as [number, number, string][]) {
      await resizeWindow(app, width, height);
      await page.getByTestId("mission-strip").waitFor({ timeout: 20_000 });
      // The shell never gains a horizontal scrollbar of its own.
      expect(await shellOverflow()).toBeLessThanOrEqual(0);
      // The way to start one is still reachable at every width, because it sits
      // outside the part that scrolls.
      expect(await page.getByTestId("strip-new-mission").isVisible()).toBe(true);
      await shot(page, name);
    }

    // The strip is the thing that scrolls, and the shell is not. Asserted as a
    // property of the strip rather than by hoping this fixture overflows at
    // this width: since the strip moved into the window's own top row (D-066)
    // it has the whole width, so how many tabs it takes to overflow is a fact
    // about the fixture and not about the layout.
    const narrow = await stripScrolls();
    expect(narrow).not.toBeNull();
    expect(narrow!.overflowX).toBe("auto");
    expect(narrow!.scrollWidth).toBeGreaterThanOrEqual(narrow!.clientWidth);
    expect(await shellOverflow()).toBeLessThanOrEqual(0);

    // And the room being read is visible in the strip that says which room is
    // being read, even when more tabs are open than fit.
    const selected = page.locator('[data-testid="mission-tab"][data-active="true"]');
    const seen = await page.evaluate(() => {
      const strip = document.querySelector(".mission-strip-scroll");
      const tab = document.querySelector('[data-testid="mission-tab"][data-active="true"]');
      if (!strip || !tab) return null;
      const outer = strip.getBoundingClientRect();
      const inner = tab.getBoundingClientRect();
      return { fitsLeft: inner.left >= outer.left - 1, fitsRight: inner.right <= outer.right + 1 };
    });
    expect(await selected.isVisible()).toBe(true);
    expect(seen).toEqual({ fitsLeft: true, fitsRight: true });
    await page.evaluate(() => {
      document.querySelector(".mission-strip-scroll")?.scrollBy({ left: 400 });
    });
    expect(await shellOverflow()).toBeLessThanOrEqual(0);

    await resizeWindow(app, 1440, 900);
  }, 180_000);

  it("an open changed file wears its change, and a clicked identifier lights its uses (D-227)", async () => {
    await closeEveryTab(page);
    await openProject(page, alphaName);
    // The idle mission, deliberately: the running one queues new directions
    // behind its live turn (D-083), and a queued write never lands.
    await projectGroup(page, alphaName).getByTestId("mission-row").filter({ hasText: "Alpha one" }).click();
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });

    // A turn writes a code file the base never held: every line of it is the
    // mission's own doing, so every line takes the wash.
    await page
      .getByTestId("composer-input")
      .fill("washprobe here and washprobe again [fake-write:src/probe.ts]");
    await page.keyboard.press("Enter");
    // Sync on THIS direction's own turn, not on any earlier outcome.
    await page.getByTestId("chat").getByText("Working on: washprobe", { exact: false }).waitFor({ timeout: 90_000 });
    await page
      .getByTestId("trace-outcome")
      .filter({ hasText: "Turn completed" })
      .last()
      .waitFor({ timeout: 90_000 });

    if ((await page.getByTestId("inspector").count()) === 0) {
      await page.getByTestId("panel-toggle").click();
    }
    await page.getByTestId("inspector-tab-files").click();
    await page.getByTestId("file-tree").waitFor({ timeout: 30_000 });
    // The filter searches the whole worktree live (D-185's search), so a file
    // a turn just wrote is findable regardless of what the tree had cached.
    await page.getByTestId("tree-filter").fill("probe");
    await page.getByTestId("tree-row").filter({ hasText: "probe.ts" }).first().click();
    await page.getByTestId("file-source-view").waitFor({ timeout: 20_000 });

    // The wash: a brand-new file is added lines end to end.
    await expect
      .poll(async () => page.locator(".code-line.line-added").count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // The click: aim at the word's own pixels — an element-center click can
    // land on a neighbouring token, and caretRangeFromPoint answers for
    // whatever is actually under the point.
    const point = await page.evaluate(() => {
      const body = document.querySelector(".code-body");
      if (!body) return null;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const at = (node.textContent ?? "").indexOf("washprobe");
        if (at !== -1) {
          const range = new Range();
          range.setStart(node, at);
          range.setEnd(node, at + "washprobe".length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 4, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    });
    expect(point).not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const marks = CSS.highlights.get("novus-ident");
          if (!marks) return 0;
          let count = 0;
          marks.forEach(() => {
            count += 1;
          });
          return count;
        })
      )
      .toBe(2);
    await shot(page, "230-file-wears-its-change.png");

    // Escape puts the file back to plain reading.
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => page.evaluate(() => CSS.highlights.has("novus-ident")))
      .toBe(false);
    // Escape composes: it cleared the highlight AND meant what it always
    // means to the room (the panel closed with it) — nothing left to tidy.
  }, 180_000);
});
