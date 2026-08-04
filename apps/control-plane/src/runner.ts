import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  TERMINAL_EXECUTION_STATES,
  AckCommandInputSchema,
  RegisterRunnerInputSchema,
  ReportRunnerEventsInputSchema,
  type RunnerCommand,
  type RunnerEvent,
  type SequencedRunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { completeTransferAtBoundary } from "./authority.ts";
import { workstreamAccess } from "./authz.ts";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { markDirectionApplied } from "./directions.ts";
import { dispatchQueuedForController } from "./executions.ts";
import { nextSeq, recordEvent, recordEventAtSeq } from "./events.ts";
import {
  CloneCredentialError,
  CloneCredentialRequestSchema,
  issueCloneCredential
} from "./repo-clone.ts";
import {
  newCheckId,
  newCheckpointId,
  newFileChangeId,
  newRunnerId,
  newSecretToken,
  newWorkspaceId
} from "./ids.ts";
import type { RouteDeps } from "./routes.ts";
import { ensureWorkspace } from "./workspace.ts";

/**
 * OWNER: the runner plane's control-plane half (D-035). Paths owned here:
 *
 *   POST   /workstreams/:workstreamId/runner            (user session: register, returns the credential once)
 *   GET    /runner/commands                             (runner credential)
 *   POST   /runner/commands/:commandId                  (runner credential: ack | complete | fail)
 *   POST   /runner/events                               (runner credential: sequenced, deduped)
 *   POST   /runner/heartbeat                            (runner credential)
 *   POST   /runner/clone-credential                     (runner credential: repository-scoped, short-lived)
 *
 * The credential is the only thing that may write `harness.*`, `runner.*`,
 * `execution.*`, `workspace.*`, or verification evidence. A normal user
 * session cannot, which is what closes D-033.
 */

/** A distinct scheme from `Bearer`, so a user session can never be read as a
 *  runner and a runner credential can never be spent as a session. */
const RUNNER_SCHEME = "Runner ";

/** Long enough that a desktop stays enrolled across a working month, short
 *  enough that a leaked credential stops being useful. */
const CREDENTIAL_TTL = "30 days";

const hashCredential = (credential: string) =>
  createHash("sha256").update(credential).digest("hex");

const WorkstreamParamsSchema = z.object({ workstreamId: z.string().startsWith("wst_") });
const CommandParamsSchema = z.object({ commandId: z.string().startsWith("cmd_") });

/** Everything a runner request resolves to. Loaded from the credential alone:
 *  a runner never names its own workstream, so it cannot reach another one. */
interface RunnerContext {
  runnerId: string;
  label: string;
  orgId: string;
  missionId: string;
  workstreamId: string;
  missionBranch: string;
  baseSha: string;
  provider: "github" | "local";
  providerRepoId: string;
  harnessSessionId: string | null;
}

/**
 * The environment string every runner-reported claim is attributed to. It is
 * composed by the server from the runner's own label, never taken from the
 * report, and never contains a filesystem path (D-032: paths stay on the
 * machine).
 */
const environmentOf = (ctx: RunnerContext) => `local runner (${ctx.label})`;

