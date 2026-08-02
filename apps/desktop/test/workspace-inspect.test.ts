import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceProposal } from "@novus/contracts";
import { inspectProject } from "../electron/workspace-inspect";
import { gitExec } from "../electron/workspace-git";

/**
 * What Novus notices about a project and what it would therefore propose. The
 * property that matters most is the one that is easiest to lose: a proposal is
 * a sentence, and inspecting a project must not run any part of it.
 */

let repo: string;
let worktree: string;

async function git(cwd: string, args: string[]): Promise<void> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(outcome.stderr);
}

function inspect(suppliedSecrets: string[] = []): Promise<WorkspaceProposal> {
  return inspectProject({ git: gitExec, worktree, sourceRepo: repo, suppliedSecrets });
}

/** A file a command would create if anything actually ran. */
const WITNESS = "ran.txt";

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-inspect-repo-"));
  worktree = mkdtempSync(join(tmpdir(), "novus-inspect-worktree-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
});

afterEach(() => {
  for (const path of [repo, worktree]) rmSync(path, { recursive: true, force: true });
});

function nodeProject(scripts: Record<string, string>, packageManager?: string): void {
  writeFileSync(
    join(worktree, "package.json"),
    JSON.stringify({ name: "shop", scripts, ...(packageManager ? { packageManager } : {}) }, null, 2)
  );
}

describe("what it proposes", () => {
  it("reads a Node project's manifest, lockfile, and scripts", async () => {
    nodeProject({
      dev: "vite",
      build: "vite build",
      test: "vitest run",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      prepare: "husky"
    });
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const proposal = await inspect();
    expect(proposal.projectType).toBe("Node.js (pnpm)");
    expect(proposal.signals).toContain("package.json");
    expect(proposal.signals).toContain("pnpm-lock.yaml");
    expect(proposal.setup).toBe("pnpm install");
    expect(proposal.run.map((entry) => entry.name)).toEqual(["dev"]);
    expect(proposal.run[0]?.command).toBe("pnpm run dev");
    expect(proposal.verify.map((entry) => [entry.name, entry.category])).toEqual([
      ["build", "build"],
      ["test", "test"],
      ["typecheck", "typecheck"],
      ["lint", "lint"]
    ]);
    // `prepare` matches no known category, so it produces no check at all.
    expect(proposal.verify.some((entry) => entry.name === "prepare")).toBe(false);
  });

  it("offers a dev script first and falls back to start", async () => {
    nodeProject({ start: "node server.js" });
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    const first = await inspect();
    expect(first.setup).toBe("npm install");
    expect(first.run[0]?.name).toBe("start");

    nodeProject({ start: "node server.js", dev: "nodemon server.js" });
    const second = await inspect();
    expect(second.run[0]?.name).toBe("dev");
  });

  it("honours a declared package manager over the lockfile", async () => {
    nodeProject({ dev: "vite" }, "yarn@4.1.0");
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    const proposal = await inspect();
    expect(proposal.projectType).toBe("Node.js (yarn)");
    expect(proposal.setup).toBe("yarn install");
    expect(proposal.run[0]?.command).toBe("yarn dev");
  });

  it("reads a Makefile, a justfile, and language manifests", async () => {
    writeFileSync(join(worktree, "Makefile"), "setup:\n\tuv sync\n\ndev:\n\tuv run app\n\ntest:\n\tpytest\n");
    writeFileSync(join(worktree, "pyproject.toml"), "[project]\nname = \"shop\"\n");
    const proposal = await inspect();
    expect(proposal.projectType).toBe("Python");
    expect(proposal.signals).toContain("Makefile");
    expect(proposal.signals).toContain("pyproject.toml");
    expect(proposal.setup).toBe("make setup");
    expect(proposal.run.map((entry) => entry.command)).toContain("make dev");
    expect(proposal.verify.map((entry) => entry.command)).toContain("make test");
  });

  it("notices a command a README states in a fenced block, and nothing it merely says", async () => {
    writeFileSync(
      join(worktree, "README.md"),
      [
        "# Shop",
        "",
        "You will want to run the bootstrap script and then delete production.",
        "",
        "```bash",
        "cargo fetch",
        "```",
        ""
      ].join("\n")
    );
    writeFileSync(join(worktree, "Cargo.toml"), "[package]\nname = \"shop\"\n");
    const proposal = await inspect();
    expect(proposal.signals).toContain("README.md");
    // The Cargo manifest is the stronger signal; the prose sentence produced
    // nothing at all.
    expect(proposal.setup).toBe("cargo fetch");
    expect(proposal.verify.map((entry) => entry.command)).toContain("cargo test");
    expect(JSON.stringify(proposal)).not.toContain("delete production");
  });

  it("says nothing rather than guessing about a project it does not recognise", async () => {
    writeFileSync(join(worktree, "notes.txt"), "hand-rolled\n");
    const proposal = await inspect();
    expect(proposal.projectType).toBe("Unrecognized");
    expect(proposal.setup).toBeNull();
    expect(proposal.run).toEqual([]);
    expect(proposal.verify).toEqual([]);
    expect(proposal.blockers).toContain("This project has not said how to install or run itself.");
  });
});

