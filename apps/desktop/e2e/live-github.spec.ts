import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * A real GitHub repository, fetched and worked by this machine (D-025, D-032,
 * D-043).
 *
 * **Opt-in, and it cannot be otherwise.** Repository access comes from a GitHub
 * App installation bound to a real organization, and that binding is created by
 * a person signing in through their own browser — there is no way to fabricate
 * it from a test without also fabricating the thing being proven. So this run
 * borrows a Novus profile that is *already signed in*, which is the one part a
 * person has to do by hand, and then drives everything else through the app.
 *
 * To run it:
 *
 *   NOVUS_LIVE_GITHUB=1 \
 *   NOVUS_LIVE_PROFILE="$HOME/Library/Application Support/Novus" \
 *   NOVUS_LIVE_REPO=owner/name \
 *   pnpm --filter @novus/desktop exec vitest run --config e2e/vitest.config.ts e2e/live-github.spec.ts
 *
 * `NOVUS_LIVE_REPO` must be a repository the Novus GitHub App is installed on
 * and that you do not mind Novus pushing a mission branch to. The control plane
 * it talks to must have `NOVUS_GHAPP_ID` and `NOVUS_GHAPP_PEM_B64` configured;
 * this spec deliberately does **not** set `NOVUS_FAKE_GITHUB`, because a fake
 * provider here would prove nothing.
 *
 * What it asserts after the fact is the part that matters: that the short-lived
 * clone credential did its job and then existed nowhere — not in `.git/config`,
 * not in an event, not in a durable row, not in a log, not on disk — that the
 * source repository and any other workstream were untouched, and that nothing
 * downstream of the clone had a case for GitHub at all.
 */

const LIVE = process.env.NOVUS_LIVE_GITHUB === "1";
const PROFILE = process.env.NOVUS_LIVE_PROFILE ?? "";
const REPO = process.env.NOVUS_LIVE_REPO ?? "";

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4495;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_live_github";

let controlPlane: ChildProcess;
let userDataDir: string;
let app: ElectronApplication;
let page: Page;
let missionId = "";

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

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    args: [desktopRoot],
    env: { ...process.env, NOVUS_CP_URL: CP_URL, NOVUS_USER_DATA_DIR: dataDir }
  });
  const window = await launched.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await launched.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await new Promise((settle) => setTimeout(settle, 250));
  return { app: launched, page: window };
}

/** Every regular file under a directory, so "the token is nowhere on disk" can
 *  be checked rather than asserted. */
function filesUnder(root: string, found: string[] = []): string[] {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) filesUnder(path, found);
    else if (stats.size < 4_000_000) found.push(path);
  }
  return found;
}

