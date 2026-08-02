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

export async function resolveLocalBase(localId: string): Promise<{ ref: string; sha: string } | { error: string }> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) return { error: "This local repository lives on another machine." };
  try {
    const sha = await git(repoPath, ["rev-parse", "HEAD"]);
    const ref = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD");
    return { ref, sha };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not read the repository head." };
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
