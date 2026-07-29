import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { SessionEventDraft } from "@novus/contracts";

import { defaultDatabasePath, SessionEventStore } from "./event-store.ts";

const withDatabaseFile = (
  body: (databasePath: string) => void | Promise<void>,
): (() => Promise<void>) => {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "novus-event-store-"));

    try {
      await body(join(directory, "events.db"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
};

const progress = (
  sessionId: string,
  message: string,
): SessionEventDraft => ({
  sessionId,
  actorId: "agent-1",
  type: "run.progress",
  payload: { runId: "run-1", message },
});

test(
  "reloads the same ordered log from a fresh store over the same file",
  withDatabaseFile(async (databasePath) => {
    const writer = new SessionEventStore({ databasePath });

    writer.append(progress("replay-session", "Reading repository"));
    writer.append(progress("replay-session", "Inspecting authentication code"));
    writer.append(progress("replay-session", "Proposing a patch"));

    const written = writer.list("replay-session");

    writer.close();

    const reader = new SessionEventStore({ databasePath });
    const reloaded = reader.list("replay-session");

    reader.close();

    assert.deepEqual(reloaded, written);
    assert.deepEqual(
      reloaded.map((event) => event.sequence),
      [0, 1, 2],
    );
    assert.deepEqual(
      reloaded.map((event) =>
        event.type === "run.progress" ? event.payload.message : event.type,
      ),
      ["Reading repository", "Inspecting authentication code", "Proposing a patch"],
    );
  }),
);

test(
  "keeps sequence numbers per session and continues them after a restart",
  withDatabaseFile(async (databasePath) => {
    const writer = new SessionEventStore({ databasePath });

    assert.equal(writer.append(progress("session-a", "first")).sequence, 0);
    assert.equal(writer.append(progress("session-b", "first")).sequence, 0);
    assert.equal(writer.append(progress("session-a", "second")).sequence, 1);

    writer.close();

    const reopened = new SessionEventStore({ databasePath });

    // The next sequence comes from the log, not from a counter that died with
    // the process — restarting must not hand out 0 again.
    assert.equal(reopened.append(progress("session-a", "third")).sequence, 2);
    assert.equal(reopened.append(progress("session-b", "second")).sequence, 1);

    assert.deepEqual(
      reopened.list("session-a").map((event) => event.sequence),
      [0, 1, 2],
    );
    assert.deepEqual(
      reopened.list("session-b").map((event) => event.sequence),
      [0, 1],
    );
    assert.deepEqual(reopened.sessions(), ["session-a", "session-b"]);

    reopened.close();
  }),
);

test(
  "refuses to hand back a stored row that is not a valid event",
  withDatabaseFile(async (databasePath) => {
    const store = new SessionEventStore({ databasePath });

    store.append(progress("tampered-session", "Reading repository"));
    store.close();

    // Whatever wrote this row — a hand edit, an older build, a corrupted
    // write — the log is an input like any other and does not get to skip the
    // schema on the way out.
    const raw = new DatabaseSync(databasePath);

    raw
      .prepare(
        `INSERT INTO session_events
           (session_id, sequence, event_id, type, actor_id, occurred_at, event)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tampered-session",
        1,
        "tampered-event",
        "run.progress",
        "agent-1",
        new Date().toISOString(),
        JSON.stringify({ type: "run.progress", payload: { message: 42 } }),
      );
    raw.close();

    const reader = new SessionEventStore({ databasePath });

    assert.throws(() => reader.list("tampered-session"));

    reader.close();
  }),
);

test(
  "rejects an invalid draft without consuming a sequence number",
  withDatabaseFile(async (databasePath) => {
    const store = new SessionEventStore({ databasePath });

    assert.throws(() =>
      store.append({
        sessionId: "invalid-draft-session",
        actorId: "agent-1",
        type: "run.progress",
        payload: { runId: "run-1", message: 42 },
      } as unknown as SessionEventDraft),
    );

    assert.equal(
      store.append(progress("invalid-draft-session", "Reading repository"))
        .sequence,
      0,
    );

    store.close();
  }),
);

test("takes the database location from NOVUS_DB when it is set", () => {
  const previous = process.env.NOVUS_DB;

  try {
    process.env.NOVUS_DB = "./relative/events.db";
    assert.equal(defaultDatabasePath(), resolve("./relative/events.db"));

    delete process.env.NOVUS_DB;
    assert.match(defaultDatabasePath(), /\.novus[/\\]events\.db$/);
  } finally {
    if (previous === undefined) {
      delete process.env.NOVUS_DB;
    } else {
      process.env.NOVUS_DB = previous;
    }
  }
});
