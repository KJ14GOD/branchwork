import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The `novus` capture endpoint (D-123): a loopback HTTP MCP server inside the
 * Electron main process, composed into every turn's strict MCP config beside
 * the person-enabled project servers. Three first-party tools —
 * `capture_screenshot` (D-123), `push_branch` (D-140), `declare_run_command`
 * (D-156) — with a two-key lock on each:
 *
 *  1. the **token** — per turn, random, carried in the config's own
 *     Authorization header — names which live turn is asking, and nothing
 *     more. It is a request-channel identifier, not authority: anything in
 *     the harness environment could learn it (the config file is on disk),
 *     and learning it grants nothing.
 *  2. the **grant** — minted by the permission router only when a person (or
 *     the lane's recorded `dont_ask` policy) *allowed* the capture tool's own
 *     request, one-shot, short-lived. Without a standing grant the endpoint
 *     refuses, so a Bash `curl` at the socket without a routed approval gets
 *     words, not pixels.
 *
 * Approval is necessary and not sufficient: the capture handler behind the
 * grant still applies every check a person's own capture faces (D-123).
 */

export const CAPTURE_TOOL_NAME = "capture_screenshot";
export const CAPTURE_TOOL_FULL_NAME = `mcp__novus__${CAPTURE_TOOL_NAME}`;
export const PUSH_TOOL_NAME = "push_branch";
export const PUSH_TOOL_FULL_NAME = `mcp__novus__${PUSH_TOOL_NAME}`;
export const DECLARE_RUN_TOOL_NAME = "declare_run_command";
export const DECLARE_RUN_TOOL_FULL_NAME = `mcp__novus__${DECLARE_RUN_TOOL_NAME}`;

/** The fenced-browser tools (D-218): the agent's hands on the preview. Unlike
 *  the one-shot tools above, these share a per-turn **session** grant — one
 *  approval covers the turn's browsing, and a person can cut it off mid-turn.
 *  They act only on the approved loopback page, so they grant no reach the
 *  agent's own shell did not already have. */
export const BROWSER_TOOLS = ["browser_navigate", "browser_click", "browser_type", "browser_press", "browser_read"] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];
export const isBrowserToolFullName = (name: string): boolean =>
  BROWSER_TOOLS.some((tool) => name === `mcp__novus__${tool}`);

/** The raw computer-use tools (D-218): the agent's hands on the whole Mac, as
 *  opposed to the fenced browser. Their own per-turn session, distinct from
 *  the browser's — allowing one never allows the other — and gated further by
 *  the machine-local opt-in and the structural fence, applied in the driver. */
export const COMPUTER_TOOLS = ["computer_screenshot", "computer_move", "computer_click", "computer_type", "computer_key", "computer_scroll"] as const;
export type ComputerTool = (typeof COMPUTER_TOOLS)[number];
export const isComputerToolFullName = (name: string): boolean =>
  COMPUTER_TOOLS.some((tool) => name === `mcp__novus__${tool}`);

/** How long an allow stands before the tool call must have arrived. The CLI
 *  invokes the tool immediately after the permission answer; minutes covers a
 *  slow machine without leaving a standing capability lying around. */
const GRANT_TTL_MS = 3 * 60_000;

