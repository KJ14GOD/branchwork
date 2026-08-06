import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * Competing approaches and the decision between them, through the interface
 * (D-074, D-075).
 *
 * The whole workflow in one real window: a turn produces a result, somebody
 * forks a second approach from it with a stated intent, directs that one too,
 * compares the two on their own evidence, chooses one with a rationale, and
 * reads the receipt with the pull request Novus prepared and did not send.
 *
 * What only a window can catch, and what this exists for: a comparison surface
 * that renders before there is anything to compare, an approach that quietly
 * runs in its sibling's worktree, a decision that a person can record without
 * typing a reason, and a "prepared" pull request that a reader could mistake
 * for one that was opened.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4498;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_decision";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let app: ElectronApplication;
let page: Page;
let missionId = "";
let worktreeRoot = "";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

const shot = (name: string) =>
  page.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

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

async function signIn(): Promise<void> {
  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

const detail = (): Promise<MissionDetailResponse> =>
  page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);

async function until(
  what: string,
  predicate: (value: MissionDetailResponse) => boolean,
  timeoutMs = 90_000
): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: MissionDetailResponse | null = null;
  while (Date.now() < deadline) {
    last = await detail();
    if (predicate(last)) return last;
    await new Promise((settle) => setTimeout(settle, 400));
  }
  // What the room actually said, so a timeout names the state it got stuck in
  // rather than only the thing it wanted.
  const where = last
    ? ` — state ${last.state}; lanes ${last.workstreams
        .map((lane) => `${lane.workstreamId}:${lane.branchStatus}`)
        .join(", ")}; executions ${last.executions
        .map((execution) => `${execution.workstreamId}:${execution.state}${execution.failureReason ? `(${execution.failureReason})` : ""}`)
        .join(", ")}; directions ${last.directions.map((direction) => direction.state).join(", ")}`
    : "";
  throw new Error(`timed out waiting for ${what}${where}`);
}

