import type { FileChangeState, RunnerEvent, RunnerFileChange } from "@novus/contracts";

/**
 * Evidence derived from git and nothing else (ARCHITECTURE.md#harness-protocol:
 * "diff extraction **via git**, never via harness-reported file lists"). The
 * harness's account of what it changed is prose; `git status`, `git show
 * --numstat`, and `git diff` are the record.
 *
 * Every function here takes the git runner as an argument, so the whole module
 * is exercisable against a real temporary repository without an app around it.
 */

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export type CheckpointPayload = Extract<RunnerEvent, { kind: "workspace.checkpoint" }>["payload"];

/** Contract ceilings for a reported checkpoint. */
const MAX_FILES = 150;
const MAX_DIFF = 12_000;

/** Files an agent may create that must never be swept into a checkpoint. */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /credentials?\.json$/i
];

export function isSecretPath(path: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(path));
}

// --- Path sanitization ------------------------------------------------------

export interface PathMask {
  /** An absolute path that must never leave this machine. */
  path: string;
  /** What the room sees instead. */
  label: string;
}

/**
 * Replaces machine-local absolute paths with neutral labels (D-032: folder
 * paths never leave the machine). The home-directory sweep at the end is the
 * backstop: an unanticipated path still loses the part that identifies a
 * person and their disk layout.
 */
export function createSanitizer(masks: PathMask[]): (text: string) => string {
  const expanded: PathMask[] = [];
  for (const mask of masks) {
    if (!mask.path) continue;
    expanded.push(mask);
    // macOS resolves /var and /tmp through /private; a temporary worktree is
    // reported under whichever form the tool happened to print.
    if (mask.path.startsWith("/private/")) expanded.push({ path: mask.path.slice("/private".length), label: mask.label });
    else if (mask.path.startsWith("/var/") || mask.path.startsWith("/tmp/")) {
      expanded.push({ path: `/private${mask.path}`, label: mask.label });
    }
  }
  // Longest first, so a nested worktree inside a repository is masked as the
  // worktree rather than half-masked as the repository.
  expanded.sort((left, right) => right.path.length - left.path.length);

  return (text: string): string => {
    let out = text;
    for (const mask of expanded) out = out.split(mask.path).join(mask.label);
    return out.replace(/\/(?:Users|home)\/[^/\s"')\]]+/g, "~");
  };
}

// --- git plumbing -----------------------------------------------------------

interface StatusEntry {
  path: string;
  previousPath: string | null;
  changeState: FileChangeState;
}

function stateFromStatus(code: string): FileChangeState {
  if (code === "??") return "added";
  const index = code[0] ?? " ";
  const worktree = code[1] ?? " ";
  if (index === "R") return "renamed";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

/**
 * The dirty set from `git status --porcelain=v1 -z`. NUL framing is not
 * fussiness: a path with a space or a rename would be mis-parsed otherwise,
 * and a mis-parsed path means a file silently missing from the record.
 */
export async function dirtyEntries(git: GitRunner, cwd: string): Promise<StatusEntry[]> {
  const raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const tokens = raw.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    const changeState = stateFromStatus(code);
    if (changeState === "renamed" || code[0] === "C") {
      // A rename record is followed by its original path as its own token.
      index += 1;
      entries.push({ path, previousPath: tokens[index] ?? null, changeState: "renamed" });
      continue;
    }
    entries.push({ path, previousPath: null, changeState });
  }
  return entries;
}

interface NumstatEntry {
  path: string;
  previousPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `--numstat -z`: `adds TAB dels TAB path NUL`, or an empty path followed by
 *  the pre- and post-image paths for a rename. */
function parseNumstat(raw: string): NumstatEntry[] {
  const tokens = raw.split("\0");
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]);
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]);
    const binary = parts[0] === "-" || parts[1] === "-";
    const inline = parts[2] ?? "";
    if (inline) {
      entries.push({ path: inline, previousPath: null, additions, deletions, binary });
      continue;
    }
    const previousPath = tokens[index + 1] ?? null;
    const path = tokens[index + 2] ?? "";
    index += 2;
    if (path) entries.push({ path, previousPath, additions, deletions, binary });
  }
  return entries;
}

/** Line counts for one commit, with rename detection on. */
export async function numstatForCommit(git: GitRunner, cwd: string, sha: string): Promise<NumstatEntry[]> {
  return parseNumstat(await git(cwd, ["show", "--numstat", "-z", "--format=", "-M", sha]));
}

/** Line counts for what is still uncommitted in the worktree. */
export async function numstatForWorktree(git: GitRunner, cwd: string): Promise<NumstatEntry[]> {
  return parseNumstat(await git(cwd, ["diff", "--numstat", "-z", "-M", "HEAD"]));
}

async function diffForCommit(git: GitRunner, cwd: string, sha: string, path: string): Promise<string> {
  return git(cwd, ["show", "--format=", "-M", "--unified=3", sha, "--", path]);
}

async function diffForWorktree(git: GitRunner, cwd: string, path: string): Promise<string> {
  return git(cwd, ["diff", "-M", "--unified=3", "HEAD", "--", path]);
}

