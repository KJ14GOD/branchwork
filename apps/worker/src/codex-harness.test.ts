import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { CodexHarness, codexArgs, codexSandbox, mapCodexLine } from "./codex-harness.ts";

/**
 * The second harness.
 *
 * These tests are the evidence for a claim about the architecture, not just
 * about Codex: adding an independently-designed harness took one adapter and
 * changed nothing above it. The Workroom, the rail, the event contract and the
 * mission-state derivation are all untouched by this file's existence.
 *
 * Fixtures are the shapes a real `codex exec --json` run emitted.
 */

const SESSION = "s1";

const fakeCodex = (lines: string[], exitCode = 0): string => {
  const dir = mkdtempSync(join(tmpdir(), "novus-fake-codex-"));
  const path = join(dir, "codex");
  const body = lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join("\n");

  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
${body}
exit ${exitCode}
`,
  );
  chmodSync(path, 0o755);

  return path;
};

const THREAD = JSON.stringify({ type: "thread.started", thread_id: "t1" });
const TURN = JSON.stringify({ type: "turn.started" });
const MESSAGE = JSON.stringify({
  type: "item.completed",
  item: { id: "item_0", type: "agent_message", text: "Mapped the boundaries." },
});
const COMMAND = JSON.stringify({
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", text: "pnpm test" },
});
const DONE = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 16776, output_tokens: 5 },
});

const harnessOver = (command: string, store: InMemorySessionEventStore) =>
  new CodexHarness({
    eventStore: store,
    cwd: tmpdir(),
    permissions: { allowWrites: false, allowCommands: false },
    command,
  });

test("a Codex run lands on the log under the same event family as Claude Code", async () => {
  // The architectural claim: a second harness needed no new event types, no
  // renderer change, and no contract change. It reuses `harness.*` exactly.
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeCodex([THREAD, TURN, MESSAGE, COMMAND, DONE]), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Map it" });

  const types = store.list(SESSION).map((event) => event.type);

  assert.ok(types.includes("run.started"));
  assert.ok(types.includes("harness.output"));
  assert.ok(types.includes("harness.activity"));
  assert.ok(types.includes("run.completed"));
  assert.ok(!types.some((type) => type.startsWith("tool.")));
});

test("run.started names Codex as the harness", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeCodex([THREAD, TURN, DONE]), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const started = store.list(SESSION).find((event) => event.type === "run.started");

  assert.ok(started && started.type === "run.started");
  assert.equal(started.payload.run.harness?.kind, "codex");
  assert.equal(started.payload.run.harness?.version, "9.9.9");
});

test("Codex declares less than Claude Code, and says so", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeCodex([THREAD, DONE]), store);
  const descriptor = await harness.describe();

  // Its stream reports tokens, not money — so it must not claim cost.
  assert.equal(descriptor.capabilities.cost, "none");
  // It never names the model, so nothing may present one as fact.
  assert.equal(descriptor.capabilities.reportsModel, false);
  assert.equal(descriptor.capabilities.pause, "none");
});

test("reasoning is never written to a shared timeline", async () => {
  // The harness's private thinking is not an act and not evidence. Publishing
  // it would put something on a shared mission that nobody chose to share.
  const store = new InMemorySessionEventStore();
  const reasoning = JSON.stringify({
    type: "item.completed",
    item: { id: "r1", type: "reasoning", text: "Considering three approaches…" },
  });
  const harness = harnessOver(fakeCodex([THREAD, TURN, reasoning, DONE]), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  for (const event of store.list(SESSION)) {
    assert.ok(
      !JSON.stringify(event).includes("Considering three approaches"),
      "reasoning must not reach the log",
    );
  }
});

test("a turn that never completes fails the run", async () => {
  const store = new InMemorySessionEventStore();
  const harness = harnessOver(fakeCodex([THREAD, TURN], 1), store);

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const terminal = store
    .list(SESSION)
    .filter((e) => e.type === "run.completed" || e.type === "run.failed");

  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type, "run.failed");
});

test("a read-only session gets a read-only sandbox", () => {
  assert.equal(codexSandbox({ allowWrites: false, allowCommands: false }), "read-only");
  assert.equal(codexSandbox({ allowWrites: true, allowCommands: false }), "workspace-write");
});

test("no permission combination ever asks for full access", () => {
  // The flag that would hand a subprocess the whole machine. No input to this
  // function produces it, which is why the function exists.
  for (const allowWrites of [true, false]) {
    for (const allowCommands of [true, false]) {
      const args = codexArgs({ allowWrites, allowCommands });

      assert.ok(!args.includes("danger-full-access"));
      assert.ok(!args.join(" ").includes("--dangerously"));
    }
  }
});

test("unknown item kinds become activity rather than being dropped or thrown on", () => {
  const out = mapCodexLine(
    {
      type: "item.completed",
      item: { id: "x", type: "something_new_next_year", text: "did a thing" },
    },
    { sessionId: "s", actorId: "a", runId: "r" },
  );

  assert.equal(out.events[0]?.type, "harness.activity");
  // Never guessed into a class a reader could mistake for a judgement.
  assert.equal(
    (out.events[0] as { payload: { class: string } }).payload.class,
    "unknown",
  );
});
