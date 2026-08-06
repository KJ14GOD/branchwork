import { MAX_APPROVAL_SUMMARY, type RunnerEvent } from "@novus/contracts";

/** The contract owns the vocabulary; these read it rather than restate it. */
type VerificationEvent = Extract<RunnerEvent, { kind: "verification.observed" }>;
type CheckCategory = VerificationEvent["payload"]["category"];
type CheckOutcome = VerificationEvent["payload"]["outcome"];

/**
 * The Claude Code adapter's inward half: `--output-format stream-json
 * --verbose` NDJSON in, Novus runner events out (ARCHITECTURE.md#harness-protocol).
 *
 * Pure on purpose — no Electron, no filesystem, no clock — so the parsing rules
 * that decide what the room is told can be tested exhaustively. Two rules carry
 * the product's weight:
 *
 *  - The harness speaks only through structured blocks it actually emitted.
 *    Assistant prose is never promoted into evidence: "tests pass" in a
 *    sentence is text, and a check is recorded only from a real tool result.
 *  - A malformed line is noise, never a fatal error. The CLI shares stdout with
 *    whatever a tool prints.
 *  - **Control is not transcript.** `control_request` and `control_response`
 *    share the same stdout as the conversation (D-056). They are lifted off it
 *    here and handed to the caller as typed control traffic; not one character
 *    of a control message can become `harness.text`, because the only branch
 *    that produces prose reads assistant content blocks.
 */

/** Contract ceilings (packages/contracts): bounded text, bounded lines. */
const MAX_TEXT = 8_000;
const MAX_LINE = 400;
const MAX_OUTPUT = 4_000;
/** Correlation memory for tool calls awaiting their result. A turn with a
 *  runaway number of tool calls must not grow this without bound. */
const MAX_PENDING_TOOLS = 256;

function bound(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export interface HarnessResult {
  isError: boolean;
  subtype: string;
  message: string | null;
}

/**
 * One permission question the harness is blocked on (D-056).
 *
 * `summary` is built from named fields and bounded. The raw tool input is
 * deliberately absent from this shape: it can be a whole file's contents, and
 * everything downstream of here is durable, distributed, and projected into
 * receipts.
 */
export interface HarnessApprovalRequest {
  kind: "approval";
  /** The harness's own correlation id; the answer names it back. */
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  displayName: string;
  summary: string;
}

/**
 * A control request Novus does not know how to answer. It still has to be
 * answered — the CLI blocks on the ones it sends — so the caller replies with
 * an error rather than leaving the turn wedged on silence.
 */
export interface HarnessUnknownControlRequest {
  kind: "unsupported";
  requestId: string;
  subtype: string;
}

/** The CLI's own answer to something Novus sent it, such as an interrupt. */
export interface HarnessControlAcknowledgement {
  kind: "acknowledgement";
  requestId: string;
  ok: boolean;
}

export type HarnessControlMessage =
  | HarnessApprovalRequest
  | HarnessUnknownControlRequest
  | HarnessControlAcknowledgement;

export interface HarnessStreamOptions {
  /** The session this turn asked to continue. A different id coming back means
   *  continuity was lost, and the event says so rather than implying it held. */
  resumeSessionId?: string | null;
  /** Replaces machine-local paths before anything leaves this process (D-032). */
  sanitize?: (text: string) => string;
  /** Where control traffic goes instead of into the transcript. Absent in the
   *  parsing tests, which assert only that it never becomes prose. */
  onControl?: (message: HarnessControlMessage) => void;
}

interface PendingTool {
  name: string;
  command: string | null;
}

interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: unknown };
  request_id?: string;
  request?: ControlRequestBody;
  response?: { subtype?: string; request_id?: string };
  /**
   * Set by the CLI on messages produced by one of its **own** subagents, naming
   * the tool call that spawned it (`--forward-subagent-text`). Null or absent
   * on everything the harness itself says.
   */
  parent_tool_use_id?: string | null;
  /** Present on the final `result` line: what the turn cost. */
  total_cost_usd?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

