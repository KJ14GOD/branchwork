import type { CreateMissionInput, Mission, MissionEvent } from "@novus/contracts";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { newEventId, newMissionId } from "./ids.ts";
import type { AuthedContext } from "./auth.ts";

interface MissionRow {
  mission_id: string;
  org_id: string;
  goal: string;
  success_criteria: string;
  primary_state: string;
  created_by: string;
  created_by_login: string;
  created_at: Date;
}

function toMission(row: MissionRow): Mission {
  return {
    missionId: row.mission_id,
    orgId: row.org_id,
    goal: row.goal,
    successCriteria: row.success_criteria,
    primaryState: row.primary_state as Mission["primaryState"],
    createdBy: row.created_by,
    createdByLogin: row.created_by_login,
    createdAt: row.created_at.toISOString()
  };
}

/**
 * `org.mission.create` (PRODUCT.md#roles-and-capabilities): every org member
 * may create a mission; the creator becomes its Mission Admin. The mission row,
 * the participant row, and the initial event commit in one transaction.
 */
export async function createMission(
  db: Db,
  ctx: AuthedContext,
  input: CreateMissionInput
): Promise<Mission> {
  const missionId = newMissionId();
  await withTransaction(db, async (client) => {
    await client.query(
      `insert into missions (mission_id, org_id, goal, success_criteria, primary_state, created_by)
       values ($1, $2, $3, $4, 'new_mission', $5)`,
      [missionId, ctx.orgId, input.goal, input.successCriteria, ctx.userId]
    );
    await client.query(
      "insert into participants (mission_id, user_id, mission_role) values ($1, $2, 'mission_admin')",
      [missionId, ctx.userId]
    );
    await client.query(
      `insert into events (event_id, org_id, mission_id, seq, kind, actor_kind, actor_id, payload)
       values ($1, $2, $3, 1, 'mission.created', 'user', $4, $5)`,
      [
        newEventId(),
        ctx.orgId,
        missionId,
        ctx.userId,
        JSON.stringify({ goal: input.goal, successCriteria: input.successCriteria })
      ]
    );
  });
  const created = await getMission(db, ctx, missionId);
  if (!created) throw new Error("mission vanished during creation");
  return created.mission;
}

const MISSION_SELECT = `
  select m.mission_id, m.org_id, m.goal, m.success_criteria, m.primary_state,
         m.created_by, u.login as created_by_login, m.created_at
    from missions m
    join users u on u.user_id = m.created_by`;

/** Every query is org-scoped; a mission outside the caller's org does not exist. */
export async function listMissions(db: Db, ctx: AuthedContext): Promise<Mission[]> {
  const result = await db.query(
    `${MISSION_SELECT} where m.org_id = $1 order by m.created_at desc`,
    [ctx.orgId]
  );
  return (result.rows as MissionRow[]).map(toMission);
}

export async function getMission(
  db: Db,
  ctx: AuthedContext,
  missionId: string
): Promise<{ mission: Mission; events: MissionEvent[] } | null> {
  const result = await db.query(
    `${MISSION_SELECT} where m.org_id = $1 and m.mission_id = $2`,
    [ctx.orgId, missionId]
  );
  const row = (result.rows as MissionRow[])[0];
  if (!row) return null;

  const eventRows = await db.query(
    `select event_id, mission_id, seq, kind, actor_kind, actor_id, payload, schema_version, occurred_at
       from events where org_id = $1 and mission_id = $2 order by seq`,
    [ctx.orgId, missionId]
  );
  const events: MissionEvent[] = eventRows.rows.map((event) => ({
    eventId: event.event_id,
    missionId: event.mission_id,
    seq: Number(event.seq),
    kind: event.kind,
    actor: { kind: event.actor_kind, id: event.actor_id },
    payload: event.payload,
    schemaVersion: event.schema_version,
    occurredAt: event.occurred_at.toISOString()
  }));
  return { mission: toMission(row), events };
}
