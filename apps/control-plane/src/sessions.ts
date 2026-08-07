import type { Session } from "@novus/contracts";
import { SESSION_TITLE_MAX } from "@novus/contracts";
import type pg from "pg";
import type { Db } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newWorkstreamSessionId } from "./ids.ts";
import type { MissionAccess } from "./authz.ts";

/**
 * Sessions (D-083): parallel conversations inside one workstream, sharing its
 * branch, worktree, workspace, and lease, and owning nothing but their own
 * thread and harness continuity.
 *
 * There is deliberately no create route and no `session.create` capability: a
 * session is words-first, created inside the transaction that lands its first
 * direction (`newSession` on the direction input). What lives here is the
 * reading, the default, and the one insert every creation path shares.
 */

interface SessionRow {
  csn_id: string;
  wst_id: string;
  title: string | null;
  created_by: string;
  created_by_login: string;
  created_at: Date;
}

const SESSION_SELECT = `
  select s.csn_id, s.wst_id, s.title, s.created_by, u.login as created_by_login, s.created_at
    from workstream_sessions s
    join users u on u.user_id = s.created_by`;

function toSession(row: SessionRow): Session {
  return {
    sessionId: row.csn_id,
    workstreamId: row.wst_id,
    title: row.title,
    createdBy: row.created_by,
    createdByLogin: row.created_by_login,
    createdAt: row.created_at.toISOString()
  };
}

/** Every session of every lane, creation order — the room filters to its lane. */
export async function listSessions(db: Db, missionId: string): Promise<Session[]> {
  const result = await db.query(
    `${SESSION_SELECT} where s.mission_id = $1 order by s.created_at, s.csn_id`,
    [missionId]
  );
  return (result.rows as SessionRow[]).map(toSession);
}

/** A session's title is its own first words, truncated — set once, never
 *  rewritten (D-083). */
export function deriveSessionTitle(body: string): string {
  return body.trim().replace(/\s+/g, " ").slice(0, SESSION_TITLE_MAX);
}

/**
 * Inserts one session. Used by mission creation, approach creation, and the
 * words-first `newSession` path; nothing else mints one. Title starts null on
 * the implicit first session — its first direction names it.
 */
export async function insertSession(
  client: pg.PoolClient,
  args: {
    orgId: string;
    missionId: string;
    workstreamId: string;
    createdBy: string;
    title?: string | null;
  }
): Promise<string> {
  const sessionId = newWorkstreamSessionId();
  await client.query(
    `insert into workstream_sessions (csn_id, org_id, mission_id, wst_id, title, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [sessionId, args.orgId, args.missionId, args.workstreamId, args.title ?? null, args.createdBy]
  );
  return sessionId;
}

/** The lane's first session — where a submission that names none lands, so
 *  nothing that predates sessions changes (D-083). */
export async function defaultSessionId(
  client: pg.PoolClient,
  workstreamId: string
): Promise<string | null> {
  const result = await client.query(
    "select csn_id from workstream_sessions where wst_id = $1 order by created_at, csn_id limit 1",
    [workstreamId]
  );
  return (result.rows[0]?.csn_id as string | undefined) ?? null;
}

export interface ResolvedSession {
  sessionId: string;
  /** True when `newSession` just created it, so the caller can say so. */
  created: boolean;
}

/**
 * Which session a direction lands in. A named session must belong to the
 * resolved lane — naming someone else's session never widens what you can do
 * to your own, so a foreign one resolves to nothing and the route answers
 * "no such mission" (ARCHITECTURE.md#authorization). `newSession` creates one
 * from the direction's own words, in this same transaction, and records the
 * creation as an event.
 */
export async function resolveSessionForDirection(
  client: pg.PoolClient,
  access: MissionAccess,
  author: { userId: string; login: string },
  input: { sessionId?: string; newSession: boolean; body: string }
): Promise<ResolvedSession | null> {
  if (!access.workstreamId) return null;
  if (input.newSession) {
    const sessionId = await insertSession(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId: access.workstreamId,
      createdBy: author.userId,
      title: deriveSessionTitle(input.body)
    });
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId: access.workstreamId,
      kind: "session.created",
      actorKind: "user",
      actorId: author.userId,
      actorLogin: author.login,
      payload: { sessionId, title: deriveSessionTitle(input.body) }
    });
    return { sessionId, created: true };
  }
  if (input.sessionId) {
    const named = await client.query(
      "select csn_id from workstream_sessions where csn_id = $1 and wst_id = $2",
      [input.sessionId, access.workstreamId]
    );
    if (named.rowCount === 0) return null;
    return { sessionId: input.sessionId, created: false };
  }
  const fallback = await defaultSessionId(client, access.workstreamId);
  return fallback ? { sessionId: fallback, created: false } : null;
}

/** Names a session's first words after the fact — only where no words exist
 *  yet, so a title is written once and never rewritten. */
export async function titleSessionFromFirstDirection(
  client: pg.PoolClient,
  sessionId: string,
  body: string
): Promise<void> {
  await client.query(
    "update workstream_sessions set title = $2 where csn_id = $1 and title is null",
    [sessionId, deriveSessionTitle(body)]
  );
}

/** This conversation's own resume point (D-083): the continuity the next turn
 *  of this session picks up, never a sibling's. */
export async function sessionResumePoint(
  client: pg.PoolClient,
  sessionId: string
): Promise<string | null> {
  const result = await client.query(
    "select harness_session_id from workstream_sessions where csn_id = $1",
    [sessionId]
  );
  return (result.rows[0]?.harness_session_id as string | null | undefined) ?? null;
}
