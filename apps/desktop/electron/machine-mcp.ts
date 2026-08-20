import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MachineMcpNameSchema,
  MachineMcpServerSchema,
  MAX_MACHINE_MCP_SERVERS,
  type EnabledMachineMcpServer,
  type MachineMcpServer
} from "@novus/contracts";

/**
 * Machine MCP servers (D-198): the operator's own user-level servers
 * (`claude mcp add -s user`, kept in the CLI's `~/.claude.json`), carried the
 * D-186 way at D-119's tier.
 *
 * Two halves, with one privacy rule across both (D-041):
 *
 *  - **discover** reads the machine's own file and publishes a *redacted*
 *    review summary: the command line with secretish flag values masked, the
 *    url, and env variable NAMES — never values. The digest is computed over
 *    the full local declaration, values included, so the approval still pins
 *    exact content while the content itself never crosses the wire.
 *  - **resolve** takes the enabled list at spawn, re-reads the same local
 *    file, verifies each digest, and returns the full entries — values and
 *    all — for the composed config, which is written on this machine and
 *    removed with the turn. The verified bytes are the written bytes, and a
 *    secret's whole journey is file-to-file on the owner's own disk.
 *
 * What is deliberately not here: the claude.ai account connectors ("claude.ai
 * Gmail" and friends). Those live in no local file — the CLI injects them
 * from its own signed-in account state, and `--strict-mcp-config` excludes
 * them. A thing the runner cannot read is a thing nobody can review, so it is
 * not listed rather than half-trusted (the D-118 rule, again).
 */

const MAX_FILE_BYTES = 1_000_000;

/** Flags whose following value is masked in the published summary. The digest
 *  is over the unmasked declaration, so masking costs review nothing but the
 *  secret. */
const SECRETISH_FLAG = /token|key|secret|password|credential|auth/i;
const MASK = "•••";

/** The CLI's user config file: `~/.claude.json`, or inside CLAUDE_CONFIG_DIR
 *  when the operator moved it — the same resolution the CLI performs. */
export function machineMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir && configDir.length > 0 ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

/** Stable JSON — object keys sorted — so the digest is layout-independent. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

interface FullEntry {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  digest: string;
}

function readUserServers(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = machineMcpConfigPath(env);
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    const servers = parsed.mcpServers;
    return servers !== null && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One user-level entry, normalized with its digest over the FULL local
 *  declaration. Null when it could never be reviewable — then it is not
 *  listed, because nothing unlistable can ever be enabled. */
function normalizeFull(name: string, raw: unknown): FullEntry | null {
  if (!MachineMcpNameSchema.safeParse(name).success) return null;
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const stated =
    typeof entry.type === "string" ? entry.type : entry.command !== undefined ? "stdio" : null;
  const type: "stdio" | "http" | "sse" | null =
    stated === "stdio" || stated === "http" || stated === "sse" ? stated : null;
  if (type === null) return null;
  const envVars: Record<string, string> = {};
  if (entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value === "string") envVars[key] = value;
    }
  }
  const full: Omit<FullEntry, "digest"> = {
    name,
    transport: type,
    command: typeof entry.command === "string" ? entry.command : null,
    args: Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [],
    env: envVars,
    url: typeof entry.url === "string" ? entry.url : null
  };
  if (type === "stdio" && full.command === null) return null;
  const sealed = { ...full, digest: createHash("sha256").update(canonical(full)).digest("hex") };
  // Validity is judged on the redacted projection, which is what the wire and
  // the reviewer will hold — a server whose summary the contract refuses (a
  // plaintext remote, a credentialed url) is not listed at all.
  return MachineMcpServerSchema.safeParse(redact(sealed)).success ? sealed : null;
}

/** The published projection: env names only, secretish flag values masked. */
function redact(full: FullEntry): MachineMcpServer {
  const args = full.args.map((arg, index) => {
    const previous = full.args[index - 1];
    return previous !== undefined && previous.startsWith("-") && SECRETISH_FLAG.test(previous)
      ? MASK
      : arg;
  });
  return {
    name: full.name,
    transport: full.transport,
    command: full.command,
    args,
    envNames: Object.keys(full.env).sort(),
    url: full.url,
    digest: full.digest
  };
}

/** The manifest the runner publishes: every reviewable user-level server, in
 *  name order, bounded — redacted for the wire, digested over the truth. */
export function discoverMachineMcp(env: NodeJS.ProcessEnv = process.env): MachineMcpServer[] {
  const declared = readUserServers(env);
  const servers: MachineMcpServer[] = [];
  for (const name of Object.keys(declared).sort()) {
    if (servers.length >= MAX_MACHINE_MCP_SERVERS) break;
    const full = normalizeFull(name, declared[name]);
    if (full === null) continue;
    servers.push(redact(full));
  }
  return servers;
}

export interface ResolvedMachineMcp {
  /** Full CLI entries for the composed config — values included, because the
   *  config is written on this same machine and removed with the turn. */
  carried: { name: string; entry: Record<string, unknown>; digest: string }[];
  dropped: { name: string; reason: string }[];
}

/** The enabled machine servers at spawn: re-read locally, digest-verified,
 *  full values returned for the config this machine writes to itself. */
export function resolveMachineMcp(
  enabled: readonly EnabledMachineMcpServer[],
  env: NodeJS.ProcessEnv = process.env
): ResolvedMachineMcp {
  if (enabled.length === 0) return { carried: [], dropped: [] };
  const declared = readUserServers(env);
  const carried: ResolvedMachineMcp["carried"] = [];
  const dropped: { name: string; reason: string }[] = [];
  for (const entry of enabled.slice(0, MAX_MACHINE_MCP_SERVERS)) {
    if (!MachineMcpNameSchema.safeParse(entry.name).success) {
      dropped.push({ name: entry.name.slice(0, 80), reason: "not a name this runner will resolve" });
      continue;
    }
    const raw = declared[entry.name];
    if (raw === undefined) {
      dropped.push({ name: entry.name, reason: "no longer on this machine" });
      continue;
    }
    const full = normalizeFull(entry.name, raw);
    if (full === null) {
      dropped.push({ name: entry.name, reason: "no longer a reviewable declaration" });
      continue;
    }
    if (full.digest !== entry.digest) {
      dropped.push({ name: entry.name, reason: "changed since it was enabled" });
      continue;
    }
    const cli: Record<string, unknown> =
      full.transport === "stdio"
        ? {
            type: "stdio",
            command: full.command,
            ...(full.args.length > 0 ? { args: full.args } : {}),
            ...(Object.keys(full.env).length > 0 ? { env: full.env } : {})
          }
        : { type: full.transport, url: full.url };
    carried.push({ name: full.name, entry: cli, digest: full.digest });
  }
  return { carried, dropped };
}
