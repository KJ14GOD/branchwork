import type {
  Checkpoint,
  ControlSnapshot,
  Execution,
  FileChange,
  MissionDetailResponse,
  MissionOverlay,
  MissionState,
  Participant,
  RunnerStatus,
  VerificationCheck
} from "@novus/contracts";
import type { Db } from "./db.ts";
import { EVENT_SELECT, toMissionEvent, type EventRow } from "./events.ts";
import { listDirections } from "./directions.ts";
import type { MissionAccess } from "./authz.ts";

/**
 * Everything the room reads, in one place. This module only ever SELECTs:
 * the write paths for control, invitations, executions, and evidence live in
 * their own modules, and none of them can change what the room sees except by
 * changing durable state. The mission's primary state is a **projection** over
 * workstream and execution state (PRODUCT.md#the-mission-state-model), never a
 * stored field that could drift.
 */

/** A runner that has not been heard from for this long reads as offline. */
const RUNNER_OFFLINE_AFTER_MS = 30_000;

export async function listParticipants(
  db: Db,
  missionId: string,
  controllerUserId: string | null
): Promise<Participant[]> {
  const result = await db.query(
    `select p.user_id, u.login, u.name, p.mission_role, p.created_at
       from participants p join users u on u.user_id = p.user_id
      where p.mission_id = $1
      order by p.created_at`,
    [missionId]
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    login: row.login as string,
    name: (row.name as string | null) ?? null,
    role: row.mission_role as Participant["role"],
    joinedAt: (row.created_at as Date).toISOString(),
    isController: row.user_id === controllerUserId
  }));
}

export async function controlSnapshot(db: Db, workstreamId: string | null): Promise<ControlSnapshot> {
  const empty: ControlSnapshot = {
    leaseId: null,
    holderUserId: null,
    holderLogin: null,
    state: null,
    openRequests: [],
    liveOffer: null
  };
  if (!workstreamId) return empty;

  const lease = await db.query(
    `select l.lease_id, l.holder_user_id, l.state, u.login
       from control_leases l join users u on u.user_id = l.holder_user_id
      where l.wst_id = $1 and l.state in ('held', 'releasing')`,
    [workstreamId]
  );
  const requests = await db.query(
    `select r.req_id, r.requester_user_id, r.state, r.created_at, u.login
       from control_requests r join users u on u.user_id = r.requester_user_id
      where r.wst_id = $1 and r.state = 'open' order by r.created_at`,
    [workstreamId]
  );
  const offer = await db.query(
    `select o.offer_id, o.from_user_id, o.to_user_id, o.state, o.created_at,
            f.login as from_login, t.login as to_login
       from handoff_offers o
       join users f on f.user_id = o.from_user_id
       join users t on t.user_id = o.to_user_id
      where o.wst_id = $1 and o.state in ('open', 'accepted', 'waiting_for_boundary')
      order by o.created_at desc limit 1`,
    [workstreamId]
  );

  const leaseRow = lease.rows[0];
  const offerRow = offer.rows[0];
  return {
    leaseId: (leaseRow?.lease_id as string | undefined) ?? null,
    holderUserId: (leaseRow?.holder_user_id as string | undefined) ?? null,
    holderLogin: (leaseRow?.login as string | undefined) ?? null,
    state: leaseRow ? (leaseRow.state === "releasing" ? "releasing" : "held") : null,
    openRequests: requests.rows.map((row) => ({
      requestId: row.req_id as string,
      requesterUserId: row.requester_user_id as string,
      requesterLogin: row.login as string,
      state: "open" as const,
      createdAt: (row.created_at as Date).toISOString()
    })),
    liveOffer: offerRow
      ? {
          offerId: offerRow.offer_id as string,
          fromUserId: offerRow.from_user_id as string,
          fromLogin: offerRow.from_login as string,
          toUserId: offerRow.to_user_id as string,
          toLogin: offerRow.to_login as string,
          state: offerRow.state as "open" | "accepted" | "waiting_for_boundary",
          createdAt: (offerRow.created_at as Date).toISOString()
        }
      : null
  };
}

