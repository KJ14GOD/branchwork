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
  ProviderUnconfiguredError,
  UnknownBaseError,
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
    provider: row.provider as "github" | "local",
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
    actorKind: "user" | "system" | "harness" | "runner";
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
  available: { providerRepoId: string; name: string; defaultBranch: string },
  provider: "github" | "local" = "github"
): Promise<string> {
  const existing = await client.query(
    "select repo_id from repositories where org_id = $1 and provider = $3 and provider_repo_id = $2",
    [ctx.orgId, available.providerRepoId, provider]
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
     values ($1, $2, $7, $3, $4, $5, $6)`,
    [repoId, ctx.orgId, available.providerRepoId, available.name, available.defaultBranch, ctx.userId, provider]
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
  // Validate the repository before writing anything. GitHub repos validate
  // against the provider; local repos must already be registered (D-032) —
  // the control plane never touches the folder itself.
  let available: { providerRepoId: string; name: string; defaultBranch: string };
  if (input.provider === "local") {
    const registered = await db.query(
      "select provider_repo_id, name, default_branch from repositories where org_id = $1 and provider = 'local' and provider_repo_id = $2",
      [ctx.orgId, input.providerRepoId]
    );
    if (!registered.rows[0]) {
      throw new MissionCreationError("unknown_repository", "That local repository isn't registered on this machine.");
    }
    available = {
      providerRepoId: registered.rows[0].provider_repo_id,
      name: registered.rows[0].name,
      defaultBranch: registered.rows[0].default_branch
    };
  } else {
    const listed = await provider.listRepositories(ctx.orgId);
    const found = listed.find((repo) => repo.providerRepoId === input.providerRepoId);
    if (!found) throw new MissionCreationError("unknown_repository", "That repository isn't available.");
    available = found;
  }

  // Concurrent duplicates can violate either the creation-key index or, when
  // the burst is a repository's first mission, the repositories index — and a
  // retry can then hit the other one (Reviewer F). A bounded loop settles every
  // combination deterministically on the winner's mission.
  let created: string | undefined;
  for (let attempt = 0; attempt < 3 && created === undefined; attempt += 1) {
    try {
      created = await createMissionTx(db, ctx, input, available, newMissionId());
    } catch (error) {
      const unique = (error as { code?: string; constraint?: string }) ?? {};
      const constraint = unique.constraint ?? "";
      if (unique.code !== "23505") throw error;
      if (constraint.includes("repo_branch_unique")) {
        throw new MissionCreationError("branch_collision", "Branch naming collided; try creating again.");
      }
      if (constraint.includes("creation_key")) {
        const winner = await db.query(
          "select mission_id from missions where org_id = $1 and creation_key = $2",
          [ctx.orgId, input.creationKey]
        );
        if (winner.rows[0]) {
          created = winner.rows[0].mission_id as string;
          continue;
        }
        // Winner not committed yet — loop; the tx duplicate-check will find it.
      } else if (!constraint.startsWith("repositories_")) {
        throw error;
      }
      if (attempt === 2) throw error;
    }
  }
  if (created === undefined) throw new Error("mission creation did not settle");

  // Local branches are created by the desktop and reported back; the server
  // attempts creation only where the provider can act (GitHub).
  if (input.provider !== "local") await attemptBranchCreation(db, provider, ctx, created);

  const detail = await getMission(db, ctx, created);
  if (!detail || !detail.workstream) throw new Error("mission vanished during creation");
  return { mission: detail.mission, workstream: detail.workstream };
}

async function createMissionTx(
  db: Db,
  ctx: AuthedContext,
  input: CreateMissionInput,
  available: { providerRepoId: string; name: string; defaultBranch: string },
  missionId: string
): Promise<string> {
  return withTransaction(db, async (client) => {
      const duplicate = await client.query(
        "select mission_id from missions where org_id = $1 and creation_key = $2",
        [ctx.orgId, input.creationKey]
      );
      if (duplicate.rowCount && duplicate.rows[0]) return duplicate.rows[0].mission_id as string;

      const repoId = await upsertRepository(client, ctx, available, input.provider);
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
        `insert into workstreams (wst_id, mission_id, repo_id, name, base_ref, base_sha, mission_branch, branch_status)
         values ($1, $2, $3, 'main', $4, $5, $6, 'pending')`,
        [newWorkstreamId(), missionId, repoId, input.baseRef, input.baseSha, missionBranch]
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
       join repositories r on r.repo_id = w.repo_id
      where w.mission_id = $1 and m.org_id = $2 and r.provider = 'github'`,
    [missionId, ctx.orgId]
  );
  const row = rows.rows[0];
  if (!row || row.branch_status === "created") return;

  // Serialize retries: only one caller moves failed → pending; the loser exits
  // quietly instead of emitting a duplicate outcome event (D-031 audit).
  if (row.branch_status === "failed") {
    const claimed = await db.query(
      "update workstreams set branch_status = 'pending', branch_error = null where wst_id = $1 and branch_status = 'failed' returning wst_id",
      [row.wst_id]
    );
    if (claimed.rowCount === 0) return;
  }

  // Only provider outcomes decide branch state; a database failure here must
  // propagate rather than record a false 'failed' for a branch that exists.
  let outcome: { ok: true } | { ok: false; message: string };
  try {
    await provider.ensureBranch(row.provider_repo_id, row.mission_branch, row.base_sha);
    outcome = { ok: true };
  } catch (error) {
    outcome = {
      ok: false,
      message:
        error instanceof BranchConflictError ||
        error instanceof ProviderTransientError ||
        error instanceof UnknownBaseError ||
        error instanceof ProviderUnconfiguredError
          ? error.message
          : "Branch creation failed."
    };
  }

  await withTransaction(db, async (client) => {
    if (outcome.ok) {
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
    } else {
      const updated = await client.query(
        "update workstreams set branch_status = 'failed', branch_error = $2 where wst_id = $1 and branch_status <> 'created' returning wst_id",
        [row.wst_id, outcome.message]
      );
      if (updated.rowCount) {
        await recordEvent(client, {
          orgId: ctx.orgId,
          missionId,
          seq: await nextSeq(client, missionId),
          kind: "workstream.branch_failed",
          actorKind: "system",
          actorId: "control-plane",
          payload: { missionBranch: row.mission_branch, error: outcome.message }
        });
      }
    }
  });
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

/** Records (or refreshes) a local repository the desktop registered (D-032). */
export async function registerLocalRepository(
  db: Db,
  ctx: AuthedContext,
  input: { localId: string; name: string; defaultBranch: string }
): Promise<RepositoryRef> {
  const repoId = await withTransaction(db, (client) =>
    upsertRepository(
      client,
      ctx,
      { providerRepoId: input.localId, name: input.name, defaultBranch: input.defaultBranch },
      "local"
    )
  );
  return {
    repoId,
    provider: "local",
    providerRepoId: input.localId,
    name: input.name,
    defaultBranch: input.defaultBranch
  };
}

export async function listLocalRepositories(db: Db, ctx: AuthedContext): Promise<RepositoryRef[]> {
  const rows = await db.query(
    "select repo_id, provider_repo_id, name, default_branch from repositories where org_id = $1 and provider = 'local' order by created_at desc",
    [ctx.orgId]
  );
  return rows.rows.map((row) => ({
    repoId: row.repo_id,
    provider: "local" as const,
    providerRepoId: row.provider_repo_id,
    name: row.name,
    defaultBranch: row.default_branch
  }));
}

/**
 * The desktop's reported outcome for a local branch — a claim from the
 * machine that ran git, recorded as such. A `created` state never downgrades.
 */
export async function reportBranchOutcome(
  db: Db,
  ctx: AuthedContext,
  workstreamId: string,
  report: { status: "created" | "failed"; error?: string | null }
): Promise<string | null> {
  const rows = await db.query(
    `select w.wst_id, w.mission_id, w.mission_branch from workstreams w
       join missions m on m.mission_id = w.mission_id
      where w.wst_id = $1 and m.org_id = $2`,
    [workstreamId, ctx.orgId]
  );
  const row = rows.rows[0];
  if (!row) return null;

  await withTransaction(db, async (client) => {
    const updated = await client.query(
      report.status === "created"
        ? "update workstreams set branch_status = 'created', branch_error = null where wst_id = $1 and branch_status <> 'created' returning wst_id"
        : "update workstreams set branch_status = 'failed', branch_error = $2 where wst_id = $1 and branch_status <> 'created' returning wst_id",
      report.status === "created" ? [row.wst_id] : [row.wst_id, report.error ?? "Branch creation failed."]
    );
    if (updated.rowCount) {
      await recordEvent(client, {
        orgId: ctx.orgId,
        missionId: row.mission_id,
        seq: await nextSeq(client, row.mission_id),
        kind: report.status === "created" ? "workstream.branch_created" : "workstream.branch_failed",
        actorKind: "user",
        actorId: ctx.userId,
        payload:
          report.status === "created"
            ? { missionBranch: row.mission_branch, reportedBy: "local-desktop" }
            : { missionBranch: row.mission_branch, error: report.error ?? "Branch creation failed.", reportedBy: "local-desktop" }
      });
    }
  });
  return row.mission_id as string;
}

/** Records a submitted direction as a durable, attributed event. */
export async function submitDirection(
  db: Db,
  ctx: AuthedContext,
  missionId: string,
  body: string
): Promise<boolean> {
  const owns = await db.query("select 1 from missions where mission_id = $1 and org_id = $2", [
    missionId,
    ctx.orgId
  ]);
  if (!owns.rowCount) return false;
  await withTransaction(db, async (client) => {
    await recordEvent(client, {
      orgId: ctx.orgId,
      missionId,
      seq: await nextSeq(client, missionId),
      kind: "direction.submitted",
      actorKind: "user",
      actorId: ctx.userId,
      payload: { body }
    });
  });
  return true;
}

/**
 * Batch-records harness/runner activity reported by a client machine — claims
 * from the machine that ran the work, with the actor forced server-side.
 */
export async function reportExecutionEvents(
  db: Db,
  ctx: AuthedContext,
  missionId: string,
  events: { kind: string; payload: Record<string, unknown> }[]
): Promise<boolean> {
  const owns = await db.query("select 1 from missions where mission_id = $1 and org_id = $2", [
    missionId,
    ctx.orgId
  ]);
  if (!owns.rowCount) return false;
  await withTransaction(db, async (client) => {
    let seq = await nextSeq(client, missionId);
    for (const event of events) {
      await recordEvent(client, {
        orgId: ctx.orgId,
        missionId,
        seq,
        kind: event.kind,
        actorKind: event.kind.startsWith("harness.") ? "harness" : "runner",
        actorId: event.kind.startsWith("harness.") ? "claude-code" : `local:${ctx.userId}`,
        payload: event.payload
      });
      seq += 1;
    }
  });
  return true;
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
