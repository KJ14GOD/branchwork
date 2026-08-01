import assert from "node:assert/strict";
import test from "node:test";
import { RunReceiptSchema } from "@novus/contracts";
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

test("a chosen attempt survives into the projection, not only the live event stream", () => {
  // decision.recorded already drew a real row in the shared event timeline —
  // this was never a rendering gap. The gap was everywhere else that reasons
  // about session state from a rebuilt projection rather than a live stream:
  // a restart, a replay, or a guest that reconnects after missing the event
  // had no way to learn a decision was ever made. See
  // skills/novus-extend-event-contract for why this class of gap is easy to
  // introduce and hard to notice.
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-1",
        sessionId: SESSION,
        goal: "Fix the locking behavior",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

  const withoutDecision = projectSession(SESSION, store.list(SESSION));
  assert.equal(withoutDecision.decision, null);

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "run-1",
      checkpointId: "checkpoint-1",
      outcome: { applied: true, files: ["src/lock.ts"] },
    },
  });

  const withDecision = projectSession(SESSION, store.list(SESSION));

  // The event above carries no `kind`, no `rationale`, no `target` and no
  // `alternatives` — exactly like every decision recorded before each of those
  // fields existed. The projection fills the kind in as `adopt` and the target
  // as `attempt`, which is what those decisions were: adopting a fork was the
  // only decision the product could record. It leaves the rationale null
  // rather than inventing one, and the alternatives empty rather than guessing
  // from forks that exist now. A log that could not be replayed after a schema
  // addition would make every past session unreadable — and this repository
  // has shipped that break once already.
  assert.deepEqual(withDecision.decision, {
    runId: "run-1",
    target: "attempt",
    checkpointId: "checkpoint-1",
    alternatives: [],
    kind: "adopt",
    rationale: null,
    decidedBy: "host",
    outcome: { applied: true, files: ["src/lock.ts"] },
  });

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "run-1",
      checkpointId: "checkpoint-1",
      kind: "revision",
      rationale: "Right shape, but it drops the retry budget on reconnect.",
      outcome: {
        applied: false,
        reason: "Revision requested — this approach was not applied.",
        conflicts: [],
      },
    },
  });

  const revised = projectSession(SESSION, store.list(SESSION));

  // A revision request is a decision and survives replay like any other. It is
  // recorded and not applied, which is the distinction the outcome language
  // exists to keep: asking for another pass is not a failed application.
  assert.equal(revised.decision?.kind, "revision");
  assert.match(revised.decision?.rationale ?? "", /retry budget/);
  assert.equal(revised.decision?.outcome.applied, false);
});

test("keeping the baseline survives replay, with its rationale and its context", () => {
  // The baseline is the approach with no worktree, which is why it could not
  // be chosen at all until now. Replay is where that matters most: which run a
  // rebuilt projection calls "the baseline" is derived from the forks that
  // exist at the time of asking, so a decision that stored only a run id would
  // quietly change meaning the next time somebody forked. The event says
  // `target: "baseline"` and names the checkpoint, so the replay does not have
  // to guess.
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: "run-parent",
        sessionId: SESSION,
        goal: "Fix the locking behavior",
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

  store.append({
    sessionId: SESSION,
    actorId: "participant-7",
    type: "decision.recorded",
    payload: {
      runId: "run-parent",
      target: "baseline",
      checkpointId: "checkpoint-1",
      alternatives: ["run-attempt-a", "run-attempt-b"],
      kind: "adopt",
      rationale: "Neither attempt beat what the parent already had on tests.",
      outcome: {
        applied: "unnecessary",
        reason:
          "The current work is already in the working tree, so nothing needed to be written.",
      },
    },
  });

  const replayed = projectSession(SESSION, store.list(SESSION));

  assert.equal(replayed.decision?.runId, "run-parent");
  assert.equal(replayed.decision?.target, "baseline");
  assert.equal(replayed.decision?.checkpointId, "checkpoint-1");
  assert.deepEqual(replayed.decision?.alternatives, [
    "run-attempt-a",
    "run-attempt-b",
  ]);
  assert.match(replayed.decision?.rationale ?? "", /beat what the parent/);
  // The decider, from the envelope. The projection is the only place a reader
  // downstream of the raw log gets to learn who made the call.
  assert.equal(replayed.decision?.decidedBy, "participant-7");

  // A no-op, not a refusal. A replay that turned this into `applied: false`
  // would tell a reader an application had been blocked when none was owed.
  assert.equal(replayed.decision?.outcome.applied, "unnecessary");
});