/** A count the harness reported, or null. Never a zero standing in for a
 *  figure that was not given: "not reported" and "none" are different. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Same rule, for a figure that is not a whole number. */
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The `can_use_tool` request the CLI blocks on, as observed against 2.1.221. */
interface ControlRequestBody {
  subtype?: string;
  tool_name?: string;
  display_name?: string;
  description?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  /** The CLI's suggestions for widening permission — `setMode acceptEdits`,
   *  `addRules … localSettings`. Read and deliberately discarded: applying one
   *  would turn a single approval into a standing grant nobody gave (D-056). */
  permission_suggestions?: unknown;
}

/**
 * Conservative command classification. A check is recorded only when the
 * command text plainly says what it is; anything ambiguous produces no check
 * at all, because a wrong category is worse than a missing one (PRODUCT.md
 * principle 3).
 */
export function classifyCommand(command: string): CheckCategory | null {
  const text = command.toLowerCase();
  if (/(^|[\s;&|])(vitest|jest|pytest|rspec|phpunit)\b/.test(text)) return "test";
  if (/\bgo test\b/.test(text)) return "test";
  if (/\bcargo test\b/.test(text)) return "test";
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(text)) return "test";
  if (/(^|[\s;&|])(tsc|mypy|pyright)\b/.test(text)) return "typecheck";
  if (/\btype-?check\b/.test(text)) return "typecheck";
  if (/(^|[\s;&|])(eslint|ruff|rubocop|flake8|clippy)\b/.test(text)) return "lint";
  if (/\blint\b/.test(text)) return "lint";
  if (/\bbuild\b/.test(text)) return "build";
  return null;
}

/** Outcome comes from the tool result's own error flag, never from prose. */
function outcomeOf(isError: boolean): CheckOutcome {
  return isError ? "failed" : "passed";
}

/** A tool result's content is either a string or a list of content blocks. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && typeof (block as StreamBlock).text === "string") {
        return (block as StreamBlock).text as string;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One short, honest line about what the tool was pointed at. */
