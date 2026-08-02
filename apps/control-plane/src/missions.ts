import type {
  CreateMissionInput,
  Mission,
  MissionEvent,
  RepositoryRef,
  Workstream
} from "@novus/contracts";
import type pg from "pg";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { newEventId, newMissionId, newRepoId, newWorkstreamId } from "./ids.ts";
import type { AuthedContext } from "./auth.ts";
import {
  BranchConflictError,
  ProviderTransientError,
  type RepositoryProvider
} from "./repo-provider.ts";

interface MissionRow {
  mission_id: string;
  org_id: string;
  goal: string;
  success_criteria: string;
  primary_state: string;
  created_by: string;
  created_by_login: string;
  created_at: Date;
  repo_id: string | null;
  provider: string | null;
  provider_repo_id: string | null;
  repo_name: string | null;
  default_branch: string | null;
}

interface WorkstreamRow {
  wst_id: string;
  mission_id: string;
  name: string;
  base_ref: string;
  base_sha: string;
  mission_branch: string;
  branch_status: string;
  branch_error: string | null;
}

function toRepository(row: MissionRow): RepositoryRef | null {
  if (!row.repo_id) return null;
  return {
    repoId: row.repo_id,
    provider: row.provider as "github",
    providerRepoId: row.provider_repo_id as string,
    name: row.repo_name as string,
    defaultBranch: row.default_branch as string
  };
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
    createdAt: row.created_at.toISOString(),
    repository: toRepository(row)
  };
}

function toWorkstream(row: WorkstreamRow): Workstream {
  return {
    workstreamId: row.wst_id,
    missionId: row.mission_id,
    name: row.name,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    missionBranch: row.mission_branch,
    branchStatus: row.branch_status as Workstream["branchStatus"],
    branchError: row.branch_error
  };
}

async function nextSeq(client: pg.PoolClient, missionId: string): Promise<number> {
  const result = await client.query(
    "select coalesce(max(seq), 0)::int + 1 as next from events where mission_id = $1",
    [missionId]
  );
  return result.rows[0]?.next as number;
}

