import { MAX_APPROVAL_SUMMARY, type RunnerEvent } from "@novus/contracts";
import { classifyCommand, type HarnessControlMessage, type HarnessResult } from "./harness-stream";

/**
 * The Codex adapter's inward half (D-230): app-server JSON-RPC NDJSON in,
 * Novus runner events out — the exact vocabulary `harness-stream.ts` speaks,
 * because that vocabulary IS the adapter contract. Protocol taken from the
 * binary itself (`codex app-server generate-json-schema`, 0.145.0), never
 * from documentation alone.
 *
 * Pure on purpose, like its Claude sibling: no Electron, no filesystem, no
 * clock. The same three rules carry the weight:
 *
 *  - Codex speaks only through items it actually completed. Deltas are
 *    accumulated and spoken once, at `item/completed` — the room reads turns,
 *    not keystrokes — and a completed `commandExecution` is the only thing
 *    that can become verification evidence, through the same classifier.
 *  - A malformed line is noise, never a fatal error.
 *  - Control is not transcript. Server-initiated approval requests are lifted
 *    into the same `HarnessControlMessage` shapes the ladder already judges;
 *    not one character of them becomes `harness.text`.
 *
 * What is deliberately dropped, D-056's rule in Codex's dialect: the
 * `acceptForSession` and `acceptWithExecpolicyAmendment` decisions — each
 * would turn one person's single approval into a standing grant nobody gave —
 * and the `auto_review` reviewer, which is the CLI approving itself.
 */

const MAX_TEXT = 8_000;
const MAX_LINE = 400;
const MAX_OUTPUT = 4_000;