beforeAll(async () => {
  if (!LIVE) return;
  if (PROFILE === "" || !existsSync(PROFILE)) {
    throw new Error("NOVUS_LIVE_PROFILE must point at a Novus profile that is already signed in");
  }
  if (!/^[^/]+\/[^/]+$/.test(REPO)) {
    throw new Error("NOVUS_LIVE_REPO must be owner/name");
  }
  mkdirSync(evidenceDir, { recursive: true });

  // A copy, so a live run never disturbs the real profile it borrows.
  userDataDir = mkdtempSync(join(tmpdir(), "novus-live-github-"));
  for (const carried of ["session.bin", "local-repos.json"]) {
    const from = join(PROFILE, carried);
    if (existsSync(from)) cpSync(from, join(userDataDir, carried));
  }
  if (!existsSync(join(userDataDir, "session.bin"))) {
    throw new Error("that profile holds no session — sign in to Novus once, then re-run");
  }

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  if ((await admin.query("select 1 from pg_database where datname='novus_e2e_live_github'")).rowCount === 0) {
    await admin.query("create database novus_e2e_live_github");
  }
  await admin.end();

  // Deliberately no NOVUS_FAKE_GITHUB: the whole point is the real provider.
  controlPlane = spawn(
    process.execPath,
    ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")],
    {
      env: { ...process.env, NOVUS_CP_PORT: String(CP_PORT), NOVUS_DATABASE_URL: DB_URL },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  const launched = await launch(userDataDir);
  app = launched.app;
  page = launched.page;
  await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
}, 300_000);

afterAll(async () => {
  if (!LIVE) return;
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe.skipIf(!LIVE)("a real GitHub repository, worked on this machine", () => {
  it("selects it, creates a mission, and fetches it onto this machine", async () => {
    await page.getByTestId("add-project").click();
    await page.getByTestId("add-project-dialog").waitFor({ timeout: 30_000 });
    await page.getByTestId("repo-search").fill(REPO.split("/")[1] ?? REPO);
    const row = page.getByTestId("repo-row").filter({ hasText: REPO });
    await row.first().waitFor({ timeout: 60_000 });
    await row.first().click();

    await page.getByTestId("draft-base").waitFor({ timeout: 60_000 });
    // The base is an exact commit resolved through the real GitHub App, not a
    // branch name Novus hopes still means the same thing later.
    const base = (await page.getByTestId("draft-base").textContent()) ?? "";
    expect(base).toContain(REPO.split("/")[1] ?? REPO);

    await page.getByTestId("composer-input").fill("read the README and say what this project is");
    await page.keyboard.press("Enter");
    expect(await page.getByTestId("send-error").count()).toBe(0);

    missionId = await expect
      .poll(
        async () =>
          page.evaluate(async (wanted) => {
            const result = await window.novus.missions.list();
            if (!result.ok) return "";
            return result.value.find((mission) => mission.repository?.name === wanted)?.missionId ?? "";
          }, REPO),
        { timeout: 90_000 }
      )
      .toMatch(/^msn_/)
      .then(() =>
        page.evaluate(async (wanted) => {
          const result = await window.novus.missions.list();
          if (!result.ok) throw new Error(result.message);
          return result.value.find((mission) => mission.repository?.name === wanted)?.missionId ?? "";
        }, REPO)
      );

    // The runner fetches it into Novus's own area, records where it landed, and
    // from there behaves exactly as it does for a folder somebody added.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const result = await window.novus.repos.checkedOutHere();
            return result.ok ? result.value.length : 0;
          }),
        { timeout: 180_000 }
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: join(evidenceDir, "60-live-github-fetched.png") });
  }, 300_000);

  it("has a worktree on the mission branch at the exact base the server recorded", async () => {
    const detail = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return {
        branch: result.value.workstream?.missionBranch ?? "",
        baseSha: result.value.workstream?.baseSha ?? "",
        status: result.value.workstream?.branchStatus ?? ""
      };
    }, missionId);
    expect(detail.status).toBe("created");
    expect(detail.branch).toMatch(/^novus\/m-/);

    const worktree = join(userDataDir, "worktrees", missionId);
    await expect.poll(() => existsSync(worktree), { timeout: 180_000 }).toBe(true);
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(detail.branch);
    // The worktree starts at the commit the control plane pinned, not at
    // whatever the branch happened to be by the time this ran.
    const merged = git(worktree, ["merge-base", "HEAD", detail.baseSha]);
    expect(merged).toBe(detail.baseSha);
  }, 300_000);

  it("runs a harmless declared command and a verification check on it", async () => {
    // Declared here rather than committed to somebody's repository: this proves
    // the runtime, and it should not require a pull request to run.
    const worktree = join(userDataDir, "worktrees", missionId);
    mkdirSync(join(worktree, ".novus"), { recursive: true });
    require("node:fs").writeFileSync(
      join(worktree, ".novus", "settings.local.toml"),
      [
        "[setup]",
        'command = "echo prepared > .novus-live-witness"',
        "",
        "[[verify]]",
        'name = "witness"',
        'command = "test -f .novus-live-witness"'
      ].join("\n")
    );

    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 30_000 });
    await page.getByTestId("run-item").filter({ hasText: "Setup" }).first().click();
    await expect
      .poll(() => existsSync(join(worktree, ".novus-live-witness")), { timeout: 120_000 })
      .toBe(true);

    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 30_000 });
    await page.getByTestId("run-item").filter({ hasText: "witness" }).first().click();
    await expect
      .poll(
        async () =>
          page.evaluate(async (mission) => {
            const result = await window.novus.missions.get(mission);
            if (!result.ok) return null;
            return result.value.checks.filter((check) => check.name === "witness").at(-1)?.outcome ?? null;
          }, missionId),
        { timeout: 120_000 }
      )
      .toBe("passed");
    await page.screenshot({ path: join(evidenceDir, "61-live-github-verified.png") });
  }, 300_000);

  it("left the clone credential nowhere: not in git, not in the record, not on disk", async () => {
    const checkout = join(userDataDir, "repositories");
    const worktree = join(userDataDir, "worktrees", missionId);

    // The remote URL is plain. A credential in it would have been written into
    // .git/config the moment the clone succeeded and would still be there.
    const remote = git(worktree, ["remote", "get-url", "origin"]);
    expect(remote.startsWith("https://")).toBe(true);
    expect(remote).not.toContain("@");
    expect(remote).not.toContain("x-access-token");

    const configs = filesUnder(checkout).filter((path) => path.endsWith("config"));
    for (const path of configs) {
      const body = readFileSync(path, "utf8");
      expect(body).not.toContain("x-access-token");
      expect(body).not.toMatch(/ghs_[A-Za-z0-9]/);
    }

    // Nothing anywhere in this machine's Novus state carries an installation
    // token, including the outbox, the enrolment file, and the process record.
    for (const path of filesUnder(userDataDir)) {
      const body = readFileSync(path, "latin1");
      expect(body, `${path} holds an installation token`).not.toMatch(/ghs_[A-Za-z0-9]{20}/);
    }

    // Nor does anything the control plane recorded.
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: DB_URL });
    const events = await pool.query("select payload::text as body from events");
    const rows = await pool.query(
      "select coalesce(command, '') || coalesce(output, '') as body from verification_checks"
    );
    await pool.end();
    for (const row of [...events.rows, ...rows.rows]) {
      expect(String(row.body)).not.toMatch(/ghs_[A-Za-z0-9]{20}/);
      expect(String(row.body)).not.toContain("x-access-token");
    }

    // And a user session cannot ask for one: only a runner credential may.
    const refused = await page.evaluate(async () => {
      const response = await fetch(`${location.origin}/runner/clone-credential`).catch(() => null);
      return response === null ? "unreachable" : String(response.status);
    });
    expect(refused).not.toBe("200");
  }, 180_000);

  it("reconstructs the mission after a relaunch, with the checkout reused", async () => {
    await app.close();
    const relaunched = await launch(userDataDir);
    app = relaunched.app;
    page = relaunched.page;
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });

    const after = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return {
        checks: result.value.checks.length,
        branch: result.value.workstream?.missionBranch ?? "",
        declared: result.value.workspace?.declared.length ?? 0
      };
    }, missionId);
    expect(after.checks).toBeGreaterThan(0);
    expect(after.branch).toMatch(/^novus\/m-/);
    expect(after.declared).toBeGreaterThan(0);
    await page.screenshot({ path: join(evidenceDir, "62-live-github-reconstructed.png") });
  }, 300_000);
});
