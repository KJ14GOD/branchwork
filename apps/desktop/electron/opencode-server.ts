import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { harnessEnv } from "./workspace-env";
import { openCodeConfig, providerConfig, object } from "./opencode-config";

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const activeServers = new Set<OpenCodeServer>();
let shuttingDown = false;

/** Includes catalogue probes, which do not belong to a running turn. */
export async function shutdownOpenCode(): Promise<void> {
  shuttingDown = true;
  const servers = [...activeServers];
  for (const server of servers) server.stop();
  await Promise.all(servers.map((server) => server.closed));
}

/** One authenticated, loopback-only server owned by one attempt. Never
 * attaches to a person's existing server. Configuration and processes are
 * disposed; OpenCode's own data directory keeps session continuity/login. */
export class OpenCodeServer {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private url = "";
  private readonly staging: string;
  private readonly authorization: string;
  private readonly abort = new AbortController();
  private stopped = false;
  private readonly expectedMcp: Record<string, unknown>;

  constructor(cwd: string, mcp: Record<string, unknown> = {}, providers = providerConfig()) {
    if (shuttingDown) throw new Error("Novus is closing.");
    this.expectedMcp = mcp;
    this.staging = mkdtempSync(join(tmpdir(), "novus-opencode-config-"));
    const password = randomBytes(32).toString("hex");
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const env = harnessEnv();
    // OpenCode reads its own login store. Existing Novus/provider credentials
    // and settings must not become this child's configuration by inheritance.
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|OPENCODE_)/.test(key)) delete env[key];
    }
    this.child = crossSpawn("opencode", ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...env,
        XDG_CONFIG_HOME: this.staging,
        OPENCODE_TEST_HOME: this.staging,
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(providers, mcp)),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode"
      }
    });
    this.child.stderr?.resume();
    activeServers.add(this);
    this.closed = new Promise((resolve) => this.child.once("close", () => {
      activeServers.delete(this);
      rmSync(this.staging, { recursive: true, force: true });
      resolve();
    }));
    this.ready = new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        reject(new Error("OpenCode did not start its supervised server within 20 seconds."));
        this.stop();
      }, 20_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      this.child.once("error", () => fail(new Error("OpenCode could not start. Install or update opencode on this machine.")));
      this.child.once("close", () => fail(new Error("OpenCode's supervised server exited before it was ready.")));
      this.child.stdout?.on("data", (chunk) => {
        if (this.url) return;
        buffer = (buffer + String(chunk)).slice(-64000);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
        if (!match) return;
        this.url = match[1]!;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", turn = false): Promise<unknown> {
    const response = await this.fetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: turn ? this.abort.signal : AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)])
    });
    if (!response.ok) {
      // An error body can contain headers/credentials returned by a provider.
      // Report the operation and HTTP status, never raw transport bytes.
      await response.body?.cancel();
      throw new OpenCodeHttpError(response.status, `OpenCode refused ${method} ${path.split("?")[0]} (HTTP ${response.status}).`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ready;
    return fetch(`${this.url}${path}`, {
      ...init, redirect: "error",
      headers: { authorization: this.authorization, "content-type": "application/json" }
    });
  }

  async events(consume: (chunk: string) => void): Promise<() => Promise<void>> {
    const response = await this.fetch("/event", { signal: this.abort.signal });
    if (!response.ok || !response.body) throw new Error("OpenCode cannot stream supervised events.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Returning the pump lets the caller install its failure handler before
    // sending a direction, with the subscription already open.
    return async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          consume(decoder.decode(value, { stream: true }));
        }
        if (!this.stopped) throw new Error("OpenCode's event stream disconnected; supervision ended.");
      } finally { reader.releaseLock(); }
    };
  }

  async validateProtocol(): Promise<void> {
    // Managed/organization config can outrank the local override. Refuse
    // before provider or tool initialization if it adds executable config.
    const config = object(await this.request("/config"));
    const agents = object(config.agent);
    const novus = object(agents.novus);
    const permission = config.permission === "ask" ? { "*": "ask" } : config.permission;
    const agent = { ...novus, options: object(novus.options) };
    if (!isDeepStrictEqual(permission, { "*": "ask" }) || Object.keys(agents).join() !== "novus" ||
      !isDeepStrictEqual(agent, { mode: "primary", options: {}, permission: { "*": "ask", question: "deny" } }) ||
      !isDeepStrictEqual(object(config.mcp), this.expectedMcp) || config.lsp !== false || config.formatter !== false || config.share !== "disabled") {
      throw new Error("OpenCode's managed configuration overrides Novus's governed tools. This turn cannot run supervised.");
    }
    const doc = object(await this.request("/doc"));
    const paths = object(doc.paths);
    for (const path of ["/event", "/provider", "/session", "/session/{sessionID}", "/session/{sessionID}/message", "/permission/{requestID}/reply"]) {
      if (!paths[path]) throw new Error("This OpenCode version cannot route the required supervised protocol. Update OpenCode.");
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    // Kill descendants even if the server exited first. Its own idle state
    // says nothing about a shell child still holding a pipe.
    if (this.child.pid) {
      if (process.platform === "win32") {
        crossSpawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => undefined);
      } else {
        try { process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); }
      }
    }
  }
}
