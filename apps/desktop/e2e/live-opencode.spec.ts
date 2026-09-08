import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/** Opt-in live OpenCode proof. The GitHub OAuth upstream is a fixture;
 * Electron, the runner, OpenCode, its hosted model, approval channel and git
 * checkpoints are real. No provider credentials are managed by this test. */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const LIVE = process.env.NOVUS_LIVE_OPENCODE === "1";
const MODEL = process.env.NOVUS_LIVE_OPENCODE_MODEL ?? "opencode:opencode/big-pickle";

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4509;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_opencode";

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;

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

/**
 * Captures what the app is actually showing. Reloading takes a signed-in
 * client past the setup surface into the room and makes the frame a
 * reconstruction from the control plane rather than leftover local state.
 */
async function capture(name: string): Promise<void> {
  try {
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-room").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  } catch (error) {
    console.warn(`could not capture ${name}:`, error instanceof Error ? error.message : error);
  }
}

const detail = (missionId: string): Promise<MissionDetailResponse> =>
  page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);

async function until(
  missionId: string,
  predicate: (value: MissionDetailResponse) => boolean,
  what: string,
  timeoutMs: number
): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: MissionDetailResponse | null = null;
  while (Date.now() < deadline) {
    last = await detail(missionId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `timed out waiting for ${what}; last execution state: ${last?.executions.at(-1)?.state ?? "none"}`
  );
}

