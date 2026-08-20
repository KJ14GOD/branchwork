import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMachineMcp, resolveMachineMcp } from "../electron/machine-mcp";

/**
 * Machine MCP servers (D-198), against a real config file.
 *
 * The property under test twice over is the privacy rule (D-041): what the
 * wire carries is reviewable and never secret — env variable names, masked
 * secretish flag values — while the digest pins the full local declaration,
 * and resolution returns the full values only on the machine that already
 * holds them.
 */

let configDir: string;

const env = () => ({ CLAUDE_CONFIG_DIR: configDir }) as NodeJS.ProcessEnv;

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "novus-machine-mcp-"));
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("publishing the machine's servers", () => {
  it("lists a stdio server with env NAMES only, and masks a secretish flag's value", () => {
    writeConfig({
      linear: {
        command: "npx",
        args: ["-y", "linear-mcp", "--api-key", "lin_live_verySecret123"],
        env: { LINEAR_TOKEN: "tok_alsoSecret", LINEAR_ORG: "novus" }
      }
    });
    const published = discoverMachineMcp(env());
    expect(published).toHaveLength(1);
    const server = published[0]!;
    expect(server.name).toBe("linear");
    expect(server.transport).toBe("stdio");
    // The flag's value is masked; the flag itself stays reviewable.
    expect(server.args).toEqual(["-y", "linear-mcp", "--api-key", "•••"]);
    // Names only — the values are nowhere in the published shape.
    expect(server.envNames).toEqual(["LINEAR_ORG", "LINEAR_TOKEN"]);
    expect(JSON.stringify(server)).not.toContain("tok_alsoSecret");
    expect(JSON.stringify(server)).not.toContain("verySecret");
  });

  it("does not list what could never be reviewed: plaintext remotes, path names, the reserved name", () => {
    writeConfig({
      good: { type: "http", url: "https://mcp.example.com/sse" },
      insecure: { type: "http", url: "http://mcp.example.com" },
      credentialed: { type: "http", url: "https://user:pass@mcp.example.com" },
      "no/slashes": { command: "node" },
      novus: { command: "node" }
    });
    expect(discoverMachineMcp(env()).map((server) => server.name)).toEqual(["good"]);
  });

  it("reads nothing from a machine with no config file", () => {
    expect(discoverMachineMcp(env())).toEqual([]);
  });
});

describe("resolving at spawn", () => {
  it("returns full values for a digest-verified entry, and drops a changed one by name", () => {
    writeConfig({
      linear: { command: "npx", args: ["-y", "linear-mcp"], env: { LINEAR_TOKEN: "tok_secret" } }
    });
    const [published] = discoverMachineMcp(env());
    const resolved = resolveMachineMcp([{ name: "linear", digest: published!.digest }], env());
    expect(resolved.dropped).toEqual([]);
    expect(resolved.carried).toHaveLength(1);
    // The composed entry carries the real value — written on this machine,
    // for this machine, having never crossed a wire.
    expect(resolved.carried[0]!.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "linear-mcp"],
      env: { LINEAR_TOKEN: "tok_secret" }
    });

    // The owner edits the server; the old approval no longer names it.
    writeConfig({
      linear: { command: "npx", args: ["-y", "linear-mcp@2"], env: { LINEAR_TOKEN: "tok_secret" } }
    });
    const stale = resolveMachineMcp([{ name: "linear", digest: published!.digest }], env());
    expect(stale.carried).toEqual([]);
    expect(stale.dropped).toEqual([{ name: "linear", reason: "changed since it was enabled" }]);
  });

  it("drops what left the machine, with the reason in words", () => {
    writeConfig({});
    const resolved = resolveMachineMcp([{ name: "gone", digest: "0".repeat(64) }], env());
    expect(resolved.dropped).toEqual([{ name: "gone", reason: "no longer on this machine" }]);
  });
});
