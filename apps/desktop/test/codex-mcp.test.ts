import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexMcpOverride } from "../electron/codex-mcp";

/**
 * The reviewed MCP world, translated for Codex (D-231): the composed file a
 * Claude turn mounts, read back as Codex's own `mcp_servers` table. The rule
 * under test everywhere: an override is returned ALWAYS — an empty table when
 * nothing was composed — because overriding wholesale is what keeps the
 * user's own ~/.codex/config.toml servers out of a Novus turn by construction.
 */

function composed(contents: object): { file: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "novus-codex-mcp-"));
  const file = join(dir, "mcp.json");
  writeFileSync(file, JSON.stringify(contents));
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the composed config, translated (D-231)", () => {
  it("a command server and a url server both cross, in Codex's own field names", () => {
    const { file, dispose } = composed({
      mcpServers: {
        playwright: { command: "npx", args: ["playwright-mcp"], env: { HEADLESS: "1" } },
        docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } }
      }
    });
    try {
      const override = codexMcpOverride(file);
      expect(override.config.mcp_servers).toEqual({
        playwright: { command: "npx", args: ["playwright-mcp"], env: { HEADLESS: "1" } },
        docs: { url: "https://docs.example/mcp", http_headers: { Authorization: "Bearer t" } }
      });
      expect(override.carried.sort()).toEqual(["docs", "playwright"]);
    } finally {
      dispose();
    }
  });

  it("the novus endpoint never crosses: its tool flows assume Claude's grammar", () => {
    const { file, dispose } = composed({
      mcpServers: {
        novus: { url: "http://127.0.0.1:9999/capture" },
        real: { command: "run-real" }
      }
    });
    try {
      const override = codexMcpOverride(file);
      expect(Object.keys(override.config.mcp_servers)).toEqual(["real"]);
      expect(override.carried).toEqual(["real"]);
    } finally {
      dispose();
    }
  });

  it("no composed file still overrides: the empty table, never the user's own", () => {
    expect(codexMcpOverride(null)).toEqual({ config: { mcp_servers: {} }, carried: [] });
  });

  it("a file that cannot be parsed degrades to no servers, never to a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-codex-mcp-bad-"));
    const file = join(dir, "mcp.json");
    writeFileSync(file, "{not json");
    try {
      expect(codexMcpOverride(file)).toEqual({ config: { mcp_servers: {} }, carried: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an entry with neither command nor url is dropped rather than guessed at", () => {
    const { file, dispose } = composed({ mcpServers: { broken: { env: { A: "1" } } } });
    try {
      expect(codexMcpOverride(file)).toEqual({ config: { mcp_servers: {} }, carried: [] });
    } finally {
      dispose();
    }
  });
});
