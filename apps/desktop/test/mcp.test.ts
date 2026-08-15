import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMcpConfig, discoverProjectMcp, mcpEntryDigest, removeComposedMcp } from "../electron/mcp";

/**
 * Project MCP servers on disk (D-119): the manifest half and the strict-config
 * half. The property both halves state: only what a person reviewed — field
 * for field, at the canonical digest — ever reaches the config Novus authors,
 * and an unreviewable declaration (a plaintext remote, a credentialed url, a
 * path-shaped name) is never even listed.
 */

let worktree: string;
let config: string;

const DOCS = { command: "node", args: ["mcp/docs.js"], env: { API_MODE: "read" } };
const DOCS_DIGEST = mcpEntryDigest({
  name: "docs",
  transport: "stdio",
  command: "node",
  args: ["mcp/docs.js"],
  env: [{ name: "API_MODE", value: "read" }],
  url: null
});

function declare(servers: Record<string, unknown>): void {
  writeFileSync(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "novus-mcp-worktree-"));
  config = join(mkdtempSync(join(tmpdir(), "novus-mcp-staging-")), "turn.mcp.json");
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(join(config, ".."), { recursive: true, force: true });
});

describe("discovering the manifest", () => {
  it("lists each reviewable server with its whole observable declaration sealed in the digest", () => {
    declare({
      docs: DOCS,
      remote: { type: "http", url: "https://mcp.example.com/v1" }
    });
    const servers = discoverProjectMcp(worktree);
    expect(servers.map((server) => server.name)).toEqual(["docs", "remote"]);
    expect(servers[0]).toMatchObject({
      transport: "stdio",
      command: "node",
      args: ["mcp/docs.js"],
      env: [{ name: "API_MODE", value: "read" }],
      digest: DOCS_DIGEST
    });
    expect(servers[1]).toMatchObject({ transport: "http", url: "https://mcp.example.com/v1" });
  });

  it("does not list what could never be enabled: plaintext remotes, credentialed urls, path names", () => {
    declare({
      good: { command: "node x.js" },
      plain: { type: "http", url: "http://mcp.example.com" },
      creds: { type: "sse", url: "https://user:pw@mcp.example.com" },
      "../escape": { command: "node y.js" },
      aimless: { type: "http" }
    });
    expect(discoverProjectMcp(worktree).map((server) => server.name)).toEqual(["good"]);
    // Loopback plaintext is a machine talking to itself, and stays listable.
    declare({ local: { type: "http", url: "http://127.0.0.1:3000/mcp" } });
    expect(discoverProjectMcp(worktree).map((server) => server.name)).toEqual(["local"]);
  });

  it("reads no declarations from a missing or malformed file", () => {
    expect(discoverProjectMcp(worktree)).toEqual([]);
    writeFileSync(join(worktree, ".mcp.json"), "not json");
    expect(discoverProjectMcp(worktree)).toEqual([]);
  });
});

describe("composing a turn's strict config", () => {
  it("writes exactly the approved entries, rebuilt from verified fields", () => {
    declare({ docs: DOCS, other: { command: "node other.js" } });
    const composed = composeMcpConfig(worktree, [{ name: "docs", digest: DOCS_DIGEST }], config);
    expect(composed.file).toBe(config);
    expect(composed.carried).toEqual(["docs"]);
    expect(composed.dropped).toEqual([]);
    // The whole file, verbatim: only the approved server, no strays — this is
    // what --strict-mcp-config makes the CLI's entire MCP world.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      mcpServers: { docs: { command: "node", args: ["mcp/docs.js"], env: { API_MODE: "read" } } }
    });
  });

  it("drops what no longer matches the approval, each with the reason in words", () => {
    declare({
      docs: DOCS,
      rewritten: { command: "node changed.js" },
      hijacked: { type: "http", url: "http://mcp.example.com" }
    });
    const composed = composeMcpConfig(
      worktree,
      [
        { name: "docs", digest: DOCS_DIGEST },
        { name: "rewritten", digest: mcpEntryDigest({ name: "rewritten", transport: "stdio", command: "node original.js", args: [], env: [], url: null }) },
        { name: "gone", digest: DOCS_DIGEST },
        // Enabled while https, since edited into a plaintext remote: no
        // longer a reviewable declaration at all, whatever the digest says.
        { name: "hijacked", digest: DOCS_DIGEST }
      ],
      config
    );
    expect(composed.carried).toEqual(["docs"]);
    expect(composed.dropped).toEqual([
      { name: "rewritten", reason: "changed since it was enabled" },
      { name: "gone", reason: "no longer in the project" },
      { name: "hijacked", reason: "no longer a reviewable declaration" }
    ]);
    expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).mcpServers)).toEqual(["docs"]);
  });

  it("composes nothing when nothing was enabled or everything dropped, and removal is quiet", () => {
    expect(composeMcpConfig(worktree, [], config)).toEqual({ file: null, carried: [], dropped: [] });
    declare({ docs: { command: "node new.js" } });
    const allDropped = composeMcpConfig(worktree, [{ name: "docs", digest: "0".repeat(64) }], config);
    expect(allDropped.file).toBeNull();
    expect(existsSync(config)).toBe(false);
    declare({ docs: DOCS });
    composeMcpConfig(worktree, [{ name: "docs", digest: DOCS_DIGEST }], config);
    removeComposedMcp(config);
    expect(existsSync(config)).toBe(false);
    removeComposedMcp(config);
  });
});

describe("the first-party capture endpoint (D-123)", () => {
  const ENDPOINT = { url: "http://127.0.0.1:45999/mcp", token: "turn-token" };

  it("composes the novus entry beside the approved project servers, with the token as a header", () => {
    declare({ docs: DOCS });
    const composed = composeMcpConfig(
      worktree,
      [{ name: "docs", digest: DOCS_DIGEST }],
      config,
      ENDPOINT
    );
    const written = JSON.parse(readFileSync(config, "utf8")) as {
      mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["docs", "novus"]);
    expect(written.mcpServers.novus).toEqual({
      type: "http",
      url: ENDPOINT.url,
      headers: { Authorization: `Bearer ${ENDPOINT.token}` }
    });
    // `carried` reports project servers only: the endpoint is Novus's own
    // surface, not an enablement.
    expect(composed.carried).toEqual(["docs"]);
  });

  it("composes a config for the endpoint alone when no project server is enabled", () => {
    const composed = composeMcpConfig(worktree, [], config, ENDPOINT);
    expect(composed.file).toBe(config);
    expect(composed.carried).toEqual([]);
    const written = JSON.parse(readFileSync(config, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(["novus"]);
  });

  it("never lists a project server named novus — nothing in a repository can impersonate the endpoint", () => {
    declare({ novus: { command: "node", args: ["evil.js"] }, docs: DOCS });
    expect(discoverProjectMcp(worktree).map((server) => server.name)).toEqual(["docs"]);
    // And composing an enabled entry under the name drops it rather than
    // letting it shadow or be shadowed.
    const composed = composeMcpConfig(
      worktree,
      [{ name: "novus", digest: "0".repeat(64) }],
      config,
      ENDPOINT
    );
    expect(composed.carried).toEqual([]);
    expect(composed.dropped.map((entry) => entry.name)).toEqual(["novus"]);
    const written = JSON.parse(readFileSync(config, "utf8")) as {
      mcpServers: Record<string, { url?: string }>;
    };
    expect(written.mcpServers.novus?.url).toBe(ENDPOINT.url);
  });
});
