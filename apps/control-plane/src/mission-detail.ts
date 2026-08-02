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
  VerificationCheck,
  Workspace,
  WorkspaceProcess
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

/**
 * A check proves the revision it ran against. Once the workstream's latest
 * checkpoint has moved past it the row is history, not evidence — so staleness
 * is derived here against the current head rather than stored and left to rot.
 */
export async function listChecks(
  db: Db,
  missionId: string,
  currentCheckpointSha: string | null
): Promise<VerificationCheck[]> {
  const result = await db.query(
    `select v.*, u.login as requested_by_login
       from verification_checks v
       left join users u on u.user_id = v.requested_by
      where v.mission_id = $1 order by v.observed_at`,
    [missionId]
  );
  return result.rows.map((row) => {
    const checkpointSha = (row.checkpoint_sha as string | null) ?? null;
    return {
      checkId: row.chk_id as string,
      executionId: (row.exe_id as string | null) ?? null,
      name: row.name as string,
      category: row.category as VerificationCheck["category"],
      outcome: row.outcome as VerificationCheck["outcome"],
      origin: row.origin as VerificationCheck["origin"],
      requestedByLogin: (row.requested_by_login as string | null) ?? null,
      command: row.command as string,
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      output: (row.output as string | null) ?? null,
      truncated: Boolean(row.truncated),
      environment: row.environment as string,
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      checkpointSha,
      // No recorded revision means it predates the workspace runtime: it can
      // never be claimed as proof of the current one.
      stale: currentCheckpointSha === null || checkpointSha === null
        ? checkpointSha !== null
        : checkpointSha !== currentCheckpointSha,
      observedAt: (row.observed_at as Date).toISOString()
    };
  });
}

export async function workspaceOf(db: Db, workstreamId: string | null): Promise<Workspace | null> {
  if (!workstreamId) return null;
  const result = await db.query("select * from workspaces where wst_id = $1", [workstreamId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    workspaceId: row.wsp_id as string,
    workstreamId: row.wst_id as string,
    location: "local",
    readiness: row.readiness as Workspace["readiness"],
    portRangeStart: row.port_range_start === null ? null : Number(row.port_range_start),
    portRangeEnd: row.port_range_end === null ? null : Number(row.port_range_end),
    setupError: (row.setup_error as string | null) ?? null,
    configuredAt: row.configured_at ? (row.configured_at as Date).toISOString() : null
  };
}

export async function listProcesses(db: Db, missionId: string): Promise<WorkspaceProcess[]> {
  const result = await db.query(
    `select p.*, u.login as started_by_login
       from workspace_processes p
       left join users u on u.user_id = p.started_by
      where p.mission_id = $1 order by p.started_at desc limit 50`,
    [missionId]
  );
  return result.rows.map((row) => ({
    processId: row.prc_id as string,
    kind: row.kind as WorkspaceProcess["kind"],
    name: row.name as string,
    command: row.command as string,
    state: row.state as WorkspaceProcess["state"],
    startedByLogin: (row.started_by_login as string | null) ?? null,
    previewUrl: (row.preview_url as string | null) ?? null,
    port: row.port === null || row.port === undefined ? null : Number(row.port),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    failureReason: (row.failure_reason as string | null) ?? null,
    startedAt: (row.started_at as Date).toISOString(),
    endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : null
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
  /** A workstream whose branch has not been allocated has no workspace to
   *  instruct yet, which is exactly what *New mission* means. */
  branchReady: boolean;
  workspace: Workspace | null;
  executions: Execution[];
  checkpoints: Checkpoint[];
  checks: VerificationCheck[];
}): MissionState {
  if (!args.hasWorkstream || !args.branchReady) return "new_mission";
  // A workspace mid-setup is being prepared, which is what *Provisioning
  // workspace* has always meant; one that was never configured says so rather
  // than pretending it is ready to run something.
  if (args.workspace?.readiness === "configuring") return "provisioning_workspace";
  if (args.workspace?.readiness === "failed") return "workspace_failed";
  // Idle, with nothing to report: say whether the workspace can actually run
  // anything. Direction is never blocked on this — the composer stays open —
  // but the room should not imply a project it cannot start.
  const idle: MissionState =
    args.workspace === null || args.workspace.readiness === "unconfigured"
      ? "workspace_needs_setup"
      : "ready_for_instruction";

  const latest = args.executions[args.executions.length - 1];
  if (!latest) return idle;

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
  // Only evidence for the revision that is actually there counts toward
  // readiness; a stale pass is history (PRODUCT.md#the-mission-state-model).
  const checksForRun = args.checks.filter((check) => !check.stale);
  if (checksForRun.some((check) => check.outcome === "failed" || check.outcome === "errored")) {
    return "verification_failed";
  }
  if (!changed) return idle;
  if (checksForRun.some((check) => check.outcome === "passed")) return "ready_for_review";
  return "work_completed_unverified";
}

export function projectOverlays(args: {
  queuedDirections: number;
  control: ControlSnapshot;
  runner: RunnerStatus | null;
  processes: WorkspaceProcess[];
  checks: VerificationCheck[];
}): MissionOverlay[] {
  const overlays: MissionOverlay[] = [];
  if (args.processes.some((process) => process.kind === "run" && (process.state === "running" || process.state === "starting"))) {
    overlays.push("project_running");
  }
  if (args.checks.length > 0 && args.checks.every((check) => check.stale)) {
    overlays.push("verification_stale");
  }
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
  const checkpointsForSha = await listCheckpoints(db, access.missionId);
  // The revision a check has to match to still count as current evidence.
  const currentCheckpointSha =
    [...checkpointsForSha].reverse().find((checkpoint) => checkpoint.sha !== null)?.sha ?? null;

  const [participants, control, directions, executions, checkpoints, checks, runner, workspace, processes, eventRows] =
    await Promise.all([
      listParticipants(db, access.missionId, access.controllerUserId),
      controlSnapshot(db, access.workstreamId),
      listDirections(db, access.missionId),
      listExecutions(db, access.missionId),
      Promise.resolve(checkpointsForSha),
      listChecks(db, access.missionId, currentCheckpointSha),
      runnerStatus(db, access.workstreamId),
      workspaceOf(db, access.workstreamId),
      listProcesses(db, access.missionId),
      db.query(`${EVENT_SELECT} where org_id = $1 and mission_id = $2 order by seq`, [
        access.orgId,
        access.missionId
      ])
    ]);

  const state = projectMissionState({
    hasWorkstream: base.workstream !== null,
    branchReady: base.workstream?.branchStatus === "created",
    workspace,
    executions,
    checkpoints,
    checks
  });
  const overlays = projectOverlays({
    queuedDirections: directions.filter((direction) => direction.state === "queued").length,
    control,
    runner,
    processes,
    checks
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
    workspace,
    processes,
    capabilities: access.capabilities,
    viewerUserId,
    state,
    overlays
  };
}
