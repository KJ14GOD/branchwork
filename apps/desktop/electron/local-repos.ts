import { app, dialog } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Local repositories (D-032): all git runs here, in the desktop main process.
 * The control plane sees only a stable id, a display name, branches, and SHAs
 * — folder paths never leave this machine. This module is the local-runner
 * precursor: everything it tells the server is a reported claim.
 */

interface LocalRepoMap {
  [localId: string]: string; // localId -> absolute path
}

function mapPath(): string {
  return join(app.getPath("userData"), "local-repos.json");
}

function loadMap(): LocalRepoMap {
  try {
    return existsSync(mapPath()) ? (JSON.parse(readFileSync(mapPath(), "utf8")) as LocalRepoMap) : {};
  } catch {
    return {};
  }
}

function saveMap(map: LocalRepoMap): void {
  writeFileSync(mapPath(), JSON.stringify(map, null, 2), { mode: 0o600 });
}

export function pathForLocalRepo(localId: string): string | null {
  return loadMap()[localId] ?? null;
}

/** Every repository this machine holds a checkout for, whichever provider it
 *  came from. A folder the user picked and a repository the runner fetched are
 *  the same entry, which is the whole point (D-025, D-032). */
export function repositoriesOnThisMachine(): string[] {
  return Object.keys(loadMap());
}

/**
 * Records a checkout Novus made itself — a GitHub repository the runner
 * fetched (D-025, D-032) — in the same machine-local map a folder the user
 * picked lives in, keyed by the provider's repository id. From here on nothing
 * downstream can tell the two apart: same lookup, same worktrees, same runtime.
 * The path still never leaves this machine.
 */
export function recordRepositoryPath(providerRepoId: string, repoPath: string): void {
  const map = loadMap();
  if (map[providerRepoId] === repoPath) return;
  map[providerRepoId] = repoPath;
  saveMap(map);
}

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, ...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

export interface PickedLocalRepo {
  localId: string;
  name: string;
  defaultBranch: string;
  headSha: string;
}

/** Folder picker → validated git repo → stable local identity. */
export async function pickLocalRepository(): Promise<PickedLocalRepo | { cancelled: true } | { error: string }> {
  const result = await dialog.showOpenDialog({
    title: "Add a local repository",
    properties: ["openDirectory"],
    buttonLabel: "Add repository"
  });
  const repoPath = result.filePaths[0];
  if (result.canceled || !repoPath) return { cancelled: true };

  try {
    const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { error: "That folder isn't a git repository." };
    const headSha = await git(repoPath, ["rev-parse", "HEAD"]);
    const branch = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]).catch(() => "main");

    const map = loadMap();
    const existing = Object.entries(map).find(([, mapped]) => mapped === repoPath)?.[0];
    const localId = existing ?? randomUUID();
    map[localId] = repoPath;
    saveMap(map);

    return { localId, name: basename(repoPath), defaultBranch: branch, headSha };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not read that repository." };
  }
}

export async function resolveLocalBase(
  localId: string,
  ref?: string
): Promise<{ ref: string; sha: string } | { error: string }> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) return { error: "This local repository lives on another machine." };
  try {
    if (ref !== undefined) {
      // A chosen base (D-139): resolve exactly the named branch, and refuse
      // in words when it does not exist rather than falling back silently.
      const sha = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${ref}`]).catch(() => null);
      if (sha === null) return { error: `No branch named ${ref} in this repository.` };
      return { ref, sha };
    }
    const sha = await git(repoPath, ["rev-parse", "HEAD"]);
    const head = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD");
    return { ref: head, sha };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not read the repository head." };
  }
}

/** The repository's branches for the base picker (D-139): default first,
 *  then by name, straight from this machine's own git. */
export async function listLocalBranches(
  localId: string
): Promise<{ name: string; sha: string; isDefault: boolean }[] | { error: string }> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) return { error: "This local repository lives on another machine." };
  try {
    const head = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]).catch(() => null);
    const raw = await git(repoPath, [
      "for-each-ref",
      "refs/heads",
      "--format=%(refname:short) %(objectname)"
    ]);
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const space = line.lastIndexOf(" ");
        return { name: line.slice(0, space), sha: line.slice(space + 1), isDefault: line.slice(0, space) === head };
      });
    rows.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name)));
    return rows;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not list branches." };
  }
}

/** Where a local mission's pinned base stands (D-139), by this machine's own
 *  git: current, moved (with the commit count), rewritten, or missing. */
export async function localBaseStatus(
  localId: string,
  ref: string,
  pinnedSha: string
): Promise<
  { state: "current" | "moved" | "rewritten" | "missing"; aheadBy: number | null; checkedAt: string } | { error: string }
> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) return { error: "This local repository lives on another machine." };
  const checkedAt = new Date().toISOString();
  try {
    const tip = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${ref}`]).catch(() => null);
    if (tip === null) return { state: "missing", aheadBy: null, checkedAt };
    if (tip === pinnedSha) return { state: "current", aheadBy: null, checkedAt };
    const ancestor = await git(repoPath, ["merge-base", "--is-ancestor", pinnedSha, tip])
      .then(() => true)
      .catch(() => false);
    if (!ancestor) return { state: "rewritten", aheadBy: null, checkedAt };
    const count = await git(repoPath, ["rev-list", "--count", `${pinnedSha}..${tip}`]).catch(() => null);
    return { state: "moved", aheadBy: count === null ? null : Number(count), checkedAt };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not check the base." };
  }
}

/**
 * Creates the mission branch as a plain ref — never switches the working
 * tree. Idempotent: an existing branch at the same SHA is success; at a
 * different SHA it is a conflict.
 */
export async function ensureLocalBranch(
  localId: string,
  branch: string,
  fromSha: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) return { ok: false, error: "This local repository lives on another machine." };
  try {
    const existing = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => null);
    if (existing !== null) {
      if (existing === fromSha) return { ok: true };
      return { ok: false, error: `Branch ${branch} already exists at a different commit.` };
    }
    await git(repoPath, ["branch", branch, fromSha]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Branch creation failed." };
  }
}
