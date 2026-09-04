import type { Readable, Writable } from "node:stream";
import { CODEX_MODELS } from "@novus/contracts";

/**
 * The editor behind the refinement (D-241): the machine's own coding agent
 * CLI, run headless on the person's existing login, so no key exists. Claude
 * Code first (`claude -p`, the fast model, no tools, no settings, no MCP,
 * no session kept), Codex when it is the one installed (`codex exec`,
 * read-only, no repository check). The ask and the guard are the same as
 * ever (`dictation-refine.ts`); this module only carries the words to the
 * CLI and back.
 *
 * Measured on 2026-09-02 against `claude 2.1.258`: `--bare` skips the
 * keychain login and answers "Not logged in", so it is deliberately absent;
 * the CLI's own start costs under half a second, and the rest of the wait
 * was the model thinking — turned off below, the edit answers in about two
 * seconds.
 */

export type EditorKind = "claude" | "codex";

export const CLAUDE_EDITOR_MODEL = "haiku";

/** The smallest Codex model the contract knows, for an editing job. */
export function codexEditorModel(): string {
  const mini = CODEX_MODELS.find((model) => /mini/i.test(model.id));
  return (mini ?? CODEX_MODELS[0])?.id ?? "gpt-5";
}

/** The exact invocation, pure so a test can read it. The user prompt rides
 *  stdin for Claude and the argument for Codex; `env` is what the child
 *  needs beyond the app's own environment. */
export function editorCommand(
  kind: EditorKind,
  model: string,
  system: string,
  user: string
): { command: string; args: string[]; stdin: string | null; env: Record<string, string> } {
  if (kind === "claude") {
    return {
      command: "claude",
      args: [
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format",
        "text",
        "--system-prompt",
        system
      ],
      stdin: user,
      // Measured 2026-09-02: the CLI turns extended thinking on by default,
      // and Haiku spent 20–60 seconds thinking about a transcript edit
      // (`--effort low` changed nothing: 23 s, 2,346 thinking tokens). With
      // thinking off the same edit answers in about two seconds, and reads
      // the same. An editing job needs no deliberation.
      env: { MAX_THINKING_TOKENS: "0" }
    };
  }
  return {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "-s", "read-only", "-m", model, `${system}\n\n${user}`],
    stdin: null,
    env: {}
  };
}

export interface EditorChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type EditorSpawn = (command: string, args: string[], env: Record<string, string>) => EditorChild;

/** Codex's exec prints its own progress before the answer; the answer is
 *  what follows the last blank line. Claude's print mode is the answer alone. */
export function editorAnswer(kind: EditorKind, stdout: string): string {
  const text = stdout.replace(/\r\n/g, "\n").trim();
  if (kind === "claude") return text;
  const blocks = text.split(/\n{2,}/);
  return (blocks.at(-1) ?? text).trim();
}

/** Runs the editor once. Resolves with its words, rejects with the CLI's
 *  own complaint when it did not answer. */
export function runEditor(args: {
  kind: EditorKind;
  model: string;
  system: string;
  user: string;
  spawn: EditorSpawn;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = editorCommand(args.kind, args.model, args.system, args.user);
    let child: EditorChild;
    try {
      child = args.spawn(invocation.command, invocation.args, invocation.env);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${invocation.command} did not answer within ${Math.round((args.timeoutMs ?? 90_000) / 1000)}s.`));
    }, args.timeoutMs ?? 90_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = editorAnswer(args.kind, stdout);
      if (code !== 0 || answer.length === 0) {
        const complaint = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ").trim();
        reject(new Error(complaint.length > 0 ? complaint : `${invocation.command} exited ${code ?? "without a code"}.`));
        return;
      }
      resolve(answer);
    });
    if (invocation.stdin !== null && child.stdin) {
      child.stdin.end(invocation.stdin);
    }
  });
}

// --- A warm session (D-242) --------------------------------------------------
// One print-mode process per take, speaking stream-json both ways, so each
// segment's edit costs the model's answer alone and not the CLI's start.
// Claude only: Codex's exec has no equivalent, and it falls back to one run
// per segment. Asks are answered one at a time, in order.

export interface EditorSession {
  ask(user: string): Promise<string>;
  close(): void;
  readonly alive: boolean;
}

/** The warm session's invocation, pure so a test can read it. */
export function editorSessionCommand(model: string, system: string): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: "claude",
    args: [
      "-p",
      "--model",
      model,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--system-prompt",
      system
    ],
    env: { MAX_THINKING_TOKENS: "0" }
  };
}

/** One user turn on the session's stdin, the CLI's own line shape. */
export function editorSessionLine(user: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: user }] } })}\n`;
}

/** The session's answer to one turn, read off its stdout: the `result`
 *  event carries the words; anything else is progress. */
export function readEditorSessionLine(line: string): { kind: "result"; text: string; error: string | null } | { kind: "other" } {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }
  if (event.type !== "result") return { kind: "other" };
  const text = typeof event.result === "string" ? event.result : "";
  if (event.is_error === true) return { kind: "result", text: "", error: text || "The editor reported an error." };
  return { kind: "result", text, error: null };
}

export function openEditorSession(args: { model: string; system: string; spawn: EditorSpawn; askTimeoutMs?: number }): EditorSession {
  const invocation = editorSessionCommand(args.model, args.system);
  const child = args.spawn(invocation.command, invocation.args, invocation.env);
  let alive = true;
  let carry = "";
  const queue: { user: string; resolve: (text: string) => void; reject: (error: Error) => void }[] = [];
  let current: { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  const failAll = (reason: string) => {
    const error = new Error(reason);
    if (current) {
      clearTimeout(current.timer);
      current.reject(error);
      current = null;
    }
    for (const waiting of queue.splice(0)) waiting.reject(error);
  };
  const next = () => {
    if (current || queue.length === 0 || !alive) return;
    const ask = queue.shift()!;
    const timer = setTimeout(() => {
      if (!current) return;
      current = null;
      ask.reject(new Error(`The editor did not answer within ${Math.round((args.askTimeoutMs ?? 60_000) / 1000)}s.`));
      next();
    }, args.askTimeoutMs ?? 60_000);
    current = { resolve: ask.resolve, reject: ask.reject, timer };
    try {
      child.stdin?.write(editorSessionLine(ask.user));
    } catch (error) {
      clearTimeout(timer);
      current = null;
      ask.reject(error instanceof Error ? error : new Error(String(error)));
      next();
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const read = readEditorSessionLine(line);
      if (read.kind !== "result" || !current) continue;
      clearTimeout(current.timer);
      const settled = current;
      current = null;
      if (read.error !== null) settled.reject(new Error(read.error));
      else settled.resolve(read.text.trim());
      next();
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => undefined);
  child.on("error", (error) => {
    alive = false;
    failAll(error.message);
  });
  child.on("exit", (code) => {
    alive = false;
    failAll(`The editor session ended (${code ?? "no code"}).`);
  });

  return {
    get alive() {
      return alive;
    },
    ask: (user) =>
      new Promise<string>((resolve, reject) => {
        if (!alive) {
          reject(new Error("The editor session is closed."));
          return;
        }
        queue.push({ user, resolve, reject });
        next();
      }),
    close: () => {
      if (!alive) return;
      alive = false;
      failAll("The editor session was closed.");
      try {
        child.stdin?.end();
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 2_000).unref();
    }
  };
}