async function loadRunner(db: Db, credential: string): Promise<RunnerContext | null> {
  const result = await db.query(
    `select r.runner_id, r.label, r.org_id, r.mission_id, r.wst_id, r.revoked_at, r.expires_at,
            w.mission_branch, w.base_sha, w.harness_session_id,
            repo.provider, repo.provider_repo_id
       from runners r
       join workstreams w on w.wst_id = r.wst_id
       join repositories repo on repo.repo_id = w.repo_id
      where r.credential_hash = $1`,
    [hashCredential(credential)]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if ((row.expires_at as Date).getTime() <= Date.now()) return null;

  // Liveness is observed on every authenticated call, so "runner offline" in
  // the room is a fact about the connection rather than a guess.
  await db.query("update runners set last_seen_at = now() where runner_id = $1", [row.runner_id]);

  return {
    runnerId: row.runner_id as string,
    label: row.label as string,
    orgId: row.org_id as string,
    missionId: row.mission_id as string,
    workstreamId: row.wst_id as string,
    missionBranch: row.mission_branch as string,
    baseSha: row.base_sha as string,
    provider: row.provider as "github" | "local",
    providerRepoId: row.provider_repo_id as string,
    harnessSessionId: (row.harness_session_id as string | null) ?? null
  };
}

/**
 * Resolves the calling runner, or replies 401 and returns null. Unknown,
 * revoked, and expired credentials are all the same answer: a rejected
 * credential must not tell its holder which of the three it was.
 */
function runnerAuthenticator(deps: RouteDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<RunnerContext | null> => {
    const header = request.headers.authorization ?? "";
    const credential = header.startsWith(RUNNER_SCHEME) ? header.slice(RUNNER_SCHEME.length) : "";
    const ctx = credential ? await loadRunner(deps.db, credential) : null;
    if (!ctx) {
      await deps.sendError(reply, 401, "runner_unauthenticated", "This runner credential isn't valid.");
      return null;
    }
    return ctx;
  };
}

// --- Event ingestion --------------------------------------------------------

interface ExecutionRow {
  exe_id: string;
  wst_id: string;
  state: string;
  starting_direction_id: string | null;
}

/**
 * Actor attribution is the server's decision, never the payload's. Anything
 * the harness said is attributed to the harness; everything else is the
 * runner's own claim about its machine.
 */
function attribute(event: RunnerEvent, ctx: RunnerContext): { kind: "harness" | "runner"; id: string } {
  return event.kind.startsWith("harness.")
    ? { kind: "harness", id: "claude-code" }
    : { kind: "runner", id: ctx.runnerId };
}

/**
 * What the event log keeps. Checkpoint file bodies live in `file_changes`, not
 * inlined per-event: the log stays readable and the diff is fetched on demand
 * (ARCHITECTURE.md#event-model — transcripts are referenced, not inlined).
 */
function eventPayload(event: RunnerEvent): Record<string, unknown> {
  // The declared list lives on the workspace row, which is where the Run
  // control reads it. The log keeps what it is *for* — that the configuration
  // changed, and to what — rather than a second copy of every command line.
  if (event.kind === "workspace.declared") {
    return {
      names: event.payload.commands.map((command) => `${command.kind}:${command.name}`),
      digests: event.payload.commands.map((command) => command.digest)
    };
  }
  if (event.kind !== "workspace.checkpoint") return { ...event.payload };
  const files = event.payload.files;
  return {
    outcome: event.payload.outcome,
    sha: event.payload.sha,
    parentSha: event.payload.parentSha,
    branch: event.payload.branch,
    withheldSecrets: event.payload.withheldSecrets,
    uncommitted: event.payload.uncommitted,
    error: event.payload.error,
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  };
}

/**
 * Execution state is monotonic: once an execution has reached a terminal
 * outcome it never moves again. A runner that was declared gone and then comes
 * back must not resurrect the run it abandoned — resume-or-restart is a human
 * choice made in a *new* execution (PRODUCT.md#the-mission-state-model). The
 * late report is still recorded in the log; only the projected state is fixed.
 */
async function setExecutionState(
  client: pg.PoolClient,
  executionId: string,
  state: string,
  extra: { ended?: boolean; started?: boolean; exitOutcome?: string; failureReason?: string | null } = {}
): Promise<void> {
  await client.query(
    `update executions
        set state = $2,
            started_at = case when $3 then coalesce(started_at, now()) else started_at end,
            ended_at = case when $4 then now() else ended_at end,
            exit_outcome = coalesce($5, exit_outcome),
            failure_reason = coalesce($6, failure_reason)
      where exe_id = $1
        and state not in ('completed', 'stopped', 'interrupted', 'failed')`,
    [
      executionId,
      state,
      extra.started === true,
      extra.ended === true,
      extra.exitOutcome ?? null,
      extra.failureReason ?? null
    ]
  );
}

async function recordCheckpoint(
  client: pg.PoolClient,
  ctx: RunnerContext,
  execution: ExecutionRow,
  payload: Extract<RunnerEvent, { kind: "workspace.checkpoint" }>["payload"]
): Promise<void> {
  const checkpointId = newCheckpointId();
  const additions = payload.files.reduce((total, file) => total + file.additions, 0);
  const deletions = payload.files.reduce((total, file) => total + file.deletions, 0);
  await client.query(
    `insert into checkpoints (ckp_id, org_id, mission_id, wst_id, exe_id, outcome, sha, parent_sha,
                              branch, files_changed, additions, deletions, withheld_secrets,
                              uncommitted, runner_id, environment, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      checkpointId,
      ctx.orgId,
      ctx.missionId,
      ctx.workstreamId,
      execution.exe_id,
      payload.outcome,
      payload.sha,
      payload.parentSha,
      payload.branch,
      payload.files.length,
      additions,
      deletions,
      payload.withheldSecrets,
      payload.uncommitted,
      ctx.runnerId,
      environmentOf(ctx),
      payload.error
    ]
  );
  for (const file of payload.files) {
    await client.query(
      `insert into file_changes (chg_id, org_id, mission_id, ckp_id, path, previous_path, change_state,
                                 additions, deletions, is_binary, truncated, diff)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        newFileChangeId(),
        ctx.orgId,
        ctx.missionId,
        checkpointId,
        file.path,
        file.previousPath,
        file.changeState,
        file.additions,
        file.deletions,
        file.binary,
        file.truncated,
        file.diff
      ]
    );
  }
  if (payload.sha) {
    await client.query("update executions set latest_checkpoint_sha = $2 where exe_id = $1", [
      execution.exe_id,
      payload.sha
    ]);
  }
}

