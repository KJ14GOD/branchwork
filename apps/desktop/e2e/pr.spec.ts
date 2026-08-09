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
  if ((await group.getByTestId("mission-row").count()) === 0) {
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

      await page.getByTestId("pull-page").waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("pull-headline").innerText()).toContain("is a draft");
      expect(await page.getByTestId("pull-branches").innerText()).toContain("→ main");
      expect(await page.getByTestId("state-line").innerText()).toContain("Pull request open");
      // No merge control exists anywhere on the page, and the sentence says
      // where merging happens instead.
      expect(await page.locator("button", { hasText: /^Merge/ }).count()).toBe(0);
      expect(await page.getByTestId("pull-no-merge").innerText()).toContain("Novus never merges");
      await shot("109-pull-request-page.png");

      // --- Review: asked from here, answered on the host --------------------
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

      await hostActs("resolve", { number: pull.number });
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

      // --- A human merges on GitHub; Novus records who ----------------------
      await hostActs("merge", { number: pull.number, author: "maya" });
      const merged = await until(
        "the merge to be ingested",
        (value) => value.pullRequest?.state === "merged",
        60_000
      );
      expect(merged.pullRequest?.mergedBy).toBe("maya");
      // The mission returns to the decision, whose sentence names publication.
      expect(merged.state).toBe("decision_recorded");
      await expect
        .poll(async () => page.getByTestId("state-line").innerText(), { timeout: 30_000 })
        .toContain("merged by maya");
      await shot("110-merged-by-a-human.png");

      // The event record carries the host's acts as external claims.
      const events = merged.events.filter((event) => event.kind.startsWith("pr."));
      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain("pr.opened");
      expect(kinds).toContain("pr.merged");
    },
    300_000
  );
});
