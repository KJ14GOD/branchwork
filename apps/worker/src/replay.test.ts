import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { InMemorySessionEventStore, SessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, ScriptedModelAdapter } from "./model.ts";
import { AllowListApprovalGate } from "./policy.ts";
import { projectSession } from "./projection.ts";
import { ReadFileTool } from "./tools.ts";

const run = promisify(execFile);

/**
 * Milestone 5: replay, and crash recovery.
 *
 * The claim under test is V1's: the event log is the source of truth, current
 * state is a projection rebuilt from it, and replay reconstructs that state
 * without re-running anything. Both halves matter — a log that survives a crash
 * but cannot be turned back into state is only half a source of truth.
 */

const SESSION = "replay-session";

test("state rebuilt from the log matches the run that produced it", async () => {
  const store = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    store,
    new FixedModelRouter({ provider: "anthropic", model: "test" }),
    [new ScriptedModelAdapter({ provider: "anthropic", model: "test" })],
    [new ReadFileTool(process.cwd())],
    new AllowListApprovalGate(["apply_patch"], "host"),
  );

  const result = await runner.run({
    sessionId: SESSION,
    actorId: "agent-1",
    goal: "Inspect the project configuration",
  });

  const projected = projectSession(SESSION, store.list(SESSION));
  const projectedRun = projected.runs.find((entry) => entry.runId === result.runId);

  assert.ok(projectedRun, "the run did not survive projection");
  assert.equal(projectedRun.status, "completed");
  assert.equal(projectedRun.goal, "Inspect the project configuration");
  // Derived from the log rather than carried alongside it: the count has to
  // come out of the events, which is the whole point.
  assert.equal(
    projectedRun.toolCalls,
    result.events.filter(
      (event) => event.type === "tool.completed" || event.type === "tool.failed",
    ).length,
  );
  assert.equal(projected.sequence, store.list(SESSION).length - 1);
});

test("projection is a pure function of the log, not of arrival order", () => {
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "participant.joined",
    payload: {
      participant: {
        id: "p-owner",
        sessionId: SESSION,
        name: "Host",
        kind: "human",
        role: "owner",
        joinedAt: new Date().toISOString(),
      },
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "participant.joined",
    payload: {
      participant: {
        id: "p-guest",
        sessionId: SESSION,
        name: "Teammate",
        kind: "human",
        role: "editor",
        joinedAt: new Date().toISOString(),
      },
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "control.transferred",
    payload: {
      fromParticipantId: "p-owner",
      toParticipantId: "p-guest",
      acceptedAt: new Date().toISOString(),
    },
  });

  const ordered = store.list(SESSION);
  const shuffled = [...ordered].reverse();

  // A projection that depended on arrival order would disagree with itself
  // between a live session and a replay of the same session.
  assert.deepEqual(
    projectSession(SESSION, shuffled),
    projectSession(SESSION, ordered),
  );
  assert.equal(projectSession(SESSION, ordered).controlHeldBy, "p-guest");
});

test("replay does not re-execute what the log records", async () => {
  const store = new InMemorySessionEventStore();
  const marker = join(await mkdtemp(join(tmpdir(), "novus-replay-")), "ran");

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-1",
        sessionId: SESSION,
        goal: "Do something with side effects",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "c1",
        name: "run_command",
        output: {
          command: `touch ${marker}`,
          exitCode: 0,
          timedOut: false,
          durationMs: 4,
          stdout: "",
          stderr: "",
          truncated: false,
        },
      },
    },
  });

  const projected = projectSession(SESSION, store.list(SESSION));

  // The command is in the log as a record that it ran. Rebuilding state from
  // it must never run it: V1 makes re-execution a separate operation started
  // from a checkpoint, not something a replay does by accident.
  assert.equal(projected.runs[0]?.toolCalls, 1);
  await assert.rejects(() => run("test", ["-e", marker]));
});

test("only applied patches count as files changed", () => {
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-1",
        sessionId: SESSION,
        goal: "Change a file",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "c1",
        name: "propose_patch",
        output: {
          patchId: "p1",
          path: "src/a.ts",
          intent: "change it",
          status: "proposed",
          diff: "--- a\n+++ b\n",
          additions: 3,
          deletions: 1,
        },
      },
    },
  });

  // A proposal a denial prevented is not a change, and a replay that counted it
  // would tell somebody the file was edited when it was not.
  assert.deepEqual(projectSession(SESSION, store.list(SESSION)).runs[0]?.filesChanged, []);
});

test("pending direction survives into the projection, applied direction does not", () => {
  const store = new InMemorySessionEventStore();

  const first = store.append({
    sessionId: SESSION,
    actorId: "teammate",
    type: "direction.submitted",
    payload: { runId: "run-1", direction: "Do not change the token schema" },
  });
  const second = store.append({
    sessionId: SESSION,
    actorId: "teammate",
    type: "direction.submitted",
    payload: { runId: "run-1", direction: "Keep the public API stable" },
  });
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "direction.applied",
    payload: {
      runId: "run-1",
      directionEventId: first.eventId,
      direction: "Do not change the token schema",
    },
  });

  const projected = projectSession(SESSION, store.list(SESSION));

  assert.deepEqual(
    projected.pendingDirection.map((entry) => entry.eventId),
    [second.eventId],
  );
});

test("a log written before a crash reloads complete and in order", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "novus-crash-")), "events.db");
  const before = new SessionEventStore({ databasePath: file });

  for (let index = 0; index < 25; index += 1) {
    before.append({
      sessionId: SESSION,
      actorId: "agent-1",
      type: "run.progress",
      payload: { runId: "run-1", message: `step ${index}` },
    });
  }

  // No close, no flush, no graceful anything — the handle is simply abandoned,
  // which is what a killed process leaves behind.
  const after = new SessionEventStore({ databasePath: file });
  const reloaded = after.list(SESSION);

  assert.equal(reloaded.length, 25);
  assert.deepEqual(
    reloaded.map((event) => event.sequence),
    Array.from({ length: 25 }, (_, index) => index),
  );
  after.close();
});

test("a worker killed mid-run leaves a log the next process can read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novus-kill-"));
  const file = join(directory, "events.db");
  const script = join(directory, "writer.ts");

  // Imported by absolute path: the scratch directory has no node_modules, so
  // the workspace alias does not resolve from there.
  const storeModule = new URL(
    "../../session-service/src/event-store.ts",
    import.meta.url,
  ).href;

  await writeFile(
    script,
    `import { SessionEventStore } from ${JSON.stringify(storeModule)};
const store = new SessionEventStore({ databasePath: ${JSON.stringify(file)} });
for (let index = 0; index < 500; index += 1) {
  store.append({
    sessionId: ${JSON.stringify(SESSION)},
    actorId: "agent-1",
    type: "run.progress",
    payload: { runId: "run-1", message: "step " + index },
  });
  if (index === 5) console.log("ready");
}
`,
  );

  const child = (await import("node:child_process")).spawn(
    process.execPath,
    ["--experimental-strip-types", script],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  await new Promise<void>((settle) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        settle();
      }
    });
    child.on("exit", () => settle());
  });

  // SIGKILL: no handler runs, nothing is flushed on the way out.
  child.kill("SIGKILL");
  await new Promise((settle) => child.on("exit", settle));

  const store = new SessionEventStore({ databasePath: file });
  const events = store.list(SESSION);

  assert.ok(events.length > 0, "the killed process left nothing readable");
  // Every event that survived is a whole event, and the sequence has no holes.
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index),
  );
  assert.ok(
    events.every((event) => event.type === "run.progress"),
    "a torn event survived the kill",
  );
  store.close();
});
