import type {
  CreateMissionInput,
  Mission,
  MissionDetailResponse,
  RepositoryRef,
  Workstream
} from "@novus/contracts";
import type pg from "pg";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { recordEvent, recordEventAtSeq } from "./events.ts";
import { newLeaseId, newMissionId, newRepoId, newWorkstreamId } from "./ids.ts";
import type { AuthedContext } from "./auth.ts";
import { missionAccess } from "./authz.ts";
import { missionDetail } from "./mission-detail.ts";
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
  archived_at: Date | null;
  archived_by_login: string | null;
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
  approach_flag?: boolean;
  intent?: string | null;
  forked_from_wst_id?: string | null;
  origin_sha?: string | null;
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
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    archivedByLogin: row.archived_by_login ?? null,
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
    branchError: row.branch_error,
    // What makes this lane an approach rather than the one the mission started
    // with (D-074). Absent on every mission that never forked.
    approach: Boolean(row.approach_flag),
    intent: row.intent ?? null,
    forkedFromWorkstreamId: row.forked_from_wst_id ?? null,
    originSha: row.origin_sha ?? null
  };
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
 * Creates the mission, its workstream, the creator's Mission Admin
 * participation, the workstream's first control lease, and the initial events
 * in one transaction, then attempts branch creation as a recorded side effect.
 * Idempotent end to end: the creationKey makes retried submissions return the
 * existing mission instead of minting a second one (D-031).
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

  const base = await getMissionBase(db, ctx, created);
  if (!base || !base.workstream) throw new Error("mission vanished during creation");
  return {
    mission: {
      ...base.mission,
      // A brand-new workstream has a branch and nothing else: no worktree, no
      // configuration, nothing it could run. Direction still works; running
      // the project does not, and the room says so.
      primaryState: base.workstream.branchStatus === "created" ? "workspace_needs_setup" : "new_mission"
    },
    workstream: base.workstream
  };
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
    const workstreamId = newWorkstreamId();
    const missionBranch = `novus/m-${missionId.slice(4, 12)}`;
    await client.query(
      `insert into workstreams (wst_id, mission_id, repo_id, name, base_ref, base_sha, mission_branch, branch_status)
         values ($1, $2, $3, 'main', $4, $5, $6, 'pending')`,
      [workstreamId, missionId, repoId, input.baseRef, input.baseSha, missionBranch]
    );
    // The creator holds the first lease: a workstream is never born without a
    // controller (PRODUCT.md#control).
    const leaseId = newLeaseId();
    await client.query(
      `insert into control_leases (lease_id, org_id, mission_id, wst_id, holder_user_id, state)
         values ($1, $2, $3, $4, $5, 'held')`,
      [leaseId, ctx.orgId, missionId, workstreamId, ctx.userId]
    );

    await recordEventAtSeq(
      client,
      {
        orgId: ctx.orgId,
        missionId,
        workstreamId,
        kind: "mission.created",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { goal: input.goal, successCriteria: input.successCriteria, repository: available.name }
      },
      1
    );
    await recordEventAtSeq(
      client,
      {
        orgId: ctx.orgId,
        missionId,
        workstreamId,
        kind: "workstream.created",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { baseRef: input.baseRef, baseSha: input.baseSha, missionBranch }
      },
      2
    );
    await recordEventAtSeq(
      client,
      {
        orgId: ctx.orgId,
        missionId,
        workstreamId,
        kind: "control.granted",
        actorKind: "system",
        actorId: "control-plane",
        causeLeaseId: leaseId,
        payload: { holderLogin: ctx.login, reason: "mission_created" }
      },
      3
    );
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
  _ctx: AuthedContext,
  missionId: string,
  /** Which lane's branch to drive. A mission may hold several (D-074); absent
   *  means the one it started with, which is every mission that never forked. */
  workstreamId?: string
): Promise<void> {
  const rows = await db.query(
    `select w.wst_id, w.mission_branch, w.base_sha, w.branch_status, r.provider_repo_id, m.org_id
       from workstreams w
       join missions m on m.mission_id = w.mission_id
       join repositories r on r.repo_id = w.repo_id
      where w.mission_id = $1 and r.provider = 'github'
        and ($2::text is null or w.wst_id = $2)
      order by w.created_at, w.wst_id`,
    [missionId, workstreamId ?? null]
  );
  const row = rows.rows[0];
  if (!row || row.branch_status === "created") return;
  const orgId = row.org_id as string;

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
          orgId,
          missionId,
          workstreamId: row.wst_id,
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
          orgId,
          missionId,
          workstreamId: row.wst_id,
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
         m.archived_at, archiver.login as archived_by_login,
         m.repo_id, r.provider, r.provider_repo_id, r.name as repo_name, r.default_branch
    from missions m
    join users u on u.user_id = m.created_by
    left join users archiver on archiver.user_id = m.archived_by
    left join repositories r on r.repo_id = m.repo_id`;

/**
 * The fragment that decides whether a caller may see a mission at all:
 * membership in the organization that owns it, and a participant row. An
 * organization member who was never invited cannot see it, so a mission id is
 * never a capability; and because the check is against the mission's own
 * organization, it keeps working for someone who belongs to two (D-036).
 */
const VISIBLE_TO = `
   join participants p on p.mission_id = m.mission_id and p.user_id = $1
   join organization_members om on om.org_id = m.org_id and om.user_id = $1`;

/**
 * Missions the caller participates in, newest first.
 *
 * Archived ones are absent by default and are the whole content of the
 * Archived view — one query, one filter, so the two lists can never disagree
 * about which mission is where (D-063). Filed away is not hidden: reading a
 * mission never consults this, so an archived mission opens exactly as it did.
 */
export async function listMissions(
  db: Db,
  ctx: AuthedContext,
  filter: "active" | "archived" = "active"
): Promise<Mission[]> {
  const result = await db.query(
    `${MISSION_SELECT} ${VISIBLE_TO}
      where m.archived_at is ${filter === "archived" ? "not null" : "null"}
      order by m.created_at desc`,
    [ctx.userId]
  );
  const missions = (result.rows as MissionRow[]).map(toMission);
  if (missions.length === 0) return missions;

  // The list must not disagree with the room. Both states come from the same
  // projection over the same durable facts; the stored column is never read.
  const ids = missions.map((mission) => mission.missionId);
  const summary = await db.query(
    `select m.mission_id,
            (select e.state from executions e
              where e.mission_id = m.mission_id order by e.created_at desc limit 1) as latest_state,
            exists (select 1 from workstreams w
                     where w.mission_id = m.mission_id and w.branch_status = 'created') as branch_ready,
            (select ws.readiness from workspaces ws
               join workstreams w2 on w2.wst_id = ws.wst_id
              where w2.mission_id = m.mission_id limit 1) as readiness,
            exists (select 1 from checkpoints c where c.mission_id = m.mission_id and c.files_changed > 0) as changed,
            exists (select 1 from verification_checks v where v.mission_id = m.mission_id and v.outcome = 'passed') as passed,
            exists (select 1 from verification_checks v where v.mission_id = m.mission_id and v.outcome in ('failed', 'errored')) as broken
       from missions m where m.mission_id = any($1::text[])`,
    [ids]
  );
  const byId = new Map(summary.rows.map((row) => [row.mission_id as string, row]));
  return missions.map((mission) => {
    const row = byId.get(mission.missionId);
    if (!row) return mission;
    return { ...mission, primaryState: projectListState(row) };
  });
}

/** The same state machine as the room's, over the columns a list can afford. */
function projectListState(row: {
  latest_state: string | null;
  branch_ready: boolean;
  readiness: string | null;
  changed: boolean;
  passed: boolean;
  broken: boolean;
}): Mission["primaryState"] {
  if (!row.branch_ready) return "new_mission";
  if (row.readiness === "configuring") return "provisioning_workspace";
  if (row.readiness === "failed") return "workspace_failed";
  const idle: Mission["primaryState"] =
    row.readiness === null || row.readiness === "unconfigured"
      ? "workspace_needs_setup"
      : "ready_for_instruction";
  switch (row.latest_state) {
    case null:
      return idle;
    case "requested":
    case "starting":
      return "agent_starting";
    case "running":
    case "stopping":
      return "agent_running";
    case "needs_direction":
      return "needs_direction";
    case "needs_approval":
      return "needs_approval";
    case "interrupted":
    case "failed":
      return "execution_interrupted";
    default:
      break;
  }
  if (row.broken) return "verification_failed";
  if (!row.changed) return idle;
  return row.passed ? "ready_for_review" : "work_completed_unverified";
}

/** The mission row and its workstream, without the room projection. */
export async function getMissionBase(
  db: Db,
  ctx: AuthedContext,
  missionId: string
): Promise<{ mission: Mission; workstream: Workstream | null } | null> {
  const result = await db.query(
    `${MISSION_SELECT} ${VISIBLE_TO} where m.mission_id = $2`,
    [ctx.userId, missionId]
  );
  const row = (result.rows as MissionRow[])[0];
  if (!row) return null;
  // The lane the room reads by default is the one the mission started with —
  // oldest first, so a mission that has since forked an approach still opens
  // where it always did (D-074).
  const workstreamRows = await db.query(
    "select * from workstreams where mission_id = $1 order by created_at, wst_id",
    [missionId]
  );
  const workstream = workstreamRows.rows[0] ? toWorkstream(workstreamRows.rows[0] as WorkstreamRow) : null;
  return { mission: toMission(row), workstream };
}

/** The complete room payload for one authorized viewer. */
export async function getMission(
  db: Db,
  ctx: AuthedContext,
  missionId: string
): Promise<MissionDetailResponse | null> {
  const base = await getMissionBase(db, ctx, missionId);
  if (!base) return null;
  const access = await missionAccess(db, ctx, missionId);
  if (!access) return null;
  return missionDetail(db, access, ctx.userId, base);
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
    `select w.wst_id, w.mission_id, w.mission_branch, m.org_id from workstreams w
       join missions m on m.mission_id = w.mission_id
       join participants p on p.mission_id = m.mission_id and p.user_id = $2
       join organization_members om on om.org_id = m.org_id and om.user_id = $2
      where w.wst_id = $1`,
    [workstreamId, ctx.userId]
  );
  const row = rows.rows[0];
  if (!row) return null;
  const orgId = row.org_id as string;

  await withTransaction(db, async (client) => {
    const updated = await client.query(
      report.status === "created"
        ? "update workstreams set branch_status = 'created', branch_error = null where wst_id = $1 and branch_status <> 'created' returning wst_id"
        : "update workstreams set branch_status = 'failed', branch_error = $2 where wst_id = $1 and branch_status <> 'created' returning wst_id",
      report.status === "created" ? [row.wst_id] : [row.wst_id, report.error ?? "Branch creation failed."]
    );
    if (updated.rowCount) {
      await recordEvent(client, {
        orgId,
        missionId: row.mission_id,
        workstreamId: row.wst_id,
        kind: report.status === "created" ? "workstream.branch_created" : "workstream.branch_failed",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload:
          report.status === "created"
            ? { missionBranch: row.mission_branch, reportedBy: "local-desktop" }
            : {
                missionBranch: row.mission_branch,
                error: report.error ?? "Branch creation failed.",
                reportedBy: "local-desktop"
              }
      });
    }
  });
  return row.mission_id as string;
}

export async function getWorkstreamMission(
  db: Db,
  ctx: AuthedContext,
  workstreamId: string
): Promise<string | null> {
  const result = await db.query(
    `select w.mission_id from workstreams w
       join missions m on m.mission_id = w.mission_id
       join participants p on p.mission_id = m.mission_id and p.user_id = $2
       join organization_members om on om.org_id = m.org_id and om.user_id = $2
      where w.wst_id = $1`,
    [workstreamId, ctx.userId]
  );
  return (result.rows[0]?.mission_id as string | undefined) ?? null;
}
