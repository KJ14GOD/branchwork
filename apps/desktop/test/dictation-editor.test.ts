import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CLAUDE_EDITOR_MODEL,
  codexEditorModel,
  editorAnswer,
  editorCommand,
  editorSessionCommand,
  editorSessionLine,
  openEditorSession,
  readEditorSessionLine,
  runEditor,
  type EditorChild
} from "../electron/dictation-editor";

/**
 * The editor behind the refinement (D-241), without the CLIs: the exact
 * invocations, how an answer is read, and a run over a fake child — the
 * prompt on stdin, the words back, a complaint when it did not answer. The
 * real CLI on the real login is stamped only by the opt-in live test.
 */

describe("the invocations", () => {
  it("asks Claude Code in print mode with no tools, no settings, no MCP, and nothing kept — and never bare", () => {
    const call = editorCommand("claude", CLAUDE_EDITOR_MODEL, "edit these", "RAW TRANSCRIPT: hi");
    expect(call.command).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "--model",
      "haiku",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "text",
      "--system-prompt",
      "edit these"
    ]);
    expect(call.args).not.toContain("--bare");
    expect(call.stdin).toBe("RAW TRANSCRIPT: hi");
    // Thinking off: the wait was the model deliberating, not the CLI starting.
    expect(call.env).toEqual({ MAX_THINKING_TOKENS: "0" });
  });

  it("asks Codex read-only with the prompt as its argument", () => {
    const call = editorCommand("codex", "gpt-5-mini", "edit these", "RAW TRANSCRIPT: hi");
    expect(call.command).toBe("codex");
    expect(call.args.slice(0, 6)).toEqual(["exec", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-5-mini"]);
    expect(call.args.at(-1)).toBe("edit these\n\nRAW TRANSCRIPT: hi");
    expect(call.stdin).toBeNull();
    expect(call.env).toEqual({});
    expect(codexEditorModel()).toMatch(/mini|gpt/i);
  });

  it("reads the answer: Claude's print is the answer, Codex's is what follows its progress", () => {
    expect(editorAnswer("claude", "Refactor composer.tsx.\n")).toBe("Refactor composer.tsx.");
    expect(editorAnswer("codex", "thinking...\nreading files\n\nRefactor composer.tsx.\n")).toBe("Refactor composer.tsx.");
  });
});

class FakeChild extends EventEmitter implements EditorChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  received = "";
  killed = false;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.received += chunk.toString();
    });
  }
  kill() {
    this.killed = true;
    return true;
  }
}

const tick = () => new Promise((settle) => setTimeout(settle, 5));

describe("a run over a fake child", () => {
  it("hands the prompt over stdin, with thinking off, and returns the words", async () => {
    let child!: FakeChild;
    let seenEnv: Record<string, string> = {};
    const running = runEditor({
      kind: "claude",
      model: "haiku",
      system: "edit",
      user: "RAW TRANSCRIPT: read factor composer dot t s x",
      spawn: (_command, _args, env) => {
        seenEnv = env;
        child = new FakeChild();
        return child;
      }
    });
    await tick();
    expect(seenEnv).toEqual({ MAX_THINKING_TOKENS: "0" });
    expect(child.received).toBe("RAW TRANSCRIPT: read factor composer dot t s x");
    child.stdout.write("Refactor composer.tsx\n");
    child.emit("exit", 0);
    expect(await running).toBe("Refactor composer.tsx");
  });

  it("rejects with the CLI's own last words when it did not answer", async () => {
    let child!: FakeChild;
    const running = runEditor({
      kind: "claude",
      model: "haiku",
      system: "edit",
      user: "x",
      spawn: () => {
        child = new FakeChild();
        return child;
      }
    });
    await tick();
    child.stderr.write("Not logged in · Please run /login\n");
    child.emit("exit", 1);
    await expect(running).rejects.toThrow(/Not logged in/);
  });

  it("gives up on a CLI that never answers", async () => {
    let child!: FakeChild;
    const running = runEditor({
      kind: "claude",
      model: "haiku",
      system: "edit",
      user: "x",
      timeoutMs: 30,
      spawn: () => {
        child = new FakeChild();
        return child;
      }
    });
    await expect(running).rejects.toThrow(/did not answer/);
    expect(child.killed).toBe(true);
  });
});

describe("the warm session (D-242)", () => {
  it("speaks stream-json both ways with thinking off, and answers asks in order", async () => {
    const call = editorSessionCommand("haiku", "edit these");
    expect(call.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]));
    expect(call.args).not.toContain("--bare");
    expect(call.env).toEqual({ MAX_THINKING_TOKENS: "0" });
    expect(JSON.parse(editorSessionLine("hi"))).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(readEditorSessionLine(JSON.stringify({ type: "result", result: "Edited.", is_error: false }))).toEqual({ kind: "result", text: "Edited.", error: null });
    expect(readEditorSessionLine(JSON.stringify({ type: "result", result: "Not logged in", is_error: true }))).toEqual({ kind: "result", text: "", error: "Not logged in" });
    expect(readEditorSessionLine(JSON.stringify({ type: "assistant", message: {} }))).toEqual({ kind: "other" });
    expect(readEditorSessionLine("noise")).toEqual({ kind: "other" });

    let child!: FakeChild;
    const session = openEditorSession({
      model: "haiku",
      system: "edit",
      spawn: () => {
        child = new FakeChild();
        return child;
      }
    });
    expect(session.alive).toBe(true);
    const first = session.ask("RAW TRANSCRIPT: one");
    const second = session.ask("RAW TRANSCRIPT: two");
    await tick();
    // One at a time: the second waits for the first's result.
    expect(child.received.split("\n").filter(Boolean)).toHaveLength(1);
    child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "result", result: "One.", is_error: false })}\n`);
    expect(await first).toBe("One.");
    await tick();
    expect(child.received.split("\n").filter(Boolean)).toHaveLength(2);
    child.stdout.write(`${JSON.stringify({ type: "result", result: "Two.", is_error: false })}\n`);
    expect(await second).toBe("Two.");

    // A closed session refuses, and a dying one fails what it owed.
    const third = session.ask("RAW TRANSCRIPT: three");
    await tick();
    child.emit("exit", 1);
    await expect(third).rejects.toThrow(/ended/);
    expect(session.alive).toBe(false);
    await expect(session.ask("x")).rejects.toThrow(/closed/);
  });

  it("closes by ending stdin, and gives up on an ask that never answers", async () => {
    let child!: FakeChild;
    let ended = false;
    const session = openEditorSession({
      model: "haiku",
      system: "edit",
      askTimeoutMs: 30,
      spawn: () => {
        child = new FakeChild();
        child.stdin.on("finish", () => {
          ended = true;
        });
        return child;
      }
    });
    await expect(session.ask("slow")).rejects.toThrow(/did not answer/);
    session.close();
    await tick();
    expect(ended).toBe(true);
    expect(session.alive).toBe(false);
  });
});
