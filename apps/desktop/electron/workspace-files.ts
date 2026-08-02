import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PreparedFile } from "@novus/contracts";
import { isSecretPath } from "./evidence";
import { isIgnoredByGit, type GitExec } from "./workspace-git";

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

  if (!(await isIgnoredByGit(git, sourceRepo, requested))) {
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

/** Where a workspace copy of a given name would live. Exported so inspection
 *  and preparation agree on one answer. */
export function workspaceCopyPath(worktree: string, path: string): string {
  return join(worktree, path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
