import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { PreparedFile } from "@novus/contracts";
import { isSecretPath } from "./evidence";
import { ignoredByGit, type GitExec } from "./workspace-git";

/**
 * Supplying a workspace with the files a worktree cannot have
 * (ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 *
 * A worktree holds tracked files and nothing else, so a project that needs a
 * `.env` is unprepared until a person supplies it. Preparation is explicit,
 * bounded, and refuses by name:
 *
 *  - only paths git *confirms* are ignored in the source repository, because a
 *    tracked file is already in the worktree and an un-ignored untracked file
 *    is something the person has not decided about yet;
 *  - nothing that escapes the source repository or the destination worktree,
 *    checked both lexically and against the resolved real path, because the two
 *    catch different attacks;
 *  - no symlink, and nothing whose real path leaves the repository;
 *  - no directory, and no dependency directory or build output at all;
 *  - a secret source is never given a mode more permissive than 0600;
 *  - an existing copy is never overwritten. Silently replacing a file somebody
 *    edited in the workspace would destroy work with no record.
 *
 * Contents never leave this process. What this module returns is names and
 * outcomes; the renderer and the control plane learn nothing else (D-041).
 */

/** Directories whose contents are produced, not supplied. Copying them would
 *  be slow, wrong, and — for `node_modules` — a way to smuggle executables. */
const NEVER_COPY_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache"
]);

/** A local file is configuration, not a payload. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface PrepareInput {
  git: GitExec;
  /** The user's own checkout: the only place a file may be copied from. */
  sourceRepo: string;
  /** The workstream's worktree: the only place a file may be copied to. */
  worktree: string;
  paths: readonly string[];
}

export async function prepareLocalFiles(input: PrepareInput): Promise<PreparedFile[]> {
  const sourceRoot = realOrSelf(input.sourceRepo);
  const worktreeRoot = realOrSelf(input.worktree);
  const results: PreparedFile[] = [];
  const seen = new Set<string>();

  for (const requested of input.paths) {
    if (seen.has(requested)) continue;
    seen.add(requested);
    results.push(await prepareOne(input.git, input.sourceRepo, sourceRoot, worktreeRoot, requested));
  }
  return results;
}

async function prepareOne(
  git: GitExec,
  sourceRepo: string,
  sourceRoot: string,
  worktreeRoot: string,
  requested: string
): Promise<PreparedFile> {
  const refuse = (because: string): PreparedFile => ({ path: requested, copied: false, refusedBecause: because });

  const shape = shapeProblem(requested);
  if (shape !== null) return refuse(shape);

  const from = resolve(sourceRoot, requested);
  const to = resolve(worktreeRoot, requested);
  // Lexical containment first: it is the check that still holds when the file
  // does not exist yet and there is no real path to resolve.
  if (!isInside(sourceRoot, from)) return refuse("that path resolves outside the repository");
  if (!isInside(worktreeRoot, to)) return refuse("that path resolves outside the workspace");

  if (!existsSync(from) && !symlinkAt(from)) return refuse("your checkout does not have that file");

  // A symlink is refused before it is followed: what it points at is a
  // different file from the one the person confirmed.
  if (symlinkAt(from)) return refuse("that path is a symlink, and Novus copies only real files");

  let realFrom: string;
  try {
    realFrom = realpathSync(from);
  } catch {
    return refuse("that path could not be resolved on this machine");
  }
  // The realpath check catches what the lexical one cannot: a parent directory
  // that is itself a link out of the repository.
  if (!isInside(sourceRoot, realFrom)) return refuse("that path resolves outside the repository");

  let stats;
  try {
    stats = statSync(realFrom);
  } catch {
    return refuse("that path could not be read on this machine");
  }
  if (stats.isDirectory()) return refuse("that path is a directory, and Novus copies files one at a time");
  if (!stats.isFile()) return refuse("that path is not an ordinary file");
  if (stats.size > MAX_FILE_BYTES) return refuse("that file is too large to be workspace configuration");

  const supplyAnswer = await ignoredByGit(git, sourceRepo, requested);
  if (supplyAnswer === "unanswerable") {
    return refuse("git could not answer whether that file is ignored just now — try again");
  }
  if (supplyAnswer !== "ignored") {
    return refuse("git does not ignore that file, so it is not this machine's to supply");
  }

  if (existsSync(to) || symlinkAt(to)) {
    return refuse("the workspace already has a copy, which Novus left alone");
  }

  const secret = isSecretPath(requested);
  try {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(realFrom, to);
  } catch (error) {
    return refuse(`that file could not be copied (${messageOf(error)})`);
  }

  // Modes are preserved so an executable hook still runs, except for a secret
  // source: whatever the original permissions were, the copy is readable by
  // this user and nobody else. A secret whose mode could not be narrowed is
  // withdrawn rather than left lying around readable.
  const mode = secret ? stats.mode & 0o600 : stats.mode & 0o777;
  if (!applyMode(to, mode) && secret) {
    try {
      rmSync(to, { force: true });
    } catch {
      /* nothing further to do; the refusal below is still the truth */
    }
    return refuse("this filesystem cannot restrict that file's permissions, so Novus did not leave a secret on it");
  }

  return { path: requested, copied: true, refusedBecause: null };
}

