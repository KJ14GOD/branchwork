import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";

/**
 * What the home screen puts in front of a person, and in what order.
 *
 * The screen was a list of repository paths and event counts, which answers
 * "what exists" and never "what needs me" — and five missions in one
 * repository were five identical rows reading "4 events".
 *
 * `remembered()` is driven directly rather than through HTTP: it is the whole
 * derivation, and no provider or repository is involved in any of it.
 */

const SESSION = "mission-a";

const adapter = {
  selection: { provider: "anthropic", model: "test" } as const,
  complete: () => new Promise<never>(() => undefined),
};

const registryOver = (store: InMemorySessionEventStore) =>
  new SessionRegistry(store, new FixedModelRouter(adapter.selection), [adapter]);

const created = (store: InMemorySessionEventStore, sessionId = SESSION) =>
  store.append({
    sessionId,
    actorId: "host",
    type: "session.created",
    payload: {
      session: {
        id: sessionId,
        repositoryPath: "/tmp/repo",
        // Null on purpose: a session is a repository somebody opened, and
        // goals arrive per run. That is exactly why the mission's name has to
        // come from its first run rather than from here.
        goal: null,
        status: "active",
        createdAt: new Date().toISOString(),
      },
    },
  });

/**
 * A real fork, which is what makes a second *approach*.
 *
 * Distinct from `startRun` on purpose: a second run alone is a second turn in
 * the same work, and the two must not be counted the same way.
 */
const forkFrom = (
  store: InMemorySessionEventStore,
  parentRunId: string,
  runId: string,
  label: string,
  sessionId = SESSION,
) =>
  store.append({
    sessionId,
    actorId: "host",
    type: "fork.created",
    payload: {
      fork: {
        runId,
        sessionId,
        checkpointId: `checkpoint-${runId}`,
        parentRunId,
        label,
        worktreePath: `/tmp/worktrees/${runId}`,
        branch: `novus/${runId}`,
        revision: "a".repeat(40),
        devPorts: [5310],
        createdAt: new Date().toISOString(),
      },
    },
  });

const startRun = (
  store: InMemorySessionEventStore,
  runId: string,
  goal: string,
  sessionId = SESSION,
) =>
  store.append({
    sessionId,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: runId,
        sessionId,
        goal,
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

const finish = (
  store: InMemorySessionEventStore,
  runId: string,
  sessionId = SESSION,
) =>
  store.append({
    sessionId,
    actorId: "agent-1",
    type: "run.completed",
    payload: { runId, summary: "Done." },
  });

const only = (store: InMemorySessionEventStore) => {
  const [mission] = registryOver(store).remembered();
  assert.ok(mission, "no mission was remembered");

  return mission;
};

test("a mission is named by its goal, not by its repository", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Fix the reconnect backoff");

  // The path was the title, so every mission in one repository looked the
  // same. It is still there, as the thing you narrow down by.
  assert.equal(only(store).goal, "Fix the reconnect backoff");
  assert.equal(only(store).repositoryPath, "/tmp/repo");
});

test("approaches with no decision are the most urgent thing on the screen", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Fix it");
  forkFrom(store, "run-1", "fork-a", "Fix it differently");
  startRun(store, "fork-a", "Fix it differently");
  finish(store, "fork-a");

  // Even with a run still going. The other approaches are finished and the
  // mission is waiting on a person, which is the whole product.
  assert.equal(only(store).attention, "needs-decision");
  assert.equal(only(store).approaches, 2);
});

test("asking a second thing is a second turn, not a second approach", () => {
  // The bug this pins: `runs.length > 1` called every follow-up question a
  // competing approach, so an ordinary second ask filed the mission under
  // "needs your decision" — and the desktop opens the Decision Room for that
  // automatically, landing a person on a comparison of one attempt with
  // nothing to decide. `/compare` never agreed: it counts baseline + forks.
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Add a health endpoint");
  finish(store, "run-1");
  startRun(store, "run-2", "Now cover it with a test");
  finish(store, "run-2");

  assert.equal(only(store).approaches, 1);
  assert.notEqual(only(store).attention, "needs-decision");
});

