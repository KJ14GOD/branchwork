import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConnectorNameSchema,
  MAX_CONNECTORS,
  type Connector,
  type ConnectorName
} from "@novus/contracts";

/**
 * Lent accounts (D-217): the CLI's own claude.ai account connectors — Gmail,
 * Calendar, Drive — which live in no file a runner can read (the CLI injects
 * them from the signed-in account). D-198 stated them uncarryable; D-217
 * measured the road and reversed it for exactly the turns a person LENDS an
 * account to.
 *
 * Two facts, two files, both machine-local:
 *
 *  - **the present connectors** are enumerated by `claude mcp list`, whose
 *    output names each with its url and connection state. That call
 *    health-checks over the network, so its result is *cached* to disk by
 *    discovery (the onboarding page, the settings page) and never read on
 *    the spawn path — a turn must not wait seconds on a health check.
 *  - **the lend preferences** are the person's own On/Off per connector,
 *    written when they choose and defaulting to off. Nothing is lent that
 *    the person did not lend, and lending is the person's standing choice on
 *    their own machine — not a mission's Admin's (D-217).
 *
 * A machine server the person added with `claude mcp add -s user` (e.g.
 * `notion`) is NOT an account connector — it lives in a readable file and
 * rides D-198's road. Only names the CLI spells `claude.ai {service}` are
 * connectors here.
 */

/** The person's own On/Off per connector, machine-local. */
const PREFS_FILE = "connectors.json";
/** The last enumeration of present connectors, so the spawn path never runs
 *  a network health check. */
const CACHE_FILE = "connectors-cache.json";

type Prefs = Record<string, boolean>;
type Cache = { name: string; url: string | null; state: Connector["state"] }[];

function prefsPath(userDataPath: string): string {
  return join(userDataPath, PREFS_FILE);
}
function cachePath(userDataPath: string): string {
  return join(userDataPath, CACHE_FILE);
}

function readPrefs(userDataPath: string): Prefs {
  try {
    const raw = JSON.parse(readFileSync(prefsPath(userDataPath), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object") return {};
    const prefs: Prefs = {};
    for (const [name, lent] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof lent === "boolean" && ConnectorNameSchema.safeParse(name).success) prefs[name] = lent;
    }
    return prefs;
  } catch {
    return {};
  }
}

function readCache(userDataPath: string): Cache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(userDataPath), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: Cache = [];
    for (const row of raw) {
      if (row === null || typeof row !== "object") continue;
      const name = (row as { name?: unknown }).name;
      if (typeof name !== "string" || !ConnectorNameSchema.safeParse(name).success) continue;
      const url = (row as { url?: unknown }).url;
      const state = (row as { state?: unknown }).state;
      out.push({
        name,
        url: typeof url === "string" ? url : null,
        state:
          state === "connected" || state === "needs_auth" || state === "failed" ? state : "unknown"
      });
    }
    return out.slice(0, MAX_CONNECTORS);
  } catch {
    return [];
  }
}

/** Where the CLI binary is likely to be, matching the harness probe (D-029).
 *  Computed per call, never at module load (D-222 amended twice): startup
 *  folds the login shell's PATH in after modules import, so a load-time
 *  snapshot would freeze the bare Finder PATH. */
