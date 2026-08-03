import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSettingsSchema, type DeclaredCommand, type RunnerEvent } from "@novus/contracts";
import { gitExec } from "../electron/workspace-git";
import type { SecretStore } from "../electron/workspace-secrets";
import {
  createWorkspaceRuntime,
  inspectWorkspace,
  prepareLocalFiles,
  repositoryLabel,
  saveWorkspaceSettings,
  worktreeFor,
  type PinnedCommand,
  type WorkspaceCommandContext,
  type WorkspaceHost,
  type WorkspaceRuntime,
  type WorkspaceTarget
} from "../electron/workspace";

/**
 * The whole workspace runtime composed as the runner composes it: a real
 * repository, a real worktree created from the mission branch, the project's
 * own configuration read out of that worktree, and real processes.
 *
 * The property the room depends on is the one at the seam: a proposal never
 * runs, a saved command does, and neither ever touches the user's own checkout.
 */

const MISSION_ID = "msn_workspace";
const WORKSTREAM_ID = "wst_workspace";
const MISSION_BRANCH = "novus/m-w0rk5p4c3";
const LOCAL_ID = "local-1";
const SECRET = "postgres://user:hunter2-and-then-some@localhost/app";

let repo: string;
let userData: string;
let events: { workstreamId: string; event: RunnerEvent }[];
let held: Record<string, string>;

async function git(cwd: string, args: string[]): Promise<string> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(`git ${args.join(" ")}: ${outcome.stderr}`);
  return outcome.stdout.trim();
}

const secretStore = (): SecretStore => ({
  suppliedNames: () => Object.keys(held),
  values: (_repositoryKey, names) =>
    Object.fromEntries(names.filter((name) => held[name] !== undefined).map((name) => [name, held[name] ?? ""])),
  allValues: () => Object.values(held),
  put: (_repositoryKey, name, value) => {
    held[name] = value;
  },
  forget: (_repositoryKey, name) => {
    delete held[name];
  }
});

function host(): WorkspaceHost {
  return {
    userDataPath: userData,
    repositoryPath: (providerRepoId) => (providerRepoId === LOCAL_ID ? repo : null),
    secretStore: secretStore(),
    git: gitExec
  };
}

const target: WorkspaceTarget = {
  missionId: MISSION_ID,
  workstreamId: WORKSTREAM_ID,
  localId: LOCAL_ID,
  missionBranch: MISSION_BRANCH
};

const context: WorkspaceCommandContext = {
  missionId: MISSION_ID,
  workstreamId: WORKSTREAM_ID,
  providerRepoId: LOCAL_ID,
  missionBranch: MISSION_BRANCH,
  workspaceId: "wsp_workspace"
};

function runtime() {
  return createWorkspaceRuntime({
    host: host(),
    emit: (workstreamId, event) => events.push({ workstreamId, event })
  });
}

function of<K extends RunnerEvent["kind"]>(kind: K): Extract<RunnerEvent, { kind: K }>["payload"][] {
  return events
    .map((entry) => entry.event)
    .filter((event): event is Extract<RunnerEvent, { kind: K }> => event.kind === kind)
    .map((event) => event.payload);
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Commits the project's configuration on the mission branch, the way a person
 *  reviewing it in a pull request would. */
async function commitSettings(contents: string): Promise<void> {
  // Configuration travels with the branch, so it is committed on the branch —
  // in the worktree once one exists, because that is where the branch is
  // checked out.
  const worktree = worktreeFor(userData, MISSION_ID);
  const where = existsSync(join(worktree, ".git")) ? worktree : repo;
  mkdirSync(join(where, ".novus"), { recursive: true });
  writeFileSync(join(where, ".novus", "settings.toml"), contents);
  await git(where, ["add", "-A"]);
  await git(where, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "configure"]);
  if (where === repo) await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-runtime-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-runtime-userdata-"));
  events = [];
  held = {};
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  writeFileSync(join(repo, ".env"), `DATABASE_URL=${SECRET}\n`);
  writeFileSync(join(repo, ".env.example"), "DATABASE_URL=\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", scripts: { dev: "vite" } }));
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
});

afterEach(async () => {
  await gitExec(repo, ["worktree", "prune"]);
  for (const path of [repo, userData]) rmSync(path, { recursive: true, force: true });
});