function detailOf(tool: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const candidates =
    tool === "Bash"
      ? ["command"]
      : tool === "Grep" || tool === "Glob"
        ? ["pattern", "query"]
        : ["file_path", "path", "notebook_path", "url", "description", "prompt"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export class HarnessStream {
  private buffer = "";
  private readonly pending = new Map<string, PendingTool>();
  private readonly resumeSessionId: string | null;
  private readonly sanitize: (text: string) => string;
  private readonly onControl: (message: HarnessControlMessage) => void;
  private observedSessionId: string | null = null;
  private observedResumed = false;
  private observedResult: HarnessResult | null = null;

  constructor(options: HarnessStreamOptions = {}) {
    this.resumeSessionId = options.resumeSessionId ?? null;
    this.sanitize = options.sanitize ?? ((text) => text);
    this.onControl = options.onControl ?? (() => undefined);
  }

  /** The session the harness actually used, once it has said so. */
  get sessionId(): string | null {
    return this.observedSessionId;
  }

  /** True only when the harness confirmed the session this turn asked for. */
  get resumed(): boolean {
    return this.observedResumed;
  }

  /** The CLI's own final verdict, which classification reads. */
  get result(): HarnessResult | null {
    return this.observedResult;
  }

  push(chunk: string): RunnerEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // The last element is whatever arrived without its newline yet.
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.consume(line));
  }

  /** Flushes the final line, which a stream that ended without a newline still
   *  owes us — dropping it would lose the result event of a whole turn. */
  end(): RunnerEvent[] {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder.trim() ? this.consume(remainder) : [];
  }

  private consume(line: string): RunnerEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let parsed: StreamLine;
    try {
      parsed = JSON.parse(trimmed) as StreamLine;
    } catch {
      // Tool output and CLI notices share stdout; unparseable is not fatal.
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];

    switch (parsed.type) {
      case "system":
        return this.consumeSystem(parsed);
      case "assistant":
        return this.consumeAssistant(parsed);
      case "user":
        return this.consumeUser(parsed);
      case "control_request":
        return this.consumeControlRequest(parsed);
      case "control_response":
        this.consumeControlResponse(parsed);
        return [];
      case "result":
        this.observedResult = {
          isError: parsed.is_error === true,
          subtype: typeof parsed.subtype === "string" ? parsed.subtype : "unknown",
          message: typeof parsed.result === "string" ? this.sanitize(parsed.result) : null
        };
        return this.consumeUsage(parsed);
      default:
        return [];
    }
  }

  /**
   * A permission question, lifted off the transcript.
   *
   * The only durable text this produces is `summary`, composed from the tool's
   * own named fields — `Bash.command`, a file path, a description — and then
   * bounded and sanitized. The whole `input` object is read and dropped: a
   * `Write` carries the file's entire contents in it, and a durable row shown
   * to every participant is the last place that belongs.
   */
  private consumeControlRequest(parsed: StreamLine): RunnerEvent[] {
    const requestId = typeof parsed.request_id === "string" ? parsed.request_id : "";
    const request = parsed.request;
    if (!requestId || !request || typeof request !== "object") return [];
    if (request.subtype !== "can_use_tool") {
      // Something Novus cannot answer. It is still reported to the caller, which
      // replies with an error — the CLI blocks on what it sends, so silence
      // here would wedge the turn rather than ignore a message.
      this.onControl({
        kind: "unsupported",
        requestId,
        subtype: typeof request.subtype === "string" ? bound(request.subtype, MAX_LINE) : "unknown"
      });
      return [];
    }
    const toolName = typeof request.tool_name === "string" && request.tool_name ? request.tool_name : "tool";
    const displayName =
      typeof request.display_name === "string" && request.display_name ? request.display_name : toolName;
    const detail = detailOf(toolName, request.input);
    const description = typeof request.description === "string" ? request.description.trim() : "";
    // The CLI's `description` is often the tail of what `detail` already says —
    // a path and then its own basename. Repeating it makes the one sentence a
    // person reads to decide worse, not more complete.
    const adds =
      description.length > 0 && detail !== null && detail.length > 0
        ? !detail.includes(description)
        : description.length > 0;
    const parts = [detail, adds ? description : ""].filter(
      (part): part is string => typeof part === "string" && part.length > 0
    );
    const summary = bound(
      this.sanitize(parts.length > 0 ? parts.join(" — ") : displayName),
      MAX_APPROVAL_SUMMARY
    );
    const approval: HarnessApprovalRequest = {
      kind: "approval",
      requestId,
      toolUseId: typeof request.tool_use_id === "string" ? bound(request.tool_use_id, MAX_LINE) : null,
      toolName: bound(this.sanitize(toolName), MAX_LINE),
      displayName: bound(this.sanitize(displayName), MAX_LINE),
      summary
    };
    this.onControl(approval);
    return [
      {
        kind: "approval.requested",
        payload: {
          requestId: bound(requestId, MAX_LINE),
          toolUseId: approval.toolUseId,
          toolName: approval.toolName,
          displayName: approval.displayName,
          summary
        }
      },
      // A pending permission prompt **is** a safe execution boundary — PRODUCT.md
      // names it as one alongside turn-complete, paused, and terminal — and only
      // the runner can declare one, because only the runner knows harness state.
      // Without this a mission blocked on an approval would hold an accepted
      // control handoff open indefinitely: the recipient could not answer the
      // question, and the question is what the turn is waiting on.
      { kind: "boundary.reached", payload: { reason: "permission prompt pending" } }
    ];
  }

  /** The CLI answering something Novus sent it — an interrupt, in practice. */
  private consumeControlResponse(parsed: StreamLine): void {
    const response = parsed.response;
    const requestId = typeof response?.request_id === "string" ? response.request_id : "";
    if (!requestId) return;
    this.onControl({ kind: "acknowledgement", requestId, ok: response?.subtype === "success" });
  }

  /**
   * What the turn cost, off the CLI's own final line.
   *
   * Observed against `claude 2.1.223`: `total_cost_usd`, `duration_ms`,
   * `num_turns`, and a `usage` object carrying input, output, and both cache
   * counts. Reported as the harness's claim and nothing more — Novus bills
   * nothing from it and stops nothing because of it (ARCHITECTURE.md#harness-protocol).
   * A line carrying none of them produces no event, rather than a row of zeros
   * that would read as a free turn.
   */
  private consumeUsage(parsed: StreamLine): RunnerEvent[] {
    const usage = parsed.usage ?? {};
    const payload = {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheCreationTokens: count(usage.cache_creation_input_tokens),
      costUsd: amount(parsed.total_cost_usd),
      durationMs: count(parsed.duration_ms),
      turns: count(parsed.num_turns)
    };
    if (Object.values(payload).every((value) => value === null)) return [];
    return [{ kind: "harness.usage", payload }];
  }

  private consumeSystem(parsed: StreamLine): RunnerEvent[] {
    if (parsed.subtype !== "init" || typeof parsed.session_id !== "string") return [];
    const sessionId = parsed.session_id;
    if (this.observedSessionId === sessionId) return [];
    this.observedSessionId = sessionId;
    this.observedResumed = this.resumeSessionId !== null && this.resumeSessionId === sessionId;
    return [
      {
        kind: "harness.session",
        payload: { sessionId: bound(sessionId, MAX_LINE), resumed: this.observedResumed }
      }
    ];
  }

  private consumeAssistant(parsed: StreamLine): RunnerEvent[] {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return [];
    // Whose words these are. The harness's own subagents speak on this same
    // stream when forwarding is on, and their text is *activity*, not the
    // answer the room is waiting for — so it is tagged rather than mixed in.
    const parentToolUseId = this.parentOf(parsed);
    const events: RunnerEvent[] = [];
    for (const raw of content) {
      const block = raw as StreamBlock;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({
          kind: "harness.text",
          payload: { text: bound(this.sanitize(block.text), MAX_TEXT), parentToolUseId }
        });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const tool = typeof block.name === "string" && block.name ? block.name : "tool";
      const detail = detailOf(tool, block.input);
      if (typeof block.id === "string") {
        this.remember(block.id, {
          name: tool,
          command: tool === "Bash" && typeof detail === "string" ? detail : null
        });
      }
      events.push({
        kind: "harness.tool",
        payload: {
          tool: bound(tool, MAX_LINE),
          detail: detail === null ? null : bound(this.sanitize(detail), MAX_LINE),
          parentToolUseId
        }
      });
    }
    return events;
  }

  /** The tool call that spawned whoever produced this line, when the harness
   *  says one did. Bounded like every other line the harness hands over. */
  private parentOf(parsed: StreamLine): string | null {
    const parent = parsed.parent_tool_use_id;
    return typeof parent === "string" && parent.trim() ? bound(parent, MAX_LINE) : null;
  }

  private consumeUser(parsed: StreamLine): RunnerEvent[] {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return [];
    const events: RunnerEvent[] = [];
    for (const raw of content) {
      const block = raw as StreamBlock;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const call = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      // Only a shell command Novus can name is evidence; everything else was
      // the harness working, which the tool line already reported.
      if (!call?.command) continue;
      const category = classifyCommand(call.command);
      if (!category) continue;
      const output = this.sanitize(textOfContent(block.content));
      events.push({
        kind: "verification.observed",
        payload: {
          name: bound(call.command, MAX_LINE),
          category,
          outcome: outcomeOf(block.is_error === true),
          command: bound(this.sanitize(call.command), MAX_LINE),
          output: output ? bound(output, MAX_OUTPUT) : null,
          truncated: output.length > MAX_OUTPUT
        }
      });
    }
    return events;
  }

  private remember(id: string, call: PendingTool): void {
    if (this.pending.size >= MAX_PENDING_TOOLS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(id, call);
  }
}
