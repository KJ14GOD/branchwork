import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@novus/contracts";
import { HarnessStream, classifyCommand } from "../electron/harness-stream";

/**
 * The parser decides what the room is told a harness did. These tests are for
 * the two ways it could lie: by promoting prose into evidence, and by losing
 * or mangling what the harness actually emitted.
 */

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const init = (sessionId: string) =>
  line({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5" });

const assistant = (content: unknown[]) => line({ type: "assistant", message: { content } });

const toolResult = (id: string, content: unknown, isError = false) =>
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }
  });

function payloadOf<K extends RunnerEvent["kind"]>(
  events: RunnerEvent[],
  kind: K
): Extract<RunnerEvent, { kind: K }>["payload"] | undefined {
  const found = events.find((event) => event.kind === kind);
  return found ? (found.payload as Extract<RunnerEvent, { kind: K }>["payload"]) : undefined;
}

describe("stream parsing", () => {
  it("reports the session and whether continuity actually held", () => {
    const fresh = new HarnessStream();
    const started = fresh.push(init("sess-1"));
    expect(payloadOf(started, "harness.session")).toEqual({ sessionId: "sess-1", resumed: false });

    const continued = new HarnessStream({ resumeSessionId: "sess-1" });
    expect(payloadOf(continued.push(init("sess-1")), "harness.session")).toEqual({
      sessionId: "sess-1",
      resumed: true
    });

    // A different id back from a resume attempt is a lost conversation, and
    // the event says so rather than implying it continued.
    const lost = new HarnessStream({ resumeSessionId: "sess-1" });
    expect(payloadOf(lost.push(init("sess-2")), "harness.session")).toEqual({
      sessionId: "sess-2",
      resumed: false
    });
    expect(lost.resumed).toBe(false);
  });

  it("turns assistant blocks into text and tool lines", () => {
    const stream = new HarnessStream();
    const events = stream.push(
      assistant([
        { type: "text", text: "Looking at the auth module." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.ts" } },
        { type: "text", text: "   " }
      ])
    );
    expect(events.map((event) => event.kind)).toEqual(["harness.text", "harness.tool"]);
    expect(payloadOf(events, "harness.text")).toEqual({ text: "Looking at the auth module." });
    expect(payloadOf(events, "harness.tool")).toEqual({ tool: "Read", detail: "src/auth.ts" });
  });

  it("ignores malformed lines instead of dying on them", () => {
    const stream = new HarnessStream();
    const events = stream.push(
      `not json at all\n{"type":"assistant"\n${assistant([{ type: "text", text: "still here" }])}`
    );
    expect(events.map((event) => event.kind)).toEqual(["harness.text"]);
  });

  it("flushes a final line that arrived without its newline", () => {
    const stream = new HarnessStream();
    expect(stream.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }))).toEqual([]);
    expect(stream.result).toBeNull();
    stream.end();
    expect(stream.result).toEqual({ isError: false, subtype: "success", message: "Done." });
  });

  it("reassembles a payload split across chunk boundaries", () => {
    const stream = new HarnessStream();
    const whole = assistant([{ type: "text", text: "split across chunks" }]);
    const half = Math.floor(whole.length / 2);
    expect(stream.push(whole.slice(0, half))).toEqual([]);
    const events = stream.push(whole.slice(half));
    expect(payloadOf(events, "harness.text")).toEqual({ text: "split across chunks" });
  });

  it("bounds text and tool detail to the contract's ceilings", () => {
    const stream = new HarnessStream();
    const events = stream.push(
      assistant([
        { type: "text", text: "x".repeat(20_000) },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "y".repeat(2_000) } }
      ])
    );
    expect(payloadOf(events, "harness.text")?.text.length).toBe(8_000);
    expect(payloadOf(events, "harness.tool")?.detail?.length).toBe(400);
  });

  it("passes every reported string through the sanitizer", () => {
    const stream = new HarnessStream({ sanitize: (text) => text.split("/tmp/secret-place").join("the worktree") });
    const events = stream.push(
      assistant([
        { type: "text", text: "wrote /tmp/secret-place/app.ts" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/secret-place/app.ts" } }
      ])
    );
    expect(payloadOf(events, "harness.text")?.text).toBe("wrote the worktree/app.ts");
    expect(payloadOf(events, "harness.tool")?.detail).toBe("the worktree/app.ts");
  });
});

