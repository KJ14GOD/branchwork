import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * Publishing a decision as a pull request, end to end (D-099).
 *
 * A real window, a real worktree, a real `git push` to a real loopback
 * remote that demands the injected credential, and the fake GitHub host on
 * the control plane for everything a live host would answer. What a person
 * does: work a lane, fork an alternative, decide with a rationale, push the
 * branch from the receipt, open the draft, request review, watch a comment
 * arrive and resolve, mark it ready — and watch a human's merge on the host
 * land in the room with their name on it. What never exists: a merge
 * control, asserted by looking.
 *
 * The live GitHub half of the adapter is deliberately not exercised here;
 * the fake proves the pipeline (AGENTS.md rule 11), and PROGRESS.md says so.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4498;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_pr";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;
/** The fake provider's fixed repository, and its deterministic head. */
const PROVIDER_REPO = "9001";
const PROVIDER_HEAD = createHash("sha1").update("demo-app@main").digest("hex");

let controlPlane: ChildProcess;
let userDataDir: string;
let fixtureDir: string;
let originDir: string;
let remote: { url: string; seen: string[]; close: () => Promise<void> } | null = null;
let missionId: string;
let app: ElectronApplication;
let page: Page;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();

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

/** The loopback remote the push credential names: smart HTTP over
 *  `git http-backend`, refusing anonymous access, so the push in this spec is
 *  a real authenticated push and not a file copy. */
async function startRemote(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Basic ")) {
      seen.push(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8"));
    }
    if (!authorization.startsWith("Basic ")) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="novus"' });
      response.end("authentication required");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: originDir,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      }
    });
    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf("\r\n\r\n");
      if (split === -1) return;
      const headerText = head.subarray(0, split).toString("utf8");
      const rest = head.subarray(split + 4);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const at = line.indexOf(":");
        if (at === -1) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      if (rest.length > 0) response.write(rest);
      headersDone = true;
    });
    backend.on("close", () => response.end());
    backend.on("error", () => {
      if (!headersDone) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    seen,
    close: () => new Promise((settle) => server.close(() => settle()))
  };
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
    ? ` — state ${last.state}; push ${JSON.stringify(last.branchPush)}; pr ${last.pullRequest?.state ?? "none"}; lanes ${last.workstreams
        .map((lane) => `${lane.workstreamId}:${lane.branchStatus}:${lane.remoteHeadSha ?? "unpushed"}`)
        .join(", ")}; executions ${last.executions
        .map((execution) => `${execution.state}${execution.failureReason ? `(${execution.failureReason})` : ""}`)
        .join(", ")}`
    : "";
  throw new Error(`timed out waiting for ${what}${where}`);
}

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