function bound(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** A count Codex reported, or null — "not reported" and "none" differ. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export interface CodexStreamOptions {
  /** The thread this turn asked to continue; a different id coming back means
   *  continuity was lost, and the event says so. */
  resumeThreadId?: string | null;
  sanitize?: (text: string) => string;
  onControl?: (message: HarnessControlMessage) => void;
  /** The driver's sequencing hook: responses to requests THIS side sent —
   *  initialize, thread/start, turn/start — arrive here by their own id. */
  onRpcResponse?: (id: string | number, result: unknown, error: { message?: string } | null) => void;
}

/** What kind of approval a server request id belongs to, so the answer can be
 *  built in that request's own decision grammar. */
export type CodexApprovalKind = "command" | "fileChange" | "permissions" | "elicitation";

interface RpcLine {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

export class CodexStream {
  private buffer = "";
  private readonly resumeThreadId: string | null;
  private readonly sanitize: (text: string) => string;
  private readonly onControl: (message: HarnessControlMessage) => void;
  private onRpcResponse: (
    id: string | number,
    result: unknown,
    error: { message?: string } | null
  ) => void;
  private observedThreadId: string | null = null;
  private observedResumed = false;
  private observedResult: HarnessResult | null = null;
  /** The live turn's own id (D-231): what turn/steer must name. Set at
   *  turn/started, cleared at completion — a steer with no live turn is a
   *  steer that honestly cannot happen. */
  private liveTurnId: string | null = null;
  /** Which decision grammar answers each pending server request. */
  private readonly approvalKinds = new Map<string, CodexApprovalKind>();
  /** The latest token usage the thread reported; spoken once, at turn end. */
  private usage: { input: number | null; cached: number | null; output: number | null } | null = null;
  /** Tool items already announced as started, so completion does not repeat
   *  the row (`item/started` is the announcement; completion is evidence). */
  private readonly announced = new Set<string>();

  constructor(options: CodexStreamOptions = {}) {
    this.resumeThreadId = options.resumeThreadId ?? null;
    this.sanitize = options.sanitize ?? ((text) => text);
    this.onControl = options.onControl ?? (() => undefined);
    this.onRpcResponse = options.onRpcResponse ?? (() => undefined);
  }

  get sessionId(): string | null {
    return this.observedThreadId;
  }

  get resumed(): boolean {
    return this.observedResumed;
  }

  get result(): HarnessResult | null {
    return this.observedResult;
  }

  /** The running turn's id, while one runs (D-231). */
  get activeTurnId(): string | null {
    return this.liveTurnId;
  }

  /** The driver attaches its sequencer after construction — it needs the
   *  stream in hand to read `sessionId` inside the callback. */
  attachRpcResponder(
    responder: (id: string | number, result: unknown, error: { message?: string } | null) => void
  ): void {
    this.onRpcResponse = responder;
  }

  /** The decision grammar for one pending request id, consumed on answer. */
  approvalKindOf(requestId: string): CodexApprovalKind | null {
    return this.approvalKinds.get(requestId) ?? null;
  }

  push(chunk: string): RunnerEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.consume(line));
  }

  end(): RunnerEvent[] {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder.trim() ? this.consume(remainder) : [];
  }

  private consume(line: string): RunnerEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let parsed: RpcLine;
    try {
      parsed = JSON.parse(trimmed) as RpcLine;
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];

    // A response to something this side sent: the driver sequences on it.
    if (parsed.method === undefined && parsed.id !== undefined) {
      this.noteThreadFromResult(parsed.result);
      this.onRpcResponse(parsed.id, parsed.result ?? null, parsed.error ?? null);
      return [];
    }
    if (typeof parsed.method !== "string") return [];

    // Server-initiated REQUESTS (carry an id) are approvals: control, never
    // transcript, exactly as Claude's control_request is lifted.
    if (parsed.id !== undefined) return this.consumeServerRequest(parsed);
    return this.consumeNotification(parsed.method, parsed.params ?? {});
  }

  /** thread/start and thread/resume answer with the thread; remember it. */
  private noteThreadFromResult(result: unknown): void {
    const thread = (result as { thread?: { id?: unknown } } | null)?.thread;
    const id = typeof thread?.id === "string" ? thread.id : null;
    if (id === null || this.observedThreadId === id) return;
    this.observedThreadId = id;
    this.observedResumed = this.resumeThreadId !== null && this.resumeThreadId === id;
  }

  private consumeServerRequest(parsed: RpcLine): RunnerEvent[] {
    const requestId = String(parsed.id);
    const params = parsed.params ?? {};
    const method = parsed.method ?? "";
    let kind: CodexApprovalKind;
    let toolName: string;
    let summaryParts: string[] = [];
    let targetPaths: string[] = [];
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval": {
        kind = "command";
        toolName = "Bash";
        const command = typeof params.command === "string" ? params.command : null;
        const reason = typeof params.reason === "string" ? params.reason : null;
        summaryParts = [command, reason].filter((part): part is string => part !== null && part !== "");
        break;
      }
      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        kind = "fileChange";
        toolName = "Edit";
        const reason = typeof params.reason === "string" ? params.reason : null;
        const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : null;
        summaryParts = [reason ?? "Apply the proposed file changes", grantRoot].filter(
          (part): part is string => part !== null && part !== ""
        );
        // The patch's own paths, when the request names them (v1 shape).
        const changes = params.changes;
        if (changes && typeof changes === "object") targetPaths = Object.keys(changes).slice(0, 50);
        break;
      }
      case "item/permissions/requestApproval": {
        kind = "permissions";
        toolName = "Permissions";
        const reason = typeof params.reason === "string" ? params.reason : null;
        summaryParts = [
          "Codex asks to widen its own permissions",
          reason
        ].filter((part): part is string => part !== null && part !== "");
        break;
      }
      case "mcpServer/elicitation/request":
      case "item/tool/requestUserInput": {
        // Something Novus does not answer on a person's behalf: reported as
        // unsupported so the driver can answer with an error rather than
        // wedge the turn on silence (the CLI blocks on what it sends).
        this.onControl({ kind: "unsupported", requestId, subtype: bound(method, MAX_LINE) });
        return [];
      }
      default: {
        this.onControl({ kind: "unsupported", requestId, subtype: bound(method, MAX_LINE) });
        return [];
      }
    }
    this.approvalKinds.set(requestId, kind);
    const summary = bound(
      this.sanitize(summaryParts.length > 0 ? summaryParts.join(" — ") : toolName),
      MAX_APPROVAL_SUMMARY
    );
    const itemId = typeof params.itemId === "string" ? bound(params.itemId, MAX_LINE) : null;
    this.onControl({
      kind: "approval",
      requestId,
      toolUseId: itemId,
      toolName,
      displayName: toolName,
      summary,
      targetPaths
    });
    return [
      {
        kind: "approval.requested",
        payload: { requestId: bound(requestId, MAX_LINE), toolUseId: itemId, toolName, displayName: toolName, summary }
      },
      { kind: "boundary.reached", payload: { reason: "permission prompt pending" } }
    ];
  }

  private consumeNotification(method: string, params: Record<string, unknown>): RunnerEvent[] {
    switch (method) {
      case "thread/started": {
        const id = (params as { thread?: { id?: unknown } }).thread?.id;
        if (typeof id !== "string" || this.observedThreadId === id) return [];
        this.observedThreadId = id;
        this.observedResumed = this.resumeThreadId !== null && this.resumeThreadId === id;
        return [
          {
            kind: "harness.session",
            payload: { sessionId: bound(id, MAX_LINE), resumed: this.observedResumed }
          }
        ];
      }
      case "item/started": {
        const item = params.item as Record<string, unknown> | undefined;
        return this.consumeItemStarted(item);
      }
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        return this.consumeItemCompleted(item);
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as Record<string, unknown> | undefined;
        if (usage) {
          this.usage = {
            input: count(usage.inputTokens ?? usage.input_tokens),
            cached: count(usage.cachedInputTokens ?? usage.cached_input_tokens),
            output: count(usage.outputTokens ?? usage.output_tokens)
          };
        }
        return [];
      }
      case "turn/started": {
        const turn = params.turn as { id?: unknown } | undefined;
        if (typeof turn?.id === "string") this.liveTurnId = turn.id;
        return [];
      }
      case "turn/completed": {
        this.liveTurnId = null;
        const turn = params.turn as Record<string, unknown> | undefined;
        const status = typeof turn?.status === "string" ? turn.status : "completed";
        const failure = turn?.error as { message?: unknown } | undefined;
        const message = typeof failure?.message === "string" ? this.sanitize(failure.message) : null;
        this.observedResult = {
          isError: status === "failed",
          subtype: status,
          message
        };
        if (this.usage === null) return [];
        return [
          {
            kind: "harness.usage",
            payload: {
              inputTokens: this.usage.input,
              outputTokens: this.usage.output,
              cacheReadTokens: this.usage.cached,
              cacheCreationTokens: null,
              costUsd: null,
              durationMs: null,
              turns: null
            }
          }
        ];
      }
      case "error":
      case "thread/error": {
        const message = typeof params.message === "string" ? this.sanitize(params.message) : null;
        this.observedResult = { isError: true, subtype: "error", message };
        return [];
      }
      default:
        return [];
    }
  }

  /** A tool item beginning is the row the room watches — same grammar as a
   *  Claude tool_use line. Codex's own message items are not announced here:
   *  their words arrive whole at completion. */
  private consumeItemStarted(item: Record<string, unknown> | undefined): RunnerEvent[] {
    if (!item || typeof item.id !== "string") return [];
    const type = typeof item.type === "string" ? item.type : "";
    let tool: string | null = null;
    let detail: string | null = null;
    if (type === "commandExecution") {
      tool = "Bash";
      detail = typeof item.command === "string" ? item.command : null;
    } else if (type === "fileChange") {
      tool = "Edit";
      const changes = item.changes;
      detail =
        changes && typeof changes === "object" ? Object.keys(changes).slice(0, 5).join(", ") : null;
    } else if (type === "mcpToolCall") {
      tool = typeof item.tool === "string" ? item.tool : "MCP tool";
      detail = typeof item.server === "string" ? item.server : null;
    } else if (type === "webSearch") {
      tool = "WebSearch";
      detail = typeof item.query === "string" ? item.query : null;
    } else {
      return [];
    }
    this.announced.add(item.id);
    return [
      {
        kind: "harness.tool",
        payload: {
          tool: bound(tool, MAX_LINE),
          detail: detail === null ? null : bound(this.sanitize(detail), MAX_LINE),
          parentToolUseId: null,
          toolUseId: bound(item.id, MAX_LINE)
        }
      }
    ];
  }

  private consumeItemCompleted(item: Record<string, unknown> | undefined): RunnerEvent[] {
    if (!item) return [];
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "agentMessage") {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) return [];
      return [
        {
          kind: "harness.text",
          payload: { text: bound(this.sanitize(text), MAX_TEXT), parentToolUseId: null }
        }
      ];
    }
    if (type === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : "";
      const events: RunnerEvent[] = [];
      // A completion nothing announced still gets its row — a resumed or
      // rejoined thread replays completions without their starts.
      if (typeof item.id === "string" && !this.announced.has(item.id)) {
        events.push({
          kind: "harness.tool",
          payload: {
            tool: "Bash",
            detail: command ? bound(this.sanitize(command), MAX_LINE) : null,
            parentToolUseId: null,
            toolUseId: bound(item.id, MAX_LINE)
          }
        });
      }
      const category = command ? classifyCommand(command) : null;
      if (category) {
        const output = this.sanitize(typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "");
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        events.push({
          kind: "verification.observed",
          payload: {
            name: bound(this.sanitize(command), MAX_LINE),
            category,
            outcome: exitCode === 0 ? "passed" : "failed",
            command: bound(this.sanitize(command), MAX_LINE),
            output: output ? bound(output, MAX_OUTPUT) : null,
            truncated: output.length > MAX_OUTPUT
          }
        });
      }
      return events;
    }
    return [];
  }
}

