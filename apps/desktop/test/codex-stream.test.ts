import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@novus/contracts";
import {
  CodexStream,
  approvalResponseLine,
  reviewStartLine,
  threadForkLine,
  threadResumeLine,
  threadStartLine,
  turnInterruptLine,
  turnStartLine,
  turnSteerLine
} from "../electron/codex-stream";
import type { HarnessControlMessage } from "../electron/harness-stream";

/**
 * The Codex dialect (D-230), proven the way harness-stream is: every line
 * shape the app-server protocol defines (taken from the binary's own
 * generate-json-schema, 0.145.0), pushed through the parser, and judged by
 * the events and control messages that come out — the two vocabularies that
 * ARE the adapter contract.
 */

function line(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function collect(): { stream: CodexStream; control: HarnessControlMessage[]; rpc: unknown[] } {
  const control: HarnessControlMessage[] = [];
  const rpc: unknown[] = [];
  const stream = new CodexStream({
    resumeThreadId: null,
    onControl: (message) => control.push(message)
  });
  stream.attachRpcResponder((id, result, error) => rpc.push({ id, result, error }));
  return { stream, control, rpc };
}

describe("threads and sessions", () => {
  it("a started thread is the session, and resuming the asked-for thread says resumed", () => {
    const fresh = new CodexStream({ resumeThreadId: null });
    const events = fresh.push(line({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thr_1" } } }));
    expect(events).toEqual([
      { kind: "harness.session", payload: { sessionId: "thr_1", resumed: false } }
    ]);
    expect(fresh.sessionId).toBe("thr_1");

    const resumed = new CodexStream({ resumeThreadId: "thr_9" });
    const again = resumed.push(
      line({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thr_9" } } })
    );
    expect((again[0] as Extract<RunnerEvent, { kind: "harness.session" }>).payload.resumed).toBe(true);
  });

  it("a thread arriving on a response is remembered for the driver's sequencing", () => {
    const { stream, rpc } = collect();
    stream.push(line({ jsonrpc: "2.0", id: "novus-1", result: { thread: { id: "thr_2" } } }));
    expect(stream.sessionId).toBe("thr_2");
    expect(rpc).toHaveLength(1);
  });
});

describe("speech and activity", () => {
  it("an agent message speaks once, at completion, bounded and sanitized", () => {
    const stream = new CodexStream({ sanitize: (text) => text.replace("/Users/kj16", "the machine") });
    const events = stream.push(
      line({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { item: { id: "itm_1", type: "agentMessage", text: "Wrote /Users/kj16/app.ts" } }
      })
    );
    expect(events).toEqual([
      { kind: "harness.text", payload: { text: "Wrote the machine/app.ts", parentToolUseId: null } }
    ]);
  });

  it("a command starting is a tool row; its completion is evidence through the one classifier", () => {
    const stream = new CodexStream();
    const started = stream.push(
      line({
        jsonrpc: "2.0",
        method: "item/started",
        params: { item: { id: "itm_2", type: "commandExecution", command: "pnpm test", status: "inProgress" } }
      })
    );
    expect(started).toEqual([
      { kind: "harness.tool", payload: { tool: "Bash", detail: "pnpm test", parentToolUseId: null, toolUseId: "itm_2" } }
    ]);
    const completed = stream.push(
      line({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            id: "itm_2",
            type: "commandExecution",
            command: "pnpm test",
            aggregatedOutput: "12 passed",
            exitCode: 0,
            status: "completed"
          }
        }
      })
    );
    expect(completed).toEqual([
      {
        kind: "verification.observed",
        payload: {
          name: "pnpm test",
          category: "test",
          outcome: "passed",
          command: "pnpm test",
          output: "12 passed",
          truncated: false
        }
      }
    ]);
  });

  it("a completion nothing announced still gets its tool row, and a failure is failed", () => {
    const stream = new CodexStream();
    const events = stream.push(
      line({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: { id: "itm_3", type: "commandExecution", command: "tsc -p .", aggregatedOutput: "error TS2304", exitCode: 2 }
        }
      })
    );
    expect(events.map((event) => event.kind)).toEqual(["harness.tool", "verification.observed"]);
    const check = events[1] as Extract<RunnerEvent, { kind: "verification.observed" }>;
    expect(check.payload.outcome).toBe("failed");
    expect(check.payload.category).toBe("typecheck");
  });

  it("a command no rule can name produces activity and no evidence", () => {
    const stream = new CodexStream();
    const events = stream.push(
      line({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { item: { id: "itm_4", type: "commandExecution", command: "cat README.md", exitCode: 0 } }
      })
    );
    expect(events.map((event) => event.kind)).toEqual(["harness.tool"]);
  });
});

describe("approvals — control, never transcript", () => {
  it("a command approval request becomes the ladder's own message, answered in accept/decline", () => {
    const { stream, control } = collect();
    const events = stream.push(
      line({
        jsonrpc: "2.0",
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr_1", turnId: "trn_1", itemId: "itm_9", command: "rm -rf dist", startedAtMs: 1 }
      })
    );
    expect(control).toHaveLength(1);
    const approval = control[0];
    expect(approval.kind).toBe("approval");
    if (approval.kind === "approval") {
      expect(approval.requestId).toBe("41");
      expect(approval.toolName).toBe("Bash");
      expect(approval.summary).toContain("rm -rf dist");
    }
    expect(events.map((event) => event.kind)).toEqual(["approval.requested", "boundary.reached"]);
    expect(stream.approvalKindOf("41")).toBe("command");
    // The answer, in this request's own grammar — numeric ids stay numeric.
    expect(approvalResponseLine("41", "command", true)).toEqual({
      jsonrpc: "2.0",
      id: 41,
      result: { decision: "accept" }
    });
    expect(approvalResponseLine("41", "command", false)).toEqual({
      jsonrpc: "2.0",
      id: 41,
      result: { decision: "decline" }
    });
  });

  it("a file-change approval names its paths for the scope policy", () => {
    const { stream, control } = collect();
    stream.push(
      line({
        jsonrpc: "2.0",
        id: "req_7",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thr_1",
          turnId: "trn_1",
          itemId: "itm_10",
          startedAtMs: 1,
          reason: "apply the patch",
          changes: { "src/a.ts": {}, "src/b.ts": {} }
        }
      })
    );
    const approval = control[0];
    expect(approval.kind).toBe("approval");
    if (approval.kind === "approval") {
      expect(approval.toolName).toBe("Edit");
      expect(approval.targetPaths).toEqual(["src/a.ts", "src/b.ts"]);
    }
    expect(stream.approvalKindOf("req_7")).toBe("fileChange");
  });

  it("a permissions-widening ask reaches a person with its reason; an elicitation is unsupported", () => {
    const { stream, control } = collect();
    stream.push(
      line({
        jsonrpc: "2.0",
        id: 5,
        method: "item/permissions/requestApproval",
        params: { threadId: "t", turnId: "u", itemId: "i", permissions: {}, startedAtMs: 1, reason: "needs network" }
      })
    );
    stream.push(
      line({ jsonrpc: "2.0", id: 6, method: "mcpServer/elicitation/request", params: {} })
    );
    expect(control.map((message) => message.kind)).toEqual(["approval", "unsupported"]);
    const widen = control[0];
    if (widen.kind === "approval") expect(widen.summary).toContain("needs network");
  });

  it("not one character of control becomes harness.text", () => {
    const { stream } = collect();
    const events = stream.push(
      line({
        jsonrpc: "2.0",
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t", turnId: "u", itemId: "i", command: "echo SECRET-WORDS", startedAtMs: 1 }
      })
    );
    expect(events.some((event) => event.kind === "harness.text")).toBe(false);
  });
});

describe("usage and the turn's own end", () => {
  it("token usage rides the turn's completion as the harness's claim, never zeros", () => {
    const stream = new CodexStream();
    stream.push(
      line({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "t", turnId: "u", tokenUsage: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 40 } }
      })
    );
    const events = stream.push(
      line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } })
    );
    expect(stream.result).toEqual({ isError: false, subtype: "completed", message: null });
    expect(events).toEqual([
      {
        kind: "harness.usage",
        payload: {
          inputTokens: 900,
          outputTokens: 40,
          cacheReadTokens: 100,
          cacheCreationTokens: null,
          costUsd: null,
          durationMs: null,
          turns: null
        }
      }
    ]);
  });

  it("a failed turn is an error result with the failure's own words", () => {
    const stream = new CodexStream();
    stream.push(
      line({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "u", status: "failed", error: { message: "usage limit reached" } } }
      })
    );
    expect(stream.result).toEqual({ isError: true, subtype: "failed", message: "usage limit reached" });
  });

  it("malformed lines and unknown notifications are noise, never a throw", () => {
    const stream = new CodexStream();
    expect(stream.push("not json at all\n")).toEqual([]);
    expect(stream.push(line({ jsonrpc: "2.0", method: "model/rerouted", params: {} }))).toEqual([]);
    expect(stream.end()).toEqual([]);
  });
});

