import type { RunnerEvent } from "@novus/contracts";

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

export interface HarnessStreamOptions {
  /** The session this turn asked to continue. A different id coming back means
   *  continuity was lost, and the event says so rather than implying it held. */
  resumeSessionId?: string | null;
  /** Replaces machine-local paths before anything leaves this process (D-032). */
  sanitize?: (text: string) => string;
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
  private observedSessionId: string | null = null;
  private observedResumed = false;
  private observedResult: HarnessResult | null = null;

  constructor(options: HarnessStreamOptions = {}) {
    this.resumeSessionId = options.resumeSessionId ?? null;
    this.sanitize = options.sanitize ?? ((text) => text);
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
      case "result":
        this.observedResult = {
          isError: parsed.is_error === true,
          subtype: typeof parsed.subtype === "string" ? parsed.subtype : "unknown",
          message: typeof parsed.result === "string" ? this.sanitize(parsed.result) : null
        };
        return [];
      default:
        return [];
    }
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
    const events: RunnerEvent[] = [];
    for (const raw of content) {
      const block = raw as StreamBlock;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "harness.text", payload: { text: bound(this.sanitize(block.text), MAX_TEXT) } });
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
          detail: detail === null ? null : bound(this.sanitize(detail), MAX_LINE)
        }
      });
    }
    return events;
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
