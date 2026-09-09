import { expect, it } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global { interface Window { novus: NovusBridge } }

// Real Electron, HTTP, PostgreSQL, git and PTY. Only OAuth and the agent are
// doubles. This is Windows compatibility evidence, never live-provider proof.
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const evidence = join(desktopRoot, "e2e/evidence");
const url = "http://127.0.0.1:4489";
const database = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_windows";

it("creates a mission, approves a write, runs a native terminal and restores the mission", async () => {
  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  try {
    if (!(await admin.query("select 1 from pg_database where datname = 'novus_e2e_windows'")).rowCount) await admin.query("create database novus_e2e_windows");
  } finally { await admin.end(); }
  const db = new pg.default.Pool({ connectionString: database });
  await db.query("drop schema public cascade; create schema public;");
  await db.end();
  const cp = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "apps/control-plane/src/main.ts")], {
    env: { ...process.env, NOVUS_FAKE_GITHUB: "1", NOVUS_CP_PORT: "4489", NOVUS_DATABASE_URL: database }, stdio: "inherit"
  });
  const dataDir = mkdtempSync(join(tmpdir(), "novus-windows-data-"));
  const localRepo = mkdtempSync(join(tmpdir(), "novus project with spaces-"));
  const localId = randomUUID();
  const git = (...args: string[]) => execFileSync("git", ["-C", localRepo, ...args]).toString().trim();
  let app: ElectronApplication | undefined;
  try {
    await expect.poll(async () => {
      try { return (await fetch(`${url}/health`)).ok; } catch { return false; }
    }, { timeout: 30_000, interval: 500 }).toBe(true);
    git("init", "-b", "main");
    writeFileSync(join(localRepo, "README.md"), "# Windows fixture\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "base");
    const started = await fetch(`${url}/auth/github/start`, { method: "POST" });
    const auth = await started.json() as { state: string; authorizeUrl: string };
    await fetch(auth.authorizeUrl);
    const claim = await fetch(`${url}/auth/github/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: auth.state }) });
    const { token } = await claim.json() as { token: string };
    const registered = await fetch(`${url}/repositories/local`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId, name: basename(localRepo), defaultBranch: "main", headSha: git("rev-parse", "HEAD") }) });
    expect(registered.ok).toBe(true);
    writeFileSync(join(dataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepo }));
    const launch = () => electron.launch({ args: [desktopRoot], env: { ...process.env,
      NOVUS_CP_URL: url, NOVUS_AUTH_AUTOVISIT: "1", NOVUS_FAKE_HARNESS: "1", NOVUS_FAKE_HARNESS_APPROVAL: "1",
      NOVUS_FAKE_CONNECTORS: "[]", NOVUS_USER_DATA_DIR: dataDir } });
    app = await launch();
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await page.getByTestId("sign-in-button").click();
    await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
    await page.getByTestId("finish-setup").click();
    await page.getByTestId("project-shell").waitFor();
    const project = page.getByTestId("project-row").filter({ hasText: basename(localRepo) });
    await project.hover();
    await page.getByTestId("repo-new-mission").click();
    await page.getByTestId("new-mission-dialog").getByTestId("composer-input").fill("Write a Windows compatibility fixture");
    await page.keyboard.press("Enter");
    await page.getByTestId("new-mission-dialog").waitFor({ state: "detached" });
    await page.getByTestId("approval-approve").waitFor({ timeout: 60_000 });
    const ids = await page.evaluate(async (id) => {
      const missions = await window.novus.missions.list();
      if (!missions.ok) throw new Error(missions.message);
      const mission = missions.value.find(m => m.repository?.providerRepoId === id)!;
      const detail = await window.novus.missions.get(mission.missionId);
      if (!detail.ok) throw new Error(detail.message);
      return { missionId: mission.missionId, workstreamId: detail.value.workstream!.workstreamId };
    }, localId);
    const worktree = join(dataDir, "worktrees", ids.workstreamId);
    expect(existsSync(join(worktree, "NOVUS_FAKE_TURN.md"))).toBe(false);
    await page.getByTestId("approval-approve").click();
    await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).waitFor({ timeout: 60_000 });
    expect(existsSync(join(worktree, "NOVUS_FAKE_TURN.md"))).toBe(true);
    expect(execFileSync("git", ["-C", worktree, "status", "--porcelain"]).toString().trim()).toBe("");
    await page.getByTestId("terminal-toggle").click();
    await page.getByTestId("terminal-screen").waitFor();
    const command = `"${process.execPath}" -e "require('fs').writeFileSync('terminal-proof.txt',process.cwd())"`;
    // Writing a file proves shell execution; an echoed command cannot pass.
    await expect.poll(async () => {
      if (existsSync(join(worktree, "terminal-proof.txt"))) return true;
      await page.getByTestId("terminal-screen").click();
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
      return false;
    }, { timeout: 30_000, interval: 2000 }).toBe(true);
    expect(realpathSync(readFileSync(join(worktree, "terminal-proof.txt"), "utf8"))).toBe(realpathSync(worktree));
    if (process.platform === "win32") {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "258-windows-mission-terminal.png") });
    }
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
    await expect.poll(async () => page.evaluate(async (id) => {
      const result = await window.novus.missions.get(id);
      return result.ok && result.value.events.some(event => event.kind === "execution.completed");
    }, ids.missionId), { timeout: 30_000 }).toBe(true);
    const terminals = await page.evaluate(async (id) => window.novus.terminal.list(id), ids.missionId);
    expect(terminals.ok && terminals.value).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    cp.kill();
  }
}, 180_000);