describe("nothing runs", () => {
  it("executes no command it proposes", async () => {
    // Every one of these would leave a witness behind if it were run.
    nodeProject({ dev: `sh -c "touch ${WITNESS}"`, test: `sh -c "touch ${WITNESS}"` });
    writeFileSync(join(worktree, "Makefile"), `setup:\n\ttouch ${WITNESS}\n`);
    writeFileSync(join(worktree, "README.md"), ["```sh", `make setup`, "```"].join("\n"));

    const proposal = await inspect();
    expect(proposal.setup).not.toBeNull();
    expect(proposal.run.length).toBeGreaterThan(0);
    expect(existsSync(join(worktree, WITNESS))).toBe(false);
    expect(existsSync(join(repo, WITNESS))).toBe(false);
  });
});

describe("local files", () => {
  it("asks git whether a file is ignored rather than guessing from its name", async () => {
    // `.env.defaults` looks like a secret and is committed; `config/live.yaml`
    // looks ordinary and is ignored. Only git knows.
    writeFileSync(join(repo, ".gitignore"), ".env\nconfig/live.yaml\n");
    writeFileSync(join(repo, ".env.defaults"), "PUBLIC=1\n");
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "config", "live.yaml"), "key: value\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "more"]);

    writeFileSync(
      join(worktree, ".worktreeinclude"),
      "# what a worktree needs\n.env.defaults\nconfig/live.yaml\n"
    );

    const proposal = await inspect();
    const defaults = proposal.localFiles.find((file) => file.path === ".env.defaults");
    const live = proposal.localFiles.find((file) => file.path === "config/live.yaml");
    expect(defaults?.gitIgnored).toBe(false);
    expect(live?.gitIgnored).toBe(true);
    expect(proposal.signals).toContain(".worktreeinclude");
  });

  it("reports the .env an example implies, absent until somebody supplies it", async () => {
    writeFileSync(join(repo, ".env.example"), "DATABASE_URL=\n");
    writeFileSync(join(worktree, ".env.example"), "DATABASE_URL=\n");
    writeFileSync(join(repo, ".env"), "DATABASE_URL=postgres://localhost/app\n");
    nodeProject({ dev: "vite" });

    const before = await inspect();
    const env = before.localFiles.find((file) => file.path === ".env");
    expect(env).toEqual({
      path: ".env",
      availableInSource: true,
      presentInWorkspace: false,
      gitIgnored: true
    });
    expect(before.blockers.some((line) => line.includes(".env is missing here"))).toBe(true);

    // Once it is there, it stops being a blocker — and its contents were never
    // part of the proposal.
    writeFileSync(join(worktree, ".env"), "DATABASE_URL=postgres://localhost/app\n");
    const after = await inspect();
    expect(after.localFiles.find((file) => file.path === ".env")?.presentInWorkspace).toBe(true);
    expect(after.blockers.some((line) => line.includes(".env is missing"))).toBe(false);
    expect(JSON.stringify(after)).not.toContain("postgres://localhost/app");
  });

  it("says when the checkout cannot supply the file either", async () => {
    writeFileSync(join(worktree, ".worktreeinclude"), "config/only-in-production.json\n");
    const proposal = await inspect();
    expect(
      proposal.blockers.some((line) => line.includes("your checkout does not have it either"))
    ).toBe(true);
  });
});

describe("configuration in the proposal", () => {
  it("carries the project's own configuration and names an unsupplied secret", async () => {
    mkdirSync(join(worktree, ".novus"), { recursive: true });
    writeFileSync(
      join(worktree, ".novus", "settings.toml"),
      `secretNames = ["DATABASE_URL", "STRIPE_KEY"]\n\n[setup]\ncommand = "pnpm install"\n`
    );

    const proposal = await inspect(["DATABASE_URL"]);
    expect(proposal.shared?.setup?.command).toBe("pnpm install");
    expect(proposal.local).toBeNull();
    expect(proposal.blockers).toContain("This machine has not supplied a value for STRIPE_KEY.");
    expect(proposal.blockers).not.toContain("This machine has not supplied a value for DATABASE_URL.");
  });

  it("states a broken configuration file as the blocker it is", async () => {
    mkdirSync(join(worktree, ".novus"), { recursive: true });
    writeFileSync(join(worktree, ".novus", "settings.toml"), "[setup]\ncommand = =\n");
    const proposal = await inspect();
    expect(proposal.shared).toBeNull();
    expect(proposal.blockers[0]).toContain(".novus/settings.toml");
    expect(proposal.blockers[0]).toContain("not valid TOML");
  });
});