beforeAll(async () => {
  if (!LIVE) return;
  mkdirSync(evidenceDir, { recursive: true });

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_e2e_opencode'");
  if (exists.rowCount === 0) await admin.query("create database novus_e2e_opencode");
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

afterAll(async () => {
  if (!LIVE) return;
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe.skipIf(!LIVE)("a real OpenCode turn, end to end", () => {
  it("changes a real repository, records git-derived evidence, and remembers the first turn in the second", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "novus-live-repo-"));
    const repoName = basename(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    writeFileSync(join(repoDir, "README.md"), "# live demo\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const headSha = git(repoDir, ["rev-parse", "HEAD"]);

    const userDataDir = mkdtempSync(join(tmpdir(), "novus-live-"));
    const localId = randomUUID();
    writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: repoDir }));

    app = await electron.launch({
      args: [desktopRoot],
      env: {
        ...process.env,
        NOVUS_CP_URL: CP_URL,
        NOVUS_AUTH_AUTOVISIT: "1",
        NOVUS_FAKE_IDENTITY: "kartik",
        NOVUS_USER_DATA_DIR: userDataDir
        // Deliberately no NOVUS_FAKE_HARNESS: this runs the real CLI.
      }
    });
    app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[novus] ${chunk}`));
    app.process().stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[novus!] ${chunk}`));
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => typeof window.novus !== "undefined");

    await page.getByText("OpenCode", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(evidenceDir, "252-opencode-setup.png") });
    await page.evaluate(() => window.novus.auth.start());
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = await page.evaluate(() => window.novus.auth.status());
      if (status.state === "signed_in") break;
      if (Date.now() > deadline) throw new Error("sign-in never completed");
      await new Promise((r) => setTimeout(r, 250));
    }

    // Register the repository the way the folder picker would.
    const token = await (async () => {
      const start = await fetch(`${CP_URL}/auth/github/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as: "kartik" })
      });
      const { state, authorizeUrl } = (await start.json()) as { state: string; authorizeUrl: string };
      await fetch(authorizeUrl, { redirect: "follow" });
      const claim = await fetch(`${CP_URL}/auth/github/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state })
      });
      return ((await claim.json()) as { token: string }).token;
    })();
    const registered = await fetch(`${CP_URL}/repositories/local`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
    });
    expect(registered.ok).toBe(true);

    const base = await page.evaluate(async (id) => {
      const result = await window.novus.repos.baseLocal(id);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }, localId);

    const created = await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.create({
          goal: "Prove a live OpenCode turn",
          successCriteria: "HELLO.txt exists on the mission branch with the expected content",
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

    await until(missionId, (value) => value.runner !== null, "the runner to register", 60_000);

    await page.reload();
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
    if (await page.getByTestId("mission-row").count() === 0) await page.getByTestId("project-row").first().click();
    const initialRow = page.getByTestId("mission-row").first();
    if (!((await initialRow.getAttribute("class")) ?? "").includes("active-mission")) await initialRow.click();
    await page.getByTestId("model-chip").click();
    await page.getByTestId("provider-opencode:opencode").waitFor({ timeout: 60_000 });
    await page.getByTestId("provider-opencode:opencode").click();
    await page.screenshot({ path: join(evidenceDir, "247-opencode-provider-menu.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 820));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidenceDir, "251-opencode-menu-narrow.png") });
    const menuFits = await page.getByTestId("model-submenu").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0;
    });
    expect(menuFits).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    const option = page.locator(`[data-model="${MODEL}"]`);
    const label = (await option.textContent())!.trim();
    await option.click();
    expect(await page.getByTestId("model-chip").textContent()).toContain(label);

    await page.getByTestId("composer-input").fill("My preferred project name is Juniper. Create HELLO.txt containing exactly hello using your file tool. Keep the project name only in this conversation. Then reply with one sentence.");
    await page.getByTestId("send").click();

    await until(
      missionId,
      (value) => {
        if (value.approvals.some((approval) => approval.state === "pending")) return true;
        if (["completed", "failed", "stopped"].includes(value.executions.at(-1)?.state ?? "")) throw new Error("The model ended without requesting the expected file-write approval: " + JSON.stringify(value.events.filter((event) => event.kind === "harness.text").map((event) => event.payload.text)));
        return false;
      },
      "the real OpenCode to ask permission",
      300_000
    );

    const card = page.getByTestId("approval");
    await card.waitFor({ timeout: 60_000 });
    const asked = (await page.getByTestId("approval-summary").textContent()) ?? "";
    // A real request about the real file, and no file body in the durable text.
    expect(asked.toUpperCase()).toContain("HELLO.TXT");
    await page.screenshot({ path: join(evidenceDir, "248-live-opencode-approval.png") });

    // Nothing has been written yet: the harness is genuinely waiting.
    const worktree = git(repoDir, ["worktree", "list", "--porcelain"]).split("\n\n").find((entry) => entry.includes(`branch refs/heads/${missionBranch}`))?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    expect(worktree).toBeTruthy();
    expect(existsSync(join(worktree!, "HELLO.txt"))).toBe(false);

    await page.getByTestId("approval-approve").click();

    const answered = await until(
      missionId,
      (value) => value.approvals.some((approval) => approval.state === "approved"),
      "the approval to settle",
      120_000
    );
    expect(answered.approvals.at(-1)?.respondedByLogin).toBe("kartik");

    const afterFirst = await until(
      missionId,
      (value) => {
        if (value.executions.at(-1)?.state === "failed") throw new Error(JSON.stringify(value.executions.at(-1)));
        if (value.approvals.some((approval) => approval.state === "pending")) void page.getByTestId("approval-approve").first().click().catch(() => undefined);
        return value.executions.at(-1)?.state === "completed";
      },
      "the first live turn to finish",
      300_000
    );

    const firstCheckpoint = afterFirst.checkpoints.at(-1);
    expect(firstCheckpoint?.outcome).toBe("committed");
    expect(firstCheckpoint?.files.some((file) => file.path === "HELLO.txt")).toBe(true);
    expect(firstCheckpoint?.sha).toMatch(/^[0-9a-f]{40}$/);

    // The evidence is a claim about a real commit — check the repository itself.
    const committed = git(repoDir, ["show", `${missionBranch}:HELLO.txt`]);
    expect(committed.trim().toLowerCase()).toContain("hello");
    expect(git(repoDir, ["rev-parse", missionBranch])).toBe(firstCheckpoint?.sha);

    // The harness reported the session it is holding.
    const firstExecution = afterFirst.executions.at(-1);
    expect(firstExecution?.harnessSessionId).toBeTruthy();
    expect(firstExecution?.harness).toBe("opencode");
    expect(afterFirst.events.some((event) => event.kind === "harness.usage")).toBe(true);
    expect(afterFirst.events.some((event) => event.kind === "approval.cancelled")).toBe(false);
    await capture("249-live-opencode-turn");

    // --- Turn two: does it remember? -----------------------------------------
    await page.evaluate(async ({ id, model, sessionId }) => {
      const result = await window.novus.missions.direct({
        missionId: id,
        sessionId,
        body: "Without using tools, reply with only the preferred project name I mentioned earlier.",
        model,
        effort: "low"
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    }, { id: missionId, model: MODEL, sessionId: firstExecution!.sessionId });

    const afterSecond = await until(
      missionId,
      (value) => value.executions.length >= 2 && value.executions.at(-1)?.state === "completed",
      "the follow-up turn to finish",
      300_000
    );

    const secondExecution = afterSecond.executions.at(-1);
    // Continuity is a fact about the harness's own session, reported by the
    // runner. If it is false the room must say so; it must never be assumed.
    expect(secondExecution?.harnessSessionId).toBe(firstExecution?.harnessSessionId);
    expect(secondExecution?.resumedSession).toBe(true);

    const spoken = afterSecond.events
      .filter((event) => event.kind === "harness.text" && event.executionId === secondExecution?.executionId)
      .map((event) => String(event.payload.text ?? ""))
      .join("\n");
    expect(spoken).toContain("Juniper");

    await capture("250-live-opencode-continuity");
    const closed = await page.evaluate((id) => window.novus.missions.close(id, { outcome: "cancelled", reason: "The adapter verification is finished." }), missionId);
    expect(closed.ok).toBe(true);
    await page.getByTestId("receipt-view").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("receipt-view").textContent()).toContain(MODEL);
    await page.screenshot({ path: join(evidenceDir, "253-opencode-receipt.png") });
  }, 900_000);
});
