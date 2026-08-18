import type { GitExec } from "./workspace-git.ts";

/**
 * Following a moved base, the worktree half (D-144).
 *
 * The base branch moved on while the mission worked from its pinned commit.
 * Syncing is a person's explicit act, and it is a merge, never a rebase: a
 * rebase re-creates every commit under a new SHA, and every checkpoint,
 * decision, and receipt in the record names the SHAs the lanes already have.
 * A merge adds one attributed commit and leaves every recorded fact true.
 *
 * All lanes move together or none do — two approaches are comparable only
 * while they stand on the same base — so every lane is prechecked with
 * `git merge-tree` before any lane merges, and a conflict anywhere refuses
 * the whole act with the lane and paths named. Dirty worktrees refuse for the
 * same reason a running turn does: the merge would fold itself into work
 * mid-flight.
 *
 * Pure git against paths it is handed; injectable and exercised against real
 * temporary repositories, no app around it.
 */

export interface SyncLane {
  workstreamId: string;
  worktreePath: string;
}

export type SyncMergeOutcome =
  | {
      kind: "synced";
      lanes: { workstreamId: string; headSha: string; preSha: string }[];
    }
  | { kind: "dirty"; workstreamId: string; paths: string[] }
  | { kind: "conflict"; workstreamId: string; paths: string[] }
  | { kind: "failed"; message: string };

const SHORT = 12;

async function headSha(git: GitExec, cwd: string): Promise<string | null> {
  const out = await git(cwd, ["rev-parse", "HEAD"]);
  return out.code === 0 ? out.stdout.trim() : null;
}

/** The worktree's uncommitted paths — capped, enough to name the refusal. */
async function dirtyPaths(git: GitExec, cwd: string): Promise<string[] | null> {
  const out = await git(cwd, ["status", "--porcelain"]);
  if (out.code !== 0) return null;
  return out.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim())
    .slice(0, 10);
}

/** Conflicted paths from `git merge-tree --write-tree --name-only`: the lines
 *  between the tree OID and the first blank line, when the merge would not be
 *  clean. */
function conflictedPaths(stdout: string): string[] {
  const lines = stdout.split("\n");
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break;
    paths.push(line.trim());
  }
  return paths.slice(0, 10);
}

/**
 * Merges `newBaseSha` into every lane's worktree, atomically across lanes.
 *
 * Precheck first — dirtiness and a simulated merge per lane — so the refusal
 * arrives before anything moved. Then merge for real; a lane that already
 * holds the base keeps its head unchanged. If a later lane's merge still
 * fails after a clean precheck (a racing write, a wedged git), every lane
 * already merged is reset to its recorded pre-merge head: none moved.
 */
export async function mergeBaseIntoLanes(
  git: GitExec,
  newBaseSha: string,
  baseRef: string,
  lanes: SyncLane[]
): Promise<SyncMergeOutcome> {
  // Precheck every lane before touching any.
  for (const lane of lanes) {
    const dirty = await dirtyPaths(git, lane.worktreePath);
    if (dirty === null) {
      return { kind: "failed", message: `Could not read the workspace for ${lane.workstreamId}.` };
    }
    if (dirty.length > 0) {
      return { kind: "dirty", workstreamId: lane.workstreamId, paths: dirty };
    }
    const simulated = await git(lane.worktreePath, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "HEAD",
      newBaseSha
    ]);
    if (simulated.code === 1) {
      return {
        kind: "conflict",
        workstreamId: lane.workstreamId,
        paths: conflictedPaths(simulated.stdout)
      };
    }
    if (simulated.code !== 0) {
      return { kind: "failed", message: simulated.stderr.slice(0, 300) };
    }
  }

  const merged: { workstreamId: string; headSha: string; preSha: string }[] = [];
  for (const lane of lanes) {
    const pre = await headSha(git, lane.worktreePath);
    if (pre === null) {
      await resetLanes(git, lanes, merged);
      return { kind: "failed", message: `The workspace for ${lane.workstreamId} has no revision.` };
    }
    const ancestor = await git(lane.worktreePath, ["merge-base", "--is-ancestor", newBaseSha, "HEAD"]);
    if (ancestor.code === 0) {
      merged.push({ workstreamId: lane.workstreamId, headSha: pre, preSha: pre });
      continue;
    }
    const outcome = await git(lane.worktreePath, [
      "-c",
      "user.name=Novus",
      "-c",
      "user.email=novus@local",
      "merge",
      "--no-verify",
      "-m",
      `Sync base: merge ${baseRef} at ${newBaseSha.slice(0, SHORT)}`,
      newBaseSha
    ]);
    if (outcome.code !== 0) {
      // The precheck said clean; something changed underneath. Abort whatever
      // half-merge git left, then walk back every lane already moved.
      await git(lane.worktreePath, ["merge", "--abort"]);
      await resetLanes(git, lanes, merged);
      return { kind: "failed", message: outcome.stderr.slice(0, 300) };
    }
    const post = await headSha(git, lane.worktreePath);
    if (post === null) {
      await resetLanes(git, lanes, merged);
      return { kind: "failed", message: "The merge left no readable revision." };
    }
    merged.push({ workstreamId: lane.workstreamId, headSha: post, preSha: pre });
  }
  return { kind: "synced", lanes: merged };
}

/** Walks every already-merged lane back to its recorded pre-merge head, so a
 *  refusal downstream (the control plane's, or a mid-flight failure) leaves
 *  the machine exactly as it stood. */
export async function resetLanes(
  git: GitExec,
  lanes: SyncLane[],
  merged: { workstreamId: string; headSha: string; preSha: string }[]
): Promise<void> {
  for (const entry of merged) {
    if (entry.headSha === entry.preSha) continue;
    const lane = lanes.find((candidate) => candidate.workstreamId === entry.workstreamId);
    if (!lane) continue;
    await git(lane.worktreePath, ["reset", "--hard", entry.preSha]);
  }
}
