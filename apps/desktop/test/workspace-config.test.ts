import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSettingsSchema } from "@novus/contracts";
import {
  LOCAL_SETTINGS_PATH,
  loadWorkspaceSettings,
  SHARED_SETTINGS_PATH,
  WorkspaceConfigError,
  writeWorkspaceSettings
} from "../electron/workspace-config";
import { gitExec } from "../electron/workspace-git";

/**
 * The two configuration files (D-040) against a real git worktree. What is
 * being proved is that a machine can override one command without restating
 * the project, that a broken file is a named error rather than a quiet
 * fallback to defaults, and that the machine-local file cannot be committed by
 * accident.
 */

let worktree: string;

async function git(args: string[]): Promise<void> {
  const outcome = await gitExec(worktree, args);
  if (outcome.code !== 0) throw new Error(outcome.stderr);
}

function writeSettings(relative: string, contents: string): void {
  mkdirSync(join(worktree, ".novus"), { recursive: true });
  writeFileSync(join(worktree, relative), contents);
}

beforeEach(async () => {
  worktree = mkdtempSync(join(tmpdir(), "novus-config-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@local"]);
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const SHARED = `
concurrentRuns = true
defaultRun = "dev"
secretNames = ["DATABASE_URL"]
localFiles = [".env"]

[setup]
command = "pnpm install"

[[run]]
name = "dev"
command = "pnpm dev"
port = 4000

[[run]]
name = "worker"
command = "pnpm worker"

[[verify]]
name = "test"
command = "pnpm test"
category = "test"

[env]
NODE_ENV = "development"
LOG_LEVEL = "info"
`;

describe("shared and machine-local configuration", () => {
  it("layers local over shared key by key", () => {
    writeSettings(SHARED_SETTINGS_PATH, SHARED);
    writeSettings(
      LOCAL_SETTINGS_PATH,
      `
secretNames = ["STRIPE_KEY"]

[[run]]
name = "dev"
command = "pnpm dev --port 5173"

[[run]]
name = "tunnel"
command = "cloudflared tunnel run"

[env]
LOG_LEVEL = "debug"
`
    );

    const { effective, shared, local } = loadWorkspaceSettings(worktree);

    // A local entry with the same name replaces the shared one; the others stay.
    expect(effective.run.map((entry) => entry.name)).toEqual(["dev", "worker", "tunnel"]);
    expect(effective.run.find((entry) => entry.name === "dev")?.command).toBe("pnpm dev --port 5173");
    expect(effective.run.find((entry) => entry.name === "worker")?.command).toBe("pnpm worker");

    // env merges, local winning on a collision.
    expect(effective.env).toEqual({ NODE_ENV: "development", LOG_LEVEL: "debug" });
    expect(effective.secretNames).toEqual(["DATABASE_URL", "STRIPE_KEY"]);

    // Untouched single values survive: the local file said nothing about them.
    expect(effective.setup?.command).toBe("pnpm install");
    expect(effective.defaultRun).toBe("dev");
    expect(effective.concurrentRuns).toBe(true);
    expect(effective.verify.map((entry) => entry.name)).toEqual(["test"]);

    // Both halves are reported as themselves, not only as the blend.
    expect(shared?.run.find((entry) => entry.name === "dev")?.command).toBe("pnpm dev");
    expect(local?.env).toEqual({ LOG_LEVEL: "debug" });
  });

  it("replaces setup, defaultRun, and concurrentRuns wholesale when the machine states them", () => {
    writeSettings(SHARED_SETTINGS_PATH, SHARED);
    writeSettings(
      LOCAL_SETTINGS_PATH,
      `
concurrentRuns = false
defaultRun = "worker"

[setup]
command = "pnpm install --offline"
cwd = "app"
`
    );
    const { effective } = loadWorkspaceSettings(worktree);
    expect(effective.setup).toEqual({ command: "pnpm install --offline", cwd: "app" });
    expect(effective.defaultRun).toBe("worker");
    expect(effective.concurrentRuns).toBe(false);
  });

  it("does not read a value the local file never wrote as an override", () => {
    // The schema fills `concurrentRuns` with false. A local file that says
    // nothing about it must not silently switch the project's own `true` off.
    writeSettings(SHARED_SETTINGS_PATH, SHARED);
    writeSettings(LOCAL_SETTINGS_PATH, `[env]\nAPI_URL = "http://localhost:8080"\n`);
    const { effective } = loadWorkspaceSettings(worktree);
    expect(effective.concurrentRuns).toBe(true);
    expect(effective.defaultRun).toBe("dev");
    expect(effective.run.map((entry) => entry.name)).toEqual(["dev", "worker"]);
  });

  it("is the defaults, and says nothing exists, when neither file is there", () => {
    const loaded = loadWorkspaceSettings(worktree);
    expect(loaded.shared).toBeNull();
    expect(loaded.local).toBeNull();
    expect(loaded.effective.run).toEqual([]);
    expect(loaded.effective.setup).toBeUndefined();
  });
});

describe("configuration that cannot be trusted", () => {
  it("names the file and the problem for invalid TOML, rather than falling back", () => {
    writeSettings(SHARED_SETTINGS_PATH, `[setup]\ncommand = =\n`);
    let thrown: unknown;
    try {
      loadWorkspaceSettings(worktree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkspaceConfigError);
    const error = thrown as WorkspaceConfigError;
    expect(error.file).toBe(SHARED_SETTINGS_PATH);
    expect(error.message).toContain(".novus/settings.toml");
    expect(error.message).toContain("not valid TOML");
    expect(error.message).toMatch(/line \d+/);
  });

  it("names the file and the offending key for a schema failure", () => {
    writeSettings(LOCAL_SETTINGS_PATH, `[[run]]\nname = "Not A Valid Name"\ncommand = "pnpm dev"\n`);
    let thrown: unknown;
    try {
      loadWorkspaceSettings(worktree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkspaceConfigError);
    const error = thrown as WorkspaceConfigError;
    expect(error.file).toBe(LOCAL_SETTINGS_PATH);
    expect(error.problem).toContain("run.0.name");
    expect(error.problem).toContain("lowercase");
  });

  it("refuses a document that is not a table", () => {
    writeSettings(SHARED_SETTINGS_PATH, `not-a-key\n`);
    expect(() => loadWorkspaceSettings(worktree)).toThrow(WorkspaceConfigError);
  });

  it("teaches the expected shape when run is written as a plain table (D-156)", () => {
    // The exact mistake an agent made in the wild: [run] instead of [[run]].
    writeSettings(SHARED_SETTINGS_PATH, `[run]\ncommand = "python3 -m http.server 8123"\n`);
    let thrown: unknown;
    try {
      loadWorkspaceSettings(worktree);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkspaceConfigError);
    const error = thrown as WorkspaceConfigError;
    expect(error.problem).toContain("[[run]]");
    expect(error.problem).toContain('name = "…"');
  });
});

describe("writing configuration", () => {
  const settings = WorkspaceSettingsSchema.parse({
    setup: { command: "pnpm install" },
    run: [{ name: "dev", command: "pnpm dev", previewUrl: "http://localhost:{port}" }],
    defaultRun: "dev",
    verify: [{ name: "test", command: "pnpm test", category: "test" }],
    env: { NODE_ENV: "development" },
    secretNames: ["DATABASE_URL"]
  });

  it("writes readable TOML that reads back as the same settings", async () => {
    await writeWorkspaceSettings(gitExec, worktree, "shared", settings);
    const written = readFileSync(join(worktree, SHARED_SETTINGS_PATH), "utf8");
    expect(written).toContain("# Novus workspace configuration");
    expect(written).toContain("[setup]");
    expect(written).toContain("[[run]]");
    expect(loadWorkspaceSettings(worktree).shared).toEqual(settings);
  });

  it("makes the machine-local file uncommittable and keeps it to this user", async () => {
    await writeWorkspaceSettings(gitExec, worktree, "local", settings);

    const ignore = await gitExec(worktree, ["check-ignore", "-q", "--", LOCAL_SETTINGS_PATH]);
    expect(ignore.code).toBe(0);
    expect(readFileSync(join(worktree, ".gitignore"), "utf8")).toContain(LOCAL_SETTINGS_PATH);
    expect(statSync(join(worktree, LOCAL_SETTINGS_PATH)).mode & 0o777).toBe(0o600);

    // git agrees the file is invisible to a careless `git add -A`.
    await git(["add", "-A"]);
    const staged = await gitExec(worktree, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout).not.toContain(LOCAL_SETTINGS_PATH);
  });

  it("leaves an existing ignore rule alone rather than repeating it", async () => {
    writeFileSync(join(worktree, ".gitignore"), ".novus/settings.local.toml\n");
    await writeWorkspaceSettings(gitExec, worktree, "local", settings);
    const contents = readFileSync(join(worktree, ".gitignore"), "utf8");
    expect(contents.split(LOCAL_SETTINGS_PATH).length - 1).toBe(1);
  });

  it("does not touch .gitignore when writing the shared file", async () => {
    await writeWorkspaceSettings(gitExec, worktree, "shared", settings);
    expect(() => readFileSync(join(worktree, ".gitignore"), "utf8")).toThrow();
  });
});
