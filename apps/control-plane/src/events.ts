import type { MissionEvent } from "@novus/contracts";
import type pg from "pg";
import { lockMission } from "./db.ts";
import { newEventId } from "./ids.ts";

/**
 * The one path that writes mission events. Every module records through this
 * function so actor attribution, causation, and ordering stay uniform
 * (ARCHITECTURE.md#event-model). The actor is always chosen by the server —
 * nothing a client sends decides it.
 */

/**
 * The Postgres notification channel every mission event announces itself on
 * (D-149). The payload is an address, never content: mission, sequence, and
 * kind, so a listener knows *that* something happened and re-reads through the
 * same authorized projection as any other client. Notification payloads are
 * capped at 8000 bytes by Postgres, which an address can never approach and an
 * event payload frequently would.
 */
export const MISSION_EVENT_CHANNEL = "novus_mission_event";

export interface RecordEventArgs {
  orgId: string;
  missionId: string;
  workstreamId?: string | null;
  executionId?: string | null;
  kind: string;
  actorKind: "user" | "system" | "harness" | "runner" | "external";
  actorId: string;
  actorLogin?: string | null;
  causeDirectionId?: string | null;
  causeLeaseId?: string | null;
  originSeq?: number | null;
  payload: Record<string, unknown>;
}

/**
 * Per-mission advisory lock, then max(seq)+1. Concurrent writers (a runner
 * reporting while a second participant submits direction) serialize here
 * instead of colliding on the (mission_id, seq) unique index and losing an
 * event.
 */
export async function nextSeq(client: pg.PoolClient, missionId: string): Promise<number> {
  await lockMission(client, missionId);
  const result = await client.query(
    "select coalesce(max(seq), 0)::int + 1 as next from events where mission_id = $1",
    [missionId]
  );
  return result.rows[0]?.next as number;
}

/** Records one event at the next mission sequence. Returns its id. */
export async function recordEvent(client: pg.PoolClient, args: RecordEventArgs): Promise<string> {
  const seq = await nextSeq(client, args.missionId);
  return recordEventAtSeq(client, args, seq);
}

/**
 * Records an event at an explicit sequence — used by mission creation, which
 * writes seq 1 and 2 inside the creating transaction.
 *
 * Runner-origin events carry `originSeq`; a replay is ignored on the scope the
 * report belongs to — the execution when there is one, the workstream when the
 * report is about the workspace itself — so a retried delivery lands once
 * (ARCHITECTURE.md#event-model). Returns the empty string when the write was
 * a de-duplicated replay.
 */
export async function recordEventAtSeq(
  client: pg.PoolClient,
  args: RecordEventArgs,
  seq: number
): Promise<string> {
  const eventId = newEventId();
  const result = await client.query(
    `insert into events (
       event_id, org_id, mission_id, workstream_id, execution_id, seq, kind,
       actor_kind, actor_id, actor_login, cause_direction_id, cause_lease_id,
       origin_seq, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (coalesce(execution_id, workstream_id), origin_seq)
       where origin_seq is not null do nothing
     returning event_id`,
    [
      eventId,
      args.orgId,
      args.missionId,
      args.workstreamId ?? null,
      args.executionId ?? null,
      seq,
      args.kind,
      args.actorKind,
      args.actorId,
      args.actorLogin ?? null,
      args.causeDirectionId ?? null,
      args.causeLeaseId ?? null,
      args.originSeq ?? null,
      JSON.stringify(args.payload)
    ]
  );
  const written = (result.rows[0]?.event_id as string | undefined) ?? "";
  // The room learns here (D-149). `pg_notify` inside the writing transaction
  // is delivered by Postgres *on commit* and not at all on rollback, so a
  // listener can never be told to re-read a row that is not yet visible —
  // the ordering trap an in-process emitter at this line would have. A
  // de-duplicated replay wrote nothing and says nothing.
  if (written) {
    await client.query("select pg_notify($1, $2)", [
      MISSION_EVENT_CHANNEL,
      JSON.stringify({ missionId: args.missionId, seq, kind: args.kind })
    ]);
  }
  return written;
}

export interface EventRow {
  event_id: string;
  mission_id: string;
  seq: string | number;
  kind: string;
  actor_kind: string;
  actor_id: string;
  actor_login: string | null;
  cause_direction_id: string | null;
  cause_lease_id: string | null;
  execution_id: string | null;
  workstream_id?: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
  occurred_at: Date;
}

export function toMissionEvent(row: EventRow): MissionEvent {
  return {
    eventId: row.event_id,
    missionId: row.mission_id,
    seq: Number(row.seq),
    kind: row.kind,
    actor: {
      kind: row.actor_kind as MissionEvent["actor"]["kind"],
      id: row.actor_id,
      login: row.actor_login
    },
    cause: { directionId: row.cause_direction_id, leaseId: row.cause_lease_id },
    executionId: row.execution_id,
    workstreamId: row.workstream_id ?? null,
    payload: row.payload,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString()
  };
}

/**
 * When an event of one kind last occurred for an execution, by the log's own
 * ordering. The log's reads belong to this module the way its one insert
 * does; a targeted question is asked here rather than re-writing the query.
 */
export async function lastEventAt(
  q: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> },
  executionId: string,
  kind: string
): Promise<Date | null> {
  const result = await q.query(
    "select occurred_at from events where execution_id = $1 and kind = $2 order by seq desc limit 1",
    [executionId, kind]
  );
  return (result.rows[0]?.occurred_at as Date | undefined) ?? null;
}

export const EVENT_SELECT = `
  select event_id, mission_id, seq, kind, actor_kind, actor_id, actor_login,
         cause_direction_id, cause_lease_id, execution_id, workstream_id, payload,
         schema_version, occurred_at
    from events`;
