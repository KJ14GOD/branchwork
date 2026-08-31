import { readFileSync } from "node:fs";

/**
 * The reviewed MCP world, translated for Codex (D-231). Claude turns get a
 * composed config file — the whole D-119/D-198 road: worktree re-derivation,
 * digest checks, drops by name — and a Codex turn now gets the SAME reviewed
 * servers, read back out of that composed file and translated into Codex's
 * own `mcp_servers` table, passed as the thread's `config` override.
 *
 * The override is returned **always** — an empty table when nothing was
 * composed — because passing it is what closes D-230's named gap: with
 * `mcp_servers` overridden wholesale, the user's own `~/.codex/config.toml`
 * servers never reach a Novus turn ungoverned, by construction.
 *
 * The `novus` first-party endpoint is deliberately excluded: its tool flows
 * assume Claude's approval grammar (D-231 names the crossing as a revisit).
 */

interface ComposedConfigFile {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    }
  >;
}

export interface CodexMcpOverride {
  config: { mcp_servers: Record<string, Record<string, unknown>> };
  /** The reviewed servers actually translated, for the execution record. */
  carried: string[];
}

export function codexMcpOverride(composedFile: string | null): CodexMcpOverride {
  const servers: Record<string, Record<string, unknown>> = {};
  const carried: string[] = [];
  if (composedFile !== null) {
    let parsed: ComposedConfigFile;
    try {
      parsed = JSON.parse(readFileSync(composedFile, "utf8")) as ComposedConfigFile;
    } catch {
      // A composed file Novus itself just wrote failing to parse is a bug,
      // but the honest degradation is "no servers", never "the user's file".
      return { config: { mcp_servers: {} }, carried: [] };
    }
    for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
      if (name === "novus") continue; // Claude-only, stated in D-231
      if (typeof entry.command === "string" && entry.command.length > 0) {
        servers[name] = {
          command: entry.command,
          ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
          ...(entry.env && typeof entry.env === "object" ? { env: entry.env } : {})
        };
        carried.push(name);
      } else if (typeof entry.url === "string" && entry.url.length > 0) {
        servers[name] = {
          url: entry.url,
          ...(entry.headers && typeof entry.headers === "object" ? { http_headers: entry.headers } : {})
        };
        carried.push(name);
      }
    }
  }
  return { config: { mcp_servers: servers }, carried };
}