/** The fake host's own side: what somebody did on GitHub. */
async function hostActs(action: string, body: Record<string, unknown>): Promise<void> {
  const acted = await fetch(`${CP_URL}/fake/github/pulls/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerRepoId: PROVIDER_REPO, ...body })
  });
  expect(acted.ok).toBe(true);
}

const shot = (name: string) =>
  page.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-pr-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  if ((await admin.query(`select 1 from pg_database where datname='${DB_NAME}'`)).rowCount === 0) {
    await admin.query(`create database ${DB_NAME}`);
  }
  await admin.end();
  const scrub = new pg.default.Pool({ connectionString: DB_URL });
  await scrub.query("drop schema public cascade; create schema public;");
  await scrub.end();

  // The push target: a bare repository behind an authenticating smart-HTTP
  // server. The fake provider's push credential points here, so the app's own
  // Push branch performs a genuine authenticated push in this spec.
  const bare = mkdtempSync(join(tmpdir(), "novus-pr-origin-"));
  originDir = bare;
  git(bare, ["init", "--bare", join(bare, "repo.git")]);
  git(join(bare, "repo.git"), ["config", "http.receivepack", "true"]);
  remote = await startRemote();

  controlPlane = spawn(
    process.execPath,
    ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")],
    {
      env: {
        ...process.env,
        NOVUS_FAKE_GITHUB: "1",
        NOVUS_CP_PORT: String(CP_PORT),
        NOVUS_DATABASE_URL: DB_URL,
        NOVUS_FAKE_PUSH_REMOTE: remote.url,
        // The host's story lands in seconds rather than the deployed cadence.
        NOVUS_PR_SWEEP_MS: "1500"
      },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  // A GitHub-provider mission whose checkout this machine already holds: the
  // repository map keys by provider id, and a mapped folder and a fetched
  // clone are the same entry (D-025, D-032). The mission branch the server
  // allocates is cut locally before the app launches, exactly where a
  // runner's earlier fetch would have left it.
  fixtureDir = mkdtempSync(join(tmpdir(), "novus-pr-repo-"));
  git(fixtureDir, ["init", "-b", "main"]);
  writeFileSync(join(fixtureDir, "README.md"), "# pr fixture\n");
  git(fixtureDir, ["add", "-A"]);
  git(fixtureDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);

  const token = await mintToken();
  const created = await fetch(`${CP_URL}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      goal: "Ship the session guard",
      successCriteria: "The change is on a reviewable pull request",
      provider: "github",
      providerRepoId: PROVIDER_REPO,
      baseRef: "main",
      baseSha: PROVIDER_HEAD,
      creationKey: randomUUID()
    })
  });
  expect(created.ok).toBe(true);
  const body = (await created.json()) as {
    mission: { missionId: string };
    workstream: { workstreamId: string; missionBranch: string };
  };
  missionId = body.mission.missionId;
  git(fixtureDir, ["branch", body.workstream.missionBranch]);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [PROVIDER_REPO]: fixtureDir }));

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

  // Open the mission the way a person does: from the rail.
  const group = page.locator(".side-group", {
    has: page.getByTestId("project-row").filter({ hasText: "novus/demo-app" })
  });
  await group.waitFor({ timeout: 30_000 });
  // Disclosure is per project and the row's click is a toggle (D-077); the
  // restore path discloses open-tab projects on its own schedule, so a count
  // of visible rows never said whether a click opens or closes. The twisty's
  // aria-expanded is the per-project fact (the D-120/D-121 batch's find).
  if ((await group.getByTestId("project-twisty").getAttribute("aria-expanded")) !== "true") {
    await group.getByTestId("project-row").click();
  }
  await group.getByTestId("mission-row").first().click();
  await page.getByTestId("state-line").waitFor({ timeout: 30_000 });

  // A first turn, so there is a result to decide on.
  await direct("write the fake turn file");
  await until("the first turn to checkpoint", (value) =>
    value.checkpoints.some((checkpoint) => checkpoint.sha !== null)
  );
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
  await remote?.close();
});

