import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionEventSchema, type SessionEvent } from "@novus/contracts";

import {
  describeConnection,
  mergeEvent,
  resumeSequence,
  retryDelayMs,
  summarise,
  type GuestConnection,
} from "./timeline.ts";

const SESSION = "session-1";
const RUN = "run-1";

// Built through the shared schema rather than cast into shape: a fixture the
// worker could never emit would make these tests agree with nothing.
const envelope = (sequence: number) => ({
  eventId: `event-${sequence}`,
  sessionId: SESSION,
  sequence,
  actorId: "agent",
  occurredAt: new Date(1_000 + sequence * 1_000).toISOString(),
});

const progress = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "run.progress",
    payload: { runId: RUN, message: `step ${sequence}` },
  });

const started = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "run.started",
    payload: {
      run: {
        id: RUN,
        sessionId: SESSION,
        goal: "Fix the failing authentication refresh test",
        status: "running",
        startedBy: "host",
        model: { provider: "anthropic", model: "claude-opus-5" },
        createdAt: envelope(sequence).occurredAt,
      },
    },
  });

const failed = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "run.failed",
    payload: { runId: RUN, reason: "step ceiling reached" },
  });

const cancelled = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "run.cancelled",
    payload: { runId: RUN },
  });

const patched = (
  sequence: number,
  additions: number,
  deletions: number,
): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "tool.completed",
    payload: {
      runId: RUN,
      result: {
        toolCallId: `call-${sequence}`,
        name: "propose_patch",
        output: {
          patchId: `patch-${sequence}`,
          path: "src/auth.ts",
          intent: "refresh before expiry",
          status: "proposed",
          diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
          additions,
          deletions,
        },
      },
    },
  });

test("a replayed event does not appear twice after a reconnect", () => {
  const first = [progress(0), progress(1)].reduce(mergeEvent, [] as SessionEvent[]);
  const again = mergeEvent(first, progress(1));

  assert.equal(again.length, 2);
  // Same reference: nothing changed, so nothing re-renders.
  assert.equal(again, first);
});

test("events arriving out of order are held in sequence order", () => {
  const timeline = [progress(2), progress(0), progress(1)].reduce(
    mergeEvent,
    [] as SessionEvent[],
  );

  assert.deepEqual(
    timeline.map((event) => event.sequence),
    [0, 1, 2],
  );
});

test("a reconnect resumes after the last event held, not from the start", () => {
  assert.equal(resumeSequence([]), 0);
  assert.equal(resumeSequence([progress(0), progress(1)]), 2);
});

test("reconnect backoff grows and then stops growing", () => {
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(2), 2_000);
  assert.equal(retryDelayMs(3), 4_000);
  // A guest watching a paused run must still notice within seconds when it
  // resumes, so the wait is capped rather than doubling forever.
  assert.equal(retryDelayMs(20), 15_000);
  assert.equal(retryDelayMs(0), 1_000);
});

test("an empty timeline never reads as a quiet session", () => {
  const connections: GuestConnection[] = [
    { kind: "unreachable", detail: "Failed to fetch", attempt: 1, retryAt: 0 },
    { kind: "absent", attempt: 1, retryAt: 0 },
    { kind: "dropped", attempt: 1, retryAt: 0 },
    { kind: "live", blind: true },
    { kind: "live", blind: false },
    { kind: "stopped", reason: "nonsense is not an address." },
  ];

  const sentences = connections.map(
    (connection) =>
      describeConnection(connection, "http://127.0.0.1:4319", "abc")
        .emptyTimeline,
  );

  // Every degraded state says what is wrong, and says something different from
  // every other state — the whole point is that a blank screen cannot mean five
  // things at once.
  assert.equal(new Set(sentences).size, connections.length);
  assert.match(sentences[0]!, /No answer from the worker/);
  assert.match(sentences[1]!, /has no session abc/);
  assert.match(sentences[2]!, /dropped/);
  assert.match(sentences[3]!, /does not list its sessions/);
  assert.match(sentences[4]!, /has not recorded an event yet/);
  assert.match(sentences[5]!, /nonsense is not an address/);
});