describe("the worktree", () => {
  it("creates one from the mission branch and never touches the checkout", async () => {
    const proposal = await inspectWorkspace(target, host());
    const worktree = worktreeFor(userData, MISSION_ID);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(MISSION_BRANCH);
    // A worktree holds tracked files and nothing else, which is exactly why
    // the .env has to be supplied.
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    expect(existsSync(join(repo, ".env"))).toBe(true);
    expect(proposal.localFiles.find((file) => file.path === ".env")?.presentInWorkspace).toBe(false);
  }, 20_000);

  it("refuses a branch name it did not allocate", async () => {
    await expect(
      inspectWorkspace({ ...target, missionBranch: "main" }, host())
    ).rejects.toThrow(/unrecognized branch/);
  }, 20_000);

  it("refuses when the repository is on another machine", async () => {
    await expect(
      inspectWorkspace({ ...target, localId: "somewhere-else" }, host())
    ).rejects.toThrow(/another machine/);
  }, 20_000);
});

/**
 * The snapshot the control plane would pin, taken from what the runner itself
 * published (D-043).
 *
 * This is the same round trip production makes: the runner reads the project
 * and announces what it declares, the control plane hands one of those back
 * with the command it authorizes, and the runner runs *that*. Resolving the
 * name here instead would test a path the product does not have.
 */
async function pin(
  running: WorkspaceRuntime,
  kind: DeclaredCommand["kind"],
  name?: string
): Promise<PinnedCommand> {
  await running.publishDeclared(context);
  const declared = of("workspace.declared")
    .flatMap((payload) => payload.commands)
    .filter((command) => command.kind === kind);
  const snapshot = (name === undefined ? declared[0] : declared.find((c) => c.name === name)) ?? null;
  return { name: name ?? snapshot?.name ?? null, snapshot };
}

describe("a proposal is not a command", () => {
  it("runs nothing on inspection, and runs only what was saved and then invoked", async () => {
    // The project's manifest names a script that would leave a witness behind.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "shop", scripts: { dev: "touch inspected.txt" } })
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "script"]);
    await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);

    const proposal = await inspectWorkspace(target, host());
    const worktree = worktreeFor(userData, MISSION_ID);
    expect(proposal.run.length).toBeGreaterThan(0);
    expect(existsSync(join(worktree, "inspected.txt"))).toBe(false);
    expect(events).toEqual([]);

    // A saved command is a different thing entirely.
    await saveWorkspaceSettings(
      target,
      "shared",
      WorkspaceSettingsSchema.parse({ setup: { command: "touch confirmed.txt" } }),
      host()
    );
    const started = runtime();
    await started.runSetup(context, await pin(started, "setup"));
    expect(existsSync(join(worktree, "confirmed.txt"))).toBe(true);
    expect(existsSync(join(worktree, "inspected.txt"))).toBe(false);
  }, 20_000);

  it("refuses a command the project never declared", async () => {
    const running = runtime();
    // Nothing declared means nothing published means nothing to pin, and the
    // runner says so rather than resolving a name out of a file for itself.
    await expect(running.runSetup(context, await pin(running, "setup"))).rejects.toThrow(
      /has not read this project's configuration/
    );
    await expect(running.runCommand(context, await pin(running, "run"))).rejects.toThrow(
      /has not read this project's configuration/
    );
    await expect(running.runVerification(context, await pin(running, "verification"))).rejects.toThrow(
      /has not read this project's configuration/
    );

    await commitSettings(`[[run]]\nname = "dev"\ncommand = "sleep 30"\n`);
    await expect(
      running.runCommand(context, await pin(running, "run", "not-a-command"))
    ).rejects.toThrow(/has not read this project's configuration/);
  }, 20_000);
});

