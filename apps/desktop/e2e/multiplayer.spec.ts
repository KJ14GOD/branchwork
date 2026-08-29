import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/**
 * Two real desktop clients, two separately authenticated people, one mission.
 *
 * This is the wedge, executed: Kartik opens a local project and directs Claude
 * Code on his own machine; Maya joins by redeeming an invitation from a second
 * client with no checkout of her own; her direction queues because she does not
 * hold the baton; she requests control, he offers it, she accepts, the transfer
 * completes at the idle boundary; his authority is gone the moment hers begins;
 * and her direction runs on his machine's runner. Both clients then close and
 * reopen and reconstruct every participant, direction, control transition, and
 * piece of evidence from the control plane.
 *
 * The clients are driven through the real IPC bridge rather than through DOM
 * selectors: this suite proves the client plane and the server's authority, and
 * stays honest when the room's composition changes. Interface coverage and
 * screenshots live in slice.spec.ts.
 *
 * The harness is the deterministic fake (`NOVUS_FAKE_HARNESS`), so this is
 * proof of the pipeline, not of Claude Code. Only GitHub's OAuth upstream is
 * faked; sessions, organizations, membership, invitations, capability
 * enforcement, the control lease, the runner credential, and every event are
 * real.
 */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4492;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_multi";

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
      NOVUS_FAKE_CONNECTORS: "[]",
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

/** Reloads into the room, so the frame is a reconstruction from the control
 *  plane rather than whatever this client had on screen. */