test("an unanswered approval outranks a run that is merely going", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Fix it");
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.approval_requested",
    payload: {
      runId: "run-1",
      call: {
        id: "c1",
        name: "apply_patch",
        input: { patchId: "p1" },
      },
      toolClass: "write",
    },
  });

  assert.equal(only(store).attention, "needs-approval");

  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "tool.approved",
    payload: { runId: "run-1", toolCallId: "c1", approvedBy: "host" },
  });

  // Answered, so it stops asking. A blocked-forever badge is how a screen
  // teaches people to ignore it. Not "running": this session is not open in
  // this process, so nothing here is driving that run — see the stale-Running
  // test below.
  assert.equal(only(store).attention, "needs-direction");
});

test("a mission that ran no tests is unverified, never clean", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Change it");
  finish(store, "run-1");

  // Completion is not verification, at the level a person scans rather than
  // reads. A tick here would be the same lie the compare screen refuses.
  assert.equal(only(store).evidence, "unverified");
  assert.equal(only(store).attention, "needs-direction");
});

test("a failing test is not the same as no test", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Change it");
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "t1",
        name: "run_tests",
        output: {
          command: "npm test",
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
          stdout: "",
          stderr: "",
          truncated: false,
          passed: false,
        },
      },
    },
  });

  assert.equal(only(store).evidence, "failing");
});

test("urgency orders the inbox, because recency buries what has stopped moving", async () => {
  const store = new InMemorySessionEventStore();

  // Oldest, and the one that needs somebody: two approaches, no decision.
  // A real fork, because two bare runs are two turns of one approach.
  created(store, "waiting");
  startRun(store, "w-1", "Needs a decision", "waiting");
  forkFrom(store, "w-1", "w-2", "The alternative", "waiting");
  startRun(store, "w-2", "The alternative", "waiting");
  finish(store, "w-2", "waiting");

  // A real gap. Timestamps are millisecond-precision and every append above
  // lands inside one, so without this the two sessions share a lastActivityAt,
  // a recency sort is stable, and insertion order hands back the right answer
  // for the wrong reason — the first version of this test passed against a
  // registry with the urgency ordering deleted.
  await new Promise((settle) => setTimeout(settle, 5));

  // Newest, and asking for nothing.
  created(store, "busy");
  startRun(store, "b-1", "Still going", "busy");

  const missions = registryOver(store).remembered();

  assert.notEqual(
    missions[0]?.lastActivityAt,
    missions[1]?.lastActivityAt,
    "the two missions must differ in recency or this proves nothing",
  );

  // Sorted by last activity, the mission that stopped because it was waiting
  // on a human sinks below every session still churning on its own — which is
  // exactly backwards for a screen whose job is "what needs me".
  assert.equal(missions[0]?.id, "waiting");
  assert.equal(missions[0]?.attention, "needs-decision");
  assert.equal(missions[1]?.id, "busy");
  // Not "running" — neither session is open in this process. What is being
  // asserted is the ordering, and needs-decision still outranks it.
  assert.equal(missions[1]?.attention, "needs-direction");
});

test("a decided mission stops asking for anything", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Fix it");
  startRun(store, "fork-a", "Differently");
  finish(store, "run-1");
  finish(store, "fork-a");
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "fork-a",
      checkpointId: "cp-1",
      kind: "adopt",
      rationale: "Smaller change and it keeps the public API stable.",
      outcome: { applied: true, files: ["src/a.ts"] },
    },
  });

  assert.equal(only(store).attention, "settled");
});

test("a run nobody is driving does not keep reading as Running", () => {
  const store = new InMemorySessionEventStore();
  created(store);
  startRun(store, "run-1", "Interrupted by a worker exit");

  // The session is in the log and not open in this process, which is exactly
  // the state every session is in when the home screen lists them. A run is
  // only "running" in the log until something writes its ending, and a worker
  // that exits mid-run writes nothing — so this row claimed to be running for
  // as long as the log survived.
  const mission = only(store);

  assert.notEqual(mission.attention, "running");
  assert.equal(mission.attention, "needs-direction");
});

test("a session this process really is driving still reads as Running", async () => {
  const store = new InMemorySessionEventStore();
  const registry = registryOver(store);

  // Opened here, so the claim is one this process can actually stand behind.
  const session = await registry.create({ repositoryPath: process.cwd() });
  startRun(store, "run-1", "Genuinely in flight", session.id);

  const mission = registry
    .remembered()
    .find((entry) => entry.id === session.id);

  assert.equal(mission?.attention, "running");
});
