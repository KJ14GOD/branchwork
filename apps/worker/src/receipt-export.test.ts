import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { exportReceipt } from "./receipt-export.ts";

/**
 * The artefact that leaves the machine.
 *
 * Everything the decision screen shows used to vanish with the tab, leaving a
 * diff in somebody's working tree and no record of what it was chosen over or
 * why. This is the part a reviewer who does not have Novus actually reads —
 * which makes it the worst possible place for an overstatement, because it
 * looks official and nobody can check it against the screen.
 */

const SESSION = "receipt-session";

const startRun = (
  store: InMemorySessionEventStore,
  runId: string,
  goal: string,
) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.started",
    payload: {
      run: {
        id: runId,
        sessionId: SESSION,
        goal,
        status: "running",
        startedBy: "agent-1",
        model: { provider: "anthropic", model: "test" },
        createdAt: new Date().toISOString(),
      },
    },
  });

const finish = (store: InMemorySessionEventStore, runId: string, summary: string) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "run.completed",
    payload: { runId, summary },
  });

const patch = (store: InMemorySessionEventStore, runId: string, path: string) =>
  store.append({
    sessionId: SESSION,
    actorId: "agent-1",
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: `c-${runId}-${path}`,
        name: "apply_patch",
        output: { patchId: `p-${runId}`, path, status: "applied", additions: 9, deletions: 2 },
      },
    },
  });

const receipt = (store: InMemorySessionEventStore) =>
  exportReceipt(SESSION, "/tmp/repo", store.list(SESSION));

test("an untested approach is exported as unverified, never as done", () => {
  const store = new InMemorySessionEventStore();
  startRun(store, "run-1", "Fix the reconnect backoff");
  patch(store, "run-1", "src/reconnect.ts");
  finish(store, "run-1", "Everything works now.");

  const markdown = receipt(store);

  // The summary is confident and nothing verified it. Both facts have to be
  // in the file, and the label has to travel with the sentence — a reader
  // three weeks later has no other way to know.
  assert.match(markdown, /\*\*Unverified\*\* — ran no tests/);
  assert.match(markdown, /Unverified claim \(this approach ran no tests\)/);
  assert.match(markdown, /Everything works now/);
});

test("the decision and its reasoning survive the export", () => {
  const store = new InMemorySessionEventStore();
  startRun(store, "run-1", "Fix it");
  startRun(store, "fork-a", "Fix it differently");
  finish(store, "fork-a", "Reworked the backoff.");
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "fork-a",
      checkpointId: "cp-1",
      kind: "adopt",
      rationale: "Smaller change, and it keeps the public API stable.",
      outcome: { applied: true, files: ["src/a.ts"] },
    },
  });

  const markdown = receipt(store);

  assert.match(markdown, /## Decision/);
  assert.match(markdown, /\*\*Adopted\*\*/);
  assert.match(markdown, /keeps the public API stable/);
});

test("a revision request is exported as a decision that wrote nothing", () => {
  const store = new InMemorySessionEventStore();
  startRun(store, "run-1", "Fix it");
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "decision.recorded",
    payload: {
      runId: "run-1",
      checkpointId: "cp-1",
      kind: "revision",
      rationale: "Drops the retry budget on reconnect.",
      outcome: {
        applied: false,
        reason: "Revision requested — this approach was not applied.",
        conflicts: [],
      },
    },
  });

  const markdown = receipt(store);

  // Selection and application stay distinct in the file too. "Not applied"
  // must not read as "the decision failed".
  assert.match(markdown, /\*\*Revision requested\*\*/);
  assert.match(markdown, /Nothing was written/);
  assert.doesNotMatch(markdown, /failed/i);
});

test("an unpriced run is exported as not counted, never as free", () => {
  const store = new InMemorySessionEventStore();
  startRun(store, "run-1", "Fix it");
  finish(store, "run-1", "Done.");

  const markdown = receipt(store);

  // A run reported as costing $0.00 because nobody had a rate for its model
  // is a worse answer than one that says it does not know.
  assert.match(markdown, /not counted/);
  assert.doesNotMatch(markdown, /\$0\.0000/);
});

test("nothing in the export ranks the approaches", () => {
  const store = new InMemorySessionEventStore();
  startRun(store, "run-1", "Fix it");
  patch(store, "run-1", "src/shared.ts");

  // A real fork event, so the baseline and the alternative both appear —
  // without one the export has a single approach and nothing to contest.
  store.append({
    sessionId: SESSION,
    actorId: "host",
    type: "fork.created",
    payload: {
      fork: {
        runId: "fork-a",
        sessionId: SESSION,
        checkpointId: "cp-1",
        parentRunId: "run-1",
        label: "differently",
        worktreePath: "/tmp/worktrees/fork-a",
        branch: "novus/fork-a",
        revision: "abc1234",
        devPorts: [4500],
        createdAt: new Date().toISOString(),
      },
    },
  });
  startRun(store, "fork-a", "Differently");
  patch(store, "fork-a", "src/shared.ts");

  const markdown = receipt(store);

  for (const forbidden of [/recommend/i, /winner/i, /\bbest\b/i, /score/i]) {
    assert.doesNotMatch(markdown, forbidden, `the export says ${forbidden}`);
  }

  // The one comparative statement it may make is which file both touched,
  // because that is a measurement rather than a verdict.
  assert.match(markdown, /changed by more than one approach/i);
});