const probePath = (): string =>
  [process.env.PATH ?? "", join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");

/** One `claude mcp list` line: `{name}: {url}[ (T)] - {glyph} {status}`. The
 *  name is everything before the first `: ` — a service name can hold spaces
 *  (`claude.ai Google Drive`) but never a colon-space. */
function parseListLine(line: string): { name: string; url: string | null; state: Connector["state"] } | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const at = clean.indexOf(": ");
  if (at <= 0) return null;
  const name = clean.slice(0, at);
  if (!ConnectorNameSchema.safeParse(name).success) return null;
  const rest = clean.slice(at + 2);
  const urlMatch = rest.match(/^(https?:\/\/[^\s(]+)/);
  const url = urlMatch ? urlMatch[1] ?? null : null;
  const status = rest.toLowerCase();
  const state: Connector["state"] = /connected/.test(status)
    ? "connected"
    : /auth/.test(status)
      ? "needs_auth"
      : /fail|error/.test(status)
        ? "failed"
        : "unknown";
  return { name, url, state };
}

/** A fake connector list for e2e (D-217): `NOVUS_FAKE_CONNECTORS` is a JSON
 *  array of `{name,url?,state?}`, so a real window can drive the lend flow
 *  without this machine's own account. Ignored unless set. */
function fakeConnectors(env: NodeJS.ProcessEnv): Cache | null {
  const raw = env.NOVUS_FAKE_CONNECTORS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: Cache = [];
    for (const row of parsed) {
      const name = (row as { name?: unknown })?.name;
      if (typeof name !== "string" || !ConnectorNameSchema.safeParse(name).success) continue;
      const url = (row as { url?: unknown })?.url;
      const state = (row as { state?: unknown })?.state;
      out.push({
        name,
        url: typeof url === "string" ? url : null,
        state:
          state === "connected" || state === "needs_auth" || state === "failed" ? state : "connected"
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Enumerate the machine's account connectors by asking the CLI, then cache
 *  the result for the spawn path. Best-effort: any failure returns an empty
 *  list rather than throwing, and `installed: false` says the CLI is absent
 *  so the page can say so. */
export function discoverConnectors(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ installed: boolean; connectors: Connector[] }> {
  const fake = fakeConnectors(env);
  if (fake !== null) {
    writeFileSync(cachePath(userDataPath), JSON.stringify(fake));
    return Promise.resolve({ installed: true, connectors: withLent(fake, readPrefs(userDataPath)) });
  }
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["mcp", "list"],
      { timeout: 12_000, env: { ...env, PATH: probePath() } },
      (error, stdout) => {
        if (error && !stdout) return resolve({ installed: false, connectors: [] });
        const present: Cache = [];
        for (const line of stdout.split("\n")) {
          const parsed = parseListLine(line);
          if (parsed && present.length < MAX_CONNECTORS) present.push(parsed);
        }
        try {
          writeFileSync(cachePath(userDataPath), JSON.stringify(present));
        } catch {
          /* a cache we could not write just means the spawn path reads a
             staler one — never a reason to fail discovery */
        }
        resolve({ installed: true, connectors: withLent(present, readPrefs(userDataPath)) });
      }
    );
  });
}

function withLent(present: Cache, prefs: Prefs): Connector[] {
  return present.map((row) => ({ ...row, lent: prefs[row.name] === true }));
}

/** Record whether a connector is lent, machine-locally, and return the view
 *  the page rerenders from. */
export function setConnectorLent(
  userDataPath: string,
  name: ConnectorName,
  lent: boolean
): { installed: boolean; connectors: Connector[] } {
  const prefs = readPrefs(userDataPath);
  prefs[name] = lent;
  writeFileSync(prefsPath(userDataPath), JSON.stringify(prefs));
  const cache = readCache(userDataPath);
  return { installed: cache.length > 0, connectors: withLent(cache, prefs) };
}

/** What a turn carries and what it hides (D-217), resolved from the two
 *  machine-local files with no network call:
 *   - `lent`   — connectors the person lent that are still present, so strict
 *                is dropped for them and their tools reach the room.
 *   - `denied` — connectors present but not lent, stripped from the model's
 *                tool list with `--disallowedTools`.
 *  An empty `lent` keeps the argv byte-for-byte what D-119 pinned. */
export function resolveConnectors(userDataPath: string): {
  lent: ConnectorName[];
  denied: ConnectorName[];
} {
  const prefs = readPrefs(userDataPath);
  const present = readCache(userDataPath).map((row) => row.name);
  const lent: ConnectorName[] = [];
  const denied: ConnectorName[] = [];
  for (const name of present) {
    if (prefs[name] === true) lent.push(name as ConnectorName);
    else denied.push(name as ConnectorName);
  }
  return { lent, denied };
}
