import { ignoredByGit, type GitExec } from "./workspace-git";

/**
 * The mission's own changes, laid onto an open file (D-227): which lines of
 * the file *as it stands* the mission added or rewrote, and where lines were
 * taken out — so a changed file shows its change in place instead of only in
 * the Changes surface. Computed on the machine that holds the checkout, from
 * git's own answer, against the lane's pinned base: the exact commit the
 * mission started from, so the wash is "what this mission did", not "what is
 * uncommitted right now".
 *
 * The wash is enrichment, never a gate: a file git cannot diff — outside the
 * repository, a base the checkout no longer holds, a transient failure —
 * answers `changed: false` and the file view simply shows the file.
 */

export interface FileLineDiff {
  /** True when the mission touched this file at all. */
  changed: boolean;
  /** 1-indexed lines of the file as it stands that the mission added or
   *  rewrote — the green wash. */
  washed: number[];
  /** 1-indexed lines *after* which content was removed (0 = before the first
   *  line) — the thin red seam between lines. */
  deletions: number[];
}

const UNCHANGED: FileLineDiff = { changed: false, washed: [], deletions: [] };

/**
 * Reads `git diff --unified=0` hunk headers into line facts. With zero
 * context every hunk is exactly the changed run: `@@ -a,b +c,d @@` means d
 * new-side lines starting at c (the wash), and where b > 0 with d = 0, b old
 * lines vanished after new-side line c.
 */
export function parseUnifiedZero(diff: string): FileLineDiff {
  const washed: number[] = [];
  const deletions: number[] = [];
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const oldCount = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const newStart = Number(hunk[2]);
    const newCount = hunk[3] === undefined ? 1 : Number(hunk[3]);
    if (newCount > 0) {
      for (let at = 0; at < newCount; at += 1) washed.push(newStart + at);
    } else if (oldCount > 0) {
      // Pure removal: git reports the new-side line *before* the gap.
      deletions.push(newStart);
    }
  }
  return washed.length === 0 && deletions.length === 0
    ? UNCHANGED
    : { changed: true, washed, deletions };
}

/** The wash for one file, or quiet nothing when git cannot answer. */
export async function fileLineDiff(
  git: GitExec,
  worktree: string,
  baseSha: string | null,
  path: string
): Promise<FileLineDiff> {
  // An ignored file is the person's or the machine's, never the mission's —
  // a .env supplied by hand must not wear the mission's wash.
  if ((await ignoredByGit(git, worktree, path)) === "ignored") return UNCHANGED;
  const base = baseSha !== null && /^[0-9a-f]{40}$/.test(baseSha) ? baseSha : "HEAD";
  const outcome = await git(worktree, ["diff", "--unified=0", "--no-color", base, "--", path]);
  if (outcome.code !== 0) {
    // The pinned base may predate a shallow or replaced checkout; what the
    // worktree holds against its own HEAD is the honest fallback.
    if (base !== "HEAD") {
      const local = await git(worktree, ["diff", "--unified=0", "--no-color", "HEAD", "--", path]);
      if (local.code === 0) return parseUnifiedZero(local.stdout);
    }
    return UNCHANGED;
  }
  const parsed = parseUnifiedZero(outcome.stdout);
  if (parsed.changed) return parsed;
  // `git diff <base> -- path` is silent about a file git has never tracked —
  // and a brand-new file an agent just wrote is THE green change, before any
  // checkpoint commits it. Ask status, and wash the whole file through git's
  // own no-index diff (exit 1 is "they differ", which here they always do).
  const status = await git(worktree, ["status", "--porcelain", "--untracked-files", "--", path]);
  if (status.code === 0 && status.stdout.startsWith("??")) {
    const fresh = await git(worktree, ["diff", "--unified=0", "--no-color", "--no-index", "--", "/dev/null", path]);
    if (fresh.code <= 1) return parseUnifiedZero(fresh.stdout);
  }
  return parsed;
}
