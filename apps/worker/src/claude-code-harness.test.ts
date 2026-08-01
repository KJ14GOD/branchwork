import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { ClaudeCodeHarness } from "./claude-code-harness.ts";

/**
 * The adapter driven end to end against a fake `claude`.
 *
 * A real one would cost money and would make the test depend on somebody
 * else's release schedule. The fake emits the exact line shapes a real session
 * produced — recorded from `claude -p --output-format stream-json
 * --input-format stream-json` against a scratch repository — so what is being
 * tested is the adapter's handling of that format, which is the part Novus
 * owns and the part that can break.
 *
 * What these hold: a run appends exactly one terminal event, an external
 * harness never emits Novus's typed tool events, the model on `run.started` is
 * the one the handshake reported rather than a guess, and a harness that is
 * not installed fails *before* a run exists rather than leaving a failed one
 * on the log.
 */

const SESSION = "s1";

/** A script on the PATH that behaves like `claude` for one turn. */
const fakeClaude = (lines: string[], exitCode = 0): string => {
  const dir = mkdtempSync(join(tmpdir(), "novus-fake-claude-"));
  const path = join(dir, "claude");
  const body = lines.map((line) => `echo '${line.replace(/'/g, "'\\''")}'`).join("\n");

  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi
# Read the goal off stdin BEFORE emitting anything.
#
# The real CLI does this: under --input-format stream-json it stays silent
# until it has had something to work on. An earlier version of this fake
# emitted its handshake unprompted, and the adapter deadlocked against the
# real binary while these tests stayed green. A fake that is easier to talk to
# than the real thing tests nothing about talking to the real thing.
head -n 1 > /dev/null
${body}
cat > /dev/null
exit ${exitCode}
`,
  );
  chmodSync(path, 0o755);

  return path;
};

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  model: "claude-opus-5",
  tools: ["Bash", "Read", "Edit"],
  session_id: "cc-1",
});

const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Reading the auth module." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/auth.ts" } },
    ],
  },
});

const TOOL_RESULT = JSON.stringify({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: "ok" }],
  },
});

const RESULT_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Read the module.",
  total_cost_usd: 0.01,
});

const harnessOver = (command: string, store: InMemorySessionEventStore) =>
  new ClaudeCodeHarness({
    eventStore: store,
    cwd: tmpdir(),
    permissions: { allowWrites: false, allowCommands: false },
    command,
  });

test("a Claude Code run lands on the log as harness activity, not Novus tool calls", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(
    fakeClaude([INIT, ASSISTANT, TOOL_RESULT, RESULT_OK]),
    store,
  );

  await harness.run({
    sessionId: SESSION,
    actorId: "host",
    goal: "Read the auth module",
  });

  const events = store.list(SESSION);
  const types = events.map((event) => event.type);

  assert.ok(types.includes("run.started"));
  assert.ok(types.includes("harness.output"));
  assert.ok(types.includes("harness.activity"));
  // The line the whole event family exists for: `tool.requested` means the
  // call crossed Novus's approval gate, and nothing here did.
  assert.ok(!types.some((type) => type.startsWith("tool.")));
});

test("run.started names the harness and the model the handshake reported", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeClaude([INIT, RESULT_OK]), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Look around" });

  const started = store
    .list(SESSION)
    .find((event) => event.type === "run.started");

  assert.ok(started && started.type === "run.started");
  assert.equal(started.payload.run.harness?.kind, "claude-code");
  assert.equal(started.payload.run.harness?.version, "9.9.9");
  // Not a router default. The real model came off `system/init`.
  assert.equal(started.payload.run.model.model, "claude-opus-5");
  assert.equal(started.payload.run.model.provider, "claude-code");
});

test("the declared capabilities admit what Novus gives up", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeClaude([INIT, RESULT_OK]), store);
  const descriptor = await harness.describe();

  // Each of these is a surface that must render disabled or differently. A
  // capability that overstated any of them would be a button that does nothing.
  assert.equal(descriptor.capabilities.pause, "none");
  assert.equal(descriptor.capabilities.approvals, "harness-internal");
  assert.equal(descriptor.capabilities.fileChanges, "observed");
  assert.equal(descriptor.capabilities.toolVisibility, "named");
  assert.notEqual(descriptor.capabilities.steer, "mid-turn");
});

test("exactly one terminal event is appended for a run", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(
    fakeClaude([INIT, ASSISTANT, TOOL_RESULT, RESULT_OK]),
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const terminal = store
    .list(SESSION)
    .filter(
      (event) =>
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled",
    );

  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type, "run.completed");
});

test("a failing tool is a row on the timeline, never the end of the run", async () => {
  const store = new InMemorySessionEventStore();
  const failed = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: "No such file",
        },
      ],
    },
  });
  const harness = harnessOver(
    fakeClaude([INIT, ASSISTANT, failed, RESULT_OK]),
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const events = store.list(SESSION);
  const activity = events.filter((event) => event.type === "harness.activity");

  assert.ok(
    activity.some(
      (event) => event.type === "harness.activity" && event.payload.status === "failed",
    ),
  );
  // The invariant the built-in loop already holds, now held by the adapter too.
  assert.ok(events.some((event) => event.type === "run.completed"));
});

test("a harness that reports failure ends the run as failed", async () => {
  const store = new InMemorySessionEventStore();
  const errored = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "the session ran out of turns",
  });
  const harness = harnessOver(fakeClaude([INIT, errored]), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const failed = store.list(SESSION).find((event) => event.type === "run.failed");

  assert.ok(failed && failed.type === "run.failed");
  assert.match(failed.payload.reason, /ran out of turns/);
});

test("a machine without the CLI fails before a run exists", async () => {
  // A failed run on the log would say an agent tried and could not. Nothing
  // tried: the binary is not there.
  const store = new InMemorySessionEventStore();
  const harness = harnessOver("/nonexistent/definitely-not-claude", store);

  await assert.rejects(
    harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" }),
    /not installed|not on the PATH/,
  );

  assert.equal(store.list(SESSION).length, 0);
});

test("resume is refused out loud rather than silently starting new work", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeClaude([INIT, RESULT_OK]), store);

  await assert.rejects(
    harness.resume({ sessionId: SESSION, actorId: "host", runId: "run-1" }),
  );

  const refusal = store
    .list(SESSION)
    .find((event) => event.type === "harness.unsupported");

  assert.ok(refusal && refusal.type === "harness.unsupported");
  assert.equal(refusal.payload.requested, "resume");
});
