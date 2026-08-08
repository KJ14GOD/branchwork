import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/**
 * Live proof of the two-person story: two real desktop clients, two separately
 * authenticated people, one mission, and the **real** `claude` binary doing the
 * work — no fake harness anywhere in the run.
 *
 * The story is `multiplayer.spec.ts`'s wedge with the deterministic fake taken
 * out: Kartik directs a live turn and answers the real permission question it
 * raises; Maya joins by invitation from a second client with no checkout of her
 * own, queues a direction she has no authority to apply, takes the baton
 * through the request-offer-accept handshake, applies her own direction, and
 * the live turn it starts — resumed in the same harness session, attributed to
 * her, executed on Kartik's machine — stops at its own permission question,
 * which **Maya** answers from her client because the baton is hers now. The
 * repository is then asked directly whether both turns' files exist on the
 * mission branch.
 *
 * Honest scope: both clients run on this one machine, under two Electron user
 * data directories and two separately authenticated sessions. That proves two
 * real clients against one control plane with a live harness; it does not
 * prove two physically separate machines, which no test runnable from one
 * machine can. PROGRESS.md's Golden V0 line stays owned by a genuinely
 * two-machine run.
 *
 * It is **opt-in** (`NOVUS_LIVE_MULTI=1`) because it spends the machine
 * owner's Claude Code quota and needs their CLI signed in.
 */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const LIVE = process.env.NOVUS_LIVE_MULTI === "1";

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4494;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_live_multi";

let controlPlane: ChildProcess;

