import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * Shared sessions inside one approach, through the interface (D-083).
 *
 * One real window, one mission, one lane, and the whole session workflow in
 * it: the first conversation is invisible chrome-wise, a second one is created
 * words-first, each keeps its own transcript and its own harness continuity,
 * the workspace takes turns — a direction for the idle session queues with the
 * running session named, and dispatches itself when the turn completes — a
 * closed session tab stops nothing, attention words survive in the switcher,
 * and a reload restores the session being read.
 *
 * What only a window can catch, and what this exists for: a session tab that
 * silently reads a sibling's transcript, a composer that names one session and
 * routes to another, a queued direction that never says what it is waiting
 * for, a closed tab that kills a running turn, and a second session that
 * resumes the first one's conversation.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4499;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_sessions";
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
  const where = last
    ? ` — state ${last.state}; sessions ${last.sessions
        .map((session) => `${session.sessionId}:${session.title ?? "untitled"}`)
        .join(", ")}; executions ${last.executions
        .map(
          (execution) =>
            `${execution.sessionId}:${execution.state}${execution.failureReason ? `(${execution.failureReason})` : ""}`
        )
        .join(", ")}; directions ${last.directions
        .map((direction) => `${direction.sessionId}:${direction.state}`)
        .join(", ")}; approvals ${last.approvals.map((approval) => approval.state).join(", ")}`
    : "";
  throw new Error(`timed out waiting for ${what}${where}`);
}

/** Types into the real composer and sends — the path a person's words take. */
async function compose(words: string): Promise<void> {
  await page.getByTestId("composer-input").fill(words);
  await page.getByTestId("send").click();
}

/** Answers the approval the SERVER says is pending — by its own id, never
 *  "whichever card is on screen": for up to a poll tick after an answer, the
 *  settled card is still rendered, and clicking it again is refused while the
 *  real question sits unanswered. */
