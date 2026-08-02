import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
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
import { nextSeq, recordEvent, recordEventAtSeq } from "./events.ts";
import { newCheckId, newCheckpointId, newFileChangeId, newRunnerId, newSecretToken } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: the runner plane's control-plane half (D-035). Paths owned here:
 *
 *   POST   /workstreams/:workstreamId/runner            (user session: register, returns the credential once)
 *   GET    /runner/commands                             (runner credential)
 *   POST   /runner/commands/:commandId                  (runner credential: ack | complete | fail)
 *   POST   /runner/events                               (runner credential: sequenced, deduped)
 *   POST   /runner/heartbeat                            (runner credential)
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

/** The durable consequence of one reported event, applied after it was
 *  recorded and only when it was not a de-duplicated replay. */
async function applySideEffects(
  client: pg.PoolClient,
  ctx: RunnerContext,
  execution: ExecutionRow,
  event: RunnerEvent
): Promise<void> {
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
      // the same conversation rather than starting cold (D-038).
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
  execution: ExecutionRow,
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
          : execution.starting_direction_id;
      const actor = attribute(item.event, ctx);
      const seq = await nextSeq(client, ctx.missionId);
      const eventId = await recordEventAtSeq(
        client,
        {
          orgId: ctx.orgId,
          missionId: ctx.missionId,
          workstreamId: ctx.workstreamId,
          executionId: execution.exe_id,
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
    await client.query(
      "update executions set last_origin_seq = greatest(last_origin_seq, $2) where exe_id = $1",
      [execution.exe_id, highest]
    );
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

    const repository = await deps.db.query(
      `select repo.provider from workstreams w
         join repositories repo on repo.repo_id = w.repo_id
        where w.wst_id = $1`,
      [params.data.workstreamId]
    );
    if (repository.rows[0]?.provider !== "local") {
      return deps.sendError(
        reply,
        409,
        "runner_not_local",
        "Only a local repository runs on this machine; cloud runners aren't built yet."
      );
    }

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

    const execution = await deps.db.query(
      "select exe_id, wst_id, state, starting_direction_id from executions where exe_id = $1 and wst_id = $2",
      [body.data.executionId, ctx.workstreamId]
    );
    const row = execution.rows[0] as ExecutionRow | undefined;
    if (!row) return deps.sendError(reply, 404, "not_found", "No such execution on this runner.");

    const { accepted, duplicates } = await ingest(deps.db, ctx, row, body.data.events);
    return { ok: true, accepted, duplicates };
  });

  app.post("/runner/heartbeat", async (request, reply) => {
    const ctx = await requireRunner(request, reply);
    if (!ctx) return;
    return { ok: true };
  });
}