describe("shipping a decision through GitHub (D-099)", () => {
  it(
    "forks, decides, pushes the decided revision, opens the draft, and stewards it to a human's merge",
    async () => {
      // --- An alternative exists, so Compare and the receipt are reachable --
      await page.getByTestId("try-another-approach").click();
      await page.getByTestId("try-approach-dialog").waitFor({ timeout: 30_000 });
      await page.getByTestId("approach-intent-input").fill("Try the guard in middleware");
      await page.getByTestId("create-approach").click();
      await until(
        "the approach to exist",
        (value) => value.workstreams.length === 2 && value.workstreams[1]?.branchStatus === "created"
      );

      // --- Decide the baseline, with a rationale ---------------------------
      await page.getByTestId("rail-compare").click();
      const columns = page.getByTestId("approach-column");
      await columns.first().waitFor({ timeout: 30_000 });
      await columns.nth(0).getByTestId("choose-approach").click();
      await page.getByTestId("record-decision").waitFor({ timeout: 30_000 });
      await page.getByTestId("decision-rationale").fill("The baseline holds and its check passed.");
      await page.getByTestId("record-decision-confirm").click();
      const decided = await until(
        "the decision to exist",
        (value) => value.decisions.some((entry) => entry.supersededAt === null)
      );
      const decision = decided.decisions.find((entry) => entry.supersededAt === null)!;
      expect(decision.checkpointSha).toBeTruthy();

      // --- The receipt offers publish, and honesty precedes the draft ------
      await page.getByTestId("pull-publish").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("push-state").innerText()).toContain("never been pushed");
      // Create is disabled until GitHub serves the decided revision; the
      // server enforces the same rule this button explains.
      expect(await page.getByTestId("create-pull-request").isDisabled()).toBe(true);
      await shot("108-publish-before-push.png");

      // --- Push branch: a real authenticated push to the loopback host -----
      await page.getByTestId("push-branch").click();
      await until(
        "the push to land",
        (value) =>
          value.branchPush?.state === "completed" &&
          value.workstreams.find((lane) => lane.workstreamId === decision.workstreamId)
            ?.remoteHeadSha === decision.checkpointSha,
        120_000
      );
      // The remote genuinely serves the decided revision, says git itself.
      const served = git(join(originDir, "repo.git"), [
        "rev-parse",
        `refs/heads/${decided.workstream!.missionBranch}`
      ]);
      expect(served).toBe(decision.checkpointSha);
      // And the credential travelled through the helper, not a URL or config.
      expect(remote!.seen.some((entry) => entry.startsWith("x-access-token:"))).toBe(true);

      // --- Open the draft ---------------------------------------------------
      await expect
        .poll(async () => page.getByTestId("create-pull-request").isDisabled(), { timeout: 30_000 })
        .toBe(false);
      await page.getByTestId("create-pull-request").click();
      const opened = await until(
        "the draft to open",
        (value) => value.pullRequest !== null && value.pullRequest.state === "draft"
      );
      expect(opened.state).toBe("pull_request_open");
      const pull = opened.pullRequest!;
      expect(pull.headSha).toBe(decision.checkpointSha);
      expect(pull.body).toContain("The baseline holds");

      // The room's sentence carries the open request while its header shows.
      await expect
        .poll(async () => page.getByTestId("state-line").innerText(), { timeout: 30_000 })
        .toContain("Pull request open");
      // The receipt collapses to its sentence; the page is the request's own
      // tab, opened by a person — from the receipt here, and the rail row
      // carries the same way in (D-100, D-089).
      await page.getByTestId("rail-pull").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("rail-pull").innerText()).toContain("PR #1");
      await page.getByTestId("open-pull-tab").click();
      await page.getByTestId("pull-tab").waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("pull-tab").innerText()).toContain("draft");
      await page.getByTestId("pull-page").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("pull-headline").innerText()).toContain("is a draft");
      expect(await page.getByTestId("pull-branches").innerText()).toContain("→ main");
      // A draft offers no merge control — readiness precedes the verb — and
      // the sentence carries the never-silent rule (D-100).
      expect(await page.locator("button", { hasText: /^Merge/ }).count()).toBe(0);
      expect(await page.getByTestId("pull-no-silent-merge").innerText()).toContain(
        "nothing ever merges silently"
      );
      await shot("109-pull-request-page.png");

      // --- Visual evidence on the request (D-122) ---------------------------
      // The artifact is seeded over the real API — begin, upload against the
      // signed grant, complete on the store's verification — because this
      // mission runs no preview; the capture path itself is proven in
      // e2e/artifacts.spec.ts. What this proves is the relationship: the
      // exact id preserved on the tracked record and shown on the page.
      const seededBytes = Buffer.from(`pr-evidence-${"x".repeat(64)}`);
      const seedToken = await mintToken();
      const begun = await fetch(`${CP_URL}/missions/${missionId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${seedToken}` },
        body: JSON.stringify({
          workstreamId: decision.workstreamId,
          kind: "screenshot",
          mimeType: "image/png",
          byteSize: seededBytes.length,
          sha256: createHash("sha256").update(seededBytes).digest("hex"),
          capturedAt: new Date().toISOString(),
          provenance: {
            processId: "prc_seeded",
            processName: "app",
            origin: "http://127.0.0.1:4600",
            readiness: "ready",
            revisionSha: decision.checkpointSha,
            revisionDirty: false
          }
        })
      });
      expect(begun.status).toBe(201);
      const begunBody = (await begun.json()) as {
        artifact: { artifactId: string };
        upload: { url: string; headers: Record<string, string> };
      };
      const uploaded = await fetch(begunBody.upload.url, {
        method: "PUT",
        headers: begunBody.upload.headers,
        body: new Uint8Array(seededBytes)
      });
      expect(uploaded.ok).toBe(true);
      const completed = await fetch(
        `${CP_URL}/artifacts/${begunBody.artifact.artifactId}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${seedToken}` },
          body: JSON.stringify({ outcome: "uploaded" })
        }
      );
      expect(completed.ok).toBe(true);
      const attachedToPull = await fetch(
        `${CP_URL}/artifacts/${begunBody.artifact.artifactId}/attach`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${seedToken}` },
          body: JSON.stringify({ target: { kind: "pull_request", id: pull.pullRequestId } })
        }
      );
      expect(attachedToPull.ok).toBe(true);
      // The page's Checks segment shows the evidence with the boundary said
      // in words: inside Novus, no copy to GitHub.
      await page.getByTestId("pull-tab-checks").click();
      const pullEvidence = page.getByTestId("pull-artifact-row");
      await pullEvidence.waitFor({ timeout: 30_000 });
      expect(await pullEvidence.getAttribute("data-artifact")).toBe(
        begunBody.artifact.artifactId
      );
      expect(await page.getByTestId("pull-visuals").innerText()).toContain(
        "GitHub receives no copy"
      );
      await shot("137-pull-request-evidence.png");
      await page.getByTestId("pull-tab-comments").click();

      // --- Review: asked from here, answered here (D-100) -------------------
      await page.getByTestId("reviewer-input").fill("maya");
      await page.getByTestId("request-review").click();
      await expect
        .poll(async () => page.getByTestId("pull-reviewers").innerText(), { timeout: 30_000 })
        .toContain("maya");

      await hostActs("comment", { number: pull.number, author: "maya", body: "Is the guard bounded?", path: "README.md" });
      await until(
        "the comment to be ingested",
        (value) => (value.pullRequest?.reviewThreads.length ?? 0) === 1,
        60_000
      );
      expect(await page.getByTestId("pull-threads").innerText()).toContain("Is the guard bounded?");
      expect(await page.getByTestId("pull-reviewers").innerText()).toContain("1 comment open");

      // Send to chat: the comment becomes a direction for the decided lane's
      // conversation, and the chat genuinely takes it.
      const directionsBefore = (await detail()).directions.length;
      await page.getByTestId("send-to-chat").click();
      const withSent = await until(
        "the comment to become a direction",
        (value) => value.directions.length > directionsBefore,
        60_000
      );
      const sent = withSent.directions[withSent.directions.length - 1]!;
      expect(sent.body).toContain("Is the guard bounded?");
      expect(sent.body).toContain("maya");
      await until(
        "the chat's turn to finish",
        (value) =>
          value.executions.length > 0 &&
          value.executions.every((execution) =>
            ["completed", "stopped", "failed", "interrupted"].includes(execution.state)
          ),
        120_000
      );

      // Resolving happens from Novus now, and lands on the host.
      await page.getByTestId("resolve-thread").click();
      await until(
        "the resolution to be reflected",
        (value) => value.pullRequest?.reviewThreads[0]?.state === "resolved",
        60_000
      );

      // --- Ready is a person's own claim ------------------------------------
      await page.getByTestId("mark-ready").click();
      await until("ready to land", (value) => value.pullRequest?.state === "ready");
      await expect
        .poll(async () => page.getByTestId("pull-headline").innerText(), { timeout: 30_000 })
        .toContain("awaits review");

      // --- The readiness gate fills from the host's own story ---------------
      await hostActs("check", { number: pull.number, checkName: "ci", checkStatus: "passed", required: true });
      await hostActs("check", { number: pull.number, checkName: "lint", checkStatus: "failed", required: false });
      await hostActs("review", { number: pull.number, verdict: "approve" });
      await hostActs("behind", { number: pull.number, behindBy: 2 });
      await until(
        "readiness to be ingested",
        (value) =>
          (value.pullRequest?.readiness?.checks.length ?? 0) >= 2 &&
          value.pullRequest?.readiness?.behindBy === 2,
        60_000
      );
      // The gate lives on the page's own Checks sub-tab, count on the label.
      await page.getByTestId("pull-tab-checks").click();
      await expect
        .poll(async () => page.getByTestId("pull-readiness").innerText(), { timeout: 30_000 })
        .toContain("ci · required");
      expect(await page.getByTestId("pull-tab-checks").innerText()).toContain("Checks 1/2");
      const readiness = await page.getByTestId("pull-readiness").innerText();
      expect(readiness).toContain("lint");
      expect(readiness).toContain("failed");
      expect(readiness).toContain("approved (1)");
      expect(readiness).toContain("2 commits behind main");
      await shot("111-merge-readiness.png");

      // Update branch is one click, and the gate follows.
      await page.getByTestId("update-branch").click();
      await until(
        "the branch to catch up",
        (value) => value.pullRequest?.readiness?.behindBy === 0,
        60_000
      );

      await shot("114-pull-request-tab.png");

      // --- The merge is Novus's control and GitHub's act (D-100) ------------
      // The confirm restates the one remaining blocker (lint, non-required)
      // and proceeding accepts exactly it — never silently.
      await page.getByTestId("merge-open").click();
      await page.getByTestId("merge-blockers").waitFor({ timeout: 20_000 });
      // The label renders in the house micro-caps; the words are what matter.
      const confirm = (await page.getByTestId("merge-blockers").innerText()).toLowerCase();
      expect(confirm).toContain("deliberately");
      await page.getByTestId("method-squash").click();
      expect(await page.getByTestId("method-squash").getAttribute("aria-checked")).toBe("true");
      await shot("112-merge-confirm.png");
      await page.getByTestId("merge-confirm").click();
      // The sweep may ingest the host's merged state a beat before the
      // route's own transaction commits; the recorded act is what to wait on.
      const merged = await until(
        "the merge to land with the person's act recorded",
        (value) =>
          value.pullRequest?.state === "merged" &&
          value.events.some((event) => event.kind === "pr.merge_performed"),
        60_000
      );
      // The person's act is recorded with what was accepted; the host
      // performed it, and the sentence names how publication ended.
      const performed = merged.events.find((event) => event.kind === "pr.merge_performed");
      expect(performed).toBeTruthy();
      expect(String((performed!.payload as { acceptedBlockers: string[] }).acceptedBlockers)).toContain(
        "lint"
      );
      expect(merged.state).toBe("decision_recorded");
      await expect
        .poll(async () => page.getByTestId("pull-headline").innerText(), { timeout: 30_000 })
        .toContain("was merged");
      await shot("113-merged-from-novus.png");
      // The room's own sentence names how publication ended — read where the
      // header shows, on the lane's canvas, then come back to the tab.
      await page.getByTestId("lane-tab").first().click();
      await expect
        .poll(async () => page.getByTestId("state-line").innerText(), { timeout: 30_000 })
        .toContain("published as PR #1, merged");
      await page.getByTestId("pull-tab").locator(".file-tab-open").click();
      await page.getByTestId("pull-page").waitFor({ timeout: 20_000 });

      // --- Completion's tail: delete the branch, archive the mission --------
      await page.getByTestId("delete-branch").click();
      await page.getByTestId("delete-branch-confirm").click();
      await until(
        "the deletion to be recorded",
        (value) => value.events.some((event) => event.kind === "pr.branch_deleted"),
        30_000
      );
      await page.getByTestId("archive-after-merge").click();
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const result = await window.novus.missions.list();
              return result.ok ? result.value.length : -1;
            }),
          { timeout: 30_000 }
        )
        .toBe(0);

      const kinds = merged.events.filter((event) => event.kind.startsWith("pr.")).map((event) => event.kind);
      expect(kinds).toContain("pr.opened");
      expect(kinds).toContain("pr.branch_updated");
      expect(kinds).toContain("pr.thread_resolved");
      expect(kinds).toContain("pr.merge_performed");
    },
    300_000
  );
});
