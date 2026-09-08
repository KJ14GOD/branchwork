import { MAX_APPROVAL_SUMMARY, MAX_ATTACHMENT_BYTES, type RunnerEvent } from "@novus/contracts";
import { classifyCommand, type HarnessControlMessage, type HarnessResult } from "./harness-stream";
import type { HarnessEventStream } from "./harness-adapter";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bound = (value: string, limit = 400) => value.slice(0, limit);
const names: Record<string, string> = {
  bash: "Bash", edit: "Edit", write: "Write", apply_patch: "Edit", read: "Read",
  glob: "Glob", grep: "Grep", webfetch: "WebFetch", websearch: "WebSearch",
  task: "Task", skill: "Skill", todowrite: "TodoWrite", lsp: "LSP"
};

/** OpenCode 1.18.29's /event SSE dialect, observed from the installed /doc.
 * Only structured completed parts become speech or evidence. Permission
 * metadata's diff/file contents never leave the process (D-246). */
export class OpenCodeStream implements HarnessEventStream {
  sessionId: string | null = null;
  resumed = false;
  result: HarnessResult | null = null;
  private buffer = "";
  private readonly sessions = new Set<string>();
  private readonly assistantMessages = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly announced = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly taskTargets = new Map<string, string | null>();

  constructor(private readonly options: {
    resumeSessionId?: string | null;
    sanitize?: (text: string) => string;
    onControl?: (message: HarnessControlMessage) => void;
    contextWindow?: number | null;
  } = {}) {}

  private clean(value: string, limit = 400): string { return bound(this.options.sanitize?.(value) ?? value, limit); }

  open(sessionId: string): RunnerEvent[] {
    this.sessionId = sessionId;
    this.sessions.add(sessionId);
    this.resumed = sessionId === this.options.resumeSessionId;
    return [{ kind: "harness.session", payload: { sessionId, resumed: this.resumed } }];
  }

