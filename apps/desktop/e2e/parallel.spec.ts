import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/**
 * Two scoped chats writing the one worktree at the same moment (D-097).
 *
 * The whole ownership claim, in a real window against a real control plane, a
 * real runner, and real git: the baton holder scopes chat A to `server/**`
 * and chat B to `ui/**`, directs both, and the second dispatches immediately
 * — two live write turns in one lane, the thing every slice before this one
 * forbade. Each turn's checkpoint commits exactly its own file, nothing
 * drifts, and the mission branch ends holding both. The harness is the
 * deterministic fake writing the file its direction names; what is being
 * proven is dispatch, enforcement, and evidence, not Claude.
 */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4496;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_parallel";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let app: ElectronApplication;
let page: Page;
let missionId = "";
let workstreamId = "";
let localId = "";
let headSha = "";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

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
    await new Promise((settle) => setTimeout(settle, 300));
  }
  const where = last
    ? ` — executions ${last.executions
        .map((execution) => `${execution.sessionId}:${execution.access}:${execution.state}`)
        .join(", ")}`
    : "";
  throw new Error(`timed out waiting for ${what}${where}`);
}

async function direct(body: string, options: { sessionId?: string; newSession?: boolean } = {}) {
  return page.evaluate(
    async (input) => {
      const result = await window.novus.missions.direct({
        missionId: input.missionId,
        body: input.body,
        model: "claude-fable-5",
        effort: "high",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.newSession ? { newSession: true } : {})
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    },
    { missionId, body, ...options }
  );
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-parallel-"));

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
  const dir = mkdtempSync(join(tmpdir(), "novus-parallel-repo-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${basename(dir)}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  headSha = git(dir, ["rev-parse", "HEAD"]);
  localId = randomUUID();
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
      NOVUS_FAKE_CONNECTORS: "[]",
      // Paced slowly enough that both turns are mid-flight together for
      // several of the room's two-second polls, so the window genuinely
      // paints them running side by side. No approval mode: enforcement is
      // proven in the unit suites; this spec proves dispatch and evidence.
      NOVUS_FAKE_HARNESS_PACE_MS: "1500",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await signIn();

  const created = await page.evaluate(
    async (input) => {
      const result = await window.novus.missions.create({
        goal: "Split the work by files",
        successCriteria: "Two chats write at once, each on its own ground",
        provider: "local",
        providerRepoId: input.localId,
        baseRef: "main",
        baseSha: input.headSha,
        creationKey: input.creationKey
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      return result.value;
    },
    { localId, headSha, creationKey: randomUUID() }
  );
  missionId = created.mission.missionId;
  workstreamId = created.workstream.workstreamId;
  await until("the runner to register", (value) => value.runner !== null);
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("scoped chats write in parallel", () => {
  it("dispatches both immediately, keeps each checkpoint to its own files, and merges cleanly", async () => {
    // Chat A exists from the mission's first direction; give it its turn so
    // both chats are titled and idle.
    const first = await direct("build the server half");
    const chatA = first.sessionId;
    await until(
      "chat A's first turn to finish",
      (value) =>
        value.executions.some(
          (execution) => execution.sessionId === chatA && execution.state === "completed"
        )
    );
    const second = await direct("build the ui half", { newSession: true });
    const chatB = second.sessionId;
    await until(
      "chat B's first turn to finish",
      (value) =>
        value.executions.some(
          (execution) => execution.sessionId === chatB && execution.state === "completed"
        )
    );

    // The baton holder declares who owns what (D-097).
    for (const [sessionId, scope] of [
      [chatA, ["server/**"]],
      [chatB, ["ui/**"]]
    ] as const) {
      const set = await page.evaluate(
        async (input) => window.novus.missions.setSessionScope(input),
        { missionId, sessionId, scope: [...scope] }
      );
      expect(set.ok).toBe(true);
    }

    // The room on screen first, so the frame that follows shows the mission —
    // the rail tree with both chats — and not the shell's Home.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    const firstTwisty = page.getByTestId("project-twisty").first();
    if ((await firstTwisty.getAttribute("aria-expanded")) !== "true") {
      await page.getByTestId("project-row").first().click();
    }
    // The active mission's row toggles its tree since D-134 (amended), so
    // "make sure it is open" must not blind-click an already-active row.
    const missionRow = page.getByTestId("mission-row").first();
    if (!(((await missionRow.getAttribute("class")) ?? "").includes("active-mission"))) {
      await missionRow.click();
    }
    await page.getByTestId("state-line").waitFor({ timeout: 30_000 });

    // Both directed; the second must not wait for the first.
    const startA = await direct("[fake-write:server/api.md] write the server file", {
      sessionId: chatA
    });
    expect(startA.dispatched).toBe(true);
    const startB = await direct("[fake-write:ui/view.md] write the ui file", { sessionId: chatB });
    expect(startB.dispatched).toBe(true);
    expect(startB.deferred).toBeNull();

    // Both genuinely mid-flight at once — the frame every slice before D-097
    // made impossible.
    await until("two live write turns at once", (value) => {
      const liveWriters = value.executions.filter(
        (execution) =>
          execution.access === "write" &&
          !["completed", "stopped", "failed", "interrupted"].includes(execution.state)
      );
      return new Set(liveWriters.map((execution) => execution.sessionId)).size === 2;
    });
    // The background chat's own word says so in the tree (D-094): the
    // selected row stays silent, the sibling reads working.
    const rows = page.getByTestId("rail-session-row");
    await expect
      .poll(async () => (await rows.allInnerTexts()).join(" | "), { timeout: 15_000 })
      .toContain("working");
    await page.screenshot({ path: join(evidenceDir, "102-two-writers-at-once.png") });

    const done = await until(
      "both turns to finish",
      (value) =>
        value.executions.filter(
          (execution) =>
            execution.startingDirectionId !== null && execution.state === "completed"
        ).length >= 4 ||
        value.executions.every((execution) => execution.state === "completed")
    );

    // Each chat's checkpoint holds exactly its own file, and nothing drifted.
    const checkpointOf = (sessionId: string) => {
      const executionIds = new Set(
        done.executions
          .filter((execution) => execution.sessionId === sessionId)
          .map((execution) => execution.executionId)
      );
      return done.checkpoints.filter(
        (checkpoint) => executionIds.has(checkpoint.executionId) && checkpoint.filesChanged > 0
      );
    };
    // The scoped turns' checkpoints (the first, pre-scope turns wrote the
    // fake file at the root — that was the point of scoping afterwards):
    // each holds exactly its own chat's file, nothing of the sibling's, and
    // nothing drifted.
    const scopedCheckpoint = (sessionId: string, ownPath: string, prefix: string) => {
      const own = checkpointOf(sessionId).find((checkpoint) =>
        checkpoint.files.some((file) => file.path === ownPath)
      );
      expect(own).toBeDefined();
      expect(own!.files.every((file) => file.path.startsWith(prefix))).toBe(true);
      expect(own!.driftPaths).toEqual([]);
    };
    scopedCheckpoint(chatA, "server/api.md", "server/");
    scopedCheckpoint(chatB, "ui/view.md", "ui/");

    // The worktree itself agrees: both files on the one branch, tree clean.
    const worktree = join(userDataDir, "worktrees", workstreamId);
    expect(existsSync(join(worktree, "server/api.md"))).toBe(true);
    expect(existsSync(join(worktree, "ui/view.md"))).toBe(true);
    expect(git(worktree, ["status", "--porcelain"]).trim()).toBe("");
    const committed = git(worktree, ["log", "--name-only", "--format=", "-4"]);
    expect(committed).toContain("server/api.md");
    expect(committed).toContain("ui/view.md");
  }, 240_000);
});