describe("the pinned outbound lines (D-056's discipline, this dialect)", () => {
  it("a thread starts untrusted, reviewed by a person, sandboxed by its access", () => {
    const write = threadStartLine("novus-2", {
      cwd: "/work/tree",
      model: "gpt-5.1-codex",
      effort: "high",
      readOnly: false,
      instructions: null
    }) as { params: Record<string, unknown> };
    expect(write.params.approvalPolicy).toBe("untrusted");
    expect(write.params.approvalsReviewer).toBe("user");
    expect(write.params.sandbox).toBe("workspace-write");

    const read = threadStartLine("novus-3", {
      cwd: "/work/tree",
      model: "gpt-5.1-codex",
      effort: "low",
      readOnly: true,
      instructions: null
    }) as { params: Record<string, unknown> };
    expect(read.params.sandbox).toBe("read-only");
  });

  it("resume, turn start, and interrupt say exactly the thread they mean", () => {
    const resume = threadResumeLine("novus-4", "thr_9", {
      cwd: "/work/tree",
      model: "gpt-5.1-codex",
      readOnly: false
    }) as { params: Record<string, unknown> };
    expect(resume.params.threadId).toBe("thr_9");
    expect(resume.params.approvalPolicy).toBe("untrusted");

    const turn = turnStartLine("novus-5", "thr_9", {
      direction: "fix the failing test",
      model: "gpt-5.1-codex",
      effort: "high"
    }) as { params: { input: unknown[]; threadId: string } };
    expect(turn.params.threadId).toBe("thr_9");
    expect(turn.params.input).toEqual([{ type: "text", text: "fix the failing test" }]);

    const interrupt = turnInterruptLine("novus-6", "thr_9") as { method: string; params: { threadId: string } };
    expect(interrupt.method).toBe("turn/interrupt");
    expect(interrupt.params.threadId).toBe("thr_9");
  });
});