  push(chunk: string): RunnerEvent[] {
    this.buffer += chunk;
    // A user file-part event can echo one permitted attachment as base64.
    // Bound each frame without rejecting several frames in the same chunk.
    const limit = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 2_000_000;
    const frames = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = frames.pop() ?? "";
    if (this.buffer.length > limit || frames.some((frame) => frame.length > limit)) throw new Error("OpenCode emitted an oversized event; supervision stopped.");
    return frames.flatMap((frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return [];
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("OpenCode emitted invalid event JSON; supervision stopped."); }
      return this.consume(event);
    });
  }

  end(): RunnerEvent[] { this.buffer = ""; return []; }

  answered(requestId: string): void { this.pending.delete(requestId); }

  registerChild(sessionId: string, parentId: string): boolean {
    if (!this.sessions.has(parentId)) return false;
    this.sessions.add(sessionId);
    return true;
  }

  consume(value: unknown): RunnerEvent[] {
    const event = row(value);
    const properties = row(event.properties);
    if (event.type === "session.created") {
      const info = row(properties.info);
      if (typeof info.id === "string" && typeof info.parentID === "string") this.registerChild(info.id, info.parentID);
      return [];
    }
    const info = row(properties.info);
    const part = row(properties.part);
    const session = string(properties.sessionID ?? info.sessionID ?? part.sessionID);
    if (!session || !this.sessions.has(session)) return [];
    if (this.completed.size > 50000) throw new Error("OpenCode exceeded the event tracking bound.");
    switch (event.type) {
      case "message.updated": return this.message(info);
      case "message.part.updated": return this.part(part);
      case "permission.asked": return this.permission(properties);
      case "permission.replied": {
        const id = string(properties.requestID);
        if (!id || !this.pending.delete(id)) return [];
        // Rejecting one OpenCode question also rejects its siblings. Cancel
        // any still-pending Novus cards; an answered card ignores cancellation.
        return [{ kind: "approval.cancelled", payload: { requestId: id, reason: "OpenCode settled this permission request." } }];
      }
      case "question.asked": {
        const id = string(properties.id);
        if (id) this.options.onControl?.({ kind: "unsupported", requestId: id, subtype: "question" });
        return [];
      }
      case "session.error": {
        if (session === this.sessionId) this.fail(row(properties.error));
        return [];
      }
      default: return [];
    }
  }

  private fail(error: Row): void {
    const data = row(error.data);
    this.result = { isError: true, subtype: "error", message: this.clean(string(data.message ?? error.message ?? error.name) ?? "OpenCode reported an error.", 2000) };
  }

  /** The HTTP prompt response is the completed turn, not an idle heartbeat. */
  finish(value: unknown): RunnerEvent[] {
    const response = row(value);
    const info = row(response.info);
    if (info.sessionID !== this.sessionId || info.role !== "assistant") return [];
    const events = this.message(info);
    for (const part of Array.isArray(response.parts) ? response.parts : []) events.push(...this.part(row(part), true));
    if (info.error) this.fail(row(info.error));
    else if (typeof info.finish === "string" && info.finish !== "tool-calls" && info.finish !== "unknown" && count(row(info.time).completed) !== null) {
      this.result = info.finish === "length"
        ? { isError: false, subtype: "error_max_turns", message: null }
        : { isError: false, subtype: "success", message: null };
    }
    return events;
  }

  private message(info: Row): RunnerEvent[] {
    const id = string(info.id);
    if (!id || info.role !== "assistant") return [];
    this.assistantMessages.add(id);
    if (count(row(info.time).completed) === null || this.completed.has(`usage:${id}`)) return [];
    this.completed.add(`usage:${id}`);
    if (info.error && info.sessionID === this.sessionId) this.fail(row(info.error));
    const tokens = row(info.tokens);
    const cache = row(tokens.cache);
    const input = count(tokens.input), read = count(cache.read), write = count(cache.write);
    const output = count(tokens.output), reasoning = count(tokens.reasoning);
    const main = info.sessionID === this.sessionId;
    return [{ kind: "harness.usage", payload: {
      inputTokens: input, outputTokens: output === null && reasoning === null ? null : (output ?? 0) + (reasoning ?? 0),
      cacheReadTokens: read, cacheCreationTokens: write, costUsd: count(info.cost),
      durationMs: null, turns: 1,
      contextTokens: main && input !== null ? input + (read ?? 0) + (write ?? 0) : null,
      contextWindow: main ? this.options.contextWindow ?? null : null
    } }];
  }

  private part(part: Row, final = false): RunnerEvent[] {
    const id = string(part.id), message = string(part.messageID);
    if (!id || !message || !this.assistantMessages.has(message) || this.completed.has(id)) return [];
    const parentToolUseId = part.sessionID === this.sessionId ? null : bound(`opencode-session:${part.sessionID}`);
    if (part.type === "text") {
      if (!final && count(row(part.time).end) === null) return [];
      this.completed.add(id);
      const text = string(part.text);
      return text?.trim() ? [{ kind: "harness.text", payload: { text: this.clean(text, 8000), parentToolUseId } }] : [];
    }
    if (part.type !== "tool") return [];
    const state = row(part.state), input = row(state.input), metadata = row(state.metadata);
    const tool = string(part.tool) ?? "unknown";
    const toolUseId = bound(string(part.callID) ?? id);
    if (tool === "task" && state.status === "running") {
      this.taskTargets.set(toolUseId, string(input.task_id));
    }
    const events: RunnerEvent[] = [];
    if (state.status !== "pending" && !this.announced.has(id)) {
      this.announced.add(id);
      const detail = string(input.command ?? input.filePath ?? input.path ?? input.description ?? input.url ?? state.title);
      events.push({ kind: "harness.tool", payload: {
        tool: names[tool] ?? this.clean(tool), detail: detail ? this.clean(detail) : null,
        toolUseId, parentToolUseId
      } });
    }
    if (state.status !== "completed" && state.status !== "error") return events;
    this.completed.add(id);
    if (tool === "bash") {
      const command = string(input.command);
      const category = command ? classifyCommand(command) : null;
      const exit = typeof metadata.exit === "number" ? metadata.exit : null;
      // No exit figure is no verdict. A tool's completed state alone does
      // not prove its shell command succeeded.
      if (command && category && exit !== null) {
        const output = this.clean(string(state.output ?? state.error) ?? "", 4000);
        events.push({ kind: "verification.observed", payload: {
          name: this.clean(command), command: this.clean(command), category,
          outcome: exit === 0 ? "passed" : "failed", output: output || null,
          truncated: (string(state.output)?.length ?? 0) > 4000
        } });
      }
    }
    return events;
  }

  private permission(properties: Row): RunnerEvent[] {
    const requestId = string(properties.id), permission = string(properties.permission);
    if (!requestId || !permission || this.pending.has(requestId)) return [];
    this.pending.add(requestId);
    const metadata = row(properties.metadata);
    const patterns = (Array.isArray(properties.patterns) ? properties.patterns : []).filter((item): item is string => typeof item === "string");
    const file = string(metadata.filepath);
    const files = Array.isArray(metadata.files) ? metadata.files.map((f) => string(row(f).filePath)).filter((f): f is string => f !== null) : [];
    const toolName = names[permission] ?? bound(`mcp__opencode__${permission}`);
    const summary = this.clean(permission === "edit" ? (files.length ? files : file ? [file] : patterns).join(", ") : patterns.join(", ") || permission, MAX_APPROVAL_SUMMARY);
    const toolUseId = string(row(properties.tool).callID);
    if (permission === "task") {
      // OpenCode accepts an arbitrary persisted task_id. A grant to launch
      // a subagent must not resume a foreign session with saved permissions.
      if (!toolUseId || !this.taskTargets.has(toolUseId)) throw new Error("OpenCode did not expose the task target before asking permission.");
      const target = this.taskTargets.get(toolUseId);
      if (target && (target === this.sessionId || !this.sessions.has(target))) throw new Error("OpenCode cannot resume a task outside this supervised conversation.");
    }
    this.options.onControl?.({ kind: "approval", requestId, toolUseId, toolName,
      displayName: toolName, summary,
      // Patterns can be globs. Only the request's explicit metadata paths
      // may auto-authorize an edit inside a session's scope.
      targetPaths: permission === "edit" ? (files.length ? files : file ? [file] : []) : []
    });
    return [
      { kind: "approval.requested", payload: { requestId, toolUseId, toolName, displayName: toolName, summary } },
      { kind: "boundary.reached", payload: { reason: "permission prompt pending" } }
    ];
  }
}