async function approvePending(): Promise<void> {
  const value = await until("an approval to be pending", (current) =>
    current.approvals.some((approval) => approval.state === "pending")
  );
  const id = value.approvals.find((approval) => approval.state === "pending")!.approvalId;
  const card = page.locator(`[data-approval-id="${id}"]`);
  await card.getByTestId("approval-approve").waitFor({ timeout: 60_000 });
  await card.getByTestId("approval-approve").click();
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-sessions-"));
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
  const dir = mkdtempSync(join(tmpdir(), "novus-sessions-repo-"));
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
      // Every scripted turn asks before it writes, and paces itself, so a turn
      // can be *caught* blocked — which is what turn-taking and background
      // attention need a window to prove.
      NOVUS_FAKE_HARNESS_APPROVAL: "1",
      NOVUS_FAKE_HARNESS_PACE_MS: "500",
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
        goal: "Hold the session guard",
        successCriteria: "Each conversation keeps its own thread",
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

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
  const group = page.locator(".side-group", {
    has: page.getByTestId("project-row").filter({ hasText: basename(dir) })
  });
  await group.waitFor({ timeout: 30_000 });
  // Disclosure is per project and the row's click is a toggle (D-077); the
  // restore path discloses open-tab projects on its own schedule, so a count
  // of visible rows never said whether a click opens or closes. The twisty's
  // aria-expanded is the per-project fact (the D-120/D-121 batch's find).
  if ((await group.getByTestId("project-twisty").getAttribute("aria-expanded")) !== "true") {
    await group.getByTestId("project-row").click();
  }
  // The active mission's row toggles its tree since D-134 (amended), so
  // "make sure it is open" must not blind-click an already-active row.
  const missionRow = group.getByTestId("mission-row").first();
  if (!(((await missionRow.getAttribute("class")) ?? "").includes("active-mission"))) {
    await missionRow.click();
  }
  await page.getByTestId("state-line").waitFor({ timeout: 30_000 });
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("shared sessions inside one approach", () => {
  it("creates, routes, takes turns, survives a closed tab and a reload, and shares one worktree", async () => {
    // --- One conversation: the structure is still shown (D-126 reversing
    // D-084's no-tree rule) — Mission → Approach → Chat, one row each. No
    // branch in the rail (D-131 reversing D-126's placement): machinery's
    // home is Overview.
    await expect.poll(() => page.getByTestId("mission-tree").count(), { timeout: 20_000 }).toBe(1);
    expect(await page.getByTestId("rail-approach-row").count()).toBe(1);
    expect(await page.getByTestId("rail-branch").count()).toBe(0);

    // --- The active mission's row toggles its tree (D-134, amended: no
    // twisty — the active row's navigation meaning is vacant, so its click
    // folds). The wash falls back to the mission row while the structure
    // is away, and the room never moves.
    await page.getByTestId("mission-row").first().click();
    await expect.poll(() => page.getByTestId("mission-tree").count(), { timeout: 20_000 }).toBe(0);
    await page.getByTestId("state-line").waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(evidenceDir, "153-mission-tree-folded.png") });
    await page.getByTestId("mission-row").first().click();
    await expect.poll(() => page.getByTestId("mission-tree").count(), { timeout: 20_000 }).toBe(1);

    // --- The first turn, in the session every mission is born with ----------
    await compose("write the guard file");
    await approvePending();
    const first = await until(
      "the first turn to complete",
      (value) =>
        value.executions.some((execution) => execution.state === "completed") &&
        value.checkpoints.some((checkpoint) => checkpoint.sha !== null)
    );


    // --- One lane still publishes (D-140): once a checkpoint exists the rail
    // offers Publish — the decision surface with a single column — and
    // leaving it decides nothing.
    await expect.poll(() => page.getByTestId("rail-publish").count(), { timeout: 60_000 }).toBe(1);
    await page.getByTestId("rail-publish").click();
    await page.getByTestId("decision-room").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("approach-column").count()).toBe(1);
    await page.screenshot({ path: join(evidenceDir, "158-single-approach-publish.png") });
    await page.getByTestId("decision-close").click();
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });

    expect(first.sessions.length).toBe(1);
    const sessionA = first.sessions[0]!;
    // Its first words are its name — nobody typed a title anywhere.
    expect(sessionA.title).toBe("write the guard file");

    // --- A second session is words-first (D-083, D-077 one level down) ------
    // The + hangs on the new session's deepest visible parent — with one lane,
    // the active mission's own row in the rail (D-084).
    await page.getByTestId("rail-new-session").click();
    await page.getByTestId("session-draft-lead").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("composer-input").getAttribute("placeholder")).toContain(
      "What should this session do"
    );
    await compose("add the tests for the guard");
    const two = await until("the second session to exist", (value) => value.sessions.length === 2);
    const sessionB = two.sessions.find((session) => session.sessionId !== sessionA.sessionId)!;
    expect(sessionB.title).toBe("add the tests for the guard");
    expect(sessionB.workstreamId).toBe(sessionA.workstreamId);

    // The tree appears only now that there is something to tell apart: one
    // row per conversation, nested under the mission in the rail (D-084).
    const rows = page.getByTestId("rail-session-row");
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(2);
    expect(await rows.nth(0).innerText()).toContain("write the guard file");
    expect(await rows.nth(1).innerText()).toContain("add the tests");
    // The selected tab names the conversation the words go to (D-176: the
    // composer's own target eyebrow is retired; the tab is the name).
    expect(
      await page.locator('[data-testid="session-tab"].active').innerText()
    ).toContain("add the tests");

    // The words landed in the session on screen — row, execution, and nothing
    // in the sibling (the composer never silently routes to the first).
    const routed = await until(
      "the second session's direction to have an execution",
      (value) => value.executions.some((execution) => execution.sessionId === sessionB.sessionId)
    );
    const directionB = routed.directions.find((direction) => direction.sessionId === sessionB.sessionId)!;
    expect(directionB.body).toBe("add the tests for the guard");
    await approvePending();
    await until(
      "the second session's turn to complete",
      (value) =>
        value.executions.filter(
          (execution) => execution.sessionId === sessionB.sessionId && execution.state === "completed"
        ).length === 1
    );
    await shot("93-two-sessions-in-one-approach.png");

    // --- Separate histories, separate continuity ----------------------------
    // Polled: the room hears the settled approval a poll tick after the bridge
    // does, and until then B's pending card legitimately renders in every
    // session's view — the question blocks the lane's one workspace.
    await rows.nth(0).click();
    await expect
      .poll(() => page.getByTestId("chat").innerText(), { timeout: 30_000 })
      .not.toContain("add the tests for the guard");
    expect(await page.getByTestId("chat").innerText()).toContain("write the guard file");
    await rows.nth(1).click();
    await expect
      .poll(() => page.getByTestId("chat").innerText(), { timeout: 30_000 })
      .not.toContain("write the guard file");
    expect(await page.getByTestId("chat").innerText()).toContain("add the tests for the guard");

    const afterTwo = await detail();
    const execA1 = afterTwo.executions.find((execution) => execution.sessionId === sessionA.sessionId)!;
    const execB1 = afterTwo.executions.find((execution) => execution.sessionId === sessionB.sessionId)!;
    // Two conversations, two harness sessions: B never resumed A's.
    expect(execA1.harnessSessionId).toBeTruthy();
    expect(execB1.harnessSessionId).toBeTruthy();
    expect(execB1.harnessSessionId).not.toBe(execA1.harnessSessionId);
    expect(execA1.resumedSession).toBe(false);
    expect(execB1.resumedSession).toBe(false);

    // --- The workspace takes turns ------------------------------------------
    // A third turn in session B, caught while it is blocked on its approval:
    // the lane is genuinely busy, deterministically.
    await compose("polish the tests please");
    await until(
      "the lane to be blocked on session B's approval",
      (value) => value.state === "needs_approval"
    );

    // Reading session A while B works: the question still shows (it blocks the
    // lane's one workspace), attributed to the session that asked.
    await rows.nth(0).click();
    const card = await page.getByTestId("approval").first().innerText();
    expect(card).toContain("asked in");
    expect(card).toContain("add the tests");
    // The background session's row says, in words, that it needs a person.
    await expect
      .poll(() => rows.nth(1).innerText(), { timeout: 30_000 })
      .toContain("needs you");
    // The state line names the working session rather than claiming the room.
    expect(await page.getByTestId("state-line").innerText()).toContain("add the tests");

    // A direction for idle session A: since D-095 the baton holder is asked
    // first — queue behind the running chat, or run alongside read-only. The
    // choice names the running session; Queue is the default this test takes,
    // and everything after it is exactly the pre-D-095 story.
    await compose("tighten the guard checks");
    await page.getByTestId("composer-choice").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("composer-choice").innerText()).toContain("add the tests");
    await page.getByTestId("choice-queue").click();
    await page.getByTestId("queued-note").waitFor({ timeout: 30_000 });
    const note = await page.getByTestId("queued-note").innerText();
    expect(note).toContain("add the tests");
    expect(note).toContain("is running; this applies when it finishes");
    // Queued means queued: no second live execution anywhere in the lane.
    const while2 = await detail();
    expect(
      while2.executions.filter((execution) =>
        ["requested", "starting", "running", "needs_approval"].includes(execution.state)
      ).length
    ).toBe(1);
    await shot("94-queued-behind-the-running-session.png");

    // --- Leaving a session stops nothing ------------------------------------
    // There is nothing to close any more: the tree lists every conversation
    // (D-084), and reading a different one changes only the canvas. The turn
    // blocked in the background stays blocked, waiting for its person.
    expect((await detail()).state).toBe("needs_approval");
    expect(await rows.count()).toBe(2);
    await shot("95-the-rail-tree-with-attention.png");
    await rows.nth(1).click();
    await expect
      .poll(() => page.getByTestId("chat").innerText(), { timeout: 30_000 })
      .toContain("add the tests for the guard");

    // --- Answering frees the workspace, and the queue moves itself ----------
    await approvePending();
    await until(
      "session B's second turn to complete",
      (value) =>
        value.executions.filter(
          (execution) => execution.sessionId === sessionB.sessionId && execution.state === "completed"
        ).length === 2
    );
    // Nobody clicked anything: the completed turn dispatched the baton
    // holder's queued direction into its own session (D-083).
    const dispatched = await until(
      "the queued direction to start session A's turn on its own",
      (value) =>
        value.executions.filter((execution) => execution.sessionId === sessionA.sessionId).length === 2
    );
    const execA2 = dispatched.executions.filter(
      (execution) => execution.sessionId === sessionA.sessionId
    )[1]!;
    await approvePending();
    const settled = await until(
      "session A's second turn to complete",
      (value) =>
        value.executions.filter(
          (execution) => execution.sessionId === sessionA.sessionId && execution.state === "completed"
        ).length === 2
    );
    // And it resumed session A's own conversation — not B's, not a fresh one.
    const execA2Done = settled.executions.find((execution) => execution.executionId === execA2.executionId)!;
    expect(execA2Done.resumedSession).toBe(true);
    expect(execA2Done.harnessSessionId).toBe(execA1.harnessSessionId);

    // --- A reload restores the session being read ---------------------------
    await rows.nth(1).click();
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await page.getByTestId("state-line").waitFor({ timeout: 30_000 });
    await expect
      .poll(() => page.getByTestId("rail-session-row").count(), { timeout: 30_000 })
      .toBe(2);
    expect(
      await page.locator('[data-testid="session-tab"].active').innerText()
    ).toContain("add the tests");
    expect(await page.getByTestId("chat").innerText()).toContain("add the tests for the guard");
    await shot("96-reload-restores-the-session.png");

    // --- One lane, one worktree: sessions never mint their own --------------
    const lane = settled.workstream!.workstreamId;
    expect(existsSync(join(worktreeRoot, lane))).toBe(true);
    const entries = readdirSync(worktreeRoot).filter((entry) => !entry.startsWith("."));
    // Worktrees are keyed by workstream and nothing else: six turns across two
    // sessions left exactly one lane directory and nothing session-keyed.
    expect(entries.every((entry) => entry.startsWith("wst_"))).toBe(true);
    expect(entries.length).toBe(1);
    expect(entries.some((entry) => entry.includes("csn_"))).toBe(false);

    // --- The session chrome at the other widths (DESIGN.md#responsive) ------
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 800);
    });
    // Below 1200 the rail is an overlay (DESIGN.md#responsive), so the tree is
    // one toggle away rather than always on screen — and still operable.
    await page.waitForTimeout(600);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().x ?? 0
          ),
        { timeout: 30_000 }
      )
      .toBeLessThan(0);
    // A resized Electron window can hit-test against a stale frame until the
    // compositor is forced to produce a fresh one; a captured frame is that
    // force, and the click that follows is still a real click.
    await page.screenshot().catch(() => undefined);
    await page.getByTestId("rail-toggle").last().click({ force: true });
    await expect.poll(() => page.getByTestId("rail-session-row").count(), { timeout: 30_000 }).toBe(2);
    await shot("97-sessions-at-1000.png");
    await page.getByTestId("rail-session-row").nth(1).click();
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(760, 720);
    });
    await page.waitForTimeout(600);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().x ?? 0
          ),
        { timeout: 30_000 }
      )
      .toBeLessThan(0);
    // A resized Electron window can hit-test against a stale frame until the
    // compositor is forced to produce a fresh one; a captured frame is that
    // force, and the click that follows is still a real click.
    await page.screenshot().catch(() => undefined);
    await page.getByTestId("rail-toggle").last().click({ force: true });
    await expect.poll(() => page.getByTestId("rail-session-row").count(), { timeout: 30_000 }).toBe(2);
    await shot("98-sessions-at-760.png");
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
  }, 300_000);

  it("a changed file pins onto the next message, and the turn's record carries it (D-182)", async () => {
    // The panel's Changes rows exist — earlier tests changed files. Pin one.
    await page.getByTestId("panel-toggle").click();
    await page.getByTestId("inspector-tab-changes").click();
    await page.getByTestId("change-add-to-chat").first().waitFor({ timeout: 20_000 });
    await page.getByTestId("change-add-to-chat").first().click();
    // The chip appears in the composer: the box shows what the send carries.
    await page.getByTestId("composer-context").waitFor({ timeout: 10_000 });
    const pinned = await page.getByTestId("composer-context").innerText();
    await shot("206-pinned-file-on-the-composer.png");

    await compose("look closely at the pinned file");
    await approvePending();
    const settled = await until(
      "the pinned direction's turn to complete",
      (value) =>
        value.directions.some(
          (direction) =>
            direction.body === "look closely at the pinned file" && direction.state === "applied"
        )
    );
    // The wire carries the reference, exactly one, the file that was pinned.
    const direction = settled.directions.find(
      (candidate) => candidate.body === "look closely at the pinned file"
    )!;
    expect(direction.context).toHaveLength(1);
    expect(direction.context[0]!.kind).toBe("file");
    expect(pinned).toContain((direction.context[0] as { path: string }).path);
    // And the sent message wears it as a quiet pill.
    await page.getByTestId("trace-context").first().waitFor({ timeout: 20_000 });
    // The chip is consumed by the send: the next message starts unpinned.
    expect(await page.getByTestId("composer-context").count()).toBe(0);
    await shot("207-pinned-file-on-the-message.png");
  }, 180_000);

  it("a new chat continues from a chosen sibling, carrying its transcript (D-173)", async () => {
    // The draft offers the lane's existing chats as sources.
    await page.getByTestId("rail-new-session").click();
    await page.getByTestId("draft-continue").waitFor({ timeout: 30_000 });
    const before = await detail();
    const sourceSession = before.sessions.find(
      (session) => session.title === "write the guard file"
    )!;
    expect(sourceSession).toBeDefined();
    const pill = page.getByTestId(`continue-from-${sourceSession.sessionId}`);
    await pill.click();
    // Picking a pill presses it and puts a chip in the composer (D-175):
    // the box shows everything the send will carry.
    expect(await pill.getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByTestId("composer-transcript").innerText()).toContain(
      "write the guard file"
    );
    await shot("202-continue-from-draft.png");
    await compose("review what the first chat built");

    const three = await until(
      "the third session to exist",
      (value) => value.sessions.length === 3
    );
    const sessionC = three.sessions.find(
      (session) => session.title === "review what the first chat built"
    )!;
    expect(sessionC).toBeDefined();

    // The first direction carries the transcript like any attachment (D-153)…
    const directionC = three.directions.find(
      (direction) => direction.sessionId === sessionC.sessionId
    )!;
    expect(directionC.attachments.length).toBe(1);
    expect(directionC.attachments[0]!.mimeType).toBe("text/markdown");

    // …and the artifact is honest about what it is: kind transcript, labelled
    // from the source chat's own title, its sessionId pointing at the SOURCE —
    // "View in conversation" opens what was projected (D-167 for free).
    const transcript = three.artifacts.find((artifact) => artifact.kind === "transcript")!;
    expect(transcript).toBeDefined();
    expect(transcript.artifactId).toBe(directionC.attachments[0]!.artifactId);
    expect(transcript.sessionId).toBe(sourceSession.sessionId);
    expect(transcript.label).toBe("Transcript · write the guard file");
    expect(transcript.state).toBe("available");

    await approvePending();
    await until(
      "the continued chat's turn to complete",
      (value) =>
        value.executions.some(
          (execution) =>
            execution.sessionId === sessionC.sessionId && execution.state === "completed"
        )
    );
    await shot("203-continued-chat-carries-the-transcript.png");
  }, 180_000);
});
