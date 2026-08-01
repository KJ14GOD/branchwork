import type { SessionEventDraft } from "@novus/contracts";

/**
 * Claude Code's stream-json, turned into Novus events.
 *
 * Pure and separately testable on purpose: the subprocess is the risky part of
 * this adapter, and the mapping is the part most likely to be quietly wrong.
 * Keeping them apart means the mapping can be pinned against recorded output
 * without spawning anything or spending anything.
 *
 * The shapes below were read off a real `claude -p --output-format stream-json
 * --input-format stream-json` session, not from documentation:
 *
 *   system/init      → tools, model, session id, permission mode
 *   assistant        → message.content[]: text blocks and tool_use blocks
 *   user             → message.content[]: tool_result blocks, with is_error
 *   result           → subtype success|error_*, usage, total_cost_usd
 *   rate_limit_event → status and reset time
 *
 * Nothing here maps a Claude Code tool onto a Novus tool name. `Edit` is not
 * `apply_patch`: the second means "this crossed Novus's approval gate", and
 * for an external harness nothing did. Every action lands in the
 * `harness.activity` family, which promises exactly that much.
 */

/** What the mapper needs to know that a single line does not carry. */
export type StreamContext = {
  sessionId: string;
  actorId: string;
  runId: string;
};

/** Anything the mapper wants to tell the caller besides an event to append. */
export type StreamSignal =
  | { kind: "init"; model: string | null; tools: readonly string[] }
  | { kind: "turn-ended"; ok: boolean; message: string | null; costUsd: number | null };

export type StreamEmission = {
  events: SessionEventDraft[];
  signals: StreamSignal[];
};

const EMPTY: StreamEmission = { events: [], signals: [] };

/**
 * A rough class for an icon and a filter, never for a decision.
 *
 * Explicitly not a permission check. Novus's gate is not in the path for an
 * external harness — that is what `approvals: "harness-internal"` declares —
 * and using this to gate anything would be a guard that reads a label the
 * child process chose for itself.
 */
export const classifyTool = (
  name: string,
): "unknown" | "read" | "search" | "edit" | "execute" | "network" | "other" => {
  switch (name) {
    case "Read":
    case "NotebookRead":
    case "Glob":
      return "read";
    case "Grep":
      return "search";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "WebFetch":
    case "WebSearch":
      return "network";
    default:
      return name.startsWith("mcp__") || name === "Task" || name === "TodoWrite"
        ? "other"
        : "unknown";
  }
};

const CAP = 2_000;

const cap = (value: string): { text: string; truncated: boolean } =>
  value.length <= CAP
    ? { text: value, truncated: false }
    : { text: value.slice(0, CAP), truncated: true };

/** A one-line human summary of a tool's input, without inventing detail. */
const summarise = (name: string, input: unknown): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const first =
    record["file_path"] ??
    record["path"] ??
    record["command"] ??
    record["pattern"] ??
    record["url"] ??
    record["description"];

  if (typeof first !== "string" || first.length === 0) {
    return null;
  }

  return cap(first).text;
};

/** Paths a tool's input names. Claimed by the harness, never verified here. */
const claimedPaths = (input: unknown): string[] => {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const record = input as Record<string, unknown>;
  const path = record["file_path"] ?? record["path"];

  return typeof path === "string" && path.length > 0 ? [path] : [];
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text ?? "")
        : "",
    )
    .join("");
};

/**
 * One parsed line in, zero or more events out.
 *
 * Returns emissions rather than appending, so the caller owns ordering and the
 * mapper stays a function of its input — which is what makes it testable
 * against a recorded stream.
 */