describe("D-231: the live turn, steered, forked, reviewed", () => {
  it("the active turn id is tracked from turn/started and cleared at completion", () => {
    const stream = new CodexStream();
    expect(stream.activeTurnId).toBeNull();
    stream.push(
      line({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t", turn: { id: "trn_7" } } })
    );
    expect(stream.activeTurnId).toBe("trn_7");
    stream.push(
      line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { id: "trn_7", status: "completed" } } })
    );
    expect(stream.activeTurnId).toBeNull();
  });

  it("a steer names the thread AND the expected turn, so a stale one fails instead of landing", () => {
    expect(turnSteerLine("novus-7", "thr_9", "trn_7", "also update the docs")).toEqual({
      jsonrpc: "2.0",
      id: "novus-7",
      method: "turn/steer",
      params: {
        threadId: "thr_9",
        expectedTurnId: "trn_7",
        input: [{ type: "text", text: "also update the docs" }]
      }
    });
  });

  it("a fork opens the source thread's history under the same pinned discipline", () => {
    const fork = threadForkLine("novus-8", "thr_src", {
      cwd: "/work/tree",
      model: "gpt-5.6-sol",
      readOnly: false,
      config: { mcp_servers: {} }
    }) as { method: string; params: Record<string, unknown> };
    expect(fork.method).toBe("thread/fork");
    expect(fork.params.threadId).toBe("thr_src");
    expect(fork.params.approvalPolicy).toBe("untrusted");
    expect(fork.params.approvalsReviewer).toBe("user");
    expect(fork.params.sandbox).toBe("workspace-write");
    expect(fork.params.config).toEqual({ mcp_servers: {} });
  });

  it("a review turn targets the uncommitted changes, inline on this thread", () => {
    expect(reviewStartLine("novus-9", "thr_9")).toEqual({
      jsonrpc: "2.0",
      id: "novus-9",
      method: "review/start",
      params: { threadId: "thr_9", target: { type: "uncommittedChanges" }, delivery: "inline" }
    });
  });

  it("the MCP override rides thread start and resume as the thread's own config", () => {
    const start = threadStartLine("novus-10", {
      cwd: "/work/tree",
      model: "gpt-5.6-sol",
      effort: "medium",
      readOnly: false,
      instructions: null,
      config: { mcp_servers: { docs: { url: "https://docs.example/mcp" } } }
    }) as { params: Record<string, unknown> };
    expect(start.params.config).toEqual({ mcp_servers: { docs: { url: "https://docs.example/mcp" } } });

    const resume = threadResumeLine("novus-11", "thr_9", {
      cwd: "/work/tree",
      model: "gpt-5.6-sol",
      readOnly: true,
      config: { mcp_servers: {} }
    }) as { params: Record<string, unknown> };
    expect(resume.params.config).toEqual({ mcp_servers: {} });
  });
});