export async function listExecutions(db: Db, missionId: string): Promise<Execution[]> {
  const result = await db.query(
    `select e.*, u.login as started_by_login from executions e
       join users u on u.user_id = e.started_by
      where e.mission_id = $1 order by e.created_at`,
    [missionId]
  );
  return result.rows.map((row) => ({
    executionId: row.exe_id as string,
    workstreamId: row.wst_id as string,
    harness: row.harness as string,
    model: row.model as string,
    effort: row.effort as string,
    runnerId: (row.runner_id as string | null) ?? null,
    startingDirectionId: (row.starting_direction_id as string | null) ?? null,
    state: row.state as Execution["state"],
    startedBy: row.started_by as string,
    startedByLogin: row.started_by_login as string,
    createdAt: (row.created_at as Date).toISOString(),
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
    endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : null,
    harnessSessionId: (row.harness_session_id as string | null) ?? null,
    resumedSession: Boolean(row.resumed_session),
    exitOutcome: (row.exit_outcome as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    latestCheckpointSha: (row.latest_checkpoint_sha as string | null) ?? null
  }));
}

export async function listCheckpoints(db: Db, missionId: string): Promise<Checkpoint[]> {
  const checkpoints = await db.query(
    "select * from checkpoints where mission_id = $1 order by created_at",
    [missionId]
  );
  if (checkpoints.rowCount === 0) return [];
  const files = await db.query(
    `select chg_id, ckp_id, path, previous_path, change_state, additions, deletions,
            is_binary, truncated
       from file_changes where mission_id = $1 order by path`,
    [missionId]
  );
  const byCheckpoint = new Map<string, FileChange[]>();
  for (const row of files.rows) {
    const list = byCheckpoint.get(row.ckp_id as string) ?? [];
    list.push({
      changeId: row.chg_id as string,
      path: row.path as string,
      previousPath: (row.previous_path as string | null) ?? null,
      changeState: row.change_state as FileChange["changeState"],
      additions: Number(row.additions),
      deletions: Number(row.deletions),
      binary: Boolean(row.is_binary),
      truncated: Boolean(row.truncated)
    });
    byCheckpoint.set(row.ckp_id as string, list);
  }
  return checkpoints.rows.map((row) => ({
    checkpointId: row.ckp_id as string,
    executionId: row.exe_id as string,
    outcome: row.outcome as Checkpoint["outcome"],
    sha: (row.sha as string | null) ?? null,
    parentSha: (row.parent_sha as string | null) ?? null,
    branch: row.branch as string,
    filesChanged: Number(row.files_changed),
    additions: Number(row.additions),
    deletions: Number(row.deletions),
    withheldSecrets: Number(row.withheld_secrets),
    uncommitted: Boolean(row.uncommitted),
    environment: row.environment as string,
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    files: byCheckpoint.get(row.ckp_id as string) ?? []
  }));
}

export async function listChecks(db: Db, missionId: string): Promise<VerificationCheck[]> {
  const result = await db.query(
    "select * from verification_checks where mission_id = $1 order by observed_at",
    [missionId]
  );
  return result.rows.map((row) => ({
    checkId: row.chk_id as string,
    executionId: row.exe_id as string,
    name: row.name as string,
    category: row.category as VerificationCheck["category"],
    outcome: row.outcome as VerificationCheck["outcome"],
    command: row.command as string,
    output: (row.output as string | null) ?? null,
    truncated: Boolean(row.truncated),
    environment: row.environment as string,
    observedAt: (row.observed_at as Date).toISOString()
  }));
}

export async function runnerStatus(db: Db, workstreamId: string | null): Promise<RunnerStatus | null> {
  if (!workstreamId) return null;
  const result = await db.query(
    `select r.runner_id, r.kind, r.label, r.last_seen_at, u.login
       from runners r join users u on u.user_id = r.owner_user_id
      where r.wst_id = $1 and r.revoked_at is null
      order by r.created_at desc limit 1`,
    [workstreamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const lastSeen = (row.last_seen_at as Date | null) ?? null;
  return {
    runnerId: row.runner_id as string,
    kind: "local",
    label: row.label as string,
    ownerLogin: row.login as string,
    online: lastSeen !== null && Date.now() - lastSeen.getTime() < RUNNER_OFFLINE_AFTER_MS,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null
  };
}

/**
 * The mission's primary state, derived from durable execution and evidence
 * state. A failed execution surfaces as *Execution interrupted* — the harness
 * stopped mid-work and the human choice is resume-or-restart; the state line
 * names the actual reason. There is no state that claims completion the
 * evidence does not support.
 */
export function projectMissionState(args: {
  hasWorkstream: boolean;
  executions: Execution[];
  checkpoints: Checkpoint[];
  checks: VerificationCheck[];
}): MissionState {
  if (!args.hasWorkstream) return "new_mission";
  const latest = args.executions[args.executions.length - 1];
  if (!latest) return "ready_for_instruction";

  switch (latest.state) {
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
    case "completed":
    case "stopped":
      break;
  }

  const changed = args.checkpoints.some((checkpoint) => checkpoint.filesChanged > 0);
  const checksForRun = args.checks.filter((check) => check.executionId === latest.executionId);
  if (checksForRun.some((check) => check.outcome === "failed" || check.outcome === "errored")) {
    return "verification_failed";
  }
  if (!changed) return "ready_for_instruction";
  if (checksForRun.some((check) => check.outcome === "passed")) return "ready_for_review";
  return "work_completed_unverified";
}

export function projectOverlays(args: {
  queuedDirections: number;
  control: ControlSnapshot;
  runner: RunnerStatus | null;
}): MissionOverlay[] {
  const overlays: MissionOverlay[] = [];
  if (args.queuedDirections > 0) overlays.push("direction_queued");
  if (args.control.openRequests.length > 0) overlays.push("control_requested");
  if (args.control.liveOffer?.state === "open") overlays.push("handoff_offered");
  if (
    args.control.liveOffer?.state === "accepted" ||
    args.control.liveOffer?.state === "waiting_for_boundary"
  ) {
    overlays.push("handoff_waiting_for_boundary");
  }
  if (args.runner && !args.runner.online) overlays.push("runner_offline");
  return overlays;
}

/** Assembles the whole room payload for one authorized viewer. */
export async function missionDetail(
  db: Db,
  access: MissionAccess,
  viewerUserId: string,
  base: { mission: MissionDetailResponse["mission"]; workstream: MissionDetailResponse["workstream"] }
): Promise<MissionDetailResponse> {
  const [participants, control, directions, executions, checkpoints, checks, runner, eventRows] =
    await Promise.all([
      listParticipants(db, access.missionId, access.controllerUserId),
      controlSnapshot(db, access.workstreamId),
      listDirections(db, access.missionId),
      listExecutions(db, access.missionId),
      listCheckpoints(db, access.missionId),
      listChecks(db, access.missionId),
      runnerStatus(db, access.workstreamId),
      db.query(`${EVENT_SELECT} where org_id = $1 and mission_id = $2 order by seq`, [
        access.orgId,
        access.missionId
      ])
    ]);

  const state = projectMissionState({
    hasWorkstream: base.workstream !== null,
    executions,
    checkpoints,
    checks
  });
  const overlays = projectOverlays({
    queuedDirections: directions.filter((direction) => direction.state === "queued").length,
    control,
    runner
  });

  return {
    mission: { ...base.mission, primaryState: state },
    workstream: base.workstream,
    events: (eventRows.rows as EventRow[]).map(toMissionEvent),
    participants,
    directions,
    executions,
    control,
    checkpoints,
    checks,
    runner,
    capabilities: access.capabilities,
    viewerUserId,
    state,
    overlays
  };
}
