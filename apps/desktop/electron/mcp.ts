import { createHash } from "node:crypto";
import type { ResolvedMachineMcp } from "./machine-mcp";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  MAX_MCP_SERVERS,
  McpServerSchema,
  SkillNameSchema,
  validMcpUrl,
  type EnabledMcpServer,
  type McpServer
} from "@novus/contracts";

/**
 * Project MCP servers (D-119): the worktree's own `.mcp.json`, governed the
 * way its skills are (D-118) — published for review, enabled by digest, and
 * handed to the harness only as a config Novus authors.
 *
 * The mechanism was probed against installed `claude 2.1.229`: `--mcp-config
 * <file>` with `--strict-mcp-config` under the pinned flags loads exactly the
 * named servers and nothing else — no user-level config, no worktree
 * `.mcp.json`, no plugin servers. So the worktree's file is never handed to
 * the CLI at all: discovery reads it into a bounded manifest, and composition
 * writes a fresh config containing only the person-approved entries,
 * reconstructed from the verified fields rather than copied from a file the
 * agent can rewrite mid-turn.
 *
 * The digest is over the **canonical entry** — name, transport, command,
 * args, env, url, with object keys sorted — so what a person approved is the
 * whole observable behavior of the server declaration, field for field.
 */

/** Where a worktree declares its servers; Claude Code's own project file. */
const MCP_FILE = ".mcp.json";
const MAX_MCP_FILE_BYTES = 100_000;

export interface ComposedMcp {
  /** The config file to hand `--mcp-config`, or null when nothing carried. */
  file: string | null;
  carried: string[];
  dropped: { name: string; reason: string }[];
  /** The machine's own servers this turn carries and could not (D-198). */
  machineCarried: string[];
  machineDropped: { name: string; reason: string }[];
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Stable JSON: object keys sorted, so the digest is layout-independent. */
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

export function mcpEntryDigest(entry: Omit<McpServer, "digest">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

/** One declared server, normalized from the file's own shape. Null when the
 *  entry could never be reviewable — then it is not listed, because nothing
 *  unlistable can ever be enabled (the D-118 rule). */
function normalizeEntry(name: string, raw: unknown): McpServer | null {
  if (!SkillNameSchema.safeParse(name).success) return null;
  // `novus` is the first-party capture endpoint's name (D-123). A project
  // declaration cannot claim it, so it is never listed and never enabled —
  // nothing in a repository can impersonate Novus's own surface.
  if (name === "novus") return null;
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const stated = typeof entry.type === "string" ? entry.type : entry.command !== undefined ? "stdio" : null;
  const type: "stdio" | "http" | "sse" | null =
    stated === "stdio" || stated === "http" || stated === "sse" ? stated : null;
  if (type === null) return null;
  const env: { name: string; value: string }[] = [];
  if (entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value === "string") env.push({ name: key, value });
    }
    env.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  const candidate = {
    name,
    transport: type,
    command: typeof entry.command === "string" ? entry.command : null,
    args: Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [],
    env,
    url: typeof entry.url === "string" ? entry.url : null
  };
  if (type !== "stdio" && (candidate.url === null || !validMcpUrl(candidate.url))) return null;
  const sealed = { ...candidate, digest: mcpEntryDigest(candidate) };
  return McpServerSchema.safeParse(sealed).success ? sealed : null;
}

/** Reads the worktree's `.mcp.json`, if it is a contained, bounded, regular
 *  file that parses; anything else reads as no declarations. */
function readDeclarations(worktreePath: string): Record<string, unknown> {
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return {};
  }
  let real: string;
  try {
    real = realpathSync(join(root, MCP_FILE));
  } catch {
    return {};
  }
  if (!inside(root, real)) return {};
  try {
    const stats = statSync(real);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_MCP_FILE_BYTES) return {};
    const parsed = JSON.parse(readFileSync(real, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
    return servers as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The manifest the runner publishes: every reviewable server, name order,
 *  bounded at MAX_MCP_SERVERS. */
export function discoverProjectMcp(worktreePath: string): McpServer[] {
  const declared = readDeclarations(worktreePath);
  const servers: McpServer[] = [];
  for (const name of Object.keys(declared).sort()) {
    if (servers.length >= MAX_MCP_SERVERS) break;
    const entry = normalizeEntry(name, declared[name]);
    if (entry !== null) servers.push(entry);
  }
  return servers;
}

/** The config entry the CLI reads, rebuilt from the verified fields only. */
function cliEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      ...(server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env.length > 0
        ? { env: Object.fromEntries(server.env.map((pair) => [pair.name, pair.value])) }
        : {})
    };
  }
  return { type: server.transport, url: server.url };
}

