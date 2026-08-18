import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseWorkspaceWorktree } from "../electron/workspace";
import { ATTACHMENT_DIR } from "../electron/secret-policy";

/**
 * Giving a lane's checkout back when its mission ends (D-155).
 *
 * Written against real git worktrees, because every interesting case here is a
 * thing git decides: whether a directory is a worktree, whether it is dirty,
 * and whether removing it succeeds. A mock would agree with whatever this file
 * assumed and prove nothing.
 *
 * The rule under test is the refusal. Deleting a directory is easy; the value
 * is entirely in *not* deleting one that still holds somebody's work, and in
 * never touching the branch, which is the record the receipt and any pull
 * request point at.
 */

let repo: string;
let userData: string;

const git = (cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
  });

const branch = "novus/m-release";

async function makeWorktree(workstreamId: string): Promise<string> {
  const path = join(userData, "worktrees", workstreamId);
  mkdirSync(join(userData, "worktrees"), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, "--", path]);
  return path;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-release-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-release-data-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe("releasing a lane's workspace", () => {
  it("removes a clean worktree and leaves the branch alone", async () => {
    const workstreamId = "wst_clean";
    const path = await makeWorktree(workstreamId);
    expect(existsSync(path)).toBe(true);

    const released = await releaseWorkspaceWorktree(userData, workstreamId, repo);

    expect(released.outcome).toBe("released");
    expect(existsSync(path)).toBe(false);
    // The branch is the record: every checkpoint is on it, the receipt names
    // it, and a pull request may still point at it.
    const branches = await git(repo, ["branch", "--list", branch]);
    expect(branches.stdout).toContain(branch);
  }, 30_000);

  it("refuses to remove a worktree holding uncommitted work, and says how much", async () => {
    const workstreamId = "wst_dirty";
    const path = await makeWorktree(workstreamId);
    writeFileSync(join(path, "unsaved.ts"), "export const mine = 1;\n");
    writeFileSync(join(path, "README.md"), "# fixture\n\nedited\n");

    const released = await releaseWorkspaceWorktree(userData, workstreamId, repo);

    expect(released.outcome).toBe("kept");
    expect(released.uncommitted).toBe(2);
    expect(released.reason).toContain("does not delete uncommitted work");
    // The whole point: it is still there.
    expect(existsSync(join(path, "unsaved.ts"))).toBe(true);
  }, 30_000);

  it("removes staged attachments, and they never count as work worth keeping", async () => {
    const workstreamId = "wst_attached";
    const path = await makeWorktree(workstreamId);
    const staged = join(path, ATTACHMENT_DIR);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "art_one-shot.png"), "bytes\n");
    writeFileSync(join(staged, "art_two-track.mp3"), "bytes\n");

    const released = await releaseWorkspaceWorktree(userData, workstreamId, repo);

    // A person's own attachment is durable in the artifact store, so the copy
    // on disk is a cache — and a cache must never be the reason a workspace
    // is kept forever.
    expect(released.outcome).toBe("released");
    expect(released.attachmentsRemoved).toBe(2);
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it("keeps a worktree whose real work is dirty even when attachments are staged too", async () => {
    const workstreamId = "wst_both";
    const path = await makeWorktree(workstreamId);
    mkdirSync(join(path, ATTACHMENT_DIR), { recursive: true });
    writeFileSync(join(path, ATTACHMENT_DIR, "art_one-shot.png"), "bytes\n");
    writeFileSync(join(path, "unsaved.ts"), "export const mine = 1;\n");

    const released = await releaseWorkspaceWorktree(userData, workstreamId, repo);

    expect(released.outcome).toBe("kept");
    // Counted honestly: the attachment is not somebody's uncommitted work.
    expect(released.uncommitted).toBe(1);
    expect(released.attachmentsRemoved).toBe(1);
    expect(existsSync(join(path, "unsaved.ts"))).toBe(true);
  }, 30_000);

  it("is quiet about a lane whose workspace was never created or is already gone", async () => {
    const released = await releaseWorkspaceWorktree(userData, "wst_never", repo);
    expect(released.outcome).toBe("absent");
    expect(released.reason).toBeNull();
  }, 30_000);

  it("can be asked twice without the second answer being a failure", async () => {
    const workstreamId = "wst_twice";
    await makeWorktree(workstreamId);
    const first = await releaseWorkspaceWorktree(userData, workstreamId, repo);
    const second = await releaseWorkspaceWorktree(userData, workstreamId, repo);
    // The command queue can re-offer a command; a release that already
    // happened must settle rather than error.
    expect(first.outcome).toBe("released");
    expect(second.outcome).toBe("absent");
  }, 30_000);
});
