import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";

import type { Workstream } from "../../workstreams.ts";
import { readMilestones } from "./activity-feed.tsx";

/**
 * The log, folded into what actually happened.
 *
 * The timeline this replaces printed one row per event with the contract's own
 * vocabulary on it. These tests hold the two things that made it unreadable:
 * thirty consecutive reads are one milestone, and finishing is never told as
 * succeeding.
 */

let sequence = 0;

const event = (type: SessionEvent["type"], payload: unknown): SessionEvent =>
  ({
    eventId: `e${(sequence += 1)}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 60_000).toISOString(),
    type,
    payload,
  }) as SessionEvent;

/**
 * A read as the runner actually records it: the request *and* its completion.
 *
 * Both, deliberately. An earlier version of this fixture emitted only the
 * request, and it let a fold that closed its group on every `tool.completed`
 * pass — so the tests were green while the real feed printed one "Read 1 file"
 * row per file. A fixture that is not the shape of the log tests nothing.
 */
const read = (path: string): SessionEvent[] => {
  const id = `c${sequence + 1}`;

  return [
    event("tool.requested", {
      runId: "r1",
      call: { id, name: "read_file", input: { path } },
    }),
    event("tool.completed", {
      runId: "r1",
      result: { toolCallId: id, name: "read_file", output: { path, content: "" } },
    }),
  ];
};

const startedRun = (runId: string, model = "claude-sonnet-5"): SessionEvent =>
  event("run.started", {
    run: {
      id: runId,
      sessionId: "s1",
      goal: "Do the thing",
      status: "running",
      startedBy: "a1",
      model: { provider: "anthropic", model },
      createdAt: new Date(0).toISOString(),
    },
  });

const streams: Workstream[] = [
  {
    runId: "r1",
    name: "Claude",
    model: "claude-sonnet-5",
    harness: "Novus agent",
    assignment: "Migrate auth",
    state: "running",
    signal: "--ws-1",
    primary: true,
  },
];

test("a run of reads collapses into one milestone counted by file", () => {
  // Counting calls made a stuck agent re-reading one file look like the
  // busiest workstream in the room.
  const milestones = readMilestones(
    [
      ...read("src/auth.ts"),
      ...read("src/auth.ts"),
      ...read("src/auth.ts"),
      ...read("src/session.ts"),
      event("tool.completed", {
        runId: "r1",
        result: {
          toolCallId: "c9",
          name: "apply_patch",
          output: {
            patchId: "p1",
            path: "src/auth.ts",
            status: "applied",
            additions: 12,
            deletions: 3,
          },
        },
      }),
    ],
    streams,
  );

  const reads = milestones.filter((m) => m.headline.startsWith("Read"));

  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.headline, "Read 2 files");
});

test("a milestone carries its workstream's identity colour", () => {
  const milestones = readMilestones(read("a.ts"), streams);

  assert.equal(milestones[0]?.signal, "--ws-1");
});

test("finishing is told as finishing, never as verified", () => {
  const milestones = readMilestones(
    [event("run.completed", { runId: "r1", summary: "Rewrote the middleware" })],
    streams,
  );

  assert.equal(milestones[0]?.headline, "Finished");
  // The tone that would give it the green treatment.
  assert.notEqual(milestones[0]?.tone, "verified");
});

test("only a passing test run earns the verified tone", () => {
  const passed = readMilestones(
    [
      event("tool.completed", {
        runId: "r1",
        result: {
          toolCallId: "c1",
          name: "run_tests",
          output: {
            command: "pnpm test",
            exitCode: 0,
            timedOut: false,
            durationMs: 900,
            stdout: "",
            stderr: "",
            truncated: false,
            passed: true,
          },
        },
      }),
    ],
    streams,
  );

  assert.equal(passed[0]?.tone, "verified");
  assert.equal(passed[0]?.headline, "Tests passed");
});

test("a person's direction is attributed to a person, not to the agent", () => {
  const milestones = readMilestones(
    [
      event("direction.queued", {
        runId: "r1",
        directionEventId: "d1",
        direction: "Leave the cookie path alone for now",
      }),
    ],
    streams,
  );

  assert.equal(milestones[0]?.human, true);
  assert.equal(milestones[0]?.tone, "attention");
  assert.match(milestones[0]?.detail ?? "", /cookie path/);
});

test("reads pending when a run fails are still reported", () => {
  // Otherwise a run that died mid-exploration shows nothing at all before the
  // failure, which reads as an agent that never did anything.
  const milestones = readMilestones(
    [
      ...read("a.ts"),
      ...read("b.ts"),
      event("run.failed", { runId: "r1", reason: "429 rate limited" }),
    ],
    streams,
  );

  assert.equal(milestones.length, 2);
  assert.equal(milestones[0]?.headline, "Read 2 files");
  assert.equal(milestones[1]?.tone, "failed");
});

test("a superseded turn keeps the agent's name and its identity colour", () => {
  // The rail holds current workstreams only, so the first of two turns is not
  // in it. Reading names from there alone made one agent appear under two
  // names in one feed — "The agent" for the first half, "Claude" for the
  // second — and turned its avatars grey halfway down.
  const milestones = readMilestones(
    [
      startedRun("old-run"),
      event("run.completed", { runId: "old-run", summary: "First pass." }),
      startedRun("r1"),
    ],
    streams,
  );

  for (const milestone of milestones) {
    assert.equal(milestone.actor, "Claude", "every turn is the same agent");
    assert.equal(milestone.signal, "--ws-1", "and keeps one identity colour");
  }
});

test("a run the log never started still gets a name rather than nothing", () => {
  const milestones = readMilestones(
    [event("run.completed", { runId: "ghost", summary: "…" })],
    [],
  );

  assert.equal(milestones[0]?.actor, "The agent");
});
