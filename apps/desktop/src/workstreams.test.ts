import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import type { AttemptComparison, Comparison, PresenceEntry } from "@novus/contracts/protocol";

import { agentName, readPeople, readWorkstreams } from "./workstreams.ts";

let sequence = 0;

const event = (type: SessionEvent["type"], payload: unknown): SessionEvent =>
  ({
    eventId: `e${(sequence += 1)}`,
    sessionId: "s1",
    sequence,
    actorId: "a1",
    occurredAt: new Date(sequence * 1000).toISOString(),
    type,
    payload,
  }) as SessionEvent;

const started = (runId: string, model: string, goal = "Do the thing"): SessionEvent =>
  event("run.started", {
    run: {
      id: runId,
      sessionId: "s1",
      goal,
      status: "running",
      startedBy: "a1",
      model: { provider: "anthropic", model },
      createdAt: new Date().toISOString(),
    },
  });

const comparison = (attempts: Partial<AttemptComparison>[]): Comparison => ({
  attempts: attempts.map((over) => ({
    runId: "r1",
    label: "Baseline",
    baseline: true,
    status: "completed" as const,
    summary: null,
    failure: null,
    filesChanged: [],
    additions: 0,
    deletions: 0,
    toolCalls: 0,
    testsRun: 0,
    testsPassed: 0,
    green: null,
    interventions: [],
    ...over,
  })),
  contestedPaths: [],
  uniquePaths: {},
  decision: null,
});

test("a model id becomes a name a teammate would say out loud", () => {
  assert.equal(agentName("claude-sonnet-5"), "Claude");
  assert.equal(agentName("gpt-5-codex"), "Codex");
  // Unknown families are not given an invented persona.
  assert.equal(agentName("llama-4-scout"), "llama");
});

test("a mission with one run shows its agent before any fork exists", () => {
  // The rail used to need a comparison to show anybody, so the first thirty
  // seconds of every mission had an empty room in it.
  const streams = readWorkstreams([started("r1", "claude-sonnet-5")], null);

  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.name, "Claude");
  assert.equal(streams[0]?.model, "claude-sonnet-5");
  assert.equal(streams[0]?.primary, true);
});

test("a run the log already terminated does not sit in the rail claiming to run", () => {
  // The lie this surface cannot afford. Without a comparison the fallback used
  // to hard-code "running" for every run it found.
  const streams = readWorkstreams(
    [
      started("r1", "claude-sonnet-5"),
      event("run.failed", { runId: "r1", reason: "401 from the provider" }),
    ],
    null,
  );

  assert.equal(streams[0]?.state, "failed");
});

test("two sequential turns are one agent, not two participants", () => {
  // The rail must agree with the comparison it is about to receive. The worker
  // treats approaches as baseline-plus-forks, so listing every `run.started`
  // put a second agent in the room until /compare answered and removed it.
  const streams = readWorkstreams(
    [started("r1", "claude-sonnet-5", "First ask"), started("r2", "claude-sonnet-5", "Second ask")],
    null,
  );

  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.assignment, "Second ask");
});

test("a resumed run is live again", () => {
  const streams = readWorkstreams(
    [
      started("r1", "claude-sonnet-5"),
      event("run.paused", { runId: "r1" }),
      event("run.resumed", { runId: "r1" }),
    ],
    null,
  );

  assert.equal(streams[0]?.state, "running");
});

test("each workstream gets its own identity colour, and none of them is green", () => {
  const streams = readWorkstreams(
    [started("r1", "claude-sonnet-5"), started("r2", "gpt-5-codex")],
    comparison([
      { runId: "r1", baseline: true },
      { runId: "r2", baseline: false, label: "Without the shim" },
    ]),
  );

  assert.equal(streams.length, 2);
  assert.notEqual(streams[0]?.signal, streams[1]?.signal);
  // Provenance, not ranking: the tokens are the workstream ramp, never --add.
  for (const stream of streams) {
    assert.match(stream.signal, /^--ws-[1-4]$/);
  }
});

test("an alternative is named by what it was told to do differently", () => {
  const streams = readWorkstreams(
    [started("r1", "claude-sonnet-5", "Migrate auth"), started("r2", "claude-sonnet-5")],
    comparison([
      { runId: "r1", baseline: true },
      { runId: "r2", baseline: false, label: "Keep the cookie path" },
    ]),
  );

  assert.equal(streams[0]?.assignment, "Migrate auth");
  assert.equal(streams[1]?.assignment, "Keep the cookie path");
});

test("control is read onto the person who holds it", () => {
  const participants = [
    { id: "p1", name: "Kartik", role: "owner", connected: true },
    { id: "p2", name: "Sam", role: "reviewer", connected: false },
  ] as PresenceEntry[];

  const people = readPeople(participants, "p2");

  assert.equal(people[0]?.inControl, false);
  assert.equal(people[1]?.inControl, true);
  assert.equal(people[1]?.connected, false);
});