// --- Outbound builders (pure): the exact lines the driver writes -------------

let rpcCounter = 0;
/** A fresh JSON-RPC id. Prefixed so a Novus id can never collide with a
 *  request id the server minted. */
export function nextRpcId(): string {
  rpcCounter += 1;
  return `novus-${rpcCounter}`;
}

export function initializeLine(id: string): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { clientInfo: { name: "novus", title: "Novus", version: "0.0.1" } }
  };
}

export const initializedLine = { jsonrpc: "2.0", method: "initialized" };

/**
 * The pinned thread (D-230, D-056's discipline in Codex's dialect): every act
 * asks (`untrusted`), the asks come to a person (`user`, never the CLI's own
 * `auto_review`), and the sandbox is the access — a read-alongside turn gets
 * `read-only`, which makes D-095's containment structural here.
 */
export function threadStartLine(
  id: string,
  input: {
    cwd: string;
    model: string;
    effort: string;
    readOnly: boolean;
    instructions: string | null;
    config?: Record<string, unknown> | null;
  }
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "thread/start",
    params: {
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: input.readOnly ? "read-only" : "workspace-write",
      ...(input.instructions ? { developerInstructions: input.instructions } : {}),
      ...(input.config ? { config: input.config } : {})
    }
  };
}

export function threadResumeLine(
  id: string,
  threadId: string,
  input: { cwd: string; model: string; readOnly: boolean; config?: Record<string, unknown> | null }
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "thread/resume",
    params: {
      threadId,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: input.readOnly ? "read-only" : "workspace-write",
      ...(input.config ? { config: input.config } : {})
    }
  };
}