/** Direction into a named lane, which is how an approach is worked at all. */
async function direct(body: string, workstreamId?: string): Promise<void> {
  const sent = await page.evaluate(
    async (args) => {
      const result = await window.novus.missions.direct({
        missionId: args.missionId,
        body: args.body,
        ...(args.workstreamId ? { workstreamId: args.workstreamId } : {})
      } as Parameters<NovusBridge["missions"]["direct"]>[0]);
      return result.ok ? "ok" : `${result.code}: ${result.message}`;
    },
    { missionId, body, workstreamId }
  );
  expect(sent).toBe("ok");
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-decision-"));
  worktreeRoot = join(userDataDir, "worktrees");

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

  const token = await mintToken();
  const dir = mkdtempSync(join(tmpdir(), "novus-decision-repo-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${basename(dir)}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]);
  const localId = randomUUID();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name: basename(dir), defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: dir }));

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
  await signIn();

  missionId = await page.evaluate(
    async (args) => {
      const base = await window.novus.repos.baseLocal(args.localId);
      if (!base.ok) throw new Error(`${base.code}: ${base.message}`);
      const created = await window.novus.missions.create({
        goal: "Make the session guard hold",
        successCriteria: "Sessions expire when they should",
        provider: "local",
        providerRepoId: args.localId,
        baseRef: base.value.ref,
        baseSha: base.value.sha,
        creationKey: args.creationKey
      });
      if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
      return created.value.mission.missionId;
    },
    { localId, creationKey: randomUUID() }
  );

  // Open it in the room, the way a person does: the rail lists the project's
  // missions, and clicking one is what puts the room on it.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
  const group = page.locator(".side-group", {
    has: page.getByTestId("project-row").filter({ hasText: basename(dir) })
  });
  await group.waitFor({ timeout: 30_000 });
  if ((await group.getByTestId("mission-row").count()) === 0) {
    await group.getByTestId("project-row").click();
  }
  await group.getByTestId("mission-row").first().click();
  await page.getByTestId("state-line").waitFor({ timeout: 30_000 });

  // A first turn, so there is a result to fork from. An approach only means
  // something beside something.
  await direct("write the fake turn file");
  await until(
    "the first turn to check point",
    (value) => value.checkpoints.some((checkpoint) => checkpoint.sha !== null)
  );
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("competing approaches, compared and decided", () => {
  it("forks a second lane, compares them, and records a decision that publishes nothing", async () => {
    // --- Nothing to compare yet, so there is no comparison ------------------
    // Prohibited pattern 11: no decision or comparison UI over empty content.
    expect(await page.getByTestId("open-decision-room").count()).toBe(0);
    // And no lane chrome at all: a one-approach mission stays simple (D-080).
    expect(await page.getByTestId("lane-tab").count()).toBe(0);
    expect(await page.getByTestId("approaches-switcher").count()).toBe(0);
    expect(await page.getByTestId("mission-approaches-count").count()).toBe(0);

    // --- Try another approach, which requires saying how it differs ---------
    await page.getByTestId("try-another-approach").click();
    const dialog = page.getByTestId("try-approach-dialog");
    await dialog.waitFor({ timeout: 30_000 });
    // The intent is required: the primary action is dead until there is one.
    expect(await page.getByTestId("create-approach").isDisabled()).toBe(true);
    // The dialog names the goal and the exact shared checkpoint it forks at,
    // and says the current lane's own changes stay where they are (D-079).
    expect(await page.getByTestId("approach-goal").innerText()).toContain("session guard");
    const originLine = await page.getByTestId("approach-origin").innerText();
    expect(originLine).toMatch(/Starts from shared checkpoint/i);
    expect(originLine).toMatch(/stay there/i);
    await page.getByTestId("approach-intent-input").fill("Do it in the middleware instead");
    await shot("83-try-another-approach.png");
    await page.getByTestId("create-approach").click();

    const forked = await until(
      "the approach to exist",
      (value) => value.workstreams.length === 2 && value.workstreams[1]?.branchStatus === "created"
    );
    const baseline = forked.workstreams[0]!;
    const approach = forked.workstreams[1]!;
    expect(approach.approach).toBe(true);
    expect(approach.intent).toBe("Do it in the middleware instead");
    expect(approach.originSha).toBeTruthy();
    // Its own branch, beside the baseline's rather than replacing it.
    expect(approach.missionBranch).not.toBe(baseline.missionBranch);
    // Named for what they are (D-079).
    expect(baseline.name).toBe("Current work");
    expect(approach.name).toBe("Alternative");

    // --- The room grows lane tabs, and the rail a count — nothing else -----
    const laneTabs = page.getByTestId("lane-tab");
    await expect.poll(() => laneTabs.count(), { timeout: 30_000 }).toBe(2);
    expect(await laneTabs.nth(0).innerText()).toContain("Current work");
    expect(await laneTabs.nth(1).innerText()).toContain("Alternative");
    // One mission row in the rail, carrying a count only (D-080).
    await expect
      .poll(() => page.getByTestId("mission-approaches-count").count(), { timeout: 30_000 })
      .toBe(1);
    expect(await page.getByTestId("mission-approaches-count").innerText()).toContain("2 approaches");
    expect(await page.getByTestId("mission-row").count()).toBe(1);

    // --- Switching lanes is the tab, and everything follows it -------------
    // The new lane opened automatically... it did not: opening is explicit
    // here, which is one deliberate click on the tab that just appeared.
    await laneTabs.nth(1).click();
    // The room re-polls for the lane it now reads; the switch is complete when
    // the header says so.
    await expect
      .poll(() => page.getByTestId("lane-context").innerText(), { timeout: 30_000 })
      .toContain("Alternative");
    expect(await page.getByTestId("lane-context").innerText()).toContain("isolated workspace");
    // A fresh lane is its own empty room: it must never wear its sibling's
    // finished state (D-080).
    expect(await page.getByTestId("state-line").innerText()).not.toContain("Work finished");
    await shot("88-the-alternative-lane-open.png");

    // --- The approach runs, in its own worktree -----------------------------
    // Directed through the real composer while the Alternative is the active
    // lane: the composer names its target, and the direction lands in the
    // lane on screen rather than the mission's first (D-080). A different
    // direction body, so the two lanes genuinely diverge.
    expect(await page.getByTestId("composer").innerText()).toContain("Directing Alternative");
    await page.getByTestId("composer-input").fill("write the fake turn file, the middleware way");
    await page.getByTestId("send").click();
    await until(
      "the approach to check point",
      (value) =>
        value.approaches.find((entry) => entry.workstreamId === approach.workstreamId)?.checkpointSha !== null &&
        value.approaches.find((entry) => entry.workstreamId === approach.workstreamId)?.checkpointSha !== undefined
    );
    // Isolation, on disk: two lanes, two worktrees, and no shared directory.
    expect(existsSync(join(worktreeRoot, baseline.workstreamId))).toBe(true);
    expect(existsSync(join(worktreeRoot, approach.workstreamId))).toBe(true);
    expect(existsSync(join(worktreeRoot, missionId))).toBe(false);

    // --- The lane switcher: every lane's own facts, and the way across -----
    await page.getByTestId("approaches-switcher").click();
    await page.getByTestId("approaches-menu").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("approaches-shared").innerText()).toMatch(/Shared checkpoint/i);
    expect(await page.getByTestId("approaches-row").count()).toBe(2);
    await shot("89-the-approaches-switcher.png");

    // --- The comparison ------------------------------------------------------
    await page.getByTestId("open-decision-room").click();
    await page.getByTestId("decision-room").waitFor({ timeout: 30_000 });
    // The header states what the comparison is about, and leaving is not
    // deciding: the way out reads Keep exploring.
    expect(await page.getByTestId("decision-shared").innerText()).toMatch(/Shared checkpoint/i);
    expect(await page.getByTestId("decision-close").innerText()).toContain("Keep exploring");
    // Two lanes need no pair selector, and get none.
    expect(await page.getByTestId("decision-pair").count()).toBe(0);
    const columns = page.getByTestId("approach-column");
    await expect.poll(() => columns.count(), { timeout: 30_000 }).toBe(2);
    // Creation order, and each column carrying its own lane's evidence.
    expect(await columns.nth(0).getAttribute("data-workstream")).toBe(baseline.workstreamId);
    expect(await columns.nth(1).getAttribute("data-workstream")).toBe(approach.workstreamId);
    expect(await columns.nth(1).innerText()).toContain("Do it in the middleware instead");
    // What was *not* verified is on screen as plainly as what was.
    expect(await columns.nth(0).innerText()).toMatch(/Not verified/i);
    expect(await columns.nth(0).innerText()).toMatch(/no check has run/i);
    // The file both lanes changed is named, and nothing offers to merge it.
    const contested = await page.getByTestId("contested").innerText();
    expect(contested).toContain("NOVUS_FAKE_TURN.md");
    expect(await page.getByTestId("decision-room").innerText()).not.toMatch(/recommend|winner|score/i);
    await shot("84-comparing-two-approaches.png");

    // --- A third approach turns the columns into a chosen pair --------------
    const third = await page.evaluate(
      async (args) => {
        const result = await window.novus.approaches.create({
          missionId: args.missionId,
          fromWorkstreamId: args.from,
          intent: "Try it as a background job"
        });
        return result.ok ? result.value.workstream.workstreamId : `${result.code}: ${result.message}`;
      },
      { missionId, from: baseline.workstreamId }
    );
    expect(third.startsWith("wst_")).toBe(true);
    await expect.poll(() => page.getByTestId("pair-chip").count(), { timeout: 30_000 }).toBe(3);
    // Still two columns — the first two by default — and one click swaps one.
    expect(await columns.count()).toBe(2);
    await page.getByTestId("pair-chip").nth(2).click();
    await expect
      .poll(async () => {
        const rendered = await columns.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-workstream"))
        );
        return rendered.includes(third);
      }, { timeout: 30_000 })
      .toBe(true);
    expect(await columns.count()).toBe(2);
    await shot("90-three-approaches-pick-a-pair.png");
    // Back to the original pair, so the choice below is between the two that
    // actually did work.
    await page.getByTestId("pair-chip").nth(0).click();
    await page.getByTestId("pair-chip").nth(1).click();
    await expect
      .poll(async () =>
        columns.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workstream"))),
        { timeout: 30_000 }
      )
      .toEqual([baseline.workstreamId, approach.workstreamId]);

    // --- Choosing asks for a reason, and will not proceed without one -------
    await columns.nth(1).getByTestId("choose-approach").click();
    await page.getByTestId("record-decision").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("record-decision-confirm").isDisabled()).toBe(true);
    // And it shows what it is about to record as unverified, while there is
    // still time to change your mind.
    expect(await page.getByTestId("decision-unresolved").innerText()).toMatch(/no verification has run/i);
    // And the evidence being accepted, with the exact revision the decision
    // will pin — in front of the person, not only in the record.
    const evidence = await page.getByTestId("decision-evidence").innerText();
    expect(evidence).toMatch(/1 file changed/);
    expect(evidence).toMatch(/revision [0-9a-f]{8}/);
    await page.getByTestId("decision-rationale").fill("The middleware version keeps the guard in one place.");
    await page.getByTestId("decision-risks").fill("Nothing is verified yet; the suite has not run.");
    await shot("85-recording-a-decision.png");
    await page.getByTestId("record-decision-confirm").click();

    // --- The record, and the pull request nobody opened ---------------------
    const decided = await until(
      "the decision to be recorded",
      (value) => value.decisions.some((entry) => entry.supersededAt === null)
    );
    const current = decided.decisions.find((entry) => entry.supersededAt === null)!;
    expect(current.workstreamId).toBe(approach.workstreamId);
    expect(current.rationale).toMatch(/one place/);
    expect(current.checkpointSha).toBeTruthy();
    // Choosing is not applying, and the room says so rather than saying "done".
    expect(decided.state).toBe("decision_recorded");

    await page.getByTestId("decision-receipt").waitFor({ timeout: 30_000 });
    const receipt = await page.getByTestId("decision-receipt").innerText();
    expect(receipt).toContain("The middleware version keeps the guard in one place.");
    expect(receipt).toMatch(/Not verified when this was decided/i);
    // The approach that was not chosen is kept, with its own intent.
    expect(await page.getByTestId("receipt-not-chosen").innerText()).toBeTruthy();
    const prepared = await page.getByTestId("prepared-pr").innerText();
    expect(prepared).toMatch(/Nothing has been sent/i);
    expect(prepared).toContain(approach.missionBranch);
    // Scrolled to the receipt itself, so the screenshot is evidence of the
    // record rather than of the columns underneath it.
    await page.getByTestId("decision-receipt").scrollIntoViewIfNeeded();
    await shot("86-the-decision-receipt.png");
    await page.getByTestId("prepared-pr").scrollIntoViewIfNeeded();
    await shot("87-the-pull-request-nobody-opened.png");

    // The state line says both facts, and never the word "done".
    const line = await page.getByTestId("state-line").innerText();
    expect(line).toContain("Decision recorded");
    expect(line).toMatch(/not published yet/i);

    // --- A reload keeps the lane, the composer's target, and the decision --
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await expect
      .poll(() => page.getByTestId("lane-context").innerText(), { timeout: 30_000 })
      .toContain("Alternative");
    expect(await page.getByTestId("composer").innerText()).toContain("Directing Alternative");
    const lineAfter = await page.getByTestId("state-line").innerText();
    expect(lineAfter).toContain("Decision recorded");

    // Back on the first lane, one click away, with its own room intact.
    await page.getByTestId("lane-tab").first().click();
    await expect
      .poll(async () => page.getByTestId("lane-context").innerText(), { timeout: 30_000 })
      .toContain("Current work");
    expect(await page.getByTestId("composer").innerText()).toContain("Directing Current work");
  }, 300_000);
});
