import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspaceSettingsSchema } from "@novus/contracts";
import { harnessEnv, novusPath, projectEnv, terminalEnv } from "../electron/workspace-env";

/**
 * The disclosure boundary D-041 exists to draw, asserted from both sides: what
 * each environment contains, and — the part that matters — what it does not.
 *
 * The compatibility requirement is equally load-bearing. Claude Code
 * authenticates through the user's own local installation, so a harness
 * environment that has lost `HOME`, or a PATH that no longer reaches where the
 * CLI is installed, breaks real execution while every deterministic suite stays
 * green: they all use the scripted harness.
 */

/** A parent environment with one of everything, including things a child has
 *  no business inheriting. */
const PARENT = {
  HOME: "/Users/someone",
  PATH: "/usr/bin:/bin",
  USER: "someone",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  TMPDIR: "/var/folders/tmp/",
  TERM: "xterm-256color",
  HTTPS_PROXY: "http://proxy.corp:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  // The harness's own login.
  ANTHROPIC_API_KEY: "sk-ant-the-users-own-key",
  CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
  // Electron's own launch noise, and a stray secret in the parent.
  ELECTRON_RUN_AS_NODE: "1",
  npm_lifecycle_event: "dev",
  NODE_OPTIONS: "--max-old-space-size=8192",
  AWS_SECRET_ACCESS_KEY: "not-the-harness-and-not-the-project"
} as const;

const SETTINGS = WorkspaceSettingsSchema.parse({
  env: { NODE_ENV: "development", API_URL: "http://localhost:8080" },
  secretNames: ["DATABASE_URL"]
});

const SECRETS = { DATABASE_URL: "postgres://user:hunter2@localhost/app", UNRELATED: "not-selected" };

const WORKSPACE = {
  workspaceId: "wst_one",
  missionBranch: "novus/m-ab12cd34",
  port: 3100,
  portRangeStart: 3100,
  portRangeEnd: 3109
};

describe("the harness environment", () => {
  const env = harnessEnv(PARENT, "darwin");

  it("keeps what the user's own local login needs", () => {
    // Losing any of these breaks a real Claude Code sign-in while every
    // scripted test stays green, so each one is asserted by name.
    expect(env.HOME).toBe("/Users/someone");
    expect(env.USER).toBe("someone");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-the-users-own-key");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/someone/.claude-work");
    // A managed machine reaches the model endpoint only through its proxy.
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
  });

  it("keeps a PATH that reaches where a CLI is actually installed", () => {
    const entries = (env.PATH ?? "").split(":");
    expect(entries).toContain("/usr/bin");
    // The places the harness probe has always looked, so a CLI installed
    // outside the login shell's PATH is still found.
    expect(entries).toContain(join("/Users/someone", ".local", "bin"));
    expect(entries).toContain("/opt/homebrew/bin");
    expect(entries).toContain("/usr/local/bin");
    expect(new Set(entries).size).toBe(entries.length); // no duplicates
  });

  it("carries no project secret and none of the parent's noise", () => {
    expect(Object.values(env)).not.toContain(SECRETS.DATABASE_URL);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.API_URL).toBeUndefined();
    // Inherited wholesale, these break child processes in ways nobody enjoys
    // debugging.
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    // Cloud credentials travel only when the harness is pointed at that cloud.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("forwards cloud credentials only when the harness is pointed at that cloud", () => {
    const bedrock = harnessEnv({ ...PARENT, CLAUDE_CODE_USE_BEDROCK: "1" }, "darwin");
    expect(bedrock.AWS_SECRET_ACCESS_KEY).toBe("not-the-harness-and-not-the-project");
  });

  it("gives a child a HOME even when the parent had none", () => {
    const env2 = harnessEnv({ PATH: "/usr/bin" }, "darwin");
    expect(env2.HOME).toBe(homedir());
  });
});

describe("the project environment", () => {
  const env = projectEnv(WORKSPACE, SETTINGS, SECRETS, PARENT, "darwin");

  it("carries the Novus variables the project is told about", () => {
    expect(env.NOVUS_WORKSPACE_ID).toBe("wst_one");
    expect(env.NOVUS_MISSION_BRANCH).toBe("novus/m-ab12cd34");
    expect(env.NOVUS_PORT).toBe("3100");
    expect(env.NOVUS_PORT_RANGE_START).toBe("3100");
    expect(env.NOVUS_PORT_RANGE_END).toBe("3109");
  });

  it("never says where the workspace is on disk", () => {
    // An absolute worktree path is a fact about somebody's laptop, and a
    // project command could echo it straight into evidence.
    expect(env.NOVUS_WORKSPACE_DIR).toBeUndefined();
  });

  it("carries the project's declared values and only the selected secrets", () => {
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_URL).toBe("http://localhost:8080");
    expect(env.DATABASE_URL).toBe(SECRETS.DATABASE_URL);
    // Held on this machine but not named by the configuration: not selected,
    // so not passed.
    expect(env.UNRELATED).toBeUndefined();
  });

  it("never carries the harness credential", () => {
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-the-users-own-key");
    expect(Object.keys(env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(Object.keys(env).filter((name) => name.startsWith("CLAUDE_"))).toEqual([]);
  });

  it("holds no secret at all when the machine has supplied none", () => {
    const bare = projectEnv(WORKSPACE, SETTINGS, {}, PARENT, "darwin");
    expect(bare.DATABASE_URL).toBeUndefined();
  });
});

describe("the terminal environment", () => {
  const env = terminalEnv({
    workspace: WORKSPACE,
    settings: SETTINGS,
    secrets: SECRETS,
    profile: { EDITOR: "hx", PATH: "/Users/someone/.rbenv/shims:/usr/bin", NODE_ENV: "production" },
    workspaceDir: "/Users/someone/Library/novus/worktrees/msn_1",
    source: PARENT,
    platform: "darwin"
  });

  it("is the project environment plus the user's own shell", () => {
    expect(env.EDITOR).toBe("hx");
    expect(env.DATABASE_URL).toBe(SECRETS.DATABASE_URL);
    expect(env.NOVUS_MISSION_BRANCH).toBe("novus/m-ab12cd34");
  });

  it("is the only environment told where the workspace is", () => {
    expect(env.NOVUS_WORKSPACE_DIR).toBe("/Users/someone/Library/novus/worktrees/msn_1");
  });

  it("lets the project's declared values win over the profile", () => {
    // The project said `development`; the person's profile says otherwise, and
    // the project is what this workspace is for.
    expect(env.NODE_ENV).toBe("development");
  });
});

describe("the constructed PATH", () => {
  it("keeps the parent's entries first and adds the usual install locations", () => {
    const path = novusPath({ PATH: "/first:/second", HOME: "/Users/someone" }, "darwin").split(":");
    expect(path[0]).toBe("/first");
    expect(path[1]).toBe("/second");
    expect(path).toContain("/opt/homebrew/bin");
  });

  it("uses the platform's own separator", () => {
    const path = novusPath({ PATH: "C:\\Windows;C:\\Windows\\System32" }, "win32");
    expect(path).toBe("C:\\Windows;C:\\Windows\\System32");
  });
});