describe("verification observed from real tool results", () => {
  it("correlates a Bash call with its result and records one check", () => {
    const stream = new HarnessStream();
    stream.push(assistant([{ type: "tool_use", id: "t7", name: "Bash", input: { command: "pnpm test" } }]));
    const events = stream.push(toolResult("t7", "Test Files 3 passed\nTests 22 passed"));
    expect(payloadOf(events, "verification.observed")).toEqual({
      name: "pnpm test",
      category: "test",
      outcome: "passed",
      command: "pnpm test",
      output: "Test Files 3 passed\nTests 22 passed",
      truncated: false
    });
  });

  it("takes the outcome from the tool result's error flag, not from prose", () => {
    const stream = new HarnessStream();
    stream.push(assistant([{ type: "tool_use", id: "t8", name: "Bash", input: { command: "pnpm vitest run" } }]));
    const failing = stream.push(toolResult("t8", [{ type: "text", text: "1 failed" }], true));
    expect(payloadOf(failing, "verification.observed")?.outcome).toBe("failed");

    // The harness then claims success in prose. It is text, and only text.
    const claimed = stream.push(assistant([{ type: "text", text: "All tests pass now." }]));
    expect(claimed.map((event) => event.kind)).toEqual(["harness.text"]);
    expect(claimed.some((event) => event.kind === "verification.observed")).toBe(false);
  });

  it("records nothing for a command it cannot confidently name", () => {
    const stream = new HarnessStream();
    stream.push(assistant([{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls -la src" } }]));
    expect(stream.push(toolResult("t9", "src/app.ts"))).toEqual([]);

    // Nor for a non-shell tool, whose result is not a command outcome at all.
    stream.push(assistant([{ type: "tool_use", id: "t10", name: "Read", input: { file_path: "src/app.ts" } }]));
    expect(stream.push(toolResult("t10", "file contents"))).toEqual([]);
  });

  it("ignores a result whose call it never saw", () => {
    const stream = new HarnessStream();
    expect(stream.push(toolResult("unknown-id", "output"))).toEqual([]);
  });

  it("bounds check output and says when it truncated", () => {
    const stream = new HarnessStream();
    stream.push(assistant([{ type: "tool_use", id: "t11", name: "Bash", input: { command: "npm test" } }]));
    const events = stream.push(toolResult("t11", "z".repeat(9_000)));
    const check = payloadOf(events, "verification.observed");
    expect(check?.output?.length).toBe(4_000);
    expect(check?.truncated).toBe(true);
  });

  it("classifies only what the command text plainly says", () => {
    expect(classifyCommand("pnpm test")).toBe("test");
    expect(classifyCommand("npx vitest run src")).toBe("test");
    expect(classifyCommand("go test ./...")).toBe("test");
    expect(classifyCommand("python -m pytest -q")).toBe("test");
    expect(classifyCommand("pnpm exec tsc -p tsconfig.json")).toBe("typecheck");
    expect(classifyCommand("npm run typecheck")).toBe("typecheck");
    expect(classifyCommand("pnpm eslint apps")).toBe("lint");
    expect(classifyCommand("pnpm run build")).toBe("build");

    expect(classifyCommand("git status")).toBeNull();
    expect(classifyCommand("cat package.json")).toBeNull();
    expect(classifyCommand("echo 'tests pass'")).toBeNull();
    expect(classifyCommand("mkdir -p src/testing")).toBeNull();
  });
});