export const mapStreamLine = (
  line: unknown,
  context: StreamContext,
): StreamEmission => {
  if (typeof line !== "object" || line === null || !("type" in line)) {
    return EMPTY;
  }

  const event = line as Record<string, unknown>;
  const base = {
    sessionId: context.sessionId,
    actorId: context.actorId,
  } as const;

  switch (event["type"]) {
    case "system": {
      if (event["subtype"] !== "init") {
        return EMPTY;
      }

      const model = event["model"];
      const tools = event["tools"];

      return {
        events: [],
        signals: [
          {
            kind: "init",
            model: typeof model === "string" ? model : null,
            tools: Array.isArray(tools) ? tools.map(String) : [],
          },
        ],
      };
    }

    case "assistant": {
      const message = event["message"] as Record<string, unknown> | undefined;
      const content = message?.["content"];

      if (!Array.isArray(content)) {
        return EMPTY;
      }

      const events: SessionEventDraft[] = [];

      for (const raw of content) {
        const block = raw as Record<string, unknown>;

        if (block["type"] === "text") {
          const text = String(block["text"] ?? "").trim();

          if (text.length > 0) {
            const held = cap(text);

            events.push({
              ...base,
              type: "harness.output",
              payload: {
                runId: context.runId,
                text: held.text,
                truncated: held.truncated,
              },
            });
          }
        }

        if (block["type"] === "tool_use") {
          const name = String(block["name"] ?? "tool");
          const summary = summarise(name, block["input"]);

          events.push({
            ...base,
            type: "harness.activity",
            payload: {
              runId: context.runId,
              callId: String(block["id"] ?? `${context.runId}-${events.length}`),
              name,
              class: classifyTool(name),
              summary,
              status: "started",
              claimedPaths: claimedPaths(block["input"]),
            },
          });
        }
      }

      return { events, signals: [] };
    }

    case "user": {
      // The other half of a tool call, under the same callId. Never terminal:
      // a tool that errored is a row on the timeline, not the end of a run.
      const message = event["message"] as Record<string, unknown> | undefined;
      const content = message?.["content"];

      if (!Array.isArray(content)) {
        return EMPTY;
      }

      const events: SessionEventDraft[] = [];

      for (const raw of content) {
        const block = raw as Record<string, unknown>;

        if (block["type"] !== "tool_result") {
          continue;
        }

        const failed = block["is_error"] === true;
        const detail = textOf(block["content"]).trim();

        events.push({
          ...base,
          type: "harness.activity",
          payload: {
            runId: context.runId,
            callId: String(block["tool_use_id"] ?? "unknown"),
            // The outcome half does not restate the tool's name; the started
            // half already did, and inventing one here would create a second
            // action in any reader that groups by name rather than by id.
            name: failed ? "failed" : "ok",
            class: "unknown",
            summary: detail.length > 0 ? cap(detail).text : null,
            status: failed ? "failed" : "completed",
            claimedPaths: [],
          },
        });
      }

      return { events, signals: [] };
    }

    case "result": {
      const ok = event["subtype"] === "success" && event["is_error"] !== true;
      const message = event["result"];
      const cost = event["total_cost_usd"];

      return {
        events: [],
        signals: [
          {
            kind: "turn-ended",
            ok,
            message: typeof message === "string" && message.length > 0
              ? cap(message).text
              : null,
            costUsd: typeof cost === "number" ? cost : null,
          },
        ],
      };
    }

    case "rate_limit_event": {
      const info = event["rate_limit_info"] as Record<string, unknown> | undefined;

      // Worth saying out loud: a run that stalls on a rate limit looks
      // identical to one that is thinking, and the person waiting deserves to
      // know which it is.
      if (info?.["status"] === "allowed") {
        return EMPTY;
      }

      return {
        events: [
          {
            ...base,
            type: "run.progress",
            payload: {
              runId: context.runId,
              message: `Rate limited by the provider (${String(info?.["rateLimitType"] ?? "unknown window")}).`,
            },
          },
        ],
        signals: [],
      };
    }

    default:
      return EMPTY;
  }
};

/**
 * Splits a chunked stdout stream into whole JSON lines.
 *
 * A partial line at the end of a chunk is not an error and must not be parsed:
 * stdout arrives in whatever sizes the pipe chooses, and a naive parse-per-
 * chunk drops roughly every tool call in a busy turn.
 */
export class LineReader {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const parsed: unknown[] = [];

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        parsed.push(JSON.parse(line));
      } catch {
        // A line this build cannot read is not a reason to end a run. The
        // adapter keeps going; the worst case is a milestone nobody sees.
      }
    }

    return parsed;
  }
}