test("a baseline chosen before any fork existed replays without a checkpoint", () => {
  // The only case where a decision legitimately names no checkpoint: nothing
  // was ever forked, so there is no shared starting point the alternatives
  // were cut from. Recording an invented one would be a worse record than an
  // absent field, and the projection has to keep reading it either way.
  const store = new InMemorySessionEventStore();

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "run-parent",
      target: "baseline",
      alternatives: [],
      kind: "adopt",
      rationale: "One approach, and it is the one we are keeping.",
      outcome: { applied: "unnecessary", reason: "Already in the working tree." },
    },
  });

  const replayed = projectSession(SESSION, store.list(SESSION));

  assert.equal(replayed.decision?.checkpointId, null);
  assert.equal(replayed.decision?.target, "baseline");
});

test("a decision on an attempt cannot be recorded without the checkpoint it was cut from", () => {
  // The other side of making `checkpointId` optional. It was relaxed for the
  // baseline alone, and the schema still refuses an attempt decision that
  // omits it — including every one already in the log, which all carry one.
  const store = new InMemorySessionEventStore();

  assert.throws(() =>
    store.append({
      sessionId: SESSION,
      actorId: "host",
      type: "decision.recorded",
      payload: {
        runId: "run-attempt-a",
        target: "attempt",
        kind: "adopt",
        rationale: "Adopting an attempt without saying what it branched from.",
        outcome: { applied: true, files: ["src/lock.ts"] },
      },
    }),
  );
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

/**
 * A receipt written before `checks` and `verification` existed.
 *
 * Reproduces a real failure: opening an older session threw a Zod error
 * naming exactly these two fields. The log is durable and the schema is not
 * as old as the log, so a field added later cannot be required — the whole
 * point of an event log is that yesterday's rows still parse today.
 */
test("a receipt from before checks existed still parses, and claims nothing", () => {
  const parsed = RunReceiptSchema.safeParse({
    runId: "run-1",
    sessionId: SESSION,
    goal: "Fix the locking",
    status: "completed",
    model: { provider: "anthropic", model: "test" },
    base: { revision: "abc123", dirty: false },
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:01:00.000Z",
    elapsedMs: 60_000,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      modelCalls: 1,
      callsMissingUsage: 0,
      costUsd: null,
      modelTimeMs: 500,
    },
    toolCalls: [],
    filesChanged: [],
    tests: [],
    approvals: [],
    summary: "Done.",
  });

  // Written out rather than spread from a helper: this is a *historical*
  // shape, and the value of the test is that it stays frozen while the schema
  // moves. A fixture that tracked the current schema would pass forever and
  // catch nothing.


  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
  );

  if (parsed.success) {
    assert.deepEqual(parsed.data.checks, []);
    // Unverified, and the direction is the point. This receipt carries no
    // evidence anything was checked, so the only safe reading is the one that
    // claims nothing — defaulting to "verified" would retroactively mark
    // every historical run as proven.
    assert.equal(parsed.data.verification, "unverified");
  }
});

test("every field added to the receipt since is defaulted, not required", () => {
  // The failure this pins was reported from the app: opening an older session
  // threw a Zod error naming payload.receipt.checks and .verification, and
  // three more fields were missing behind them. Five in total had been added
  // as required to a schema that has to read years of its own history.
  //
  // Asserting on the *shape of the rule* rather than on today's field list, so
  // this keeps working as the receipt grows.
  const minimal = {
    runId: "run-1",
    sessionId: SESSION,
    goal: "Something old",
    status: "completed",
    model: { provider: "anthropic", model: "test" },
    base: { revision: null, dirty: null },
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:01.000Z",
    elapsedMs: 1_000,
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, callsMissingUsage: 0 },
    toolCalls: [],
    filesChanged: [],
    tests: [],
    approvals: [],
  };

  const parsed = RunReceiptSchema.safeParse(minimal);

  assert.equal(
    parsed.success,
    true,
    parsed.success
      ? ""
      : `a receipt from before these fields existed no longer parses:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
  );

  if (parsed.success) {
    // Every default has to claim less, never more. A field that filled itself
    // in optimistically would retroactively mark historical runs as proven.
    assert.equal(parsed.data.verification, "unverified");
    assert.deepEqual(parsed.data.checks, []);
    assert.equal(parsed.data.testsFollowedFinalChange, null);
    assert.equal(parsed.data.usage.costUsd, null);
  }
});