/**
 * A timestamp the runner observed, or null. The wire shape is a bounded string
 * (the contract does not parse dates), so an unparseable value is recorded as
 * "not known" rather than allowed to abort the batch it arrived in: one
 * malformed field must not lose the outcome it was attached to.
 */
function observedAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Who asked for the command this report is about, or null when nothing asked —
 * a harness-run check, or a process the runner restarted on its own. Read from
 * the durable command the control plane enqueued, never from the report: the
 * runner does not get to name a requester.
 *
 * The fallback to a nameless command is the "run the default" case: the
 * request omitted a name, the project's configuration chose one, and the
 * process reports the concrete name it actually ran.
 */
async function requesterOf(
  client: pg.PoolClient,
  workstreamId: string,
  kind: "run_setup" | "run_command" | "run_verification",
  name: string
): Promise<string | null> {
  const result = await client.query(
    `select payload->>'requestedBy' as requested_by
       from runner_commands
      where wst_id = $1 and kind = $2
        and (payload->>'name' = $3 or payload->>'name' is null)
      order by (payload->>'name' is not distinct from $3) desc, seq desc
      limit 1`,
    [workstreamId, kind, name]
  );
  return (result.rows[0]?.requested_by as string | null | undefined) ?? null;
}

/**
 * The workspace-scoped half of ingest: what the runner reports about the
 * machine rather than about a turn. Returns true when it handled the event.
 *
 * These four are the only reports that are meaningful with no execution — a
 * run command is not an execution (D-042) — and they arrive with none. The
 * replay guard is the same one every other report gets: the unique index is
 * keyed on coalesce(execution, workstream), so a workspace batch de-duplicates
 * against the workstream. Readiness, a started process and an exit are
 * additionally idempotent on their own; a completed check is not, and relies
 * on that guard alone.
 */