/** What a person's own file act came to: done, or refused in words. */
export type LocalFileOutcome = { done: true; refusedBecause: null } | { done: false; refusedBecause: string };

const refuseOutcome = (because: string): LocalFileOutcome => ({ done: false, refusedBecause: because });
const DONE: LocalFileOutcome = { done: true, refusedBecause: null };

/** A typed-in local file is configuration; a megabyte of it is something else. */
const MAX_WRITE_BYTES = 1024 * 1024;

export interface LocalWriteInput {
  git: GitExec;
  worktree: string;
  path: string;
  content: string;
}

/**
 * Writes a person-typed local file into the workspace (D-226) — the `.env`
 * case: the project needs an ignored file that exists nowhere on this machine
 * yet, so there is nothing to copy and the person supplies the contents
 * directly. The same boundary as the copy path, from the other side:
 *
 *  - only a path git *confirms* is ignored — a tracked file changes through
 *    the mission's own attributed work, never through a person's silent hand,
 *    and an un-ignored path would land in the next diff as nobody's change;
 *  - the same shape, containment, and never-copy rules as `prepareLocalFiles`;
 *  - written 0600 always: a person-typed local file is presumed sensitive;
 *  - overwriting is allowed — it is the person's own supplied file, and
 *    editing a key they mistyped must not require a delete first — but never
 *    through a symlink and never onto a directory.
 *
 * Contents never leave this process and are never echoed back (D-041).
 */
export async function writeLocalFile(input: LocalWriteInput): Promise<LocalFileOutcome> {
  const shape = shapeProblem(input.path);
  if (shape !== null) return refuseOutcome(shape);
  if (Buffer.byteLength(input.content, "utf8") > MAX_WRITE_BYTES) {
    return refuseOutcome("that is too large to be workspace configuration");
  }

  const worktreeRoot = realOrSelf(input.worktree);
  const to = resolve(worktreeRoot, input.path);
  if (!isInside(worktreeRoot, to)) return refuseOutcome("that path resolves outside the workspace");

  const writeAnswer = await ignoredByGit(input.git, input.worktree, input.path);
  if (writeAnswer === "unanswerable") {
    return refuseOutcome("git could not answer whether that path is ignored just now — try again");
  }
  if (writeAnswer !== "ignored") {
    return refuseOutcome(
      "git does not ignore that path — a tracked file changes through the mission's own work, not a supplied copy"
    );
  }

  if (symlinkAt(to)) return refuseOutcome("that path is a symlink, and Novus writes only real files");
  if (existsSync(to) && statSync(to).isDirectory()) {
    return refuseOutcome("that path is a directory");
  }

  try {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, input.content, { mode: 0o600 });
  } catch (error) {
    return refuseOutcome(`that file could not be written (${messageOf(error)})`);
  }
  // An overwrite keeps whatever mode the file had; narrow it regardless — the
  // person-typed contents are presumed sensitive whatever the old copy was.
  if (!applyMode(to, 0o600)) {
    try {
      rmSync(to, { force: true });
    } catch {
      /* the refusal below is still the truth */
    }
    return refuseOutcome("this filesystem cannot restrict that file's permissions, so Novus did not leave it there");
  }
  return DONE;
}

/**
 * Deletes a person-supplied local file from the workspace (D-226). The same
 * ignored-only rule as writing: git tracking a path means deleting it is the
 * mission's work to record, not a person's silent act.
 */
export async function deleteLocalFile(
  git: GitExec,
  worktree: string,
  path: string
): Promise<LocalFileOutcome> {
  const shape = shapeProblem(path);
  if (shape !== null) return refuseOutcome(shape);

  const worktreeRoot = realOrSelf(worktree);
  const at = resolve(worktreeRoot, path);
  if (!isInside(worktreeRoot, at)) return refuseOutcome("that path resolves outside the workspace");
  if (symlinkAt(at)) return refuseOutcome("that path is a symlink, and Novus removes only real files");
  if (!existsSync(at)) return refuseOutcome("the workspace has no such file");
  if (statSync(at).isDirectory()) return refuseOutcome("that path is a directory");
  const removeAnswer = await ignoredByGit(git, worktree, path);
  if (removeAnswer === "unanswerable") {
    return refuseOutcome("git could not answer whether that file is ignored just now — try again");
  }
  if (removeAnswer !== "ignored") {
    return refuseOutcome("git does not ignore that file, so removing it is the mission's own work to record");
  }
  try {
    rmSync(at);
  } catch (error) {
    return refuseOutcome(`that file could not be removed (${messageOf(error)})`);
  }
  return DONE;
}

/** Everything wrong with a path that can be decided without touching a disk. */
function shapeProblem(requested: string): string | null {
  if (requested.trim() === "") return "that is not a path";
  if (isAbsolute(requested) || /^[a-zA-Z]:[\\/]/.test(requested)) {
    return "an absolute path is never copied; name the file relative to the repository";
  }
  if (requested.includes("\0")) return "that path is malformed";
  const segments = requested.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) return "that path climbs out of the repository";
  const blocked = segments.find((segment) => NEVER_COPY_SEGMENTS.has(segment));
  if (blocked !== undefined) return `${blocked} is built, not supplied, so Novus never copies it`;
  return null;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false; // the root itself is a directory
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function symlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function applyMode(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
