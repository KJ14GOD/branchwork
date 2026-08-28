import { execFile } from "node:child_process";

/**
 * Git, asked the way the workspace runtime needs to ask it: with the exit code
 * returned rather than thrown.
 *
 * The questions this slice puts to git are questions whose "no" is an ordinary
 * answer — `check-ignore` exits 1 for a path that is simply not ignored — and a
 * thrown error there is indistinguishable from a broken repository. Deciding
 * whether a file may be copied on the strength of that difference is exactly
 * the kind of guess ARCHITECTURE.md#workspace-configuration-environments-and-processes
 * forbids: only paths Git *confirms* are ignored may ever be copied.
 *
 * Injectable everywhere it is used, so the modules that depend on git are
 * exercisable against a real temporary repository without an app around them.
 */

export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitExec = (cwd: string, args: string[]) => Promise<GitOutcome>;

/** Long enough for a slow index refresh, short enough that a wedged git does
 *  not hold a command open forever. */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export const gitExec: GitExec = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A killed or unspawnable git has no numeric status; 128 is git's own
        // "this went wrong" code, which is the honest thing to report.
        const status = (error as { code?: number | string }).code;
        resolve({
          code: typeof status === "number" ? status : 128,
          stdout,
          stderr: stderr.trim() || error.message
        });
      }
    );
  });

/** `true` only when git positively confirms the path is ignored in `cwd`. */
/** What `git check-ignore` actually said (D-226 hardening): exit 0 is
 *  "ignored", exit 1 is "not ignored", and anything else — a held lock, a
 *  racing operation, a failed spawn — is git failing to answer at all, which
 *  must never be read as either answer. One beat and one more ask covers the
 *  transient case before the caller says so in words. */
export type IgnoreAnswer = "ignored" | "not-ignored" | "unanswerable";

export async function ignoredByGit(git: GitExec, cwd: string, path: string): Promise<IgnoreAnswer> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await git(cwd, ["check-ignore", "-q", "--", path]);
    if (outcome.code === 0) return "ignored";
    if (outcome.code === 1) return "not-ignored";
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return "unanswerable";
}

/** The boolean face, for callers where "unanswerable" safely reads as "not
 *  ignored" (a listing flag, a skip). The gates that refuse in a person's
 *  face use `ignoredByGit` and name the difference. */
export async function isIgnoredByGit(git: GitExec, cwd: string, path: string): Promise<boolean> {
  return (await ignoredByGit(git, cwd, path)) === "ignored";
}

/** The revision a workspace is on, or null when the branch has no commit yet. */
export async function headSha(git: GitExec, cwd: string): Promise<string | null> {
  const outcome = await git(cwd, ["rev-parse", "HEAD"]);
  if (outcome.code !== 0) return null;
  const sha = outcome.stdout.trim();
  return sha === "" ? null : sha;
}