interface Client {
  app: ElectronApplication;
  page: Page;
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

async function launch(login: string, userDataDir: string): Promise<Client> {
  const app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_IDENTITY: login,
      NOVUS_USER_DATA_DIR: userDataDir
      // Deliberately no NOVUS_FAKE_HARNESS: the runner spawns the real CLI.
    }
  });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${login}] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${login}!] ${chunk}`));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, login };
}

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

/** Mints a session over HTTP so the test can register the local repository the
 *  way the native folder picker would. */
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

const detail = (client: Client, missionId: string): Promise<MissionDetailResponse> =>
  client.page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);

async function until(
  client: Client,
  missionId: string,
  predicate: (value: MissionDetailResponse) => boolean,
  what: string,
  timeoutMs = 60_000
): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: MissionDetailResponse | null = null;
  while (Date.now() < deadline) {
    last = await detail(client, missionId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `timed out waiting for ${what}; last execution state: ${last?.executions.at(-1)?.state ?? "none"}`
  );
}

/** Opens the room in a real frame so an approval can be answered by a click. */
async function openRoom(client: Client): Promise<void> {
  await client.page.reload();
  await client.page.waitForLoadState("domcontentloaded");
  await client.page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
  if ((await client.page.getByTestId("mission-row").count()) === 0) {
    await client.page.getByTestId("project-row").first().click().catch(() => undefined);
  }
  if ((await client.page.getByTestId("mission-row").count()) > 0) {
    await client.page.getByTestId("mission-row").first().click();
  }
}

async function snap(client: Client, name: string): Promise<void> {
  try {
    await client.page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  } catch (error) {
    console.warn(`could not capture ${name}:`, error instanceof Error ? error.message : error);
  }
}

beforeAll(async () => {
  if (!LIVE) return;
  mkdirSync(evidenceDir, { recursive: true });

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_e2e_live_multi'");
  if (exists.rowCount === 0) await admin.query("create database novus_e2e_live_multi");
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
}, 120_000);

afterAll(() => {
  if (!LIVE) return;
  controlPlane?.kill("SIGTERM");
});

describe.skipIf(!LIVE)("two clients, one live Claude Code", () => {
  it("hands the baton between two real clients and both people's live turns land as commits", async () => {
    // A real local git repository, on Kartik's side only.
    const repoDir = mkdtempSync(join(tmpdir(), "novus-live-multi-repo-"));
    const repoName = basename(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    writeFileSync(join(repoDir, "README.md"), "# live multiplayer demo\n");
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

    const kartikDir = mkdtempSync(join(tmpdir(), "novus-live-kartik-"));
    const mayaDir = mkdtempSync(join(tmpdir(), "novus-live-maya-"));
    // Only Kartik's client knows where the folder is; Maya never gets a path.
    writeFileSync(join(kartikDir, "local-repos.json"), JSON.stringify({ [localId]: repoDir }));

    const kartik = await launch("kartik", kartikDir);
    const maya = await launch("maya", mayaDir);
    const kartikIdentity = await signIn(kartik);
    const mayaIdentity = await signIn(maya);
    expect(mayaIdentity.userId).not.toBe(kartikIdentity.userId);

    // --- Kartik's live turn, with its real permission question ---------------
    const base = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.repos.baseLocal(id);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }, localId);

    const created = await kartik.page.evaluate(
      async (input) => {
        const result = await window.novus.missions.create({
          goal: "Prove two people can steer one live Claude",
          successCriteria: "Both people's files exist on the mission branch",
          provider: "local",
          providerRepoId: input.localId,
          baseRef: input.ref,
          baseSha: input.sha,
          creationKey: input.creationKey
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        return result.value;
      },
      { localId, ref: base.ref, sha: base.sha, creationKey: randomUUID() }
    );
    const missionId = created.mission.missionId;
    const missionBranch = created.workstream.missionBranch;

    await until(kartik, missionId, (value) => value.runner !== null, "the runner to register");

    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        body: "Create a file named HELLO.md containing exactly the single word: hello",
        model: "claude-fable-5",
        effort: "low"
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);

    await until(
      kartik,
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "pending"),
      "the real Claude to ask permission for Kartik's turn",
      300_000
    );

    // Answered in the window, by the person who holds the baton.
    await openRoom(kartik);
    await kartik.page.getByTestId("approval").waitFor({ timeout: 60_000 });
    expect(existsSync(join(repoDir, "HELLO.md"))).toBe(false);
    await kartik.page.getByTestId("approval-approve").click();

    const afterFirst = await until(
      kartik,
      missionId,
      (value) => value.executions.at(-1)?.state === "completed",
      "Kartik's live turn to finish",
      300_000
    );
    const firstExecution = afterFirst.executions.at(-1);
    expect(firstExecution?.harnessSessionId).toBeTruthy();
    expect(afterFirst.checkpoints.at(-1)?.files.some((file) => file.path === "HELLO.md")).toBe(true);
    await snap(kartik, "32-live-multi-first-turn");

    // --- Maya joins from the second client -----------------------------------
    const invitation = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.invites.create({ missionId: id, role: "contributor" });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    }, missionId);

    const beforeJoin = await maya.page.evaluate(async (id) => window.novus.missions.get(id), missionId);
    expect(beforeJoin.ok).toBe(false);

    const redeemed = await maya.page.evaluate(
      async (token) => window.novus.invites.redeem(token),
      invitation.token
    );
    expect(redeemed.ok).toBe(true);

    const mayaView = await detail(maya, missionId);
    expect(mayaView.participants.map((p) => p.login).sort()).toEqual(["kartik", "maya"]);
    expect(mayaView.checkpoints.length).toBe(afterFirst.checkpoints.length);
    expect(mayaView.capabilities).not.toContain("direction.apply");
    expect(mayaView.runner?.ownerLogin).toBe("kartik");

    // --- Her direction queues; the baton moves through the handshake ---------
    const queued = await maya.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        body: "Create a file named MAYA.md containing exactly the single line: maya was here",
        model: "claude-fable-5",
        effort: "low"
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    }, missionId);
    expect(queued.dispatched).toBe(false);

    await maya.page.evaluate(async (id) => {
      const result = await window.novus.control.request(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);
    await until(
      kartik,
      missionId,
      (value) => value.control.openRequests.some((r) => r.requesterLogin === "maya"),
      "Maya's request to reach Kartik"
    );
    await kartik.page.evaluate(
      async (input) => {
        const result = await window.novus.control.offer(input);
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      },
      { missionId, toUserId: mayaIdentity.userId }
    );
    const offered = await until(
      maya,
      missionId,
      (value) => value.control.liveOffer?.state === "open",
      "the offer to reach Maya"
    );
    await maya.page.evaluate(async (id) => {
      const result = await window.novus.control.acceptOffer(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, offered.control.liveOffer?.offerId as string);
    const transferred = await until(
      maya,
      missionId,
      (value) => value.control.holderLogin === "maya",
      "control to transfer to Maya"
    );
    expect(transferred.capabilities).toContain("direction.apply");

    // --- Maya's live turn: her direction, her approval, his machine ----------
    const mayaDirection = transferred.directions.find((d) => d.authorLogin === "maya");
    await maya.page.evaluate(
      async (directionId) => {
        const result = await window.novus.missions.resolveDirection({ directionId, action: "apply" });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      },
      mayaDirection?.directionId as string
    );

    await until(
      maya,
      missionId,
      (value) =>
        value.approvals.filter((approval) => approval.state === "pending").length > 0 &&
        value.executions.length >= 2,
      "the real Claude to ask permission for Maya's turn",
      300_000
    );

    // The question raised by her turn is hers to answer now — from her client.
    await openRoom(maya);
    await maya.page.getByTestId("approval").waitFor({ timeout: 60_000 });
    expect(existsSync(join(repoDir, "MAYA.md"))).toBe(false);
    await snap(maya, "33-live-multi-maya-asked");
    await maya.page.getByTestId("approval-approve").click();

    const afterSecond = await until(
      maya,
      missionId,
      (value) => value.executions.length >= 2 && value.executions.at(-1)?.state === "completed",
      "Maya's live turn to finish",
      300_000
    );
    const secondExecution = afterSecond.executions.at(-1);
    expect(secondExecution?.startedByLogin).toBe("maya");
    expect(secondExecution?.resumedSession).toBe(true);
    expect(secondExecution?.harnessSessionId).toBe(firstExecution?.harnessSessionId);
    expect(
      afterSecond.approvals.filter((approval) => approval.respondedByLogin === "maya").length
    ).toBeGreaterThan(0);

    // The repository itself is the record: both people's turns are commits on
    // the one mission branch, and the branch head is the recorded checkpoint.
    expect(git(repoDir, ["show", `${missionBranch}:HELLO.md`]).trim().toLowerCase()).toContain("hello");
    expect(git(repoDir, ["show", `${missionBranch}:MAYA.md`]).trim().toLowerCase()).toContain(
      "maya was here"
    );
    expect(git(repoDir, ["rev-parse", missionBranch])).toBe(afterSecond.checkpoints.at(-1)?.sha);

    // Kartik's client reads the same finished story.
    const kartikFinal = await until(
      kartik,
      missionId,
      (value) => value.executions.length >= 2 && value.executions.at(-1)?.state === "completed",
      "Kartik's client to catch up"
    );
    expect(kartikFinal.control.holderLogin).toBe("maya");
    expect(kartikFinal.checkpoints.length).toBe(afterSecond.checkpoints.length);
    await snap(maya, "34-live-multi-both-turns");

    await kartik.app.close();
    await maya.app.close();
  }, 1_800_000);
});
