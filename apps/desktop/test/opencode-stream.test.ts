import { describe, expect, it } from "vitest";
import { RunnerEventSchema } from "@novus/contracts";
import type { HarnessControlMessage } from "../electron/harness-stream";
import { OpenCodeStream } from "../electron/opencode-stream";

const sessionID = "ses_test";
const message = (overrides = {}) => ({ id: "msg_one", sessionID, role: "assistant", ...overrides });
const event = (type: string, properties: unknown) => ({ type, properties });
const sse = (type: string, properties: unknown) => `data: ${JSON.stringify(event(type, properties))}\n\n`;

describe("OpenCode event normalization", () => {
  it("frames split SSE, excludes user text and other sessions, and deduplicates final parts", () => {
    const stream = new OpenCodeStream();
    stream.open(sessionID);
    const input = sse("message.updated", { info: message() });
    stream.push(input.slice(0, 9));
    stream.push(input.slice(9));
    const part = { id: "prt_text", messageID: "msg_one", sessionID, type: "text", text: "The answer", time: { end: 42 } };
    expect(stream.consume(event("message.part.updated", { part: { ...part, sessionID: "ses_other" } }))).toEqual([]);
    const events = stream.push(sse("message.part.updated", { part }));
    expect(events).toEqual([{ kind: "harness.text", payload: { text: "The answer", parentToolUseId: null } }]);
    expect(stream.consume(event("message.part.updated", { part }))).toEqual([]);
    expect(stream.consume(event("message.part.updated", { part: { ...part, id: "prt_user", messageID: "msg_user" } }))).toEqual([]);
    events.forEach((item) => expect(RunnerEventSchema.safeParse(item).success).toBe(true));
  });

  it("routes bounded permission summaries and exact paths without retaining the proposed contents or standing grants", () => {
    const controls: HarnessControlMessage[] = [];
    const stream = new OpenCodeStream({ sanitize: (text) => text.replaceAll("/private/work", "worktree"), onControl: (value) => controls.push(value) });
    stream.open(sessionID);
    const request = { sessionID, id: "per_edit", permission: "edit", patterns: ["a.txt"], always: ["*"], tool: { callID: "call_1" }, metadata: { filepath: "/private/work/a.txt", diff: "SECRET FILE CONTENT" } };
    const events = stream.consume(event("permission.asked", request));
    expect(controls[0]).toMatchObject({ kind: "approval", toolName: "Edit", targetPaths: ["/private/work/a.txt"] });
    expect(JSON.stringify(events)).not.toContain("SECRET FILE CONTENT");
    expect(JSON.stringify(events)).not.toContain("/private/work");
    expect(JSON.stringify(controls)).not.toContain("always");
    expect(stream.consume(event("permission.asked", request))).toEqual([]);
    events.forEach((item) => expect(RunnerEventSchema.safeParse(item).success).toBe(true));
    expect(stream.consume(event("permission.replied", { sessionID, requestID: "per_edit", reply: "reject" }))[0]?.kind).toBe("approval.cancelled");
  });

  it("never turns an unknown permission into a policy-auto-allowed ordinary tool", () => {
    const controls: HarnessControlMessage[] = [];
    const stream = new OpenCodeStream({ onControl: (value) => controls.push(value) });
    stream.open(sessionID);
    stream.consume(event("permission.asked", { id: "per_unknown", sessionID, permission: "external_directory", patterns: ["/outside/*"], metadata: {} }));
    expect(controls[0]).toMatchObject({ toolName: "mcp__opencode__external_directory", targetPaths: [] });
  });

  it("sums reported usage once per completed message and preserves absent cost", () => {
    const stream = new OpenCodeStream({ contextWindow: 100000 });
    stream.open(sessionID);
    const info = message({ time: { completed: 42 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } } });
    const events = stream.consume(event("message.updated", { info }));
    expect(events[0]).toMatchObject({ kind: "harness.usage", payload: { costUsd: null, inputTokens: 100, outputTokens: 25, contextTokens: 160, contextWindow: 100000 } });
    expect(stream.consume(event("message.updated", { info }))).toEqual([]);
    const second = stream.consume(event("message.updated", { info: { ...info, id: "msg_two", cost: 0.001 } }));
    expect(second[0]).toMatchObject({ payload: { costUsd: 0.001 } });
    [...events, ...second].forEach((item) => expect(RunnerEventSchema.safeParse(item).success).toBe(true));
  });

  it("requires a reported shell exit for verification and ignores evidence claims in prose", () => {
    const stream = new OpenCodeStream();
    stream.open(sessionID);
    stream.consume(event("message.updated", { info: message() }));
    const part = { id: "prt_shell", sessionID, messageID: "msg_one", type: "tool", tool: "bash", callID: "call_shell", state: { status: "completed", input: { command: "pnpm test" }, output: "pass", metadata: { exit: 0 } } };
    const events = stream.consume(event("message.part.updated", { part }));
    expect(events.find((item) => item.kind === "verification.observed")).toMatchObject({ payload: { outcome: "passed", command: "pnpm test" } });
    const silent = stream.consume(event("message.part.updated", { part: { ...part, id: "prt_silent", state: { ...part.state, metadata: {} } } }));
    expect(silent.some((item) => item.kind === "verification.observed")).toBe(false);
    events.forEach((item) => expect(RunnerEventSchema.safeParse(item).success).toBe(true));
  });

  it("can skip a user attachment event larger than two megabytes while retaining a frame limit", () => {
    const stream = new OpenCodeStream();
    stream.open(sessionID);
    expect(stream.push(sse("message.part.updated", { part: { id: "prt_image", messageID: "msg_user", sessionID, type: "file", url: "data:image/png;base64," + "a".repeat(3_000_000) } }))).toEqual([]);
    expect(() => stream.push("a".repeat(9_000_000))).toThrow("oversized event");
  });

  it("refuses a task that could resume a foreign session with saved grants", () => {
    const controls: HarnessControlMessage[] = [];
    const stream = new OpenCodeStream({ onControl: (value) => controls.push(value) });
    stream.open(sessionID);
    stream.consume(event("message.updated", { info: message() }));
    const ask = (id: string) => event("permission.asked", { id: `per_${id}`, sessionID, permission: "task", patterns: ["general"], tool: { callID: id } });
    expect(() => stream.consume(ask("missing"))).toThrow("task target");
    stream.consume(event("message.part.updated", { part: { id: "prt_task", messageID: "msg_one", sessionID, type: "tool", tool: "task", callID: "foreign", state: { status: "running", input: { task_id: "ses_foreign" } } } }));
    expect(() => stream.consume(ask("foreign"))).toThrow("outside this supervised conversation");
    stream.registerChild("ses_child", sessionID);
    stream.consume(event("message.part.updated", { part: { id: "prt_childtask", messageID: "msg_one", sessionID, type: "tool", tool: "task", callID: "child", state: { status: "running", input: { task_id: "ses_child" } } } }));
    stream.consume(ask("child"));
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ kind: "approval", toolName: "Task" });
  });

  it("idle is not success, a complete HTTP answer is; protocol loss fails closed", () => {
    const stream = new OpenCodeStream({ resumeSessionId: sessionID });
    expect(stream.open(sessionID)[0]).toMatchObject({ payload: { resumed: true } });
    stream.consume(event("session.idle", { sessionID }));
    expect(stream.result).toBeNull();
    stream.finish({ info: message({ time: { completed: 42 }, finish: "stop" }), parts: [] });
    expect(stream.result).toEqual({ isError: false, subtype: "success", message: null });
    expect(() => stream.push("data: {invalid}\n\n")).toThrow("invalid event JSON");
  });
});
