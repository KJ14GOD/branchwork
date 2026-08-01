import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeArgs } from "./claude-code-args.ts";
import {
  LineReader,
  classifyTool,
  mapStreamLine,
  type StreamContext,
} from "./claude-code-stream.ts";

/**
 * The mapping, against the shapes a real session emits.
 *
 * Every fixture below was read off `claude -p --output-format stream-json
 * --input-format stream-json` running against a scratch repository, not off
 * documentation. That distinction matters: the adapter's whole job is to be
 * right about somebody else's output format, and a test written from a guess
 * would agree with the guess.
 */

const context: StreamContext = {
  sessionId: "s1",
  actorId: "host",
  runId: "run-1",
};

test("init reports the model and tools without appending anything", () => {
  // `run.started` has to carry the real model, so this arrives before the run
  // exists and is a signal rather than an event.
  const out = mapStreamLine(
    {
      type: "system",
      subtype: "init",
      model: "claude-opus-5[1m]",
      tools: ["Bash", "Read", "Edit"],
      session_id: "cc-1",
    },
    context,
  );

  assert.equal(out.events.length, 0);
  assert.deepEqual(out.signals, [
    { kind: "init", model: "claude-opus-5[1m]", tools: ["Bash", "Read", "Edit"] },
  ]);
});

test("a tool call becomes activity, never a Novus tool event", () => {
  // The line this file exists to hold. `tool.requested` carries Novus's own
  // union, whose apply_patch arm means "this crossed the approval gate".
  // Nothing an external harness does crossed it.
  const out = mapStreamLine(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look at the auth module." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "src/auth/session.ts" },
          },
        ],
      },
    },
    context,
  );

  assert.equal(out.events.length, 2);
  assert.equal(out.events[0]?.type, "harness.output");
  assert.equal(out.events[1]?.type, "harness.activity");

  for (const event of out.events) {
    assert.ok(
      !event.type.startsWith("tool."),
      "an external harness must not emit Novus tool events",
    );
  }

  const activity = out.events[1] as Extract<
    (typeof out.events)[number],
    { type: "harness.activity" }
  >;

  assert.equal(activity.payload.name, "Read");
  assert.equal(activity.payload.class, "read");
  assert.equal(activity.payload.status, "started");
  assert.deepEqual(activity.payload.claimedPaths, ["src/auth/session.ts"]);
});

test("a tool result closes its call by id, and an error is not terminal", () => {
  const out = mapStreamLine(
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: "No such file or directory",
          },
        ],
      },
    },
    context,
  );

  assert.equal(out.events.length, 1);

  const activity = out.events[0] as Extract<
    (typeof out.events)[number],
    { type: "harness.activity" }
  >;

  assert.equal(activity.payload.callId, "toolu_1");
  assert.equal(activity.payload.status, "failed");
  // A failing tool is a row, not the end of a run — the same invariant the
  // built-in loop holds with is_error tool_results.
  assert.equal(out.signals.length, 0);
});

test("a result signals the turn ended, with its cost", () => {
  const out = mapStreamLine(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      total_cost_usd: 0.0641865,
      num_turns: 2,
    },
    context,
  );

  assert.deepEqual(out.signals, [
    { kind: "turn-ended", ok: true, message: "Done.", costUsd: 0.0641865 },
  ]);
});

test("an errored result is reported as not ok", () => {
  const out = mapStreamLine(
    { type: "result", subtype: "error_max_turns", is_error: true, result: "hit the cap" },
    context,
  );

  assert.equal(out.signals[0]?.kind, "turn-ended");
  assert.equal(
    (out.signals[0] as { ok: boolean }).ok,
    false,
  );
});

test("an allowed rate-limit notice is not worth a row", () => {
  const quiet = mapStreamLine(
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    context,
  );
  const loud = mapStreamLine(
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    },
    context,
  );

  assert.equal(quiet.events.length, 0);
  // A run stalled on a rate limit looks exactly like one that is thinking.
  assert.equal(loud.events.length, 1);
  assert.equal(loud.events[0]?.type, "run.progress");
});

test("unknown line kinds are ignored rather than thrown on", () => {
  // Claude Code adds event types on its own schedule. An unrecognised one must
  // cost a milestone, never a run.
  for (const line of [
    { type: "system", subtype: "hook_started" },
    { type: "something_new_in_2_2" },
    null,
    "not an object",
    42,
  ]) {
    assert.deepEqual(mapStreamLine(line, context), { events: [], signals: [] });
  }
});

test("the line reader holds a partial line rather than parsing it", () => {
  // stdout arrives in whatever sizes the pipe chooses. Parsing per chunk drops
  // roughly every tool call in a busy turn.
  const reader = new LineReader();

  assert.deepEqual(reader.push('{"type":"a"}\n{"ty'), [{ type: "a" }]);
  assert.deepEqual(reader.push('pe":"b"}\n'), [{ type: "b" }]);
});

test("a malformed line does not end the stream", () => {
  const reader = new LineReader();

  assert.deepEqual(reader.push("{oh no\n{\"type\":\"ok\"}\n"), [{ type: "ok" }]);
});

test("tool classes are for icons, and unknown names stay unknown", () => {
  assert.equal(classifyTool("Bash"), "execute");
  assert.equal(classifyTool("Edit"), "edit");
  assert.equal(classifyTool("Grep"), "search");
  assert.equal(classifyTool("mcp__whatever__do"), "other");
  // Never guessed into a class that a reader might mistake for a judgement.
  assert.equal(classifyTool("SomeToolAddedNextYear"), "unknown");
});

/* ---------- permissions ---------- */

test("a read-only session refuses writes, commands and the network", () => {
  const args = claudeCodeArgs({ allowWrites: false, allowCommands: false }, null);
  const denied = args[args.indexOf("--disallowedTools") + 1] ?? "";

  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");

  for (const tool of ["Bash", "Edit", "Write", "WebFetch"]) {
    assert.ok(denied.includes(tool), `${tool} must be refused`);
  }
});

test("allowing writes does not allow commands", () => {
  const args = claudeCodeArgs({ allowWrites: true, allowCommands: false }, null);
  const denied = args[args.indexOf("--disallowedTools") + 1] ?? "";

  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(denied.includes("Bash"));
  assert.ok(!denied.includes("Edit"));
});

test("no permission combination ever skips permission checks", () => {
  // The flag that would hand an external process the whole machine. There is
  // no input to this function that produces it, which is why the function
  // exists rather than the flags being assembled at the call site.
  for (const allowWrites of [true, false]) {
    for (const allowCommands of [true, false]) {
      const args = claudeCodeArgs({ allowWrites, allowCommands }, null);

      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.ok(!args.includes("--allow-dangerously-skip-permissions"));
    }
  }
});

test("a model is passed through only when one was chosen", () => {
  assert.ok(!claudeCodeArgs({ allowWrites: true, allowCommands: true }, null).includes("--model"));

  const picked = claudeCodeArgs(
    { allowWrites: true, allowCommands: true },
    "claude-sonnet-5",
  );

  assert.equal(picked[picked.indexOf("--model") + 1], "claude-sonnet-5");
});