describe("commands the project declared", () => {
  it("runs setup, a run command, and a check, all in the worktree", async () => {
    await commitSettings(
      [
        `[setup]`,
        `command = "pwd > setup-ran.txt"`,
        ``,
        `[[run]]`,
        `name = "dev"`,
        `command = "pwd > dev-ran.txt; sleep 20"`,
        ``,
        `[[verify]]`,
        `name = "test"`,
        `command = "test -f setup-ran.txt"`,
        `category = "test"`
      ].join("\n")
    );
    const worktree = worktreeFor(userData, MISSION_ID);
    const running = runtime();

    await running.runSetup(context, await pin(running, "setup"));
    expect(of("workspace.readiness").map((payload) => payload.readiness)).toEqual(["configuring", "ready"]);
    expect(of("workspace.readiness")[1]?.portRangeStart).toBeGreaterThan(3000);

    await running.runCommand(context, await pin(running, "run"));
    await waitFor("the run command to write", () => existsSync(join(worktree, "dev-ran.txt")));

    await running.runVerification(context, await pin(running, "verification"));
    const check = of("verification.completed")[0];
    expect(check?.name).toBe("test");
    expect(check?.outcome).toBe("passed");
    expect(check?.checkpointSha).toBe(await git(worktree, ["rev-parse", "HEAD"]));

    // Everything happened in the worktree; the user's own checkout is untouched.
    expect(readFileSync(join(worktree, "setup-ran.txt"), "utf8")).toContain("worktrees");
    expect(existsSync(join(repo, "setup-ran.txt"))).toBe(false);
    expect(existsSync(join(repo, "dev-ran.txt"))).toBe(false);

    await running.stopCommand(context, "dev");
    expect(of("process.exited").some((payload) => payload.state === "stopped")).toBe(true);
    await running.shutdown("test over");
  }, 30_000);

  it("hands the project its workspace variables but never where it is on disk", async () => {
    await commitSettings(
      [
        `[setup]`,
        `command = "env | grep NOVUS_ | sort > novus-env.txt"`
      ].join("\n")
    );
    const running = runtime();
    await running.runSetup(context, await pin(running, "setup"));
    const seen = readFileSync(join(worktreeFor(userData, MISSION_ID), "novus-env.txt"), "utf8");
    expect(seen).toContain("NOVUS_WORKSPACE_ID=wsp_workspace");
    expect(seen).toContain(`NOVUS_MISSION_BRANCH=${MISSION_BRANCH}`);
    expect(seen).toMatch(/NOVUS_PORT=\d+/);
    expect(seen).toMatch(/NOVUS_PORT_RANGE_START=\d+/);
    expect(seen).toMatch(/NOVUS_PORT_RANGE_END=\d+/);
    expect(seen).not.toContain("NOVUS_WORKSPACE_DIR");
  }, 20_000);

  it("passes a selected secret to the command and to nothing that is reported", async () => {
    held.DATABASE_URL = SECRET;
    await commitSettings(
      [
        `secretNames = ["DATABASE_URL"]`,
        ``,
        `[[verify]]`,
        `name = "test"`,
        `command = "echo connecting to $DATABASE_URL"`,
        `category = "test"`
      ].join("\n")
    );

    const checking = runtime();
    await checking.runVerification(context, await pin(checking, "verification", "test"));
    const check = of("verification.completed")[0];
    // The command really did receive the value...
    expect(check?.output).toContain("[redacted]");
    // ...and no part of it reached anything reported.
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain(SECRET);
  }, 20_000);
});

describe("supplying local files", () => {
  it("copies the ignored file the project needs, and only that", async () => {
    const results = await prepareLocalFiles(target, [".env", "README.md"], host());
    const worktree = worktreeFor(userData, MISSION_ID);
    expect(results.find((result) => result.path === ".env")?.copied).toBe(true);
    expect(results.find((result) => result.path === "README.md")?.copied).toBe(false);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toContain("DATABASE_URL=");
    // Names in, names out: the value never crossed this boundary.
    expect(JSON.stringify(results)).not.toContain("hunter2");
  }, 20_000);

  it("makes the workspace stop asking for a file once it has it", async () => {
    const before = await inspectWorkspace(target, host());
    expect(before.blockers.some((line) => line.includes(".env is missing here"))).toBe(true);
    await prepareLocalFiles(target, [".env"], host());
    const after = await inspectWorkspace(target, host());
    expect(after.blockers.some((line) => line.includes(".env is missing"))).toBe(false);
  }, 20_000);
});

describe("after a relaunch", () => {
  it("does not claim a run command is still running", async () => {
    await commitSettings(`[[run]]\nname = "dev"\ncommand = "sleep 40"\n`);
    const first = runtime();
    await first.runCommand(context, await pin(first, "run"));
    expect(of("process.started").length).toBe(1);
    const processId = of("process.started")[0]?.processId;

    // The app closed without a clean shutdown: a fresh runtime reads the record
    // the last one left behind.
    events = [];
    runtime().reconcile();

    const exited = of("process.exited")[0];
    expect(exited?.processId).toBe(processId);
    expect(exited?.state).toBe("stopped");
    expect(events[0]?.workstreamId).toBe(WORKSTREAM_ID);
    await first.shutdown("test over");
  }, 30_000);
});

describe("what a terminal tab is called", () => {
  it("takes the repository's own short name, from either kind of repository", () => {
    // A GitHub repository's `name` is `owner/name`; a folder on this Mac is
    // registered under its own name, and a path is one too. Both end in what
    // the project is called, which is the only part a tab has room for.
    expect(repositoryLabel("KJ14GOD/branchwork")).toBe("branchwork");
    expect(repositoryLabel("robinhood-agentic")).toBe("robinhood-agentic");
    expect(repositoryLabel("/Users/someone/code/robinhood-agentic")).toBe("robinhood-agentic");
    expect(repositoryLabel("/Users/someone/code/robinhood-agentic/")).toBe("robinhood-agentic");
    expect(repositoryLabel("git@github.com:KJ14GOD/branchwork.git")).toBe("branchwork");
    // Nothing usable to shorten: the name stands as it is rather than becoming
    // an empty tab.
    expect(repositoryLabel("/")).toBe("/");
  });
});
