import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/**
 * A permission the harness asks for, answered by a person, in two clients.
 *
 * This is the whole point of approval routing, executed: the harness stops and
 * asks; the person who does *not* hold the baton sees the question and is told
 * plainly that they cannot answer it; control moves; the new holder answers
 * through the actual card in the actual window; the harness is unblocked and
 * does the thing — or, on a denial, does not. Both clients then see who
 * answered, and a relaunch reconstructs it from the server.
 *
 * The harness is the deterministic fake, which asks the question in the shape
 * the real CLI sends it and blocks on stdin exactly as the real CLI does, so
 * what this drives is the production parser and the production answer path.
 * The real Claude Code proof is `test/live-approval.test.ts` (D-062).
 *
 * Answering happens through the DOM, not the bridge: the claim being made is
 * that a person can do this in the product.
 */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4494;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_approval";

let controlPlane: ChildProcess;

interface Client {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  login: string;
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

async function launch(login: string, userDataDir: string): Promise<Client> {
  const app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      // The fake asks a permission question in the shape the real CLI sends it.
      NOVUS_FAKE_HARNESS_APPROVAL: "1",
      NOVUS_FAKE_IDENTITY: login,
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  // The runner lives in the main process, so its diagnostics are the only
  // window into why a turn did not happen. Forward them into the test output.
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${login}] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${login}!] ${chunk}`));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataDir, login };
}

/** Signs in through the app's own flow; the gated auto-visit stands in for the
 *  human's browser leg. */
async function signIn(client: Client): Promise<{ userId: string; login: string }> {
  await client.page.waitForFunction(() => typeof window.novus !== "undefined");
  const already = await client.page.evaluate(() => window.novus.auth.status());
  if (already.state !== "signed_in") {
    await client.page.evaluate(() => window.novus.auth.start());
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await client.page.evaluate(() => window.novus.auth.status());
    if (current.state === "signed_in") {
      return { userId: current.user.userId, login: current.user.login };
    }
    if (current.state === "failed") throw new Error(`sign-in failed: ${current.message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${client.login} never signed in`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

/** Mints a session over HTTP for a named identity, so the test can register a
 *  local repository the way the native folder picker would. */
async function mintToken(as: string): Promise<string> {
  const start = await fetch(`${CP_URL}/auth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ as })
  });
  const { state, authorizeUrl } = (await start.json()) as { state: string; authorizeUrl: string };
  await fetch(authorizeUrl, { redirect: "follow" });
  const claim = await fetch(`${CP_URL}/auth/github/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  const body = (await claim.json()) as { token?: string };
  if (!body.token) throw new Error("auth claim did not return a token");
  return body.token;
}


/**
 * Captures what a client is actually showing at this point in the story.
 * Screenshots are evidence, not assertions: a capture that cannot be taken
 * records that fact and never fails the run.
 */
/** Screenshots exactly what is on screen now, without reloading — for frames
 *  whose whole point is transient interface state, like an open panel. */
async function snap(client: Client, name: string): Promise<void> {
  await client.page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}


const detail = (client: Client, missionId: string): Promise<MissionDetailResponse> =>
  client.page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);

/** Polls the room until a condition holds, so tests never race the runner. */
async function until(
  client: Client,
  missionId: string,
  predicate: (value: MissionDetailResponse) => boolean,
  what: string,
  timeoutMs = 45_000
): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: MissionDetailResponse | null = null;
  while (Date.now() < deadline) {
    last = await detail(client, missionId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(last?.state)}`);
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_e2e_approval'");
  if (exists.rowCount === 0) await admin.query("create database novus_e2e_approval");
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
});

afterAll(() => {
  controlPlane?.kill("SIGTERM");
});


/** The mission both tests below need: a repository on Kartik's machine, Maya
 *  invited into it, and the harness working. Returns both clients. */
