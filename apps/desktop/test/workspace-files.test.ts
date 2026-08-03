import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedFile } from "@novus/contracts";
import { prepareLocalFiles } from "../electron/workspace-files";
import { gitExec } from "../electron/workspace-git";

/**
 * Supplying a workspace with the files a worktree cannot hold, against a real
 * repository with a real `.gitignore`. Every refusal here is a path somebody
 * could otherwise walk out of the repository with, so each one is asserted by
 * outcome and by the file *not* being there afterwards.
 */

let repo: string;
let worktree: string;
let outside: string;

async function git(cwd: string, args: string[]): Promise<void> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(outcome.stderr);
}

async function prepare(paths: string[]): Promise<PreparedFile[]> {
  return prepareLocalFiles({ git: gitExec, sourceRepo: repo, worktree, paths });
}

function only(results: PreparedFile[]): PreparedFile {
  const first = results[0];
  if (!first) throw new Error("expected one result");
  return first;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-files-repo-"));
  worktree = mkdtempSync(join(tmpdir(), "novus-files-worktree-"));
  outside = mkdtempSync(join(tmpdir(), "novus-files-outside-"));

  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n*.pem\nconfig/local.json\nsecrets/\n");
  writeFileSync(join(repo, ".env"), "DATABASE_URL=postgres://user:hunter2@localhost/app\n");
  chmodSync(join(repo, ".env"), 0o644);
  writeFileSync(join(repo, "README.md"), "# tracked\n");
  writeFileSync(join(repo, "key.pem"), "-----BEGIN PRIVATE KEY-----\n");
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "config", "local.json"), "{}\n");
  mkdirSync(join(repo, "secrets"), { recursive: true });
  writeFileSync(join(repo, "secrets", "token"), "shhh\n");
  writeFileSync(join(outside, "stolen.txt"), "not yours\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
});

afterEach(() => {
  for (const path of [repo, worktree, outside]) rmSync(path, { recursive: true, force: true });
});

describe("what may be copied", () => {
  it("copies a git-ignored file and nothing else", async () => {
    const results = await prepare([".env", "README.md"]);
    const env = results.find((result) => result.path === ".env");
    const readme = results.find((result) => result.path === "README.md");

    expect(env?.copied).toBe(true);
    expect(env?.refusedBecause).toBeNull();
    expect(readFileSync(join(worktree, ".env"), "utf8")).toContain("DATABASE_URL");

    // A tracked file is already in the worktree; supplying it is not a thing
    // this machine gets to do.
    expect(readme?.copied).toBe(false);
    expect(readme?.refusedBecause).toContain("git does not ignore");
    expect(existsSync(join(worktree, "README.md"))).toBe(false);
  });

  it("copies into a nested directory the worktree does not have yet", async () => {
    const result = only(await prepare(["config/local.json"]));
    expect(result.copied).toBe(true);
    expect(existsSync(join(worktree, "config", "local.json"))).toBe(true);
  });

  it("never overwrites a copy the workspace already has", async () => {
    writeFileSync(join(worktree, ".env"), "EDITED_IN_THE_WORKSPACE=1\n");
    const result = only(await prepare([".env"]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("already has a copy");
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("EDITED_IN_THE_WORKSPACE=1\n");
  });

  it("says so when the checkout does not have the file at all", async () => {
    const result = only(await prepare([".env.production"]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("does not have that file");
  });
});

describe("what is refused", () => {
  it("refuses a path that climbs out of the repository", async () => {
    const results = await prepare(["../stolen.txt", "config/../../stolen.txt"]);
    for (const result of results) {
      expect(result.copied).toBe(false);
      expect(result.refusedBecause).toContain("climbs out");
    }
    expect(existsSync(join(worktree, "stolen.txt"))).toBe(false);
  });

  it("refuses an absolute path", async () => {
    const result = only(await prepare([join(outside, "stolen.txt")]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("absolute path");
  });

  it("refuses a symlink, even one git ignores", async () => {
    symlinkSync(join(outside, "stolen.txt"), join(repo, "linked.pem"));
    const result = only(await prepare(["linked.pem"]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("symlink");
    expect(existsSync(join(worktree, "linked.pem"))).toBe(false);
  });

  it("refuses a file whose real path leaves the repository through a linked directory", async () => {
    // The lexical check passes: nothing here contains "..". Only the resolved
    // real path shows that the file is not in the repository at all.
    writeFileSync(join(outside, "escape.pem"), "-----BEGIN PRIVATE KEY-----\n");
    symlinkSync(outside, join(repo, "elsewhere"));
    const result = only(await prepare(["elsewhere/escape.pem"]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("outside the repository");
    expect(existsSync(join(worktree, "elsewhere"))).toBe(false);
  });

  it("refuses a directory", async () => {
    const result = only(await prepare(["secrets"]));
    expect(result.copied).toBe(false);
    expect(result.refusedBecause).toContain("directory");
  });

  it("refuses dependency directories and build output outright", async () => {
    mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "bundle.js"), "// built\n");

    const results = await prepare(["node_modules/left-pad/index.js", "dist/bundle.js"]);
    expect(results.map((result) => result.copied)).toEqual([false, false]);
    expect(results[0]?.refusedBecause).toContain("node_modules");
    expect(results[1]?.refusedBecause).toContain("dist");
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });
});

describe("permissions", () => {
  it("never leaves a secret source more permissive than 0600", async () => {
    // The original is group- and world-readable; the copy must not be.
    expect(statSync(join(repo, ".env")).mode & 0o777).toBe(0o644);
    await prepare([".env"]);
    expect(statSync(join(worktree, ".env")).mode & 0o777).toBe(0o600);
  });

  it("preserves the mode of an ordinary file", async () => {
    writeFileSync(join(repo, "hook.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(repo, "hook.sh"), 0o755);
    writeFileSync(join(repo, ".gitignore"), ".env\n*.pem\nconfig/local.json\nsecrets/\nhook.sh\n");
    const result = only(await prepare(["hook.sh"]));
    expect(result.copied).toBe(true);
    expect(statSync(join(worktree, "hook.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("what leaves this process", () => {
  it("returns names and outcomes, never contents", async () => {
    const results = await prepare([".env", "key.pem", "README.md", "../stolen.txt"]);
    const reported = JSON.stringify(results);
    expect(reported).not.toContain("hunter2");
    expect(reported).not.toContain("BEGIN PRIVATE KEY");
    expect(reported).not.toContain("not yours");
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(["copied", "path", "refusedBecause"]);
    }
  });
});
