import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceWorktree } from "../electron/workspace";
import { gitExec } from "../electron/workspace-git";
import { mergeBaseIntoLanes, resetLanes, type SyncLane } from "../electron/workspace-sync";

/**
 * Following a moved base against a real git (D-144): two lanes on mission
 * branches, a base branch that moves on, and the module's whole promise —
 * a merge and never a rebase, all lanes or none, a conflict anywhere refuses
 * everything with names, and a walk-back leaves the machine exactly as it
 * stood.
 */

const LANE_ONE = "wst_sync_lane_one";
const LANE_TWO = "wst_sync_lane_two";
const BRANCH_ONE = "novus/m-sync0001";
const BRANCH_TWO = "novus/m-sync0002";

let repo: string;
let userData: string;
let lanes: SyncLane[];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args]).toString().trim();

const commit = (cwd: string, message: string): void => {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", message]);
};

const head = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]);

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-sync-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-sync-userdata-"));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "one\ntwo\nthree\n");
  commit(repo, "base");
  git(repo, ["branch", BRANCH_ONE]);
  git(repo, ["branch", BRANCH_TWO]);
  const one = await ensureWorkspaceWorktree(gitExec, repo, userData, LANE_ONE, BRANCH_ONE);
  const two = await ensureWorkspaceWorktree(gitExec, repo, userData, LANE_TWO, BRANCH_TWO);
  lanes = [
    { workstreamId: LANE_ONE, worktreePath: one },
    { workstreamId: LANE_TWO, worktreePath: two }
  ];
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

/** The base branch grows a commit the lanes do not have. */
function moveBase(file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  commit(repo, `base moves: ${file}`);
  return head(repo);
}

describe("mergeBaseIntoLanes", () => {
  it("merges the moved base into every lane and leaves the base file present", async () => {
    writeFileSync(join(lanes[0].worktreePath, "lane-one.txt"), "work\n");
    commit(lanes[0].worktreePath, "lane one works");
    const laneOnePre = head(lanes[0].worktreePath);
    const tip = moveBase("base-news.txt", "fresh\n");

    const outcome = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(outcome.kind).toBe("synced");
    if (outcome.kind !== "synced") return;
    // Lane one had its own work: a merge commit on top of it, never a rewrite
    // — its old head is still an ancestor, so every recorded SHA stays true.
    const one = outcome.lanes.find((lane) => lane.workstreamId === LANE_ONE);
    expect(one?.preSha).toBe(laneOnePre);
    expect(one?.headSha).not.toBe(laneOnePre);
    expect(git(lanes[0].worktreePath, ["merge-base", "--is-ancestor", laneOnePre, "HEAD"])).toBe("");
    // Both worktrees now hold what the base gained.
    expect(existsSync(join(lanes[0].worktreePath, "base-news.txt"))).toBe(true);
    expect(existsSync(join(lanes[1].worktreePath, "base-news.txt"))).toBe(true);
  });

  it("keeps a lane that already holds the base at its unchanged head", async () => {
    const tip = moveBase("base-news.txt", "fresh\n");
    const first = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(first.kind).toBe("synced");
    const again = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(again.kind).toBe("synced");
    if (again.kind !== "synced") return;
    for (const lane of again.lanes) expect(lane.headSha).toBe(lane.preSha);
  });

  it("refuses the whole act when one lane conflicts, and nothing moves", async () => {
    // Lane two edits the same line the base then edits: a genuine conflict.
    writeFileSync(join(lanes[1].worktreePath, "README.md"), "one\nlane two's line\nthree\n");
    commit(lanes[1].worktreePath, "lane two edits");
    const heads = lanes.map((lane) => head(lane.worktreePath));
    const tip = moveBase("README.md", "one\nthe base's line\nthree\n");

    const outcome = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.workstreamId).toBe(LANE_TWO);
    expect(outcome.paths).toContain("README.md");
    // Lane one would have merged cleanly; the refusal still moved nothing.
    expect(lanes.map((lane) => head(lane.worktreePath))).toEqual(heads);
  });

  it("refuses a dirty worktree by name before anything merges", async () => {
    writeFileSync(join(lanes[0].worktreePath, "uncommitted.txt"), "mid-flight\n");
    const heads = lanes.map((lane) => head(lane.worktreePath));
    const tip = moveBase("base-news.txt", "fresh\n");

    const outcome = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(outcome.kind).toBe("dirty");
    if (outcome.kind !== "dirty") return;
    expect(outcome.workstreamId).toBe(LANE_ONE);
    expect(outcome.paths).toContain("uncommitted.txt");
    expect(lanes.map((lane) => head(lane.worktreePath))).toEqual(heads);
  });

  it("walks every merged lane back to where it stood", async () => {
    const before = lanes.map((lane) => head(lane.worktreePath));
    const tip = moveBase("base-news.txt", "fresh\n");
    const outcome = await mergeBaseIntoLanes(gitExec, tip, "main", lanes);
    expect(outcome.kind).toBe("synced");
    if (outcome.kind !== "synced") return;
    await resetLanes(gitExec, lanes, outcome.lanes);
    expect(lanes.map((lane) => head(lane.worktreePath))).toEqual(before);
    expect(existsSync(join(lanes[0].worktreePath, "base-news.txt"))).toBe(false);
  });
});