test("only a healthy stream is reported as live", () => {
  const tone = (connection: GuestConnection) =>
    describeConnection(connection, "http://127.0.0.1:4319", "abc").tone;

  assert.equal(tone({ kind: "live", blind: false }), "live");
  assert.equal(tone({ kind: "live", blind: true }), "warn");
  assert.equal(tone({ kind: "dropped", attempt: 2, retryAt: 0 }), "warn");
  assert.equal(tone({ kind: "absent", attempt: 2, retryAt: 0 }), "error");
  assert.equal(
    tone({ kind: "unreachable", detail: "down", attempt: 2, retryAt: 0 }),
    "error",
  );
});

test("the rail counts only what the log actually contains", () => {
  const summary = summarise([
    started(0),
    patched(1, 4, 2),
    patched(2, 1, 0),
    progress(3),
  ]);

  assert.equal(summary.goal, "Fix the failing authentication refresh test");
  assert.equal(summary.model, "anthropic/claude-opus-5");
  assert.equal(summary.runStatus, "working");
  assert.equal(summary.patches.length, 2);
  assert.equal(summary.additions, 5);
  assert.equal(summary.deletions, 2);
  assert.equal(summary.elapsed, "3.0s");
});

test("a run is only over when a terminator follows its start", () => {
  assert.equal(summarise([]).runStatus, "waiting");
  assert.equal(summarise([progress(0)]).runStatus, "waiting");
  assert.equal(summarise([started(0), failed(1)]).runStatus, "failed");
  // A second run after a failure is running again, not still failed.
  assert.equal(summarise([started(0), failed(1), started(2)]).runStatus, "working");
});

test("a cancelled run reads as cancelled, not as still working or as a failure", () => {
  assert.equal(summarise([started(0)]).runStatus, "working");
  assert.equal(summarise([started(0), cancelled(1)]).runStatus, "cancelled");
  // A remote teammate has to see this without a verbal recap — the whole
  // reason the guest carries its own runStatus at all.
  assert.notEqual(summarise([started(0), cancelled(1)]).runStatus, "failed");
});

// A mission ending, in the copy a teammate's screen reads. The worker's
// projection is asserted against the same sequences in
// `apps/worker/src/mission-completion.test.ts`; the two are separate
// implementations on purpose and drift silently if only one is pinned.

const missionCompleted = (
  sequence: number,
  outcome: "resolved" | "abandoned" = "resolved",
): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "mission.completed",
    payload: {
      outcome,
      summary: "The failing checkout test passes again after the rounding fix.",
      verification: "verified",
      filesChanged: 2,
      actorId: "agent",
    },
  });

const missionReopened = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "mission.reopened",
    payload: {
      actorId: "agent",
      reason: "The fix regressed the refund path, so this is not finished.",
    },
  });

const runCompleted = (sequence: number): SessionEvent =>
  SessionEventSchema.parse({
    ...envelope(sequence),
    type: "run.completed",
    payload: { runId: RUN, summary: "Adjusted the rounding in the tax helper." },
  });

test("a mission is finished only once somebody says so", () => {
  // Not when its runs stop. A completed run is a mission waiting on a person,
  // and conflating the two is what left the product with no ending at all.
  assert.equal(summarise([started(0), runCompleted(1)]).missionOutcome, null);
  assert.equal(summarise([started(0), runCompleted(1)]).runStatus, "completed");
  assert.equal(
    summarise([started(0), runCompleted(1), missionCompleted(2)]).missionOutcome,
    "resolved",
  );
});

test("reopening a mission makes it live again for a teammate too", () => {
  assert.equal(summarise([missionCompleted(0), missionReopened(1)]).missionOutcome, null);
  assert.equal(
    summarise([missionCompleted(0), missionReopened(1), missionCompleted(2, "abandoned")])
      .missionOutcome,
    "abandoned",
  );
});

test("the mission's ending and the run's ending are reported separately", () => {
  // A resolved mission whose last run failed is an ordinary ending: somebody
  // finished the job by hand and said so. One field could only tell that story
  // by suppressing half of it.
  const events = [started(0), failed(1), missionCompleted(2)];

  assert.equal(summarise(events).runStatus, "failed");
  assert.equal(summarise(events).missionOutcome, "resolved");
});
