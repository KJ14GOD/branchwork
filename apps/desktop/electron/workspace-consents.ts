import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PreparedFile } from "@novus/contracts";

/**
 * Local-file consents, remembered per repository (D-041): when a person
 * confirms copying a Git-ignored file into a worktree, the *path* is recorded
 * here so a lane forked later on this machine can start with the same files
 * without asking again. Paths only, never contents — and only paths that were
 * actually copied, because a refused path is a question the next worktree must
 * not answer on this person's behalf. Applying a remembered path re-runs every
 * per-file validation, so a file that stopped being ignored is refused then.
 *
 * The store is machine-local JSON in Electron userData, exactly like
 * `local-repos.ts`; the caller supplies the path because this module must stay
 * importable without Electron.
 */

interface ConsentMap {
  [providerRepoId: string]: string[]; // relative paths, oldest consent first
}

/** Matches the most `prepareLocalFiles` accepts in one request; older consents
 *  are evicted first. */
export const MAX_CONSENTED_PATHS = 50;

/** An unreadable or malformed store is an empty one: losing a remembered
 *  convenience is strictly better than refusing to fork. */
export function loadFileConsents(storePath: string): ConsentMap {
  let parsed: unknown;
  try {
    if (!existsSync(storePath)) return {};
    parsed = JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: ConsentMap = {};
  for (const [repoId, paths] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(paths)) continue;
    map[repoId] = paths.filter((path): path is string => typeof path === "string" && path.length > 0);
  }
  return map;
}

/**
 * Records the paths that actually landed. A path recorded again moves to the
 * newest position, so the bound evicts what was consented longest ago rather
 * than what is still in use.
 */
export function recordFileConsents(
  storePath: string,
  providerRepoId: string,
  prepared: readonly PreparedFile[]
): void {
  const copied = prepared.filter((file) => file.copied).map((file) => file.path);
  if (copied.length === 0) return;
  const map = loadFileConsents(storePath);
  const existing = map[providerRepoId] ?? [];
  const merged = [
    ...existing.filter((path) => !copied.includes(path)),
    ...[...new Set(copied)]
  ].slice(-MAX_CONSENTED_PATHS);
  if (merged.length === existing.length && merged.every((path, index) => path === existing[index])) {
    return;
  }
  map[providerRepoId] = merged;
  // 0600 like every other machine-local store: paths can name what a project
  // keeps secret (.env), even though values never land here.
  writeFileSync(storePath, JSON.stringify(map, null, 2), { mode: 0o600 });
}

export function consentedFilePaths(storePath: string, providerRepoId: string): string[] {
  return loadFileConsents(storePath)[providerRepoId] ?? [];
}
