import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceEntry, WorkspaceFile } from "@novus/contracts";
import { isSecretPath, SECRET_PATH_REFUSAL } from "./secret-policy";
import { WorkspaceCommandError } from "./workspace-processes";

/**
 * Reading and writing the workspace's own files (D-048).
 *
 * The worktree is on this machine, so this is a local act like opening a
 * terminal in it: there is no control-plane route and no runner command, and
 * nothing here is reported anywhere. What crosses the bridge crosses it to be
 * *shown*.
 *
 * Every path is resolved against the worktree and refused if it leaves — by
 * `realpath`, not by string comparison, because a symlink inside the worktree
 * pointing at `~/.ssh` looks like a perfectly ordinary relative path right up
 * until it is followed. `.git` is skipped entirely: it is not the project, it
 * is bookkeeping, and its packfiles are the largest thing in most repositories.
 */

/** A pane, not a stream. Past this a file is offered as too large to show. */
const MAX_FILE_BYTES = 1_000_000;
/** One directory listing; a generated folder with more entries than this is
 *  not something a person is reading through. */
const MAX_ENTRIES = 2_000;
/** How much of a file's head decides whether it is text. */
const SNIFF_BYTES = 8_000;

/** Never listed, never opened. Bookkeeping and build output a person browsing
 *  a project is not looking for, and directories that would make listing a
 *  directory an expensive operation. */
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * A file that looks like it holds a credential is refused here, by the same
 * policy checkpoints use (D-052).
 *
 * Enforced in this process rather than by not drawing a row: the renderer can
 * ask for any path it likes, and a panel that merely declines to display one is
 * a decision the caller can walk around. Listing, reading, and writing each ask
 * separately, because each is a different way for the contents to leave.
 */
function refuseSecretPath(relativePath: string): void {
  if (isSecretPath(relativePath)) {
    throw new WorkspaceCommandError(SECRET_PATH_REFUSAL);
  }
  // `.git` is skipped when listing, which is not the same as being unreadable —
  // and in a linked worktree it is a *file* whose one line is the absolute path
  // of the repository it belongs to, which is the thing the path sanitizer
  // exists to keep off the screen.
  if (/(^|\/)\.git(\/|$)/.test(relativePath.replace(/\\/g, "/"))) {
    throw new WorkspaceCommandError("That is git's own bookkeeping, not the project.");
  }
}

/**
 * Where a path may point.
 *
 * Resolved through `realpath` so a symlink is judged by where it actually goes,
 * and compared with a separator so `/work/tree-elsewhere` cannot pass for being
 * inside `/work/tree`.
 */
function within(worktree: string, relativePath: string): string {
  const root = realOrSelf(worktree);
  const target = resolve(root, relativePath);
  const real = realOrSelf(target);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new WorkspaceCommandError("That path is not inside this workspace.");
  }
  return real;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function entryFor(worktree: string, absolute: string, isDirectory: boolean): WorkspaceEntry {
  const name = basename(absolute);
  return {
    path: relative(realOrSelf(worktree), absolute).split(sep).join("/"),
    name,
    kind: isDirectory ? "directory" : "file",
    extension: isDirectory ? "" : extname(name).replace(/^\./, "").toLowerCase().slice(0, 20)
  };
}

/**
 * One directory of the worktree, directories first and then files, each group
 * in case-insensitive name order — which is the order a person expects and not
 * the order the filesystem happens to return.
 */
export function listWorkspaceTree(worktree: string, relativePath = ""): WorkspaceEntry[] {
  refuseSecretPath(relativePath);
  const directory = within(worktree, relativePath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    throw new WorkspaceCommandError(`That folder could not be read: ${messageOf(error)}`);
  }

  const entries: WorkspaceEntry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    if (SKIP.has(name)) continue;
    const absolute = join(directory, name);
    // Judged on the path the reader would see, so a credential file is absent
    // from the listing rather than present and refused on opening — a name in a
    // tree is itself a disclosure about a project.
    if (isSecretPath(relative(realOrSelf(worktree), absolute).split(sep).join("/"))) continue;
    let isDirectory: boolean;
    try {
      // `lstat` deliberately not used: a symlink is shown as what it points at,
      // and `within` above is what stops it pointing outside.
      isDirectory = statSync(absolute).isDirectory();
    } catch {
      continue; // it went away between the listing and the question
    }
    entries.push(entryFor(worktree, absolute, isDirectory));
  }

  return entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

/** True when the head of a file has a NUL in it, which no text file does and
 *  every compiled artefact, image, and archive does. */
function looksBinary(body: Buffer): boolean {
  const head = body.subarray(0, SNIFF_BYTES);
  return head.includes(0);
}

/** One file, for showing. A directory, a file too large, and a file that is not
 *  text each come back saying so rather than as an error a pane has to guess at. */
export function readWorkspaceFile(worktree: string, relativePath: string): WorkspaceFile {
  refuseSecretPath(relativePath);
  const absolute = within(worktree, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    throw new WorkspaceCommandError(`That file could not be read: ${messageOf(error)}`);
  }
  if (stats.isDirectory()) {
    throw new WorkspaceCommandError("That is a folder, not a file.");
  }

  const path = relative(realOrSelf(worktree), absolute).split(sep).join("/");
  if (stats.size > MAX_FILE_BYTES) {
    return { path, text: null, binary: false, truncated: true, bytes: stats.size };
  }

  let body: Buffer;
  try {
    body = readFileSync(absolute);
  } catch (error) {
    throw new WorkspaceCommandError(`That file could not be read: ${messageOf(error)}`);
  }
  if (looksBinary(body)) {
    return { path, text: null, binary: true, truncated: false, bytes: stats.size };
  }
  return { path, text: body.toString("utf8"), binary: false, truncated: false, bytes: stats.size };
}

/**
 * Writes a file the person at this machine edited.
 *
 * Only over a file that is already there and already text: creating files and
 * replacing binaries are things a coding harness does under direction, with a
 * checkpoint behind it, and an editor pane is not that. The change lands in the
 * worktree like any other and is picked up by the next checkpoint (D-048).
 */
export function writeWorkspaceFile(worktree: string, relativePath: string, text: string): void {
  refuseSecretPath(relativePath);
  const absolute = within(worktree, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new WorkspaceCommandError("Novus edits a file that is already there; it does not create one.");
  }
  if (stats.isDirectory()) throw new WorkspaceCommandError("That is a folder, not a file.");
  // Size first, and as a refusal rather than as a reason to skip the sniff.
  // Gated behind the size test, the "text only" rule inverted exactly where it
  // mattered most: a file too large to *show* was still small enough to
  // truncate, so a database this pane would not open it would happily destroy.
  if (stats.size > MAX_FILE_BYTES) {
    throw new WorkspaceCommandError("That file is too large to edit here.");
  }
  if (looksBinary(readFileSync(absolute))) {
    throw new WorkspaceCommandError("That file is not text, so there is nothing here that could edit it.");
  }
  try {
    writeFileSync(absolute, text, "utf8");
  } catch (error) {
    throw new WorkspaceCommandError(`That file could not be saved: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong on this machine.";
}