async function applyWorkspaceSideEffects(
  client: pg.PoolClient,
  ctx: RunnerContext,
  event: RunnerEvent
): Promise<boolean> {
  switch (event.kind) {
    case "workspace.readiness": {
      const payload = event.payload;
      await client.query(
        `insert into workspaces (wsp_id, org_id, mission_id, wst_id, runner_id, readiness,
                                 port_range_start, port_range_end, setup_error, configured_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 case when $6 = 'ready' then now() else null end)
         on conflict (wst_id) do update
            set readiness = excluded.readiness,
                runner_id = excluded.runner_id,
                -- A range is allocated once for the workstream; a later report
                -- that omits it must not forget the ports already in use.
                port_range_start = coalesce(excluded.port_range_start, workspaces.port_range_start),
                port_range_end = coalesce(excluded.port_range_end, workspaces.port_range_end),
                -- Assigned, not coalesced: a successful setup clears the
                -- failure that came before it.
                setup_error = excluded.setup_error,
                configured_at = case
                  when excluded.readiness = 'ready' then coalesce(workspaces.configured_at, now())
                  else workspaces.configured_at end,
                updated_at = now()`,
        [
          newWorkspaceId(),
          ctx.orgId,
          ctx.missionId,
          ctx.workstreamId,
          ctx.runnerId,
          payload.readiness,
          payload.portRangeStart,
          payload.portRangeEnd,
          payload.setupError
        ]
      );
      return true;
    }
    case "workspace.declared": {
      // Stored verbatim and never parsed for meaning: the control plane does
      // not learn how to build anything (D-040). What it holds this list for is
      // twofold — every participant's Run control offers the same commands, and
      // an authorization can be pinned to the exact snapshot it authorized.
      const workspaceId = await ensureWorkspace(client, {
        orgId: ctx.orgId,
        missionId: ctx.missionId,
        workstreamId: ctx.workstreamId,
        runnerId: ctx.runnerId
      });
      await client.query(
        `update workspaces set declared = $2::jsonb, declared_at = now(), updated_at = now()
          where wsp_id = $1`,
        [workspaceId, JSON.stringify(event.payload.commands)]
      );
      return true;
    }
    case "process.readiness": {
      const payload = event.payload;
      // Monotonic in the same way an exit is: a process that already finished
      // never becomes ready, and a late probe result cannot revive it.
      await client.query(
        `update workspace_processes
            set readiness = $3,
                state = case when $3 = 'ready' then 'running' else state end,
                preview_url = coalesce($4, preview_url)
          where prc_id = $1 and wst_id = $2 and state in ('starting', 'running')`,
        [payload.processId, ctx.workstreamId, payload.readiness, payload.previewUrl]
      );
      return true;
    }
    case "process.started": {
      const payload = event.payload;
      const workspaceId = await ensureWorkspace(client, {
        orgId: ctx.orgId,
        missionId: ctx.missionId,
        workstreamId: ctx.workstreamId,
        runnerId: ctx.runnerId
      });
      const startedBy = await requesterOf(
        client,
        ctx.workstreamId,
        payload.kind === "setup" ? "run_setup" : payload.kind === "run" ? "run_command" : "run_verification",
        payload.name
      );
      // Two unique indexes can refuse this row: the primary key on a replayed
      // report, and one-live-process-per-name when a runner starts a second
      // copy of something already running. Neither is worth losing the rest of
      // the batch over — the event itself is already in the log.
      //
      // A repeat report for the same process is how a preview URL discovered
      // after start-up arrives; `previewUrl` rides on no other event. So the
      // conflict is an upsert of what a late report can legitimately add, and
      // only while the process is still live: a finished one is never revived,
      // and a null in a later report never erases what an earlier one knew.
      await client.query("savepoint process_started");
      try {
        await client.query(
          `insert into workspace_processes (prc_id, org_id, mission_id, wst_id, wsp_id, kind, name,
                                            command, state, readiness, started_by, runner_id,
                                            preview_url, port)
           values ($1, $2, $3, $4, $5, $6, $7, $8,
                   case when $13 = 'pending' then 'starting' else 'running' end,
                   $13, $9, $10, $11, $12)
           on conflict (prc_id) do update
             set preview_url = coalesce(excluded.preview_url, workspace_processes.preview_url),
                 port = coalesce(excluded.port, workspace_processes.port)
             where workspace_processes.state in ('starting', 'running')`,
          [
            payload.processId,
            ctx.orgId,
            ctx.missionId,
            ctx.workstreamId,
            workspaceId,
            payload.kind,
            payload.name,
            payload.command,
            startedBy,
            ctx.runnerId,
            payload.previewUrl,
            payload.port,
            payload.readiness
          ]
        );
        await client.query("release savepoint process_started");
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        await client.query("rollback to savepoint process_started");
      }
      return true;
    }
    case "process.exited": {
      const payload = event.payload;
      // Monotonic, like execution state above: a process that has already
      // ended never returns to running, so a late or duplicated exit changes
      // nothing. Scoped to this runner's workstream — a credential is one lane.
      await client.query(
        `update workspace_processes
            set state = $3, exit_code = $4, failure_reason = $5, ending = $6,
                readiness = case when readiness = 'pending' then 'not_required' else readiness end,
                ended_at = now()
          where prc_id = $1 and wst_id = $2
            and state in ('starting', 'running')`,
        [
          payload.processId,
          ctx.workstreamId,
          payload.state,
          payload.exitCode,
          payload.failureReason,
          payload.ending
        ]
      );
      return true;
    }
    case "verification.completed": {
      const payload = event.payload;
      const requestedBy = await requesterOf(
        client,
        ctx.workstreamId,
        "run_verification",
        payload.name
      );
      await client.query(
        `insert into verification_checks (chk_id, org_id, mission_id, exe_id, name, category, outcome,
                                          origin, requested_by, command, exit_code, output, truncated,
                                          environment, runner_id, started_at, completed_at, duration_ms,
                                          checkpoint_sha, ending)
         values ($1, $2, $3, null, $4, $5, $6, 'participant', $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18)`,
        [
          newCheckId(),
          ctx.orgId,
          ctx.missionId,
          payload.name,
          payload.category,
          payload.outcome,
          requestedBy,
          payload.command,
          payload.exitCode,
          payload.output,
          payload.truncated,
          // Composed by the server from the runner's label, never taken from
          // the report and never a filesystem path.
          environmentOf(ctx),
          ctx.runnerId,
          observedAt(payload.startedAt),
          observedAt(payload.completedAt),
          payload.durationMs,
          // The revision this check proves. Staleness is derived against the
          // workstream's head at read time, never stored (D-037).
          payload.checkpointSha,
          // A check that ran out of time or was cancelled reached no verdict,
          // and says which rather than reading as an ordinary failure.
          payload.ending
        ]
      );
      return true;
    }
    default:
      return false;
  }
}

