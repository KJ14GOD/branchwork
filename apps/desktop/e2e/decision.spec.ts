import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  // A declared setup that writes a witness, so "the fork's setup auto-ran" is
  // a fact on disk in the new lane's own worktree rather than a status word.
  // The witness is git-ignored: a checkpoint commits every dirty file, and a
  // setup artifact must never ride along in a lane's evidence.
  mkdirSync(join(dir, ".novus"), { recursive: true });
  writeFileSync(
    join(dir, ".novus", "settings.toml"),
    ["[setup]", 'command = "echo forked > setup-witness.txt"'].join("\n")
  );
  writeFileSync(join(dir, ".gitignore"), "setup-witness.txt\n");
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
    expect(await page.getByTestId("rail-compare").count()).toBe(0);
    // And no structure chrome at all: a one-approach mission grows no tree in
    // the rail (D-084) and no count on its row.
    // One lane still shows its one approach row (D-126); forking adds beside it.
    await expect.poll(() => page.getByTestId("rail-approach-row").count(), { timeout: 20_000 }).toBe(1);
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

    // --- The rail grows the tree: one row per approach, under the mission ---
    const laneRows = page.getByTestId("rail-approach-row");
    await expect.poll(() => laneRows.count(), { timeout: 30_000 }).toBe(2);
    expect(await laneRows.nth(0).innerText()).toContain("Current work");
    expect(await laneRows.nth(1).innerText()).toContain("Alternative");
    // The mission row keeps its count for when the tree is folded away, and
    // there is still exactly one mission row (D-084).
    await expect
      .poll(() => page.getByTestId("mission-approaches-count").count(), { timeout: 30_000 })
      .toBe(1);
    expect(await page.getByTestId("mission-approaches-count").innerText()).toContain("2 approaches");
    expect(await page.getByTestId("mission-row").count()).toBe(1);

    // --- Choosing a folded approach shows it -------------------------------
    // Owner-reported: fold one approach's conversations, go to its sibling,
    // come back — and the click that chooses it changes nothing on screen,
    // because selecting deliberately left the fold alone. The way back was to
    // click it a second time, which reads as a dead control. Choosing a lane
    // is asking to see it.
    const chatsIn = (row: number) =>
      page.evaluate((index) => {
        const rows = [...document.querySelectorAll('[data-testid="rail-approach-row"]')];
        const target = rows[index];
        if (!target) return -1;
        // A lane's conversations live in the `.side-children` block that
        // follows its row, so counting siblings is counting the wrong thing.
        const children = target.nextElementSibling;
        if (!children || !children.classList.contains("side-children")) return 0;
        return children.querySelectorAll('[data-testid="rail-session-row"]').length;
      }, row);

    // Alternative is the selected lane here, so fold its own conversations.
    const openBefore = await chatsIn(1);
    expect(openBefore).toBeGreaterThan(0);
    await laneRows.nth(1).click();
    await expect.poll(() => chatsIn(1), { timeout: 10_000 }).toBe(0);

    // Away to the sibling, then back. One click, and it is showing again.
    await laneRows.nth(0).click();
    await page.waitForTimeout(400);
    await laneRows.nth(1).click();
    await expect.poll(() => chatsIn(1), { timeout: 10_000 }).toBe(openBefore);

    // And it is still a toggle once it is the selected lane.
    await laneRows.nth(1).click();
    await expect.poll(() => chatsIn(1), { timeout: 10_000 }).toBe(0);
    await laneRows.nth(1).click();
    await expect.poll(() => chatsIn(1), { timeout: 10_000 }).toBe(openBefore);

    // --- The room lands in the lane that was just made ----------------------
    // Start approach selects the new lane (D-084): the room you asked for is
    // the room you get, its row washed in the tree beside its sibling's.
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
    // lane: the rail names the lane (D-126; the composer's target eyebrow is
    // retired, D-176), and the direction lands in the lane on screen rather
    // than the mission's first (D-080). A different direction body, so the
    // two lanes genuinely diverge.
    expect(await page.getByTestId("lane-context").innerText()).toContain("Alternative");
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

    // A forked approach inherits its sibling's workspace setup: the project's
    // declared setup runs in the new lane without anyone opening the setup UI,
    // proven by the witness it writes in the fork's own worktree.
    await expect
      .poll(() => existsSync(join(worktreeRoot, approach.workstreamId, "setup-witness.txt")), {
        timeout: 60_000
      })
      .toBe(true);
    // In the fork specifically: nobody ran setup for the first lane, and
    // nothing did it for them.
    expect(existsSync(join(worktreeRoot, baseline.workstreamId, "setup-witness.txt"))).toBe(false);

    // --- The tree is the switcher now: rows, and the way across -------------
    expect(await laneRows.count()).toBe(2);
    expect(await page.getByTestId("rail-compare").count()).toBe(1);
    await shot("89-the-rail-tree.png");

    // --- The comparison ------------------------------------------------------
    await page.getByTestId("rail-compare").click();
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
    // The whole page on the record (D-138 batch): its head, then its foot.
    await page.getByTestId("decision-room").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      document.querySelector('[data-testid="decision-room"]')?.scrollIntoView({ block: "start" });
    });
    await shot("154-decision-room-head.png");
    await page.getByTestId("contested").scrollIntoViewIfNeeded();
    await shot("155-decision-room-foot.png");
    await shot("84-comparing-two-approaches.png");

    // --- A third approach is a third column (D-138, reversing the pair
    // rule): every lane compares at once, in creation order, and the sheet
    // scrolls sideways past what fits. No picker, no chips.
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
    await expect.poll(() => columns.count(), { timeout: 30_000 }).toBe(3);
    expect(await page.getByTestId("pair-chip").count()).toBe(0);
    await expect
      .poll(async () =>
        columns.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workstream"))),
        { timeout: 30_000 }
      )
      .toEqual([baseline.workstreamId, approach.workstreamId, third]);
    await shot("90-three-approaches-compared.png");

    // --- Visual evidence to cite (D-122): seeded over the real API ----------
    // The capture path is e2e/artifacts.spec.ts's; what this drives is the
    // decision dialog's own picker and the frozen citation.
    const seedToken = await mintToken();
    const seedBytes = Buffer.from(`decision-evidence-${"x".repeat(48)}`);
    const seedSha = createHash("sha256").update(seedBytes).digest("hex");
    const begun = await fetch(`${CP_URL}/missions/${missionId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seedToken}` },
      body: JSON.stringify({
        workstreamId: approach.workstreamId,
        kind: "screenshot",
        mimeType: "image/png",
        byteSize: seedBytes.length,
        sha256: seedSha,
        capturedAt: new Date().toISOString(),
        provenance: {
          processId: "prc_seeded",
          processName: "app",
          origin: "http://127.0.0.1:4600",
          readiness: "ready",
          revisionSha: null,
          revisionDirty: false
        }
      })
    });
    expect(begun.status).toBe(201);
    const begunBody = (await begun.json()) as {
      artifact: { artifactId: string };
      upload: { url: string; headers: Record<string, string> };
    };
    expect(
      (
        await fetch(begunBody.upload.url, {
          method: "PUT",
          headers: begunBody.upload.headers,
          body: new Uint8Array(seedBytes)
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await fetch(`${CP_URL}/artifacts/${begunBody.artifact.artifactId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${seedToken}` },
          body: JSON.stringify({ outcome: "uploaded" })
        })
      ).ok
    ).toBe(true);
    await until(
      "the seeded artifact to reach the room",
      (value) => value.artifacts.some((entry) => entry.artifactId === begunBody.artifact.artifactId)
    );

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
    // The recorder chooses which visual evidence mattered (D-122): the lane's
    // completed artifact is offered, and checking it cites it.
    await page.getByTestId("decision-artifacts").waitFor({ timeout: 10_000 });
    await page
      .locator(`[data-testid="decision-artifact-option"][data-artifact="${begunBody.artifact.artifactId}"]`)
      .check();
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
    // The citation froze with the rationale (D-122): the exact id, on the row.
    expect(current.artifactIds).toEqual([begunBody.artifact.artifactId]);
    // Choosing is not applying, and the room says so rather than saying "done".
    expect(decided.state).toBe("decision_recorded");

    await page.getByTestId("decision-receipt").waitFor({ timeout: 30_000 });
    const receipt = await page.getByTestId("decision-receipt").innerText();
    expect(receipt).toContain("The middleware version keeps the guard in one place.");
    expect(receipt).toMatch(/Not verified when this was decided/i);
    // The cited evidence is on the receipt, as a row rather than an id.
    expect(receipt).toMatch(/Visual evidence cited/i);
    await page
      .locator(`[data-testid="receipt-artifact-row"][data-artifact="${begunBody.artifact.artifactId}"]`)
      .waitFor({ timeout: 10_000 });
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
    // The sentence says "not published yet", so its action sits beside it
    // (D-141) and leads to the receipt where the publish verbs live.
    expect(await page.getByTestId("state-publish").count()).toBe(1);

    // --- A reload keeps the lane, the composer's target, and the decision --
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await expect
      .poll(() => page.getByTestId("lane-context").innerText(), { timeout: 30_000 })
      .toContain("Alternative");
    // The rail names the lane from the shell's own selection (D-126); the
    // composer's target eyebrow is retired (D-176), so the rail's word and
    // the state line below are the whole claim.
    const lineAfter = await page.getByTestId("state-line").innerText();
    expect(lineAfter).toContain("Decision recorded");

    // Back on the first lane, one rail row away, with its own room intact.
    // And the tree's Compare row carries the decision's standing in words.
    expect(await page.getByTestId("rail-compare").innerText()).toContain("decision recorded");
    await page.getByTestId("rail-approach-row").first().click();
    await expect
      .poll(async () => page.getByTestId("lane-context").innerText(), { timeout: 30_000 })
      .toContain("Current work");
    // Both bright-path cases on the record (D-133): 89- holds the second
    // lane open; this one holds the first, captured after the canvas has
    // followed the rail.
    await shot("152-the-rail-tree-first-lane.png");

    // --- The tree at the other widths (DESIGN.md#responsive) ----------------
    // Below 1200 the rail is an overlay, so the structure is one toggle away
    // rather than always on screen — and still operable, not clipped away.
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 800);
    });
    // Reading the sidebar's box proves the overlay is genuinely off-canvas
    // before the toggle is asked to open it. The toggle clicks are forced:
    // after an Electron resize, Playwright's actionability hit-test is skewed
    // by the titlebar inset and blames an off-canvas element, while the page's
    // own elementFromPoint returns the toggle itself — and the row clicks
    // inside the opened overlay just below stay ordinary, fully hit-tested
    // clicks, which is where operability is actually proven.
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
    await page.screenshot().catch(() => undefined);
    await page.getByTestId("rail-toggle").last().click({ force: true });
    await expect.poll(() => page.getByTestId("rail-approach-row").count(), { timeout: 30_000 }).toBe(3);
    await shot("91-lanes-at-1000.png");
    // Narrower still, with the overlay simply kept open across the resize:
    // the tree — and the way into the comparison — survives the width.
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(760, 720);
    });
    await page.waitForTimeout(600);
    await expect.poll(() => page.getByTestId("rail-compare").count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => page.getByTestId("rail-approach-row").count(), { timeout: 30_000 }).toBe(3);
    await shot("92-lanes-at-760.png");
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
  }, 300_000);
});
