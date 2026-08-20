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
  // And one slash command (D-187), the same review-then-enable road.
  mkdirSync(join(localRepoDir, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(localRepoDir, ".claude", "commands", "relnotes.md"),
    "---\ndescription: Draft release notes the project's way.\n---\n\nSay the codeword MELON-9: $ARGUMENTS\n"
  );
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

  // The machine's own user-level skills (D-186): a fixture config dir stands
  // in for ~/.claude, so the published display list is deterministic rather
  // than whatever this developer machine happens to carry.
  const configDir = mkdtempSync(join(tmpdir(), "novus-skills-config-"));
  // And one machine MCP server (D-198), in the CLI's own user config shape —
  // with a secret value that must never reach the wire.
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        linear: { command: "node", args: ["linear-mcp.js"], env: { LINEAR_TOKEN: "tok_secret_e2e" } }
      }
    })
  );
  mkdirSync(join(configDir, "skills", "unslop"), { recursive: true });
  writeFileSync(
    join(configDir, "skills", "unslop", "SKILL.md"),
    "---\ndescription: Cut AI tells from any writing.\n---\n\nBody.\n"
  );

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_USER_DATA_DIR: userDataDir,
      CLAUDE_CONFIG_DIR: configDir
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

describe("what a project declares is carried, and the record says which bytes (D-193)", () => {
  it(
    "lists what the project and the machine declare, folds each row, and carries them all",
    async () => {
      if ((await page.getByTestId("inspector").count()) === 0) {
        await page.getByTestId("panel-toggle").click();
      }
      await page.getByTestId("inspector").waitFor({ timeout: 20_000 });
      if ((await page.getByTestId("inspector-extensions").count()) === 0) {
        await page.getByTestId("inspector-tab-extensions").click();
      }
      await page.getByTestId("inspector-extensions").waitFor({ timeout: 20_000 });

      // Repo skills and Global skills, each group named for what it holds and
      // tagged with where it came from; no Enable anywhere on either (D-193).
      const row = page.getByTestId("skill-row").filter({ hasText: "zephyr-codes" });
      await row.waitFor({ timeout: 30_000 });
      expect(await page.getByTestId("skill-action").count()).toBe(0);
      expect(await page.getByTestId("global-skill-action").count()).toBe(0);
      expect(await page.getByTestId("inspector-extensions").textContent()).toContain("Repo skills");
      expect(await page.getByTestId("inspector-extensions").textContent()).toContain("Global skills");

      // A row folds its own description (D-193): shut by default, opened by
      // pressing the name.
      expect(await row.textContent()).not.toContain("Codewords for releases.");
      await page.getByTestId("skill-toggle").filter({ hasText: "zephyr-codes" }).click();
      expect(await row.textContent()).toContain("Codewords for releases.");
      await page.getByTestId("global-skill-row").filter({ hasText: "unslop" }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidenceDir, "124-project-skills-in-overview.png") });

      // The next turn carries everything declared, and the record names each
      // with the digest that ran.
      await page.getByTestId("composer-input").fill("now use the codeword skill");
      await page.keyboard.press("Enter");
      await page
        .getByTestId("trace-note")
        .filter({ hasText: "Project skills carried: zephyr-codes" })
        .waitFor({ timeout: 90_000 });
      await page
        .getByTestId("trace-note")
        .filter({ hasText: "Machine skills carried: unslop" })
        .waitFor({ timeout: 90_000 });
      await page.screenshot({ path: join(evidenceDir, "125-skill-carried-on-the-turn.png") });
    },
    180_000
  );



  it(
    "labels an extension: created by typing, worn on the row, recoloured, removed (D-195)",
    async () => {
      // The collection is the group it sits in; a label is the team's own
      // word laid over it. Typing a name nothing matches makes it.
      await page.getByTestId("extension-label-add").filter({ hasText: "+" }).first().click();
      await page.getByTestId("label-picker").waitFor({ timeout: 10_000 });
      await page.getByTestId("label-picker-field").fill("review");
      await page.getByTestId("label-create").click();

      // It is worn on the row, and it is the organization's from then on.
      const chip = page.getByTestId("extension-label").filter({ hasText: "review" });
      await chip.first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidenceDir, "212-extension-labels.png") });

      const pg = await import("pg");
      const db = new pg.default.Pool({ connectionString: DB_URL });
      const labels = await db.query("select name, color from extension_labels");
      const worn = await db.query("select source, extension_name from extension_label_assignments");
      await db.end();
      expect(labels.rows.map((row) => row.name)).toEqual(["review"]);
      expect(worn.rowCount).toBe(1);
      // A repo skill's label is filed under its collection, never loose.
      expect(worn.rows[0].source).toBe("repo");
    },
    120_000
  );

  it(
    "keeps the MCP gate: a server is enabled by an Admin, not merely declared (D-119)",
    async () => {
      // Instructions are carried; new tool surface still asks (D-193's line).
      const row = page.getByTestId("mcp-row").filter({ hasText: "docs" });
      await row.waitFor({ timeout: 30_000 });
      expect(await row.textContent()).toContain("runs node mcp/docs.js");
      expect(await row.textContent()).not.toContain("enabled");
      await page.getByTestId("mcp-action").filter({ hasText: "Enable" }).click();
      await page.getByTestId("mcp-row").filter({ hasText: "· enabled" }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(evidenceDir, "126-mcp-server-enabled.png") });
      const pg = await import("pg");
      const db = new pg.default.Pool({ connectionString: DB_URL });
      const events = await db.query("select payload from events where kind = 'mcp.changed'");
      await db.end();
      expect(events.rowCount).toBe(1);
    },
    180_000
  );

  it(
    "admits a machine server on two keys, with the consequence recorded and no value on the wire (D-198)",
    async () => {
      // Published as a redacted summary under the machine origin.
      const row = page.getByTestId("machine-mcp-row").filter({ hasText: "linear" });
      await row.waitFor({ timeout: 30_000 });
      expect(await row.textContent()).toContain("runs node linear-mcp.js");
      expect(await row.textContent()).toContain("needs LINEAR_TOKEN");
      expect(await row.textContent()).not.toContain("tok_secret_e2e");

      // Enabling states its consequence; accepting records that sentence.
      await page.getByTestId("machine-mcp-action").filter({ hasText: "Enable" }).click();
      await page.getByTestId("machine-mcp-confirm").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(evidenceDir, "213-machine-mcp-confirm.png") });
      await page.getByTestId("machine-mcp-accept").click();
      await page
        .getByTestId("machine-mcp-row")
        .filter({ hasText: "· enabled" })
        .waitFor({ timeout: 20_000 });

      const pg = await import("pg");
      const db = new pg.default.Pool({ connectionString: DB_URL });
      const events = await db.query("select payload from events where kind = 'machine-mcp.changed'");
      const manifest = await db.query("select declared_machine_mcp from workspaces limit 1");
      await db.end();
      expect(events.rowCount).toBe(1);
      const payload = events.rows[0].payload as { acknowledged: string; to: { name: string }[] };
      expect(payload.to.map((entry) => entry.name)).toEqual(["linear"]);
      expect(payload.acknowledged).toContain("anyone directing this lane");
      // The privacy rule, asserted at the store: the value never travelled.
      expect(JSON.stringify(manifest.rows[0].declared_machine_mcp)).not.toContain("tok_secret_e2e");

      // The next turn merges it into the strict config from this machine's
      // own file, and the record names it apart.
      await page.getByTestId("composer-input").fill("now use linear");
      await page.keyboard.press("Enter");
      await page
        .getByTestId("trace-note")
        .filter({ hasText: "Machine MCP servers carried: linear" })
        .waitFor({ timeout: 90_000 });
      await page.screenshot({ path: join(evidenceDir, "214-machine-mcp-carried.png") });
    },
    180_000
  );

  it(
    "offers the project's command and its skills from the composer's / menu (D-193)",
    async () => {
      await page.getByTestId("composer-input").click();
      await page.getByTestId("composer-input").fill("/");
      await page.getByTestId("slash-row").first().waitFor({ timeout: 30_000 });
      const offered = (await page.getByTestId("slash-row").allTextContents()).join(" ");
      // The project's command, and the skills — declared is offered.
      expect(offered).toContain("relnotes");
      await page.screenshot({ path: join(evidenceDir, "209-slash-command-menu.png") });
      await page.keyboard.press("Escape");
      await page.getByTestId("composer-input").fill("");
    },
    120_000
  );

  it(
    "offers the CLI's own commands too, captured from the session's announcement (D-188)",
    async () => {
      // The turns above already ran, so this machine has heard the harness
      // announce its command list; the next publish carried it. Typing /
      // offers those beside the project's — plainly, as /name — and never
      // the terminal-only entry the CLI itself marked.
      await page.getByTestId("composer-input").click();
      await page.getByTestId("composer-input").fill("/");
      await page.getByTestId("slash-row").filter({ hasText: "compact" }).waitFor({ timeout: 30_000 });
      const offered = await page.getByTestId("slash-row").allTextContents();
      expect(offered.join(" ")).toContain("/review");
      expect(offered.join(" ")).not.toContain("doctor");
      await page.screenshot({ path: join(evidenceDir, "211-global-commands-in-menu.png") });
      await page.keyboard.press("Escape");
      await page.getByTestId("composer-input").fill("");
    },
    120_000
  );
});
