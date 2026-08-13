import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Project skills in a real window (D-118): the worktree's `.claude/skills`
 * published to the inspector's Overview, enabled from it by a person, the
 * enablement recorded as a durable event, and the next turn's own record
 * stating what it carried — driven end to end with the runner genuinely
 * discovering the manifest and composing the skills-only directory from the
 * real worktree. Only the CLI itself is the deterministic fake; everything
 * this spec asserts about publication, approval, pinning, and composition is
 * the production path.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4489;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_skills";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

const SKILL_BODY =
  "---\nname: zephyr-codes\ndescription: Codewords for releases.\n---\n\nThe codeword is XILOPHONE-72.\n";

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;
let repoName: string;

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

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-skills-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({
    connectionString: "postgres://novus:novus@127.0.0.1:5433/novus"
  });
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

  // The fixture project carries one skill of its own, committed like any
  // repository content — the thing D-072 refused to load wholesale and this
  // slice carries deliberately.
  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-skills-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# skills fixture\n");
  mkdirSync(join(localRepoDir, ".claude", "skills", "zephyr-codes"), { recursive: true });
  writeFileSync(join(localRepoDir, ".claude", "skills", "zephyr-codes", "SKILL.md"), SKILL_BODY);
  // And one declared MCP server (D-119), governed the same way one tier up.
  writeFileSync(
    join(localRepoDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "node", args: ["mcp/docs.js"] } } })
  );
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  const localId = randomUUID();
  const token = await mintToken();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepoDir }));

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

  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("start on the release notes");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("project skills reach the agent only after a person enabled them (D-118)", () => {
  it(
    "publishes the manifest, enables on a click, records the event, and the next turn carries it",
    async () => {
      // The first turn ran with nothing enabled — a fork of nothing, a grant
      // of nothing — so its record says nothing about skills.
      expect(
        await page
          .getByTestId("trace-note")
          .filter({ hasText: "Project skills carried" })
          .count()
      ).toBe(0);

      // The runner read the worktree and published what the project declares;
      // the inspector's Overview offers it for review: name, what it says it
      // is, and no standing answer yet.
      if ((await page.getByTestId("inspector").count()) === 0) {
        await page.getByTestId("panel-toggle").click();
      }
      await page.getByTestId("inspector").waitFor({ timeout: 20_000 });
      // The drawer opens on Overview already; the trigger is a toggle, so a
      // click while it shows would fold it away (the multiplayer spec's old
      // trap).
      if ((await page.getByTestId("inspector-overview").count()) === 0) {
        await page.getByTestId("inspector-tab-overview").click();
      }
      await page.getByTestId("inspector-overview").waitFor({ timeout: 20_000 });
      const row = page.getByTestId("skill-row").filter({ hasText: "zephyr-codes" });
      await row.waitFor({ timeout: 30_000 });
      expect(await row.textContent()).toContain("Codewords for releases.");
      expect(await row.textContent()).not.toContain("enabled");
      await page.screenshot({ path: join(evidenceDir, "124-project-skills-in-overview.png") });

      // Enabling is one click for the Mission Admin, and the standing answer
      // comes back on the room's own poll, in words.
      await page.getByTestId("skill-action").filter({ hasText: "Enable" }).click();
      await page
        .getByTestId("skill-row")
        .filter({ hasText: "· enabled" })
        .waitFor({ timeout: 20_000 });

      // The enablement is durable and attributed: one skills.changed event,
      // from nothing to exactly this skill at exactly the reviewed digest.
      const pg = await import("pg");
      const db = new pg.default.Pool({ connectionString: DB_URL });
      const events = await db.query("select payload, actor_kind from events where kind = 'skills.changed'");
      await db.end();
      expect(events.rowCount).toBe(1);
      const payload = events.rows[0].payload as {
        from: unknown[];
        to: { name: string; digest: string }[];
      };
      expect(events.rows[0].actor_kind).toBe("user");
      expect(payload.from).toEqual([]);
      expect(payload.to.map((entry) => entry.name)).toEqual(["zephyr-codes"]);
      expect(payload.to[0]?.digest).toMatch(/^[0-9a-f]{64}$/);

      // The next turn is dispatched with the set pinned; the runner composes
      // the skills-only directory from the real worktree, verifies the digest,
      // and the turn's own record states what it carried.
      await page.getByTestId("composer-input").fill("now use the codeword skill");
      await page.keyboard.press("Enter");
      await page
        .getByTestId("trace-note")
        .filter({ hasText: "Project skills carried: zephyr-codes" })
        .waitFor({ timeout: 90_000 });
      await page.screenshot({ path: join(evidenceDir, "125-skill-carried-on-the-turn.png") });
    },
    180_000
  );

  it(
    "governs the project's MCP servers the same way, one tier up (D-119)",
    async () => {
      // The declared server is published for review beside the skills: what
      // this machine would run, in words, before anyone enables anything.
      const row = page.getByTestId("mcp-row").filter({ hasText: "docs" });
      await row.waitFor({ timeout: 30_000 });
      expect(await row.textContent()).toContain("runs node mcp/docs.js");
      expect(await row.textContent()).not.toContain("enabled");

      // Enabling is the Mission Admin's click; the standing answer returns on
      // the room's own poll, and the event is durable with the reviewed digest.
      await page.getByTestId("mcp-action").filter({ hasText: "Enable" }).click();
      await page.getByTestId("mcp-row").filter({ hasText: "· enabled" }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidenceDir, "126-mcp-server-enabled.png") });
      const pg = await import("pg");
      const db = new pg.default.Pool({ connectionString: DB_URL });
      const events = await db.query("select payload from events where kind = 'mcp.changed'");
      await db.end();
      expect(events.rowCount).toBe(1);
      const payload = events.rows[0].payload as { to: { name: string; digest: string }[] };
      expect(payload.to.map((entry) => entry.name)).toEqual(["docs"]);
      expect(payload.to[0]?.digest).toMatch(/^[0-9a-f]{64}$/);

      // The next turn composes the strict config from the real worktree and
      // states what it carried on its own record.
      await page.getByTestId("composer-input").fill("now look something up");
      await page.keyboard.press("Enter");
      await page
        .getByTestId("trace-note")
        .filter({ hasText: "MCP servers carried: docs" })
        .waitFor({ timeout: 90_000 });
    },
    180_000
  );
});