interface RegisteredTurn {
  executionId: string;
  /** Performs the capture under every person-equivalent check and returns
   *  what the agent should be told. */
  capture: () => Promise<{ text: string; isError: boolean }>;
  /** Pushes the lane's latest checkpoint through the same hardened path a
   *  person's publish uses (D-140). Same grant discipline as capture. */
  push: () => Promise<{ text: string; isError: boolean }>;
  /** Declares a run command by writing `.novus/settings.toml` through the
   *  same serializer a person's confirm uses (D-156) — valid by construction,
   *  because the schema is Novus's own and an agent cannot be expected to
   *  guess an undocumented format. Same grant discipline as capture. */
  declareRun: (input: unknown) => Promise<{ text: string; isError: boolean }>;
  /** Drives the fenced preview (D-218): navigate, click, type, press, read.
   *  Behind the per-turn session grant rather than a one-shot. */
  browser: (tool: BrowserTool, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  /** Operates the whole Mac (D-218): the driver applies the opt-in, the
   *  structural fence, and the native backend. Behind its own per-turn
   *  session, separate from the browser's. */
  computer: (tool: ComputerTool, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

interface ToolGrant {
  expiresAt: number;
}

const turns = new Map<string, RegisteredTurn>();
/** One grant per (execution, tool): an allow for capture spends nothing of
 *  push, and each is one-shot. */
const grants = new Map<string, ToolGrant>();
/** The browser session per execution (D-218): `granted` after a person allows
 *  the first browse this turn, `revoked` after a person cuts it off — sticky
 *  for the turn, so a cut-off cannot be undone by the agent asking again. */
const browserSessions = new Map<string, "granted" | "revoked">();

/** A person allowed the turn's first browse: the session stands until the
 *  turn ends or a person revokes it. A cut-off already in force wins — the
 *  agent cannot re-open browsing it was denied. */
export function grantBrowserSession(executionId: string): void {
  if (browserSessions.get(executionId) === "revoked") return;
  browserSessions.set(executionId, "granted");
}

/** A person's mid-turn cut-off (D-218): sticky for the rest of the turn. */
export function revokeBrowserSession(executionId: string): void {
  browserSessions.set(executionId, "revoked");
}

/** What the router reads to decide ask / allow / deny for a browser tool. */
export function browserSessionState(executionId: string): "granted" | "revoked" | null {
  return browserSessions.get(executionId) ?? null;
}

/** The raw computer-use session per execution (D-218), the browser session's
 *  twin — separate so a browser approval never grants the Mac and vice versa. */
const computerSessions = new Map<string, "granted" | "revoked">();

export function grantComputerSession(executionId: string): void {
  if (computerSessions.get(executionId) === "revoked") return;
  computerSessions.set(executionId, "granted");
}

export function revokeComputerSession(executionId: string): void {
  computerSessions.set(executionId, "revoked");
}

export function computerSessionState(executionId: string): "granted" | "revoked" | null {
  return computerSessions.get(executionId) ?? null;
}
let server: Server | null = null;
let port: number | null = null;

const grantKey = (executionId: string, tool: string) => `${executionId}\u0000${tool}`;

/** Router hook (D-123, D-140): an *allow* for one of this endpoint's tools
 *  mints one grant for that execution and that tool — person-approved or
 *  policy-answered, either way recorded by the router itself before this is
 *  called. */
export function mintToolGrant(executionId: string, tool: string): void {
  grants.set(grantKey(executionId, tool), { expiresAt: Date.now() + GRANT_TTL_MS });
}

function consumeToolGrant(executionId: string, tool: string): boolean {
  const key = grantKey(executionId, tool);
  const grant = grants.get(key);
  if (!grant) return false;
  grants.delete(key);
  return grant.expiresAt >= Date.now();
}

function tokenMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("request too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/** JSON-RPC result envelope. */
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
});

const TOOL_DESCRIPTION =
  "Capture a screenshot of this mission's live application preview in Novus as durable evidence. " +
  "Requires the preview to be open and showing a page, and every call is approved by a person " +
  "under the lane's permission profile. The screenshot proves what the preview displayed at " +
  "that revision and time; it does not prove the application is correct.";

const PUSH_DESCRIPTION =
  "Push this mission's latest checkpoint to its own branch on GitHub, through Novus's governed " +
  "push: only the mission branch, never --force, credential injected for this one operation. " +
  "Every call is approved by a person under the lane's permission profile. Work from the current " +
  "turn checkpoints when the turn completes, so ask in a follow-up turn to push it. This shares " +
  "the branch; opening a pull request stays a person's own act in Novus.";

const DECLARE_RUN_DESCRIPTION =
  "Declare a run command for this project in .novus/settings.toml — Novus writes its own " +
  "configuration format, so never hand-edit that file. Use this after building something " +
  "runnable (a server, an app) so the person's Run control can start it. The command must be " +
  "long-running and serve on 127.0.0.1 for the preview to attach. Every call is approved by a " +
  "person under the lane's permission profile; declaring never runs anything — a person runs it.";

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const turn = [...turns.entries()].find(([candidate]) => tokenMatches(token, candidate))?.[1];
  if (!turn) {
    json(response, 401, { error: "This capture endpoint token names no live turn." });
    return;
  }

  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    message = JSON.parse(await readBody(request)) as typeof message;
  } catch {
    json(response, 400, rpcError(null, -32700, "Parse error"));
    return;
  }
  const id = message.id ?? null;

