import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfig, openCodeConfig, openCodeMcp } from "../electron/opencode-config";
import { openCodeModels } from "../electron/opencode-adapter";

const scratch: string[] = [];
function config(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "novus-opencode-config-test-"));
  scratch.push(dir);
  const file = join(dir, "opencode.jsonc");
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("OpenCode configuration boundary", () => {
  it("carries a configured Ollama endpoint and model while dropping executable settings", () => {
    const file = config({ provider: { ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama", options: { baseURL: "http://localhost:11434/v1" }, models: { "llama3.1": { name: "Llama 3.1", tool_call: true } } } }, permission: "allow", plugin: ["unreviewed"], mcp: { rogue: {} }, lsp: { rogue: {} } });
    const providers = providerConfig([file]);
    expect(providers).toMatchObject({ ollama: { options: { baseURL: "http://localhost:11434/v1" }, models: { "llama3.1": { name: "Llama 3.1" } } } });
    expect(openCodeConfig(providers, {})).toMatchObject({ permission: "ask", plugin: [], mcp: {}, lsp: false, formatter: false });
    const publicModels = openCodeModels({ connected: ["ollama"], all: [{ id: "ollama", name: "Ollama", options: { apiKey: "PRIVATE" }, models: { "llama3.1": { name: "Llama 3.1", capabilities: { toolcall: true } }, embedding: { capabilities: { toolcall: false } } } }, { id: "disconnected", models: { other: {} } }] });
    expect(publicModels).toEqual([{ id: "opencode:ollama/llama3.1", label: "Llama 3.1", provider: "ollama", providerLabel: "Ollama" }]);
    expect(JSON.stringify(publicModels)).not.toContain("PRIVATE");
  });

  it.each([
    { npm: "unreviewed-sdk" },
    { options: { apiKey: "PRIVATE" } },
    { env: ["PROVIDER_KEY"] },
    { models: { custom: { headers: { authorization: "PRIVATE" } } } },
    { models: { custom: { provider: { npm: "unreviewed-sdk" } } } },
    { models: { custom: { variants: { custom: { apiKey: "PRIVATE" } } } } }
  ])("refuses unmapped executable or credential configuration", (provider) => {
    const file = config({ provider: { custom: provider } });
    expect(() => providerConfig([file])).toThrow();
    try { providerConfig([file]); } catch (error) { expect(String(error)).not.toContain("PRIVATE"); }
  });

  it("accepts JSONC layering, refuses broken syntax and reads no credential file", () => {
    const first = config('// local endpoint\n{"provider":{"local":{"name":"Local","options":{"baseURL":"http://localhost:11434/v1"}}}}');
    const second = config({ provider: { local: { models: { llama: { name: "Llama" } } } } });
    expect(providerConfig([first, second])).toMatchObject({ local: { name: "Local", options: { baseURL: "http://localhost:11434/v1" }, models: { llama: { name: "Llama" } } } });
    expect(() => providerConfig([config("{invalid")])).toThrow("invalid JSON");
  });

  it("translates only the composed MCP declarations and excludes the first-party endpoint", () => {
    const file = config({ mcpServers: { novus: { url: "http://localhost:1" }, reviewed: { command: "node", args: ["server.js"], env: { LOCAL_SETTING: "value" } }, remote: { url: "https://example.com/mcp", headers: { authorization: "local-only" } } } });
    expect(openCodeMcp(file)).toEqual({ reviewed: { type: "local", command: ["node", "server.js"], environment: { LOCAL_SETTING: "value" }, enabled: true }, remote: { type: "remote", url: "https://example.com/mcp", headers: { authorization: "local-only" }, enabled: true, oauth: false } });
    expect(openCodeMcp(null)).toEqual({});
  });
});