export function turnStartLine(
  id: string,
  threadId: string,
  input: { direction: string; model: string; effort: string; serviceTier?: string | null }
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: input.direction }],
      model: input.model,
      effort: input.effort,
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {})
    }
  };
}

export function turnInterruptLine(id: string, threadId: string): object {
  return { jsonrpc: "2.0", id, method: "turn/interrupt", params: { threadId } };
}

/** A direction steered into the live turn (D-231): the send box's own
 *  mid-turn meaning, delivered rather than queued. `expectedTurnId` is the
 *  protocol's precondition — a stale steer fails instead of landing in a
 *  turn the person never saw. */
export function turnSteerLine(id: string, threadId: string, expectedTurnId: string, text: string): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "turn/steer",
    params: { threadId, expectedTurnId, input: [{ type: "text", text }] }
  };
}

/** A native continuation (D-231): the new session's first turn opens on a
 *  fork of the source thread, under the same pinned parameters. */
export function threadForkLine(
  id: string,
  threadId: string,
  input: { cwd: string; model: string; readOnly: boolean; config?: Record<string, unknown> | null }
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "thread/fork",
    params: {
      threadId,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: input.readOnly ? "read-only" : "workspace-write",
      ...(input.config ? { config: input.config } : {})
    }
  };
}

/** Codex's reviewer, inline on this thread (D-231): its findings stream as
 *  ordinary items, so the room renders a review turn as the turn it is. */
export function reviewStartLine(id: string, threadId: string): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "review/start",
    params: { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" }
  };
}

/**
 * One approval, answered in its request's own decision grammar. Accept or
 * decline and nothing else: `acceptForSession` and the execpolicy amendment
 * are standing grants nobody gave (D-056's rule, Codex's dialect).
 */
export function approvalResponseLine(
  requestId: string,
  kind: CodexApprovalKind,
  allow: boolean
): object {
  const id: string | number = /^\d+$/.test(requestId) ? Number(requestId) : requestId;
  return { jsonrpc: "2.0", id, result: { decision: allow ? "accept" : "decline" } };
}