async function recordEvent(
  client: pg.PoolClient,
  args: {
    orgId: string;
    missionId: string;
    seq: number;
    kind: string;
    actorKind: "user" | "system";
    actorId: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `insert into events (event_id, org_id, mission_id, seq, kind, actor_kind, actor_id, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newEventId(),
      args.orgId,
      args.missionId,
      args.seq,
      args.kind,
      args.actorKind,
      args.actorId,
      JSON.stringify(args.payload)
    ]
  );
}

/**
 * Records the repository for this org if it isn't recorded yet. Repository
 * identity is the stable provider id, never the name (ARCHITECTURE.md).
 */
async function upsertRepository(
  client: pg.PoolClient,
  ctx: AuthedContext,
  available: { providerRepoId: string; name: string; defaultBranch: string }
): Promise<string> {
  const existing = await client.query(
    "select repo_id from repositories where org_id = $1 and provider = 'github' and provider_repo_id = $2",
    [ctx.orgId, available.providerRepoId]
  );
  if (existing.rowCount && existing.rows[0]) {
    await client.query("update repositories set name = $2, default_branch = $3 where repo_id = $1", [
      existing.rows[0].repo_id,
      available.name,
      available.defaultBranch
    ]);
    return existing.rows[0].repo_id as string;
  }
  const repoId = newRepoId();
  await client.query(
    `insert into repositories (repo_id, org_id, provider, provider_repo_id, name, default_branch, connected_by)
     values ($1, $2, 'github', $3, $4, $5, $6)`,
    [repoId, ctx.orgId, available.providerRepoId, available.name, available.defaultBranch, ctx.userId]
  );
  return repoId;
}

export class MissionCreationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Creates the mission, its workstream, and both initial events in one
 * transaction, then attempts branch creation as a recorded side effect.
 * Idempotent end to end: the creationKey makes retried submissions return
 * the existing mission instead of minting a second one (D-031).
 */
export async function createMission(
  db: Db,
  provider: RepositoryProvider,
  ctx: AuthedContext,
  input: CreateMissionInput
): Promise<{ mission: Mission; workstream: Workstream }> {
  // Validate the repository against the provider before writing anything.
  const listed = await provider.listRepositories(ctx.orgId);
  const available = listed.find((repo) => repo.providerRepoId === input.providerRepoId);
  if (!available) throw new MissionCreationError("unknown_repository", "That repository isn't available.");

  const missionId = newMissionId();
  const created = await withTransaction(db, async (client) => {
    const duplicate = await client.query(
      "select mission_id from missions where org_id = $1 and creation_key = $2",
      [ctx.orgId, input.creationKey]
    );
    if (duplicate.rowCount && duplicate.rows[0]) return duplicate.rows[0].mission_id as string;

    const repoId = await upsertRepository(client, ctx, available);
    await client.query(
      `insert into missions (mission_id, org_id, goal, success_criteria, primary_state, created_by, repo_id, creation_key)
       values ($1, $2, $3, $4, 'new_mission', $5, $6, $7)`,
      [missionId, ctx.orgId, input.goal, input.successCriteria, ctx.userId, repoId, input.creationKey]
    );
    await client.query(
      "insert into participants (mission_id, user_id, mission_role) values ($1, $2, 'mission_admin')",
      [missionId, ctx.userId]
    );
    const missionBranch = `novus/m-${missionId.slice(4, 12)}`;
    await client.query(
      `insert into workstreams (wst_id, mission_id, name, base_ref, base_sha, mission_branch, branch_status)
       values ($1, $2, 'main', $3, $4, $5, 'pending')`,
      [newWorkstreamId(), missionId, input.baseRef, input.baseSha, missionBranch]
    );
    await recordEvent(client, {
      orgId: ctx.orgId,
      missionId,
      seq: 1,
      kind: "mission.created",
      actorKind: "user",
      actorId: ctx.userId,
      payload: { goal: input.goal, successCriteria: input.successCriteria, repository: available.name }
    });
    await recordEvent(client, {
      orgId: ctx.orgId,
      missionId,
      seq: 2,
      kind: "workstream.created",
      actorKind: "user",
      actorId: ctx.userId,
      payload: {
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        missionBranch
      }
    });
    return missionId;
  });

  await attemptBranchCreation(db, provider, ctx, created);

  const detail = await getMission(db, ctx, created);
  if (!detail || !detail.workstream) throw new Error("mission vanished during creation");
  return { mission: detail.mission, workstream: detail.workstream };
}

/**
 * Drives the workstream's branch to `created` if the provider allows.
 * Safe to call repeatedly: provider.ensureBranch is idempotent, and the
 * status update is guarded so concurrent retries settle deterministically.
 */
export async function attemptBranchCreation(
  db: Db,
  provider: RepositoryProvider,
  ctx: AuthedContext,
  missionId: string
): Promise<void> {
  const rows = await db.query(
    `select w.wst_id, w.mission_branch, w.base_sha, w.branch_status, r.provider_repo_id
       from workstreams w
       join missions m on m.mission_id = w.mission_id
       join repositories r on r.repo_id = m.repo_id
      where w.mission_id = $1 and m.org_id = $2`,
    [missionId, ctx.orgId]
  );
  const row = rows.rows[0];
  if (!row || row.branch_status === "created") return;

  try {
    await provider.ensureBranch(row.provider_repo_id, row.mission_branch, row.base_sha);
    await withTransaction(db, async (client) => {
      const updated = await client.query(
        "update workstreams set branch_status = 'created', branch_error = null where wst_id = $1 and branch_status <> 'created' returning wst_id",
        [row.wst_id]
      );
      if (updated.rowCount) {
        await recordEvent(client, {
          orgId: ctx.orgId,
          missionId,
          seq: await nextSeq(client, missionId),
          kind: "workstream.branch_created",
          actorKind: "system",
          actorId: "control-plane",
          payload: { missionBranch: row.mission_branch, baseSha: row.base_sha }
        });
      }
    });
  } catch (error) {
    const message =
      error instanceof BranchConflictError
        ? error.message
        : error instanceof ProviderTransientError
          ? error.message
          : "Branch creation failed.";
    await withTransaction(db, async (client) => {
      const updated = await client.query(
        "update workstreams set branch_status = 'failed', branch_error = $2 where wst_id = $1 and branch_status <> 'created' returning wst_id",
        [row.wst_id, message]
      );
      if (updated.rowCount) {
        await recordEvent(client, {
          orgId: ctx.orgId,
          missionId,
          seq: await nextSeq(client, missionId),
          kind: "workstream.branch_failed",
          actorKind: "system",
          actorId: "control-plane",
          payload: { missionBranch: row.mission_branch, error: message }
        });
      }
    });
  }
}

const MISSION_SELECT = `
  select m.mission_id, m.org_id, m.goal, m.success_criteria, m.primary_state,
         m.created_by, u.login as created_by_login, m.created_at,
         m.repo_id, r.provider, r.provider_repo_id, r.name as repo_name, r.default_branch
    from missions m
    join users u on u.user_id = m.created_by
    left join repositories r on r.repo_id = m.repo_id`;

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
): Promise<{ mission: Mission; workstream: Workstream | null; events: MissionEvent[] } | null> {
  const result = await db.query(
    `${MISSION_SELECT} where m.org_id = $1 and m.mission_id = $2`,
    [ctx.orgId, missionId]
  );
  const row = (result.rows as MissionRow[])[0];
  if (!row) return null;

  const workstreamRows = await db.query("select * from workstreams where mission_id = $1", [missionId]);
  const workstream = workstreamRows.rows[0] ? toWorkstream(workstreamRows.rows[0] as WorkstreamRow) : null;

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
  return { mission: toMission(row), workstream, events };
}

export async function getWorkstreamMission(
  db: Db,
  ctx: AuthedContext,
  workstreamId: string
): Promise<string | null> {
  const result = await db.query(
    `select w.mission_id from workstreams w join missions m on m.mission_id = w.mission_id
      where w.wst_id = $1 and m.org_id = $2`,
    [workstreamId, ctx.orgId]
  );
  return (result.rows[0]?.mission_id as string | undefined) ?? null;
}