async function showRoom(client: Client): Promise<void> {
  await client.page.reload();
  await client.page.waitForLoadState("domcontentloaded");
  await client.page.getByTestId("project-room").first().waitFor({ timeout: 20_000 });
  await client.page.waitForTimeout(1_500);
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

async function capture(client: Client, name: string): Promise<void> {
  try {
    await client.page.reload();
    await client.page.waitForLoadState("domcontentloaded");
    await client.page
      .getByTestId("project-room")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    // Let the room's first poll land so the frame is not a loading state.
    await client.page.waitForTimeout(2_500);
    await client.page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  } catch (error) {
    console.warn(`could not capture ${name}:`, error instanceof Error ? error.message : error);
  }
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
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_e2e_multi'");
  if (exists.rowCount === 0) await admin.query("create database novus_e2e_multi");
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

describe("two people, one mission", () => {
  it("carries a mission through invitation, queued direction, a control handoff, and reconstruction", async () => {
    // A real local git repository, on Kartik's machine only.
    const repoDir = mkdtempSync(join(tmpdir(), "novus-multi-repo-"));
    const repoName = basename(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    writeFileSync(join(repoDir, "README.md"), "# auth service\n");
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

    const kartikDir = mkdtempSync(join(tmpdir(), "novus-kartik-"));
    const mayaDir = mkdtempSync(join(tmpdir(), "novus-maya-"));
    // Only Kartik's machine knows where the folder is. Maya never gets a path.
    writeFileSync(join(kartikDir, "local-repos.json"), JSON.stringify({ [localId]: repoDir }));

    let kartik = await launch("kartik", kartikDir);
    let maya = await launch("maya", mayaDir);
    const kartikIdentity = await signIn(kartik);
    const mayaIdentity = await signIn(maya);
    expect(kartikIdentity.login).toBe("kartik");
    expect(mayaIdentity.login).toBe("maya");
    expect(mayaIdentity.userId).not.toBe(kartikIdentity.userId);

    // --- Kartik opens the workstream and directs the harness -----------------
    const base = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.repos.baseLocal(id);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }, localId);
    expect(base.sha).toBe(headSha);

    const created = await kartik.page.evaluate(
      async (input) => {
        const result = await window.novus.missions.create({
          goal: "Harden the authentication flow",
          successCriteria: "Session handling is safe and the change is reviewable",
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
    expect(created.workstream.branchStatus).toBe("created");

    // The host desktop registers itself as the workstream's runner.
    const withRunner = await until(
      kartik,
      missionId,
      (value) => value.runner !== null,
      "Kartik's machine to register as the runner"
    );
    expect(withRunner.runner?.ownerLogin).toBe("kartik");
    expect(withRunner.control.holderLogin).toBe("kartik");
    expect(withRunner.capabilities).toContain("direction.apply");

    const firstDirection = await kartik.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        body: "Add a session-expiry guard",
        model: "claude-fable-5",
        effort: "high"
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    }, missionId);
    expect(firstDirection.dispatched).toBe(true);

    const afterFirstTurn = await until(
      kartik,
      missionId,
      (value) =>
        value.executions.length > 0 &&
        value.executions[value.executions.length - 1]?.state === "completed",
      "Kartik's first turn to finish"
    );
    // Evidence is derived from git, not from what the harness said.
    const checkpoint = afterFirstTurn.checkpoints[afterFirstTurn.checkpoints.length - 1];
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.filesChanged).toBeGreaterThan(0);
    expect(checkpoint?.files.some((file) => file.changeState === "added")).toBe(true);
    expect(afterFirstTurn.directions[0]?.state).toBe("applied");
    expect(afterFirstTurn.directions[0]?.authorLogin).toBe("kartik");
    await capture(kartik, "20-direction-trace-with-checkpoint");

    // --- Maya joins from a second authenticated client -----------------------
    // Through the interface, not the bridge: an invitation nobody can issue by
    // clicking is an invitation that does not exist for a user.
    await showRoom(kartik);
    await kartik.page.getByTestId("panel-toggle").click();
    // The workspace drawer opens on Overview already; clicking the tab again
    // would fold it away (the drawer rework after D-068).
    await kartik.page.getByTestId("inspector-overview").waitFor({ timeout: 30_000 });
    await kartik.page.getByTestId("create-invitation").click();
    await kartik.page.getByTestId("invitation-token").waitFor({ timeout: 15_000 });
    const invitationToken = (
      (await kartik.page.getByTestId("invitation-token").locator("code").textContent()) ?? ""
    ).trim();
    expect(invitationToken.length).toBeGreaterThanOrEqual(32);
    await snap(kartik, "28-invitation-issued");

    // Before redeeming, the mission does not exist for her.
    const beforeJoin = await maya.page.evaluate(async (id) => window.novus.missions.get(id), missionId);
    expect(beforeJoin.ok).toBe(false);

    // And redeemed the same way: a person with an empty Novus pastes what they
    // were sent into the one control the rail offers them.
    await maya.page.reload();
    await maya.page.waitForLoadState("domcontentloaded");
    await maya.page.getByTestId("join-mission").waitFor({ timeout: 20_000 });
    await maya.page.getByTestId("join-mission").click();
    await maya.page.getByTestId("join-token").fill(invitationToken);
    await snap(maya, "29-join-with-invitation");
    await maya.page.getByTestId("join-submit").click();
    await maya.page.getByTestId("join-dialog").waitFor({ state: "detached", timeout: 20_000 });

    // The same invitation cannot be spent twice.
    const replay = await maya.page.evaluate(
      async (token) => window.novus.invites.redeem(token),
      invitationToken
    );
    expect(replay.ok).toBe(false);

    // Both clients read the same durable mission.
    const kartikView = await detail(kartik, missionId);
    const mayaView = await detail(maya, missionId);
    expect(mayaView.participants.map((p) => p.login).sort()).toEqual(["kartik", "maya"]);
    expect(mayaView.participants).toEqual(kartikView.participants);
    expect(mayaView.checkpoints).toEqual(kartikView.checkpoints);
    expect(mayaView.directions).toEqual(kartikView.directions);
    expect(mayaView.control.holderLogin).toBe("kartik");
    // She sees the evidence without holding authority over it.
    expect(mayaView.capabilities).toContain("direction.submit");
    expect(mayaView.capabilities).not.toContain("direction.apply");
    // Her machine has no checkout, so it registers no runner of its own.
    expect(mayaView.runner?.ownerLogin).toBe("kartik");
    await capture(maya, "21-second-participant-joined");

    // --- Her direction is attributed and queued, not dropped -----------------
    const queued = await maya.page.evaluate(async (id) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        body: "Also rotate the signing key",
        model: "claude-fable-5",
        effort: "high"
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    }, missionId);
    expect(queued.dispatched).toBe(false);

    const withQueue = await detail(kartik, missionId);
    const mayaDirection = withQueue.directions.find((d) => d.authorLogin === "maya");
    expect(mayaDirection?.state).toBe("queued");
    expect(withQueue.overlays).toContain("direction_queued");
    await capture(kartik, "22-queued-non-controller-direction");

    // --- Request, offer, accept, transfer ------------------------------------
    await maya.page.evaluate(async (id) => {
      const result = await window.novus.control.request(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);

    const requested = await until(
      kartik,
      missionId,
      (value) => value.control.openRequests.some((r) => r.requesterLogin === "maya"),
      "Maya's control request to reach Kartik"
    );
    expect(requested.overlays).toContain("control_requested");
    await capture(kartik, "23-control-request");

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
      "the handoff offer to reach Maya"
    );
    const offerId = offered.control.liveOffer?.offerId as string;
    await capture(maya, "24-handoff-offer");

    // A non-recipient cannot accept an offer addressed to someone else.
    const stolen = await kartik.page.evaluate(
      async (id) => window.novus.control.acceptOffer(id),
      offerId
    );
    expect(stolen.ok).toBe(false);

    await maya.page.evaluate(async (id) => {
      const result = await window.novus.control.acceptOffer(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, offerId);

    // The workstream is idle, so the transfer completes at once.
    const transferred = await until(
      maya,
      missionId,
      (value) => value.control.holderLogin === "maya",
      "control to transfer to Maya"
    );
    expect(transferred.capabilities).toContain("direction.apply");
    expect(transferred.control.openRequests).toHaveLength(0);
    await capture(maya, "25-control-transferred");

    // --- The previous controller's authority is gone -------------------------
    const kartikAfter = await detail(kartik, missionId);
    expect(kartikAfter.control.holderLogin).toBe("maya");
    expect(kartikAfter.capabilities).not.toContain("direction.apply");
    expect(kartikAfter.capabilities).not.toContain("control.offer");

    const deniedApply = await kartik.page.evaluate(
      async (directionId) =>
        window.novus.missions.resolveDirection({ directionId, action: "apply" }),
      mayaDirection?.directionId as string
    );
    expect(deniedApply.ok).toBe(false);
    expect(deniedApply.ok === false && deniedApply.code).toBe("forbidden");

    const deniedOffer = await kartik.page.evaluate(
      async (input) => window.novus.control.offer(input),
      { missionId, toUserId: kartikIdentity.userId }
    );
    expect(deniedOffer.ok).toBe(false);

    // --- The new controller directs; Kartik's machine does the work ----------
    const applied = await maya.page.evaluate(
      async (directionId) => {
        const result = await window.novus.missions.resolveDirection({ directionId, action: "apply" });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        return true;
      },
      mayaDirection?.directionId as string
    );
    expect(applied).toBe(true);

    const mayasTurn = await until(
      maya,
      missionId,
      (value) =>
        value.executions.length >= 2 &&
        value.executions[value.executions.length - 1]?.state === "completed",
      "Maya's direction to run on Kartik's runner",
      60_000
    );
    const mayasExecution = mayasExecutionOf(mayasTurn);
    expect(mayasExecution.startedByLogin).toBe("maya");
    expect(mayasExecution.runnerId).toBe(mayasTurn.runner?.runnerId);
    expect(mayasTurn.directions.find((d) => d.authorLogin === "maya")?.state).toBe("applied");
    expect(mayasTurn.checkpoints.length).toBeGreaterThan(1);
    await capture(maya, "26-new-controller-direction-executed");

    // Both clients see the identical result.
    const kartikFinal = await until(
      kartik,
      missionId,
      (value) => value.executions.length >= 2,
      "Kartik's client to catch up"
    );
    expect(kartikFinal.checkpoints.length).toBe(mayasTurn.checkpoints.length);
    expect(kartikFinal.control.holderLogin).toBe("maya");

    // Nothing was verified, and the room says so rather than implying otherwise.
    expect(mayasTurn.checks.filter((check) => check.outcome === "passed")).toHaveLength(0);
    expect(["work_completed_unverified", "ready_for_review"]).toContain(mayasTurn.state);

    // --- Both clients close and reopen ---------------------------------------
    await kartik.app.close();
    await maya.app.close();
    kartik = await launch("kartik", kartikDir);
    maya = await launch("maya", mayaDir);
    await signIn(kartik);
    await signIn(maya);

    const kartikReopened = await detail(kartik, missionId);
    const mayaReopened = await detail(maya, missionId);
    for (const view of [kartikReopened, mayaReopened]) {
      expect(view.participants.map((p) => p.login).sort()).toEqual(["kartik", "maya"]);
      expect(view.control.holderLogin).toBe("maya");
      expect(view.directions.map((d) => `${d.authorLogin}:${d.state}`)).toEqual(
        mayasTurn.directions.map((d) => `${d.authorLogin}:${d.state}`)
      );
      expect(view.checkpoints.length).toBe(mayasTurn.checkpoints.length);
      expect(view.events.some((event) => event.kind === "control.transferred")).toBe(true);
      expect(view.events.some((event) => event.kind === "participant.joined")).toBe(true);
    }

    await capture(kartik, "27-reconstructed-after-relaunch");

    // --- The baton goes back (D-219): release, then claim ---------------------
    // Maya reopened as the controller, so her state line carries the quiet
    // Release control action beside "You have the baton". She clicks it — the
    // real interface, not the bridge — and the lane is unheld until claimed.
    await maya.page.getByTestId("project-room").first().waitFor({ timeout: 20_000 });
    const releaseAction = maya.page.getByTestId("release-control");
    await releaseAction.waitFor({ timeout: 15_000 });
    await snap(maya, "227-release-control-on-the-state-line");
    await releaseAction.click();

    const unheld = await until(
      kartik,
      missionId,
      (value) => value.control.holderUserId === null,
      "the baton to come back unheld"
    );
    expect(unheld.events.some((event) => event.kind === "control.released")).toBe(true);

    // Maya's lease authority ended the moment she let go.
    const mayaAfterRelease = await detail(maya, missionId);
    expect(mayaAfterRelease.capabilities).not.toContain("control.offer");
    expect(mayaAfterRelease.capabilities).not.toContain("direction.apply");

    // The unheld lane is claimable: Kartik's request fulfills immediately,
    // completing the two-step return of the baton (PRODUCT.md#control).
    await kartik.page.evaluate(async (id) => {
      const result = await window.novus.control.request(id);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, missionId);
    const reclaimed = await until(
      maya,
      missionId,
      (value) => value.control.holderLogin === "kartik",
      "Kartik to claim the released baton"
    );
    expect(reclaimed.events.some((event) => event.kind === "control.granted")).toBe(true);
    await capture(kartik, "228-baton-handed-back-and-claimed");

    await kartik.app.close();
    await maya.app.close();
  });
});

/** The execution Maya's applied direction produced. */
function mayasExecutionOf(view: MissionDetailResponse) {
  const found = view.executions[view.executions.length - 1];
  if (!found) throw new Error("no execution recorded");
  return found;
}
