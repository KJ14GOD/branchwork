import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceWorktree } from "../electron/workspace";
import { gitExec } from "../electron/workspace-git";

/**
 * Migrating off the pre-approaches worktree layout (D-074, found in a real
 * session). Worktrees used to be keyed by *mission*; D-074 rekeyed them by
 * workstream, and a mission from before that change still holds its branch
 * checked out under the old name — so `git worktree add` for the new key
 * fails with "already checked out", and the room says the workspace could not
 * be created for a mission that worked yesterday.
 *
 * The rule these tests pin: Novus retires its own clean legacy worktree and
 * carries on; it never deletes uncommitted work, and it never touches a
 * checkout that is not its own.
 */

const BRANCH = "novus/m-legacy01";

let repo: string;
let userData: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "novus-worktree-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-worktree-data-"));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "init"]);
  git(repo, ["branch", BRANCH]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

/** The old layout: the branch checked out at `worktrees/<missionId>`. */
function legacyWorktree(missionId: string): string {
  const root = join(userData, "worktrees");
  mkdirSync(root, { recursive: true });
  const path = join(root, missionId);
  git(repo, ["worktree", "add", "--", path, BRANCH]);
  return path;
}

describe("the pre-approaches worktree layout", () => {
  it("retires a clean mission-keyed worktree and prepares the workstream-keyed one", async () => {
    const legacy = legacyWorktree("msn_legacymission01");

    const worktree = await ensureWorkspaceWorktree(gitExec, repo, userData, "wst_freshlane01", BRANCH);

    expect(worktree).toBe(join(userData, "worktrees", "wst_freshlane01"));
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(git(repo, ["rev-parse", BRANCH]));
    // The old worktree is gone from disk and from git's own registry.
    expect(existsSync(legacy)).toBe(false);
    expect(git(repo, ["worktree", "list"])).not.toContain("msn_legacymission01");
  });

  it("refuses to delete a legacy worktree that holds uncommitted work, by name", async () => {
    const legacy = legacyWorktree("msn_legacymission02");
    writeFileSync(join(legacy, "half-finished.ts"), "// not committed anywhere\n");

    await expect(
      ensureWorkspaceWorktree(gitExec, repo, userData, "wst_freshlane02", BRANCH)
    ).rejects.toThrow(/uncommitted/i);
    // Nothing was deleted: the dirty file is exactly where it was.
    expect(existsSync(join(legacy, "half-finished.ts"))).toBe(true);
  });

  it("never touches a conflicting checkout that is not Novus's own", async () => {
    // A worktree the *user* made, outside Novus's root, holding the branch.
    const theirs = mkdtempSync(join(tmpdir(), "novus-users-own-"));
    rmSync(theirs, { recursive: true, force: true });
    git(repo, ["worktree", "add", "--", theirs, BRANCH]);

    await expect(
      ensureWorkspaceWorktree(gitExec, repo, userData, "wst_freshlane03", BRANCH)
    ).rejects.toThrow(/could not be created/i);
    expect(existsSync(join(theirs, "README.md"))).toBe(true);
    rmSync(theirs, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  });
});