function toFileChange(
  entry: NumstatEntry,
  states: Map<string, StatusEntry>,
  diff: string | null,
  sanitize: (text: string) => string
): RunnerFileChange {
  const status = states.get(entry.path);
  const changeState: FileChangeState =
    entry.previousPath !== null ? "renamed" : (status?.changeState ?? "modified");
  const bounded = diff === null ? null : sanitize(diff);
  return {
    path: entry.path,
    previousPath: entry.previousPath ?? status?.previousPath ?? null,
    changeState,
    additions: Number.isFinite(entry.additions) ? entry.additions : 0,
    deletions: Number.isFinite(entry.deletions) ? entry.deletions : 0,
    binary: entry.binary,
    diff: bounded === null ? null : bounded.slice(0, MAX_DIFF),
    truncated: bounded !== null && bounded.length > MAX_DIFF
  };
}

async function head(git: GitRunner, cwd: string): Promise<string | null> {
  try {
    const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return sha || null;
  } catch {
    // A branch with no commits yet has no HEAD; that is a fact, not a failure.
    return null;
  }
}

// --- The checkpoint ---------------------------------------------------------

export interface CheckpointOptions {
  branch: string;
  /** What the checkpoint commit is for, in one line. */
  summary: string;
  /** Replaces machine-local paths in anything reported. */
  sanitize?: (text: string) => string;
  maxFiles?: number;
}

/**
 * Snapshots the worktree at a turn boundary (D-025). Three honest outcomes and
 * no fourth:
 *
 *  - `committed` — there were changes, they are now an attributed commit.
 *  - `clean` — the turn changed nothing. Still reported: "nothing changed" is
 *    evidence, and silence would be indistinguishable from "no checkpoint yet".
 *  - `failed` — git refused. The error travels with it, and the caller must
 *    not then claim the execution completed.
 *
 * Files that look like secrets are never committed; they are counted in
 * `withheldSecrets` and leave the checkpoint `uncommitted`.
 */
export async function captureCheckpoint(
  git: GitRunner,
  cwd: string,
  options: CheckpointOptions
): Promise<CheckpointPayload> {
  const sanitize = options.sanitize ?? ((text: string) => text);
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const parentSha = await head(git, cwd);
  const base: CheckpointPayload = {
    outcome: "clean",
    sha: null,
    parentSha,
    branch: options.branch,
    withheldSecrets: 0,
    uncommitted: false,
    error: null,
    files: []
  };

  let entries: StatusEntry[];
  try {
    entries = await dirtyEntries(git, cwd);
  } catch (error) {
    return { ...base, outcome: "failed", uncommitted: true, error: sanitize(messageOf(error)).slice(0, 400) };
  }

  const withheld = entries.filter((entry) => isSecretPath(entry.path));
  const safe = entries.filter((entry) => !isSecretPath(entry.path));
  if (safe.length === 0) {
    return { ...base, withheldSecrets: withheld.length, uncommitted: withheld.length > 0 };
  }

  const states = new Map(safe.map((entry) => [entry.path, entry]));
  try {
    await git(cwd, ["add", "--", ...safe.map((entry) => entry.path)]);
    await git(cwd, [
      "-c",
      "user.name=Novus",
      "-c",
      "user.email=novus@local",
      "commit",
      "--no-verify",
      "-m",
      `Checkpoint: ${options.summary}`
    ]);
  } catch (error) {
    return {
      ...base,
      outcome: "failed",
      withheldSecrets: withheld.length,
      uncommitted: true,
      error: sanitize(messageOf(error)).slice(0, 400)
    };
  }

  const sha = await head(git, cwd);
  if (!sha) {
    return {
      ...base,
      outcome: "failed",
      withheldSecrets: withheld.length,
      uncommitted: true,
      error: "The checkpoint commit could not be read back."
    };
  }

  const counted = await numstatForCommit(git, cwd, sha);
  const files: RunnerFileChange[] = [];
  for (const entry of counted.slice(0, maxFiles)) {
    let diff: string | null = null;
    if (!entry.binary) {
      diff = await diffForCommit(git, cwd, sha, entry.path).catch(() => null);
    }
    files.push(toFileChange(entry, states, diff, sanitize));
  }

  return {
    outcome: "committed",
    sha,
    parentSha,
    branch: options.branch,
    withheldSecrets: withheld.length,
    // Whatever was withheld is still sitting in the worktree, so the checkpoint
    // says so rather than implying the tree is clean.
    uncommitted: withheld.length > 0,
    error: null,
    files
  };
}

/**
 * The same per-file record for work that is still uncommitted — used when a
 * checkpoint could not commit but the room should still see what changed.
 */
export async function uncommittedChanges(
  git: GitRunner,
  cwd: string,
  sanitize: (text: string) => string = (text) => text,
  maxFiles = MAX_FILES
): Promise<RunnerFileChange[]> {
  const states = new Map((await dirtyEntries(git, cwd)).map((entry) => [entry.path, entry]));
  const counted = await numstatForWorktree(git, cwd);
  const files: RunnerFileChange[] = [];
  for (const entry of counted.slice(0, maxFiles)) {
    const diff = entry.binary ? null : await diffForWorktree(git, cwd, entry.path).catch(() => null);
    files.push(toFileChange(entry, states, diff, sanitize));
  }
  return files;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown git failure.";
}
