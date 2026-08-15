import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The `novus` capture endpoint (D-123): a loopback HTTP MCP server inside the
 * Electron main process, composed into every turn's strict MCP config beside
 * the person-enabled project servers. One tool, `capture_screenshot`, and a
 * two-key lock on it:
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

/** How long an allow stands before the tool call must have arrived. The CLI
 *  invokes the tool immediately after the permission answer; minutes covers a
 *  slow machine without leaving a standing capability lying around. */
const GRANT_TTL_MS = 3 * 60_000;

interface RegisteredTurn {
  executionId: string;
  /** Performs the capture under every person-equivalent check and returns
   *  what the agent should be told. */
  capture: () => Promise<{ text: string; isError: boolean }>;
}

interface CaptureGrant {
  executionId: string;
  expiresAt: number;
}

const turns = new Map<string, RegisteredTurn>();
const grants = new Map<string, CaptureGrant>();
let server: Server | null = null;
let port: number | null = null;

/** Router hook (D-123): an *allow* for the capture tool mints one grant for
 *  that execution — person-approved or policy-answered, either way recorded
 *  by the router itself before this is called. */
export function mintCaptureGrant(executionId: string): void {
  grants.set(executionId, { executionId, expiresAt: Date.now() + GRANT_TTL_MS });
}

function consumeCaptureGrant(executionId: string): boolean {
  const grant = grants.get(executionId);
  if (!grant) return false;
  grants.delete(executionId);
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
          }
        ]
      })
    );
    return;
  }
  if (message.method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string };
    if (params.name !== CAPTURE_TOOL_NAME) {
      json(response, 200, rpcError(id, -32602, `No such tool: ${params.name ?? "(none)"}`));
      return;
    }
    // The grant is the routed approval's receipt: no allow, no capture —
    // whoever is asking, however they found the socket.
    if (!consumeCaptureGrant(turn.executionId)) {
      json(
        response,
        200,
        result(id, {
          content: [
            {
              type: "text",
              text: "Capture refused: no approval stands for this request. Each capture is approved once, at the moment it is asked."
            }
          ],
          isError: true
        })
      );
      return;
    }
    const outcome = await turn.capture().catch((error: unknown) => ({
      text: `Capture failed: ${error instanceof Error ? error.message : "unknown error"}`,
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
  capture: RegisteredTurn["capture"]
): Promise<{ url: string; token: string; release: () => void }> {
  const listeningPort = await ensureServer();
  const token = randomBytes(24).toString("base64url");
  turns.set(token, { executionId, capture });
  return {
    url: `http://127.0.0.1:${listeningPort}/mcp`,
    token,
    release: () => {
      turns.delete(token);
      grants.delete(executionId);
    }
  };
}

/** Test hook: everything down, nothing remembered. */
export function resetCaptureEndpoint(): void {
  turns.clear();
  grants.clear();
  server?.close();
  server = null;
  port = null;
}
