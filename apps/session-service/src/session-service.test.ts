import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEventDraft } from "@novus/contracts";

import { InMemorySessionEventStore } from "./session-service.ts";

test("assigns increasing sequence numbers within one session", () => {
  const eventStore = new InMemorySessionEventStore();

  const firstEvent = eventStore.append({
    sessionId: "sequence-session",
    actorId: "agent-1",
    type: "run.progress",
    payload: {
      runId: "run-1",
      message: "Reading repository",
    },
  });

  const secondEvent = eventStore.append({
    sessionId: "sequence-session",
    actorId: "agent-1",
    type: "run.progress",
    payload: {
      runId: "run-1",
      message: "Inspecting authentication code",
    },
  });

  assert.equal(firstEvent.sequence, 0);
  assert.equal(secondEvent.sequence, 1);
});

test("keeps session ordering independent and lists recorded events", () => {
  const eventStore = new InMemorySessionEventStore();

  eventStore.append({
    sessionId: "first-session",
    actorId: "agent-1",
    type: "run.progress",
    payload: {
      runId: "run-1",
      message: "Reading repository",
    },
  });

  const otherSessionEvent = eventStore.append({
    sessionId: "second-session",
    actorId: "agent-2",
    type: "run.progress",
    payload: {
      runId: "run-2",
      message: "Reading repository",
    },
  });

  assert.equal(otherSessionEvent.sequence, 0);
  assert.equal(eventStore.list("first-session").length, 1);
  assert.equal(eventStore.list("second-session").length, 1);
});

test("rejects an invalid event payload", () => {
  const eventStore = new InMemorySessionEventStore();

  assert.throws(() =>
    eventStore.append(
      {
        sessionId: "invalid-event-session",
        actorId: "agent-3",
        type: "run.progress",
        payload: {
          runId: "run-3",
          message: 42,
        },
      } as unknown as SessionEventDraft,
    ),
  );
});