/** The durable consequence of one reported event, applied after it was
 *  recorded and only when it was not a de-duplicated replay. */
async function applySideEffects(
  client: pg.PoolClient,
  ctx: RunnerContext,
  /** Null for a workspace-scoped report: a run command is not an execution. */
  execution: ExecutionRow | null,
  event: RunnerEvent
): Promise<void> {
  if (await applyWorkspaceSideEffects(client, ctx, event)) return;
  // Everything below is a claim about a turn. Without one there is nothing to
  // move; the event stays in the log and no projected state changes.
  if (!execution) return;
  // A turn that has already ended does not get to keep changing anything.
  // `setExecutionState` has always refused to move a terminal execution, so a
  // late report could not resurrect one — but the transcript, the session
  // pointer, and checkpoints did not go through it, so a stopped execution
  // went on talking, could overwrite the workstream's resume point with the
  // session it was killed in, and could commit a checkpoint after the
  // participant had stopped it. The event is still recorded; what it is no
  // longer allowed to do is change what the room shows (D-053).
  if (TERMINAL_EXECUTION_STATES.includes(execution.state as never)) return;
  switch (event.kind) {
    case "execution.starting":
      await setExecutionState(client, execution.exe_id, "starting");
      return;
    case "execution.running":
      await setExecutionState(client, execution.exe_id, "running", { started: true });
      return;
    case "harness.session":
      await client.query(
        "update executions set harness_session_id = $2, resumed_session = $3 where exe_id = $1",
        [execution.exe_id, event.payload.sessionId, event.payload.resumed]
      );
      // The workstream remembers the session so the next execution can continue
      // the same conversation rather than starting cold. (This cited a decision
      // number that has never existed; the reason is stated instead.)
      await client.query("update workstreams set harness_session_id = $2 where wst_id = $1", [
        ctx.workstreamId,
        event.payload.sessionId
      ]);
      return;
    case "direction.applied": {
      // Only a direction that belongs to this workstream can be marked applied
      // by this runner; a credential is scoped to one lane.
      const owns = await client.query("select 1 from directions where dir_id = $1 and wst_id = $2", [
        event.payload.directionId,
        ctx.workstreamId
      ]);
      if (owns.rowCount === 0) return;
      await markDirectionApplied(client, {
        orgId: ctx.orgId,
        missionId: ctx.missionId,
        workstreamId: ctx.workstreamId,
        directionId: event.payload.directionId,
        executionId: execution.exe_id
      });
      return;
    }
    case "boundary.reached":
      await completeTransferAtBoundary(client, {
        orgId: ctx.orgId,
        missionId: ctx.missionId,
        workstreamId: ctx.workstreamId
      });
      return;
    case "workspace.checkpoint":
      await recordCheckpoint(client, ctx, execution, event.payload);
      return;
    case "verification.observed":
      await client.query(
        `insert into verification_checks (chk_id, org_id, mission_id, exe_id, name, category, outcome,
                                          command, output, truncated, environment, runner_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          newCheckId(),
          ctx.orgId,
          ctx.missionId,
          execution.exe_id,
          event.payload.name,
          event.payload.category,
          event.payload.outcome,
          event.payload.command,
          event.payload.output,
          event.payload.truncated,
          environmentOf(ctx),
          ctx.runnerId
        ]
      );
      return;
    case "execution.completed":
      await setExecutionState(client, execution.exe_id, "completed", {
        ended: true,
        exitOutcome: "completed"
      });
      return;
    case "execution.stopped":
      await setExecutionState(client, execution.exe_id, "stopped", {
        ended: true,
        exitOutcome: "stopped",
        failureReason: event.payload.reason
      });
      return;
    case "execution.failed":
      await setExecutionState(client, execution.exe_id, "failed", {
        ended: true,
        exitOutcome: event.payload.classification,
        failureReason: event.payload.reason
      });
      return;
    case "execution.interrupted":
      await setExecutionState(client, execution.exe_id, "interrupted", {
        ended: true,
        exitOutcome: "interrupted",
        failureReason: event.payload.reason
      });
      return;
    case "harness.text":
    case "harness.tool":
    case "runner.gap":
      // Recorded and nothing else: a gap is stated honestly in the log rather
      // than repaired (ARCHITECTURE.md#failure-handling, case 6).
      return;
  }
}

async function ingest(
  db: Db,
  ctx: RunnerContext,
  /** Null for a workspace-scoped report, which belongs to the machine rather
   *  than to a turn. De-duplication still holds: the unique index is keyed on
   *  coalesce(execution, workstream), so such a batch dedupes against the
   *  workstream's own sequence instead of an execution's. */
  execution: ExecutionRow | null,
  reported: SequencedRunnerEvent[]
): Promise<{ accepted: number; duplicates: number }> {
  // Ascending origin sequence, whatever order the delivery arrived in: a
  // retried batch after a partition must land in the order the runner observed.
  const ordered = [...reported].sort((left, right) => left.originSeq - right.originSeq);
  const highest = ordered[ordered.length - 1]?.originSeq ?? 0;

  return withTransaction(db, async (client) => {
    let accepted = 0;
    let duplicates = 0;
    for (const item of ordered) {
      const cause =
        item.event.kind === "direction.applied"
          ? item.event.payload.directionId
          : execution?.starting_direction_id ?? null;
      const actor = attribute(item.event, ctx);
      const seq = await nextSeq(client, ctx.missionId);
      const eventId = await recordEventAtSeq(
        client,
        {
          orgId: ctx.orgId,
          missionId: ctx.missionId,
          workstreamId: ctx.workstreamId,
          executionId: execution?.exe_id ?? null,
          kind: item.event.kind,
          actorKind: actor.kind,
          actorId: actor.id,
          causeDirectionId: cause,
          originSeq: item.originSeq,
          payload: eventPayload(item.event)
        },
        seq
      );
      // An empty id means the (execution, originSeq) row already existed: the
      // replay is dropped along with everything it would have done twice.
      if (eventId === "") {
        duplicates += 1;
        continue;
      }
      accepted += 1;
      await applySideEffects(client, ctx, execution, item.event);
    }
    // Only an execution-scoped report advances an execution's cursor. A
    // workspace report counts on the workstream's own sequence, and writing it
    // here would corrupt the resume point of whatever turn ran last.
    if (execution) {
      await client.query(
        "update executions set last_origin_seq = greatest(last_origin_seq, $2) where exe_id = $1",
        [execution.exe_id, highest]
      );
    }
    return { accepted, duplicates };
  });
}

// --- Routes -----------------------------------------------------------------

export function registerRunnerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const requireRunner = runnerAuthenticator(deps);

  app.post("/workstreams/:workstreamId/runner", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = WorkstreamParamsSchema.safeParse(request.params);
    const body = RegisterRunnerInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed runner registration.");
    }
    if (body.data.workstreamId !== params.data.workstreamId) {
      return deps.sendError(reply, 400, "bad_request", "Malformed runner registration.");
    }
    // Enrolling a machine is not a privileged act — running a command on it is,
    // and every command path checks the capability separately. What enrolment
    // requires is that the caller actually participates in this mission.
    const access = await workstreamAccess(deps.db, ctx, params.data.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such workstream in your organization.");

    // A label reaches the room and the evidence ledger as the environment a
    // claim came from; a path there would leak the machine's filesystem.
    const label = body.data.label.trim();
    if (label.includes("/") || label.includes("\\")) {
      return deps.sendError(reply, 422, "invalid_label", "A runner label can't be a filesystem path.");
    }

    // No provider gate. A local repository is already on the machine that
    // registered it; a GitHub repository is fetched by the runner itself with a
    // repository-scoped credential (/runner/clone-credential), after which it
    // is the same worktree, the same runner, and the same workspace runtime.
    // This is still the local runner — cloud runners remain unbuilt.
    const credential = newSecretToken();
    const runnerId = newRunnerId();
    const registration = await withTransaction(deps.db, async (client) => {
      // Enrolling a machine is not privileged; *displacing someone else's* is.
      // Without this, an invited Contributor could revoke the host's runner and
      // enrol a machine with no checkout, killing the workstream — a denial of
      // service by an invited party, in the part of the product whose whole
      // claim is that authority is explicit.
      const held = await client.query(
        `select r.runner_id, r.owner_user_id, u.login
           from runners r join users u on u.user_id = r.owner_user_id
          where r.wst_id = $1 and r.revoked_at is null
          for update of r`,
        [params.data.workstreamId]
      );
      const current = held.rows[0];
      const displacing = current !== undefined && current.owner_user_id !== ctx.userId;
      if (displacing && !access.capabilities.includes("execution.start")) {
        return { taken: current.login as string };
      }

      // One live runner per workstream: the previous enrolment is revoked in
      // the same transaction that replaces it, so the partial unique index
      // never sees two. Replacing your own is a relaunch or a rotation.
      await client.query(
        "update runners set revoked_at = now() where wst_id = $1 and revoked_at is null",
        [params.data.workstreamId]
      );
      const inserted = await client.query(
        `insert into runners (runner_id, org_id, mission_id, wst_id, owner_user_id, kind, label,
                              credential_hash, expires_at)
         values ($1, $2, $3, $4, $5, 'local', $6, $7, now() + $8::interval)
         returning expires_at`,
        [
          runnerId,
          access.orgId,
          access.missionId,
          params.data.workstreamId,
          ctx.userId,
          label,
          hashCredential(credential),
          CREDENTIAL_TTL
        ]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: params.data.workstreamId,
        kind: "runner.registered",
        actorKind: "system",
        actorId: "control-plane",
        // A takeover is named in the log; nobody's machine disappears silently.
        payload: {
          runnerId,
          label,
          ownerLogin: ctx.login,
          replacedLogin: displacing ? (current.login as string) : null
        }
      });
      return { expiresAt: inserted.rows[0].expires_at as Date };
    });

    if ("taken" in registration) {
      return deps.sendError(
        reply,
        409,
        "runner_held",
        `${registration.taken}'s machine is already the runner for this workstream.`
      );
    }
    // A workstream's first direction is submitted before its host has finished
    // enrolling, so it was deferred with a reason. Now there is somewhere to
    // send it; without this the room would sit on "queued" forever waiting for
    // nobody.
    try {
      await dispatchQueuedForController({ db: deps.db }, params.data.workstreamId);
    } catch (error) {
      request.log?.error?.(error);
    }

    // The only time the usable credential exists outside the desktop's memory.
    return { runnerId, credential, expiresAt: registration.expiresAt.toISOString() };
  });

  app.get("/runner/commands", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;

    const commands = await withTransaction(deps.db, async (client) => {
      // Acknowledged commands are re-offered, not forgotten. A runner that
      // crashed after claiming one would otherwise leave its execution
      // non-terminal forever, with nothing able to finish or fail it; the
      // runner's own record of what it has already done makes the replay a
      // no-op. Only settled commands (completed, failed) stop being offered.
      const result = await client.query(
        `select cmd_id, kind, wst_id, mission_id, exe_id, seq, payload, created_at, state
           from runner_commands
          where runner_id = $1 and state in ('pending', 'delivered', 'acknowledged')
          order by seq`,
        [ctx.runnerId]
      );
      const pending = result.rows
        .filter((row) => row.state === "pending")
        .map((row) => row.cmd_id as string);
      if (pending.length > 0) {
        await client.query(
          "update runner_commands set state = 'delivered', delivered_at = now() where cmd_id = any($1::text[])",
          [pending]
        );
      }
      return result.rows.map(
        (row): RunnerCommand => ({
          commandId: row.cmd_id as string,
          kind: row.kind as RunnerCommand["kind"],
          workstreamId: row.wst_id as string,
          missionId: row.mission_id as string,
          executionId: (row.exe_id as string | null) ?? null,
          seq: Number(row.seq),
          payload: row.payload as Record<string, unknown>,
          createdAt: (row.created_at as Date).toISOString()
        })
      );
    });

    return {
      commands,
      workstream: {
        workstreamId: ctx.workstreamId,
        missionId: ctx.missionId,
        missionBranch: ctx.missionBranch,
        baseSha: ctx.baseSha,
        provider: ctx.provider,
        providerRepoId: ctx.providerRepoId,
        harnessSessionId: ctx.harnessSessionId
      }
    };
  });

  app.post("/runner/commands/:commandId", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;
    const params = CommandParamsSchema.safeParse(request.params);
    const body = AckCommandInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed acknowledgement.");
    }

    const known = await withTransaction(deps.db, async (client) => {
      // Scoped to the acknowledging runner: another machine's command is not
      // merely forbidden, it does not exist.
      const found = await client.query(
        "select cmd_id, state from runner_commands where cmd_id = $1 and runner_id = $2 for update",
        [params.data.commandId, ctx.runnerId]
      );
      const row = found.rows[0];
      if (!row) return false;
      // Replay after a relaunch: a settled command stays settled.
      if (row.state === "completed" || row.state === "failed") return true;

      const state = body.data.state;
      await client.query(
        `update runner_commands
            set state = $2,
                acknowledged_at = case when $2 = 'acknowledged' then now() else acknowledged_at end,
                completed_at = case when $2 in ('completed', 'failed') then now() else completed_at end,
                failure_reason = coalesce($3, failure_reason),
                exe_id = coalesce(exe_id, $4)
          where cmd_id = $1`,
        [
          params.data.commandId,
          state,
          body.data.failureReason ?? null,
          body.data.executionId ?? null
        ]
      );
      return true;
    });
    if (!known) return deps.sendError(reply, 404, "not_found", "No such command for this runner.");
    return { ok: true };
  });

  app.post("/runner/events", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;
    const body = ReportRunnerEventsInputSchema.safeParse(request.body);
    if (!body.success) return deps.sendError(reply, 422, "invalid_events", "Malformed runner report.");

    // A workspace-scoped report names no execution: a setup or run command is
    // not part of any turn, and can happen before a turn has ever existed.
    // There is nothing to resolve and nothing to refuse. When an execution
    // *is* named it must still be one of this runner's — a credential is
    // scoped to a single lane, and that is not a check to lose here.
    let execution: ExecutionRow | null = null;
    if (body.data.executionId !== null) {
      const found = await deps.db.query(
        "select exe_id, wst_id, state, starting_direction_id from executions where exe_id = $1 and wst_id = $2",
        [body.data.executionId, ctx.workstreamId]
      );
      execution = (found.rows[0] as ExecutionRow | undefined) ?? null;
      if (!execution) return deps.sendError(reply, 404, "not_found", "No such execution on this runner.");
    }

    const { accepted, duplicates } = await ingest(deps.db, ctx, execution, body.data.events);
    return { ok: true, accepted, duplicates };
  });

  app.post("/runner/heartbeat", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;
    return { ok: true };
  });

  /**
   * The credential a runner uses to fetch its GitHub repository onto the
   * machine it runs on (ARCHITECTURE.md#secret-placement: repository access is
   * "issued per workspace, held by the runner supervisor").
   *
   * Only over the runner credential — a user session authenticates as a person
   * and gets 401 here — and only for the workstream that credential is scoped
   * to, which the runner does not get to name. Nothing durable records what is
   * returned: no row, no event, no log line.
   */
  app.post("/runner/clone-credential", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;
    const body = CloneCredentialRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed clone-credential request.");
    }
    // A runner that believes it is somewhere else is refused, not corrected.
    if (body.data.workstreamId !== undefined && body.data.workstreamId !== ctx.workstreamId) {
      return deps.sendError(reply, 404, "not_found", "No such workstream for this runner.");
    }
    try {
      return await issueCloneCredential(deps.db, deps.provider, {
        orgId: ctx.orgId,
        workstreamId: ctx.workstreamId
      });
    } catch (error) {
      if (error instanceof CloneCredentialError) {
        return deps.sendError(reply, error.status, error.code, error.message);
      }
      throw error;
    }
  });
}
