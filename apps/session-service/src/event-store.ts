import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  SessionEventDraftSchema,
  SessionEventSchema,
  type SessionEvent,
  type SessionEventDraft,
} from "@novus/contracts";

export type SessionEventListener = (event: SessionEvent) => void;

export type SessionEventStoreOptions = {
  /**
   * Where the log is kept. `":memory:"` keeps it inside the process, which is
   * what tests and the scripted demo want; anything else is a file path.
   */
  databasePath?: string;
};

/** SQLite's name for a database that is never written to disk. */
export const MEMORY_DATABASE = ":memory:";

/**
 * The event log's shape.
 *
 * `event` holds the whole validated event as JSON and is the only column the
 * store reads back — the rest are extracted so SQLite can order, index and
 * constrain without anyone having to trust a projection. The unique constraint
 * on `(session_id, sequence)` is what makes "one sequence per session, assigned
 * on append" a property of the storage rather than of the code that happens to
 * be calling it.
 *
 * `ordinal` records global append order across sessions, which per-session
 * sequences cannot express and a fork will need.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_events (
    ordinal     INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    sequence    INTEGER NOT NULL,
    event_id    TEXT    NOT NULL UNIQUE,
    type        TEXT    NOT NULL,
    actor_id    TEXT    NOT NULL,
    occurred_at TEXT    NOT NULL,
    event       TEXT    NOT NULL,
    UNIQUE (session_id, sequence)
  );
`;

/**
 * Where the log lives when nobody says.
 *
 * Resolved from this file rather than from the working directory, because the
 * worker is started from wherever the host happens to be and a log that moves
 * with `cwd` is a log nobody can find twice. `.novus/` is already gitignored.
 */
export const defaultDatabasePath = (): string => {
  const configured = process.env.NOVUS_DB?.trim();

  return configured
    ? resolve(configured)
    : fileURLToPath(new URL("../../../.novus/events.db", import.meta.url));
};

const readEventColumn = (row: Record<string, unknown>): SessionEvent => {
  const stored = row["event"];

  if (typeof stored !== "string") {
    throw new Error("Stored event row is missing its event column.");
  }

  // Parsed on the way out as well as on the way in. A row edited by hand, or
  // written by an older build, is a value arriving from outside this process,
  // so it crosses the same Zod boundary every other input does.
  return SessionEventSchema.parse(JSON.parse(stored));
};

/**
 * The session event log, kept in SQLite.
 *
 * The log is the source of truth and everything else — the desktop timeline, a
 * receipt, a fork — is a projection rebuilt by reading it back in order. That
 * only means something if it outlives the process that wrote it, which is why
 * this is a file and not an array.
 */
export class SessionEventStore {
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<SessionEventListener>();
  private readonly nextSequenceStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly sessionsStatement: StatementSync;