  if (message.method === "initialize") {
    const params = (message.params ?? {}) as { protocolVersion?: string };
    json(
      response,
      200,
      result(id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "novus", version: "1.0.0" }
      })
    );
    return;
  }
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
    response.writeHead(202).end();
    return;
  }
  if (message.method === "ping") {
    json(response, 200, result(id, {}));
    return;
  }
  if (message.method === "tools/list") {
    json(
      response,
      200,
      result(id, {
        tools: [
          {
            name: CAPTURE_TOOL_NAME,
            description: TOOL_DESCRIPTION,
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          },
          {
            name: PUSH_TOOL_NAME,
            description: PUSH_DESCRIPTION,
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          },
          {
            name: DECLARE_RUN_TOOL_NAME,
            description: DECLARE_RUN_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Short name for the Run menu, e.g. \"serve\" or \"web\"."
                },
                command: {
                  type: "string",
                  description: "The shell command, e.g. \"python3 -m http.server 8123 --bind 127.0.0.1\"."
                },
                port: {
                  type: "integer",
                  description: "The port the command serves on, if it serves one — lets the preview attach."
                },
                cwd: {
                  type: "string",
                  description: "Directory to run in, relative to the repository root. Omit for the root."
                }
              },
              required: ["name", "command"],
              additionalProperties: false
            }
          },
          {
            name: "browser_navigate",
            description:
              "Navigate this mission's live preview to a path on its own app (e.g. \"/settings\"). Stays on the app's own origin; it is not a web browser. One approval covers all browsing this turn, and a person can stop it at any time.",
            inputSchema: {
              type: "object",
              properties: { url: { type: "string", description: "A path like \"/settings\" or a same-origin URL." } },
              required: ["url"],
              additionalProperties: false
            }
          },
          {
            name: "browser_click",
            description:
              "Click a point in the live preview, in the page's own CSS pixels (top-left is 0,0). Take a screenshot first to see where things are.",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
              additionalProperties: false
            }
          },
          {
            name: "browser_type",
            description: "Type text into whatever the live preview currently has focused (click a field first).",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false
            }
          },
          {
            name: "browser_press",
            description: "Press a named key in the live preview: enter, tab, backspace, delete, escape, up, down, left, right.",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
              additionalProperties: false
            }
          },
          {
            name: "browser_read",
            description: "Read the live preview's current page as text (title, url, and visible text) — a screenshot without the pixels.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          },
          {
            name: "computer_screenshot",
            description:
              "Take a screenshot of the whole Mac's screen to see where things are, in screen pixels (top-left is 0,0). Raw computer use is off unless the machine's owner has turned it on, one approval covers the turn, a person can stop it, and Novus's own window can never be acted on. The screen may contain sensitive information.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          },
          {
            name: "computer_move",
            description: "Move the mouse to a point on the Mac's screen, in screen pixels.",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
              additionalProperties: false
            }
          },
          {
            name: "computer_click",
            description: "Click at a point on the Mac's screen. Never on Novus's own window — that is refused.",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] } },
              required: ["x", "y"],
              additionalProperties: false
            }
          },
          {
            name: "computer_type",
            description: "Type text on the Mac, into whatever has focus. Refused while Novus is the frontmost app.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false
            }
          },
          {
            name: "computer_key",
            description: "Press a named key on the Mac: enter, tab, escape, backspace, delete, up, down, left, right, or a combo like 'cmd+c'.",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
              additionalProperties: false
            }
          },
          {
            name: "computer_scroll",
            description: "Scroll at a point on the Mac's screen by dx, dy pixels.",
            inputSchema: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } },
              required: ["x", "y", "dx", "dy"],
              additionalProperties: false
            }
          }
        ]
      })
    );
    return;
  }
  if (message.method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string; arguments?: unknown };

    // Raw computer use (D-218) shares its own per-turn session, verified here
    // like the browser's; the driver applies the opt-in, the fence, and the
    // native backend besides.
    if (params.name && (COMPUTER_TOOLS as readonly string[]).includes(params.name)) {
      if (computerSessions.get(turn.executionId) !== "granted") {
        json(
          response,
          200,
          result(id, {
            content: [
              {
                type: "text",
                text: "Computer use is not open for this turn — a person either has not approved it or has stopped it."
              }
            ],
            isError: true
          })
        );
        return;
      }
      const outcome = await turn
        .computer(params.name as ComputerTool, (params.arguments ?? {}) as Record<string, unknown>)
        .catch((error: unknown) => ({
          text: `Computer action failed: ${error instanceof Error ? error.message : "unknown error"}`,
          isError: true
        }));
      json(
        response,
        200,
        result(id, { content: [{ type: "text", text: outcome.text }], isError: outcome.isError })
      );
      return;
    }

    // The browser tools (D-218) share a per-turn session grant rather than a
    // one-shot: the endpoint verifies the session still stands — a person's
    // mid-turn cut-off refuses the next call even after the router allowed the
    // last — and the driver applies every preview-validity check besides.
    if (params.name && (BROWSER_TOOLS as readonly string[]).includes(params.name)) {
      if (browserSessions.get(turn.executionId) !== "granted") {
        json(
          response,
          200,
          result(id, {
            content: [
              {
                type: "text",
                text: "Browsing is not open for this turn — a person either has not approved it or has stopped it."
              }
            ],
            isError: true
          })
        );
        return;
      }
      const outcome = await turn
        .browser(params.name as BrowserTool, (params.arguments ?? {}) as Record<string, unknown>)
        .catch((error: unknown) => ({
          text: `Browser action failed: ${error instanceof Error ? error.message : "unknown error"}`,
          isError: true
        }));
      json(
        response,
        200,
        result(id, { content: [{ type: "text", text: outcome.text }], isError: outcome.isError })
      );
      return;
    }

    const tool =
      params.name === CAPTURE_TOOL_NAME
        ? { name: CAPTURE_TOOL_NAME, run: turn.capture, verb: "Capture" }
        : params.name === PUSH_TOOL_NAME
          ? { name: PUSH_TOOL_NAME, run: turn.push, verb: "Push" }
          : params.name === DECLARE_RUN_TOOL_NAME
            ? {
                name: DECLARE_RUN_TOOL_NAME,
                run: () => turn.declareRun(params.arguments ?? {}),
                verb: "Declare"
              }
            : null;
    if (!tool) {
      json(response, 200, rpcError(id, -32602, `No such tool: ${params.name ?? "(none)"}`));
      return;
    }
    // The grant is the routed approval's receipt: no allow, no act —
    // whoever is asking, however they found the socket.
    const grantOk = consumeToolGrant(turn.executionId, tool.name);
    if (!grantOk) {
      json(
        response,
        200,
        result(id, {
          content: [
            {
              type: "text",
              text: `${tool.verb} refused: no approval stands for this request. Each ${tool.verb.toLowerCase()} is approved once, at the moment it is asked.`
            }
          ],
          isError: true
        })
      );
      return;
    }
    const outcome = await tool.run().catch((error: unknown) => ({
      text: `${tool.verb} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      isError: true
    }));
    json(
      response,
      200,
      result(id, { content: [{ type: "text", text: outcome.text }], isError: outcome.isError })
    );
    return;
  }
  json(response, 200, rpcError(id, -32601, `Method not found: ${message.method ?? "(none)"}`));
}

async function ensureServer(): Promise<number> {
  if (server !== null && port !== null) return port;
  const created = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    created.once("error", reject);
    // Loopback only, ephemeral port: nothing off this machine can reach it,
    // and nothing on it learns a stable address.
    created.listen(0, "127.0.0.1", () => resolve());
  });
  created.unref();
  server = created;
  const address = created.address();
  port = typeof address === "object" && address !== null ? address.port : null;
  if (port === null) throw new Error("the capture endpoint has no port");
  return port;
}

/**
 * Registers a turn with the endpoint and returns what the composed MCP config
 * needs. Released when the turn ends; the token dies with it, and any
 * unconsumed grant for the execution dies too.
 */
export async function registerCaptureTurn(
  executionId: string,
  capture: RegisteredTurn["capture"],
  push: RegisteredTurn["push"],
  declareRun: RegisteredTurn["declareRun"],
  browser: RegisteredTurn["browser"] = async () => ({
    text: "This turn has no browser driver.",
    isError: true
  }),
  computer: RegisteredTurn["computer"] = async () => ({
    text: "This turn has no computer driver.",
    isError: true
  })
): Promise<{ url: string; token: string; release: () => void }> {
  const listeningPort = await ensureServer();
  const token = randomBytes(24).toString("base64url");
  turns.set(token, { executionId, capture, push, declareRun, browser, computer });
  return {
    url: `http://127.0.0.1:${listeningPort}/mcp`,
    token,
    release: () => {
      turns.delete(token);
      grants.delete(grantKey(executionId, CAPTURE_TOOL_NAME));
      grants.delete(grantKey(executionId, PUSH_TOOL_NAME));
      grants.delete(grantKey(executionId, DECLARE_RUN_TOOL_NAME));
      browserSessions.delete(executionId);
      computerSessions.delete(executionId);
    }
  };
}

/** Test hook: everything down, nothing remembered. */
export function resetCaptureEndpoint(): void {
  turns.clear();
  grants.clear();
  browserSessions.clear();
  computerSessions.clear();
  server?.close();
  server = null;
  port = null;
}