/** Novus's own first-party capture endpoint (D-123): a loopback HTTP MCP
 *  server inside the Electron main process, carried on every turn beside the
 *  person-enabled project servers. The token is the config's own header. */
export interface FirstPartyEndpoint {
  url: string;
  token: string;
}

/**
 * One turn's strict MCP config, composed from the pinned enabled list: each
 * entry re-derived from the worktree and admitted only when its canonical
 * digest still equals the approval's. The written file is Novus's, in
 * Novus's staging, containing exactly the approved entries — plus, when the
 * runner provides one, the `novus` first-party capture endpoint (D-123),
 * which is Novus's own surface rather than project code: its one tool is
 * routed as every MCP tool is, a person's question under every profile short
 * of `dont_ask`, and its handler additionally demands the routed approval's
 * own grant. It never appears in `carried`, which reports project servers.
 */
export function composeMcpConfig(
  worktreePath: string,
  enabled: readonly EnabledMcpServer[],
  configPath: string,
  firstParty: FirstPartyEndpoint | null = null,
  machine: ResolvedMachineMcp = { carried: [], dropped: [] }
): ComposedMcp {
  if (enabled.length === 0 && firstParty === null && machine.carried.length === 0) {
    return { file: null, carried: [], dropped: [], machineCarried: [], machineDropped: machine.dropped };
  }
  const declared = readDeclarations(worktreePath);
  const carried: McpServer[] = [];
  const dropped: { name: string; reason: string }[] = [];
  for (const entry of enabled.slice(0, MAX_MCP_SERVERS)) {
    if (!SkillNameSchema.safeParse(entry.name).success) {
      dropped.push({ name: entry.name.slice(0, 80), reason: "not a name this runner will resolve" });
      continue;
    }
    const raw = declared[entry.name];
    if (raw === undefined) {
      dropped.push({ name: entry.name, reason: "no longer in the project" });
      continue;
    }
    const server = normalizeEntry(entry.name, raw);
    if (server === null) {
      dropped.push({ name: entry.name, reason: "no longer a reviewable declaration" });
      continue;
    }
    if (server.digest !== entry.digest) {
      dropped.push({ name: entry.name, reason: "changed since it was enabled" });
      continue;
    }
    carried.push(server);
  }
  if (carried.length === 0 && firstParty === null && machine.carried.length === 0) {
    return { file: null, carried: [], dropped, machineCarried: [], machineDropped: machine.dropped };
  }

  const servers: Record<string, Record<string, unknown>> = Object.fromEntries(
    carried.map((server) => [server.name, cliEntry(server)])
  );
  // The machine's own enabled servers (D-198) join the same strict config —
  // resolved from the machine's own file by machine-mcp.ts, values never
  // having crossed the wire. A name the project already holds is the
  // project's: the reviewed repo declaration wins, and the collision is a
  // stated drop rather than a silent shadowing.
  const machineCarried: string[] = [];
  const machineDropped = [...machine.dropped];
  for (const { name, entry } of machine.carried) {
    if (servers[name] !== undefined || name === "novus") {
      machineDropped.push({ name, reason: "a project server already uses this name" });
      continue;
    }
    servers[name] = entry;
    machineCarried.push(name);
  }
  if (firstParty !== null) {
    // The name is reserved at discovery, so nothing person-enabled can be
    // standing here under it.
    servers.novus = {
      type: "http",
      url: firstParty.url,
      headers: { Authorization: `Bearer ${firstParty.token}` }
    };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return {
    file: configPath,
    carried: carried.map((server) => server.name),
    dropped,
    machineCarried,
    machineDropped
  };
}

/** Removes a turn's composed config; staging outlives nothing. */
export function removeComposedMcp(configPath: string): void {
  rmSync(configPath, { force: true });
}