  constructor(options: SessionEventStoreOptions = {}) {
    const databasePath = options.databasePath ?? defaultDatabasePath();

    if (databasePath !== MEMORY_DATABASE) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(databasePath);

    if (databasePath !== MEMORY_DATABASE) {
      // A run appends constantly while the desktop reads the backlog. Under
      // WAL a reader never blocks the writer, so replaying history cannot
      // stall the agent that is still producing it.
      this.database.exec("PRAGMA journal_mode = WAL");
      // Without a busy timeout a second worker on the same file does not queue
      // behind the write lock, it fails immediately with SQLITE_BUSY. Waiting
      // is what the sequencing comment above promises.
      this.database.exec("PRAGMA busy_timeout = 5000");
    }

    this.database.exec(SCHEMA);

    this.nextSequenceStatement = this.database.prepare(
      "SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM session_events WHERE session_id = ?",
    );
    this.insertStatement = this.database.prepare(
      `INSERT INTO session_events
         (session_id, sequence, event_id, type, actor_id, occurred_at, event)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // The `sequence >= ?` predicate is what keeps a reconnect cheap. Every SSE
    // connect asks for the tail of a log that only ever grows, and selecting
    // the whole session to throw most of it away in JavaScript meant the cost
    // of resuming was set by the log's total length rather than by how much of
    // it the client was missing. The UNIQUE (session_id, sequence) index
    // already covers this exactly, so SQLite seeks to the resume point instead
    // of scanning to it, and rows before it are never read or parsed.
    this.listStatement = this.database.prepare(
      `SELECT event FROM session_events
         WHERE session_id = ? AND sequence >= ?
         ORDER BY sequence ASC`,
    );
    this.sessionsStatement = this.database.prepare(
      "SELECT session_id FROM session_events GROUP BY session_id ORDER BY MIN(ordinal) ASC",
    );
  }

  append(draftInput: SessionEventDraft): SessionEvent {
    // Before the transaction opens: an invalid draft should never reach SQLite
    // and should never consume a sequence number.
    const draft = SessionEventDraftSchema.parse(draftInput);

    // Reading the next sequence and claiming it are one step. Nothing else in
    // this process can interleave, and a second process on the same file takes
    // the write lock rather than racing for the same number — so a sequence is
    // never duplicated and never skipped.
    this.database.exec("BEGIN IMMEDIATE");

    let event: SessionEvent;

    try {
      const row = this.nextSequenceStatement.get(draft.sessionId);
      const sequence = Number(row?.["next"] ?? 0);

      event = SessionEventSchema.parse({
        ...draft,
        eventId: crypto.randomUUID(),
        sequence,
        occurredAt: new Date().toISOString(),
      });

      this.insertStatement.run(
        event.sessionId,
        event.sequence,
        event.eventId,
        event.type,
        event.actorId,
        event.occurredAt,
        JSON.stringify(event),
      );

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    // Subscribers run after the commit, so nothing observes an event that a
    // later failure could still take back — and a subscriber that appends is
    // not appending inside our transaction.
    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  /**
   * A session's log from `since` onward, oldest first.
   *
   * `since` is inclusive and defaults to the beginning, so a caller that wants
   * the whole log still asks for it by name alone. Sequences are per session
   * and start at 0, which is why the default can be a number rather than a
   * branch to a second statement.
   */
  list(sessionId: string, since = 0): SessionEvent[] {
    return this.listStatement.all(sessionId, since).map(readEventColumn);
  }

  /**
   * The readable part of a session's log from `since` onward, and a count of
   * what was not readable.
   *
   * `list` is strict on purpose — a row it cannot parse is a real problem and
   * saying so is the honest answer for a store. But the log now outlives the
   * build that wrote it, and `packages/contracts` changes with almost every
   * capability, so a database written by an older build holds rows this one
   * cannot read. Strictness on a serving path turns that into an unhandled
   * throw inside an HTTP handler, which ends the worker process rather than the
   * request. One stale row should cost its own line, not the session.
   *
   * The count is of unreadable rows in the range asked for, not in the session.
   * A damaged row the caller was never going to be sent is not a gap in what it
   * receives, and reporting it would describe the log rather than the answer.
   */
  readable(
    sessionId: string,
    since = 0,
  ): { events: SessionEvent[]; unreadable: number } {
    const events: SessionEvent[] = [];
    let unreadable = 0;

    for (const row of this.listStatement.all(sessionId, since)) {
      try {
        events.push(readEventColumn(row));
      } catch {
        unreadable += 1;
      }
    }

    return { events, unreadable };
  }

  /**
   * Every session the log has heard of, in the order each first appeared.
   *
   * Kept despite having no caller in the worker today. `GET /sessions` reports
   * the registry, which is a map that dies with the process — so after a
   * restart the only record that a session ever existed is this table, and
   * without this method the durable log is a thing you can only read if you
   * already know the id to ask for. Recovering sessions after a restart, and
   * the fork the `ordinal` column exists for, both begin here.
   */
  sessions(): string[] {
    return this.sessionsStatement.all().map((row) => String(row["session_id"]));
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
    this.database.close();
  }
}

/**
 * A store that is thrown away with the process.
 *
 * Same SQLite engine, same schema, same sequencing — only the file is missing.
 * Tests and the scripted demo want exactly that, and they should not have to
 * describe it differently from the durable store they are standing in for.
 */
export class InMemorySessionEventStore extends SessionEventStore {
  constructor() {
    super({ databasePath: MEMORY_DATABASE });
  }
}
