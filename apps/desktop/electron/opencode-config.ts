import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

const SDK_PACKAGES = new Set([
  "@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic",
  "@ai-sdk/google", "@ai-sdk/google-vertex", "@ai-sdk/amazon-bedrock",
  "@ai-sdk/azure", "@ai-sdk/mistral", "@ai-sdk/deepseek", "@ai-sdk/groq",
  "@ai-sdk/xai", "@ai-sdk/cohere", "@ai-sdk/togetherai", "@ai-sdk/cerebras",
  "@ai-sdk/perplexity", "@openrouter/ai-sdk-provider"
]);

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Copy provider declarations, never credential values or executable config.
 * Login stays in OpenCode's auth store, which Novus never opens. Unknown
 * options fail explicitly instead of silently selecting a different account. */
export function providerConfig(files?: string[]): Record<string, unknown> {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const paths = files ?? [join(configHome, "opencode", "opencode.json"), join(configHome, "opencode", "opencode.jsonc")];
  const providers: Record<string, unknown> = {};
  for (const file of paths) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("OpenCode provider configuration could not be read.");
    }
    if (raw.length > 1_000_000) throw new Error("OpenCode provider configuration is too large.");
    const errors: ParseError[] = [];
    const config = object(parse(raw, errors, { allowTrailingComma: true }));
    if (errors.length) throw new Error("Fix the invalid JSON in OpenCode's global configuration.");
    if (config.enabled_providers || config.disabled_providers) throw new Error("OpenCode provider enable/disable lists need an explicit adapter mapping.");
    for (const [id, value] of Object.entries(object(config.provider))) {
      const entry = object(value);
      if (Object.keys(entry).some((key) => !["api", "name", "npm", "options", "models", "whitelist", "blacklist"].includes(key))) {
        throw new Error(`OpenCode provider ${id} has configuration that needs an explicit adapter mapping.`);
      }
      if (entry.npm && !SDK_PACKAGES.has(String(entry.npm))) {
        throw new Error(`OpenCode provider ${id} requires an SDK outside Novus's supported built-in SDKs.`);
      }
      const options = object(entry.options);
      if (Object.keys(options).some((key) => !["baseURL", "region", "location", "project", "timeout"].includes(key))) {
        throw new Error(`OpenCode provider ${id} uses unsupported options. Keep credentials in opencode auth login; Novus carries endpoint, region, location, project and timeout only.`);
      }
      if (entry.env || entry.headers || Object.values(object(entry.models)).some((model) => {
        const m = object(model);
        const provider = object(m.provider);
        if (provider.npm && !SDK_PACKAGES.has(String(provider.npm))) throw new Error(`OpenCode model in ${id} requires an unsupported SDK.`);
        return m.headers || m.options || m.variants;
      })) throw new Error(`OpenCode provider ${id} has custom headers, environment or model options that need an explicit adapter mapping.`);
      const previous = object(providers[id]);
      providers[id] = {
        ...previous,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.api === "string" ? { api: entry.api } : {}),
        ...(typeof entry.npm === "string" ? { npm: entry.npm } : {}),
        ...(Array.isArray(entry.whitelist) ? { whitelist: entry.whitelist } : {}),
        ...(Array.isArray(entry.blacklist) ? { blacklist: entry.blacklist } : {}),
        options: { ...object(previous.options), ...options },
        models: { ...object(previous.models), ...object(entry.models) }
      };
    }
  }
  return providers;
}

/** Translate only the MCP file Novus composed after review. */
export function openCodeMcp(file: string | null): Record<string, unknown> {
  if (!file) return {};
  const servers = object(object(JSON.parse(readFileSync(file, "utf8"))).mcpServers);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (name === "novus") continue;
    const entry = object(value);
    if (typeof entry.command === "string") result[name] = {
      type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])],
      environment: object(entry.env), enabled: true
    };
    else if (typeof entry.url === "string") result[name] = {
      type: "remote", url: entry.url, headers: object(entry.headers), enabled: true, oauth: false
    };
  }
  return result;
}

export const OPEN_CODE_PERMISSION = [
  { permission: "*", pattern: "*", action: "ask" },
  ...["read", "glob", "grep", "list"].map((permission) => ({ permission, pattern: "*", action: "allow" })),
  { permission: "question", pattern: "*", action: "deny" }
] as const;

export function openCodeConfig(providers: Record<string, unknown>, mcp: Record<string, unknown>) {
  return {
    provider: providers, mcp, permission: "ask", share: "disabled", plugin: [],
    lsp: false, formatter: false,
    // The question tool has a different answer grammar; the agent asks in
    // prose and the person sends another direction instead.
    agent: { novus: { mode: "primary", permission: { "*": "ask", question: "deny" } } }
  };
}