async function twoClientsOnOneMission(label: string): Promise<{
  kartik: Client;
  maya: Client;
  missionId: string;
  worktreeOf: () => string;
  kartikDir: string;
}> {
  const repoDir = mkdtempSync(join(tmpdir(), `novus-${label}-repo-`));
  const repoName = basename(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "README.md"), "# a project\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  const headSha = git(repoDir, ["rev-parse", "HEAD"]);

  const localId = randomUUID();
  const kartikToken = await mintToken("kartik");
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${kartikToken}` },
    body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);

  const kartikDir = mkdtempSync(join(tmpdir(), `novus-${label}-kartik-`));
  const mayaDir = mkdtempSync(join(tmpdir(), `novus-${label}-maya-`));
  writeFileSync(join(kartikDir, "local-repos.json"), JSON.stringify({ [localId]: repoDir }));

  const kartik = await launch("kartik", kartikDir);
  const maya = await launch("maya", mayaDir);
  await signIn(kartik);
  await signIn(maya);

  const base = await kartik.page.evaluate(async (id) => {
    const result = await window.novus.repos.baseLocal(id);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }, localId);

  const created = await kartik.page.evaluate(
    async (input) => {
      const result = await window.novus.missions.create({
        goal: `Approval ${input.label}`,
        successCriteria: "The harness asks before it writes",
        provider: "local",
        providerRepoId: input.localId,
        baseRef: input.ref,
        baseSha: input.sha,
        creationKey: input.creationKey
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    },
    { localId, ref: base.ref, sha: base.sha, creationKey: randomUUID(), label }
  );
  const missionId = created.mission.missionId;
  // Worktrees are keyed by workstream, not mission, since a mission may hold
  // competing approaches (D-074).
  const workstreamId = created.workstream.workstreamId;

  await until(kartik, missionId, (value) => value.runner !== null, "the runner to register");

  // Maya joins through a real invitation, exactly as multiplayer.spec.ts does.
  const token = await kartik.page.evaluate(async (id) => {
    const result = await window.novus.invites.create({ missionId: id, role: "contributor" });
    if (!result.ok) throw new Error(result.message);
    return result.value.token;
  }, missionId);
  await maya.page.evaluate(async (value) => {
    const result = await window.novus.invites.redeem(value);
    if (!result.ok) throw new Error(result.message);
  }, token);

  return {
    kartik,
    maya,
    missionId,
    kartikDir,
    worktreeOf: () => join(kartikDir, "worktrees", workstreamId)
  };
}

/** Opens the mission in a client's window and waits for the room. */
async function openRoom(client: Client, missionId: string): Promise<void> {
  await client.page.reload();
  await client.page.waitForLoadState("domcontentloaded");
  await client.page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
  const row = client.page.getByTestId("mission-row").first();
  if ((await client.page.getByTestId("mission-row").count()) === 0) {
    await client.page.getByTestId("project-row").first().click();
  }
  await row.waitFor({ timeout: 30_000 });
  await client.page
    .getByTestId("mission-row")
    .filter({ hasText: "Approval" })
    .first()
    .click();
  await client.page.getByTestId("state-line").waitFor({ timeout: 30_000 });
  void missionId;
}

describe("a permission the harness asks for", () => {
  it("blocks the turn, refuses the wrong person, follows the baton, and unblocks on approve", async () => {
    const { kartik, maya, missionId, worktreeOf } = await twoClientsOnOneMission("approve");

    // --- Kartik directs; the harness stops and asks --------------------------
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({ missionId: id, body: "write the fake turn file" });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);

    const asked = await until(
      kartik,
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "pending"),
      "the harness to ask for permission"
    );
    expect(asked.state).toBe("needs_approval");
    const pending = asked.approvals.find((approval) => approval.state === "pending");
    expect(pending?.toolName).toBe("Write");
    // The durable summary names the act and carries no file body.
    expect(pending?.summary).toContain("NOVUS_FAKE_TURN.md");
    expect(JSON.stringify(asked.approvals)).not.toContain("# Fake turn");

    // The harness is genuinely blocked: the file it asked about is not there.
    expect(existsSync(join(worktreeOf(), "NOVUS_FAKE_TURN.md"))).toBe(false);

    // --- Maya sees the question and is told she cannot answer it -------------
    await openRoom(maya, missionId);
    const mayaCard = maya.page.getByTestId("approval");
    await mayaCard.waitFor({ timeout: 30_000 });
    expect(await maya.page.getByTestId("approval-summary").textContent()).toContain("NOVUS_FAKE_TURN.md");
    expect(await maya.page.getByTestId("approval-approve").count()).toBe(0);
    const refusal = await maya.page.getByTestId("approval-denied-to-viewer").textContent();
    expect(refusal).toContain("kartik");
    await snap(maya, "74-approval-not-yours-to-answer");

    // And the server agrees, which is the part that matters: the card is not
    // what is stopping her.
    const refused = await maya.page.evaluate(async (id) => {
      const result = await window.novus.missions.respondApproval({ approvalId: id, decision: "approve" });
      return result.ok ? "allowed" : result.code;
    }, pending?.approvalId ?? "");
    expect(refused).toBe("forbidden");

    // --- Control moves to Maya, and so does the authority to answer ----------
    await maya.page.evaluate(async (id) => {
      const result = await window.novus.control.request(id);
      if (!result.ok) throw new Error(result.message);
    }, missionId);
    const requested = await until(
      kartik,
      missionId,
      (value) => value.control.openRequests.length > 0,
      "Kartik to see the request"
    );
    const mayaUserId = requested.control.openRequests[0]?.requesterUserId ?? "";
    await kartik.page.evaluate(
      async (input) => {
        const result = await window.novus.control.offer({ missionId: input.missionId, toUserId: input.toUserId });
        if (!result.ok) throw new Error(result.message);
      },
      { missionId, toUserId: mayaUserId }
    );
    const offered = await until(
      maya,
      missionId,
      (value) => value.control.liveOffer?.state === "open",
      "the offer to reach Maya"
    );
    await maya.page.evaluate(async (offerId) => {
      const result = await window.novus.control.acceptOffer(offerId);
      if (!result.ok) throw new Error(result.message);
    }, offered.control.liveOffer?.offerId ?? "");

    // The transfer completes even though the turn is blocked, because a pending
    // permission prompt is a safe boundary (PRODUCT.md#control).
    await until(
      maya,
      missionId,
      (value) => value.control.holderLogin === "maya",
      "control to reach Maya while the harness is blocked"
    );
    // The request is still pending — the handoff did not answer it for anyone.
    const stillPending = await detail(maya, missionId);
    expect(stillPending.approvals.some((approval) => approval.state === "pending")).toBe(true);

    // --- Maya answers, in the window, through the card ----------------------
    const approve = maya.page.getByTestId("approval-approve");
    await approve.waitFor({ timeout: 30_000 });
    await snap(maya, "75-approval-mine-to-answer");
    await approve.click();

    // The harness is unblocked and does the thing it asked about.
    await expect
      .poll(() => existsSync(join(worktreeOf(), "NOVUS_FAKE_TURN.md")), { timeout: 60_000 })
      .toBe(true);
    const settled = await until(
      kartik,
      missionId,
      (value) => value.approvals.every((approval) => approval.state !== "pending"),
      "the approval to settle"
    );
    const answered = settled.approvals[0];
    expect(answered?.state).toBe("approved");
    // Attribution, on the client that did not answer.
    expect(answered?.respondedByLogin).toBe("maya");

    // The execution carried on rather than ending at the question.
    await until(
      kartik,
      missionId,
      (value) => value.executions.some((execution) => execution.state === "completed"),
      "the turn to finish after the approval"
    );
    await snap(kartik, "76-approval-answered-seen-by-the-other-client");

    // --- Relaunch reconstructs the decision ---------------------------------
    await maya.app.close();
    const mayaAgain = await launch("maya", maya.userDataDir);
    await signIn(mayaAgain);
    const rebuilt = await detail(mayaAgain, missionId);
    expect(rebuilt.approvals[0]?.state).toBe("approved");
    expect(rebuilt.approvals[0]?.respondedByLogin).toBe("maya");
    await mayaAgain.app.close();
    await kartik.app.close();
  }, 300_000);

  it("does not do the thing when the controller denies it, and says who denied it", async () => {
    const { kartik, maya, missionId, worktreeOf } = await twoClientsOnOneMission("deny");
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({ missionId: id, body: "write the fake turn file" });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);
    await until(
      kartik,
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "pending"),
      "the harness to ask"
    );

    await openRoom(kartik, missionId);
    const deny = kartik.page.getByTestId("approval-deny");
    await deny.waitFor({ timeout: 30_000 });
    await deny.click();

    const settled = await until(
      kartik,
      missionId,
      (value) => value.approvals.every((approval) => approval.state !== "pending"),
      "the denial to settle"
    );
    expect(settled.approvals[0]?.state).toBe("denied");
    expect(settled.approvals[0]?.respondedByLogin).toBe("kartik");

    // The act was refused, so it did not happen.
    expect(existsSync(join(worktreeOf(), "NOVUS_FAKE_TURN.md"))).toBe(false);

    // A denial is not a failure: the turn ends normally with the refusal as
    // context, rather than the execution being reported as broken.
    const ended = await until(
      kartik,
      missionId,
      (value) => value.executions.some((execution) => ["completed", "failed"].includes(execution.state)),
      "the turn to end after the denial"
    );
    expect(ended.executions.at(-1)?.state).toBe("completed");
    await snap(kartik, "77-approval-denied");
    await maya.app.close();
    await kartik.app.close();
  }, 300_000);

  it("answers a second chat alongside, read-only, while the write turn stays blocked (D-095)", async () => {
    const { kartik, maya, missionId, worktreeOf } = await twoClientsOnOneMission("alongside");

    // --- Chat A: the write turn, blocked on its real question ----------------
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({ missionId: id, body: "write the fake turn file" });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);
    await until(
      kartik,
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "pending"),
      "the harness to ask"
    );

    // --- Chat B: alongside, read-only, started while A is blocked ------------
    // The same call the composer's "Run alongside · read-only" makes.
    const review = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        body: "Explain what the blocked turn is about to do",
        newSession: true,
        alongside: true
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    }, missionId);
    expect(review.dispatched).toBe(true);

    // B finishes its whole answer while A has not moved: the read turn ran
    // beside the blocked write turn instead of queueing behind it.
    const answered = await until(
      kartik,
      missionId,
      (value) =>
        value.executions.some(
          (execution) => execution.access === "read" && execution.state === "completed"
        ),
      "the read turn to finish beside the blocked write turn",
      120_000
    );
    const readExecution = answered.executions.find((execution) => execution.access === "read");
    expect(answered.executions.find((execution) => execution.access === "write")?.state).toBe(
      "needs_approval"
    );
    // B's own write attempt was denied at the machine (the scripted harness
    // asks in this mode too): no second card ever reached the room, and no
    // checkpoint was captured for the read turn.
    expect(answered.approvals.filter((approval) => approval.state === "pending")).toHaveLength(1);
    expect(
      answered.checkpoints.some((checkpoint) => checkpoint.executionId === readExecution?.executionId)
    ).toBe(false);
    expect(existsSync(join(worktreeOf(), "NOVUS_FAKE_TURN.md"))).toBe(false);

    // --- The window: A's question is still the room's, and answering it in
    // the real frame unblocks the write turn exactly as before ---------------
    await openRoom(kartik, missionId);
    // Two conversations now, so the room lands on the approach's overview
    // (D-089); the question renders in a conversation's own view. Chat A is
    // the first row — and the overview says what it is doing.
    const rowA = kartik.page.getByTestId("overview-session-row").first();
    await rowA.waitFor({ timeout: 30_000 });
    await expect
      .poll(async () => (await rowA.textContent()) ?? "", { timeout: 15_000 })
      .toContain("needs you");
    await rowA.click();
    const approve = kartik.page.getByTestId("approval-approve");
    await approve.waitFor({ timeout: 30_000 });
    await snap(kartik, "101-read-turn-answered-while-blocked");
    await approve.click();
    const finished = await until(
      kartik,
      missionId,
      (value) =>
        value.executions.find((execution) => execution.access === "write")?.state === "completed",
      "the write turn to finish after the approval",
      120_000
    );
    // The write turn's work happened; the read turn changed nothing.
    expect(existsSync(join(worktreeOf(), "NOVUS_FAKE_TURN.md"))).toBe(true);
    expect(
      finished.checkpoints.every(
        (checkpoint) => checkpoint.executionId !== readExecution?.executionId
      )
    ).toBe(true);

    await maya.app.close();
    await kartik.app.close();
  }, 300_000);
});

describe("filing a mission away", () => {
  /**
   * Archival, in the product (D-063).
   *
   * The claim is narrow and worth proving exactly: the mission leaves the rail
   * and nothing else about it changes. Its tab closes because the rail no
   * longer offers a way back to that room, not because closing a tab and
   * archiving a mission are the same act — they are not, and the working set
   * suite proves the other direction.
   */
  it("leaves the rail, keeps everything, comes back, and is refused while working", async () => {
    const { kartik, maya, missionId } = await twoClientsOnOneMission("archive");
    await openRoom(kartik, missionId);

    // --- Refused while the harness is waiting --------------------------------
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({ missionId: id, body: "write the fake turn file" });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);
    await until(
      kartik,
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "pending"),
      "the harness to ask"
    );

    const whileWaiting = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.archive(id);
      return result.ok ? "archived" : result.message;
    }, missionId);
    expect(whileWaiting).toContain("Answer it");

    // Answer it, let the turn finish, and it becomes archivable.
    await kartik.page.getByTestId("approval-deny").click();
    await until(
      kartik,
      missionId,
      (value) => value.executions.every((execution) => ["completed", "failed", "stopped"].includes(execution.state)),
      "the turn to end"
    );

    // --- Archived, through the rail's own control ---------------------------
    const before = await detail(kartik, missionId);
    expect(before.events.length).toBeGreaterThan(0);

    const archiveControl = kartik.page.getByTestId("mission-archive").first();
    await archiveControl.waitFor({ timeout: 30_000 });
    await archiveControl.click();

    // Gone from the rail, and its tab with it — but nowhere near deleted.
    await expect
      .poll(async () => kartik.page.getByTestId("mission-row").count(), { timeout: 30_000 })
      .toBe(0);
    await expect
      .poll(async () => kartik.page.getByTestId("mission-tab").count(), { timeout: 30_000 })
      .toBe(0);

    // And it is *put away*, not parked in the rail: nothing lists it until you
    // go and look, and taking it back out is a deliberate act.
    expect(await kartik.page.getByTestId("archived-row").count()).toBe(0);
    const openArchived = kartik.page.getByTestId("open-archived");
    await openArchived.waitFor({ timeout: 30_000 });
    await snap(kartik, "79-mission-archived");
    await openArchived.click();
    await kartik.page.getByTestId("archived-dialog").waitFor({ timeout: 20_000 });
    await expect
      .poll(async () => kartik.page.getByTestId("archived-row").count(), { timeout: 20_000 })
      .toBe(1);
    await snap(kartik, "80-archived-dialog");

    // Everything it was, still is.
    const after = await detail(kartik, missionId);
    expect(after.events.length).toBeGreaterThanOrEqual(before.events.length);
    expect(after.directions.length).toBe(before.directions.length);
    expect(after.approvals.length).toBe(before.approvals.length);
    expect(after.approvals[0]?.state).toBe("denied");
    expect(after.mission.archivedAt).not.toBeNull();

    // The other client sees this one leave the list too. Asserted about this
    // mission rather than about the length: these tests share a control plane,
    // so Maya is a participant in the earlier ones as well.
    await expect
      .poll(
        async () =>
          maya.page.evaluate(async (id) => {
            const result = await window.novus.missions.list();
            return result.ok ? result.value.some((mission) => mission.missionId === id) : true;
          }, missionId),
        { timeout: 30_000 }
      )
      .toBe(false);
    const filedForMaya = await maya.page.evaluate(async (id) => {
      const result = await window.novus.missions.list("archived");
      return result.ok ? result.value.some((mission) => mission.missionId === id) : false;
    }, missionId);
    expect(filedForMaya).toBe(true);

    // --- And it comes back ---------------------------------------------------
    await kartik.page.getByTestId("mission-restore").first().click();
    await expect
      .poll(async () => kartik.page.getByTestId("archived-row").count(), { timeout: 30_000 })
      .toBe(0);
    await kartik.page.getByTestId("archived-close").click();
    await expect
      .poll(async () => kartik.page.getByTestId("mission-row").count(), { timeout: 30_000 })
      .toBe(1);
    // Nothing is filed away any more, so the way to look is gone too.
    await expect
      .poll(async () => kartik.page.getByTestId("open-archived").count(), { timeout: 30_000 })
      .toBe(0);

    // Survives a relaunch, because it is a fact about the mission and not a
    // preference of this window.
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.archive(id);
      if (!result.ok) throw new Error(result.message);
    }, missionId);
    await kartik.app.close();
    const again = await launch("kartik", kartik.userDataDir);
    await signIn(again);
    const listed = await again.page.evaluate(async (id) => {
      const active = await window.novus.missions.list();
      const filed = await window.novus.missions.list("archived");
      return {
        active: active.ok ? active.value.some((mission) => mission.missionId === id) : true,
        filed: filed.ok ? filed.value.some((mission) => mission.missionId === id) : false
      };
    }, missionId);
    expect(listed).toEqual({ active: false, filed: true });
    await again.app.close();
    await maya.app.close();
  }, 300_000);
});
