import type { FastifyInstance } from "fastify";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DirectionInputSchema,
  DirectionResolutionSchema,
  ExecutionStateSchema,
  TERMINAL_EXECUTION_STATES,
  type FileDiffResponse
} from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { settlePendingApprovals } from "./approvals.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { MissionAccess } from "./authz.ts";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { cancelDirection, resolveDirection, submitDirection } from "./directions.ts";
import { recordEvent } from "./events.ts";
import { newCommandId, newExecutionId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: durable executions and the dispatch of authorized direction to the
 * host runner. Paths owned by this module:
 *
 *   POST   /missions/:missionId/direction              (submit; dispatches when the author controls)
 *   POST   /directions/:directionId/resolve            (controller: apply | reject | supersede)
 *   POST   /directions/:directionId/cancel             (author)
 *   POST   /missions/:missionId/execution/stop
 *   GET    /file-changes/:changeId                     (diff body, fetched on demand)
 *
 * No other module registers a path under /directions, /file-changes, or
 * /missions/:id/execution.
 */

/** Derived from the contract so a new execution state can never be forgotten
 *  here: everything that is not terminal still occupies the workstream. */
const ACTIVE_EXECUTION_STATES: string[] = ExecutionStateSchema.options.filter(
  (state) => !TERMINAL_EXECUTION_STATES.includes(state)
);

/**
 * A runner unheard from for this long is treated as gone. It mirrors the
 * threshold the room already renders "runner offline" from
 * (mission-detail.ts), so what a participant sees and what stopping does
 * cannot disagree.
 */
const RUNNER_OFFLINE_AFTER_MS = 30_000;

/** Said in the log when the machine that was working never answered again. */
const RUNNER_GONE =
  "The runner stopped responding, so the execution ended without a reported outcome.";

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });
const DirectionParamsSchema = z.object({ directionId: z.string().startsWith("dir_") });
const ChangeParamsSchema = z.object({ changeId: z.string().startsWith("chg_") });

export interface DispatchResult {
  executionId: string | null;
  commandId: string | null;
  /** Why nothing was dispatched, when nothing was: no runner, already busy. */
  deferred: string | null;
}

export interface EnqueueArgs {
  orgId: string;
  missionId: string;
  workstreamId: string;
  executionId: string | null;
  runnerId: string;
  kind:
    | "start_execution"
    | "apply_direction"
    | "stop_execution"
    | "boundary_request"
    | "respond_approval";
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Durable transport, control plane → runner. The idempotency key is what makes
 * a retried dispatch after a partition apply once: the second insert loses to
 * the unique index and the caller gets the command that already exists.
 */
export async function enqueueCommand(client: pg.PoolClient, args: EnqueueArgs): Promise<string> {
  const commandId = newCommandId();
  const inserted = await client.query(
    `insert into runner_commands (cmd_id, org_id, mission_id, wst_id, exe_id, runner_id, kind,
                                  payload, idempotency_key, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     on conflict (wst_id, idempotency_key) do nothing
     returning cmd_id`,
    [
      commandId,
      args.orgId,
      args.missionId,
      args.workstreamId,
      args.executionId,
      args.runnerId,
      args.kind,
      JSON.stringify(args.payload),
      args.idempotencyKey
    ]
  );
  const fresh = inserted.rows[0]?.cmd_id as string | undefined;
  if (fresh) return fresh;
  const existing = await client.query(
    "select cmd_id from runner_commands where wst_id = $1 and idempotency_key = $2",
    [args.workstreamId, args.idempotencyKey]
  );
  return existing.rows[0].cmd_id as string;
}

async function activeExecution(client: pg.PoolClient, workstreamId: string): Promise<string | null> {
  const result = await client.query(
    "select exe_id from executions where wst_id = $1 and state = any($2::text[]) limit 1",
    [workstreamId, ACTIVE_EXECUTION_STATES]
  );
  return (result.rows[0]?.exe_id as string | undefined) ?? null;
}

/**
 * Dispatches whatever the controller already authorized but nothing could
 * carry yet. A workstream's very first direction is submitted before its host
 * has finished enrolling as the runner, so it is deferred with a reason and
 * would otherwise sit there: the room would say "queued" for work nobody was
 * waiting on. Enrolment calls this, and the controller's own oldest queued
 * direction goes out at once.
 *
 * Only the lease holder's own direction is dispatched. Someone else's still
 * waits for an explicit apply — a runner appearing is not authority.
 */
export async function dispatchQueuedForController(
  deps: { db: RouteDeps["db"] },
  workstreamId: string
): Promise<DispatchResult | null> {
  const pending = await deps.db.query(
    `select d.dir_id, d.mission_id, d.model, d.effort, u.user_id, u.login
       from directions d
       join control_leases l on l.wst_id = d.wst_id and l.state = 'held'
                            and l.holder_user_id = d.author_user_id
       join users u on u.user_id = d.author_user_id
      where d.wst_id = $1 and d.state = 'queued'
      order by d.ordinal limit 1`,
    [workstreamId]
  );
  const row = pending.rows[0];
  if (!row) return null;

  // The author's own standing decides this, not the enroller's: authority is
  // read from durable state at command time (ARCHITECTURE.md#authorization).
  const access = await missionAccess(deps.db, { userId: row.user_id as string }, row.mission_id as string);
  if (!access || !access.isController) return null;
  if (!access.capabilities.includes("execution.start")) return null;

  return dispatchDirection(
    deps,
    access,
    { userId: row.user_id as string, login: row.login as string },
    {
      directionId: row.dir_id as string,
      model: (row.model as string | null) ?? DEFAULT_MODEL,
      effort: (row.effort as string | null) ?? DEFAULT_EFFORT
    }
  );
}

/**
 * Sends an authorized direction toward the host runner: starts a new execution
 * when the workstream is idle, or applies it to the running one. Enqueues a
 * durable command; it never marks the direction Applied — only the runner's
 * acknowledgement does that.
 */
export async function dispatchDirection(
  deps: { db: RouteDeps["db"] },
  access: MissionAccess,
  actor: { userId: string; login: string },
  args: { directionId: string; model: string; effort: string }
): Promise<DispatchResult> {
  const workstreamId = access.workstreamId;
  if (!workstreamId) {
    return { executionId: null, commandId: null, deferred: "This mission has no workstream yet." };
  }

  return withTransaction(deps.db, async (client) => {
    // No runner means no execution. Inventing one would put the room in
    // "Agent starting" with nothing behind it.
    const runner = await client.query(
      `select runner_id from runners
        where wst_id = $1 and revoked_at is null and expires_at > now()
        order by created_at desc limit 1`,
      [workstreamId]
    );
    const runnerId = runner.rows[0]?.runner_id as string | undefined;
    if (!runnerId) {
      return {
        executionId: null,
        commandId: null,
        deferred: "No runner is registered for this workstream yet."
      };
    }

    const direction = await client.query(
      "select body from directions where dir_id = $1 and wst_id = $2",
      [args.directionId, workstreamId]
    );
    const body = direction.rows[0]?.body as string | undefined;
    if (body === undefined) {
      return { executionId: null, commandId: null, deferred: "That direction is no longer available." };
    }

    const base = {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      runnerId
    };
    const applyTo = async (executionId: string): Promise<DispatchResult> => ({
      executionId,
      commandId: await enqueueCommand(client, {
        ...base,
        executionId,
        kind: "apply_direction",
        payload: { directionId: args.directionId, body, model: args.model, effort: args.effort },
        idempotencyKey: `apply:${args.directionId}`
      }),
      deferred: null
    });

    const running = await activeExecution(client, workstreamId);
    if (running) return applyTo(running);

    const session = await client.query("select harness_session_id from workstreams where wst_id = $1", [
      workstreamId
    ]);
    const resumeSessionId = (session.rows[0]?.harness_session_id as string | null) ?? null;
    const executionId = newExecutionId();

    // The partial unique index is the concurrency guard, not a memory of what
    // this process already started. A second dispatch that loses the race
    // becomes an apply against the winner's execution.
    await client.query("savepoint start_execution");
    try {
      await client.query(
        `insert into executions (exe_id, org_id, mission_id, wst_id, harness, model, effort,
                                 runner_id, starting_direction_id, state, started_by)
         values ($1, $2, $3, $4, 'claude-code', $5, $6, $7, $8, 'requested', $9)`,
        [
          executionId,
          access.orgId,
          access.missionId,
          workstreamId,
          args.model,
          args.effort,
          runnerId,
          args.directionId,
          actor.userId
        ]
      );
      await client.query("release savepoint start_execution");
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      await client.query("rollback to savepoint start_execution");
      const winner = await activeExecution(client, workstreamId);
      if (!winner) throw error;
      return applyTo(winner);
    }

    const commandId = await enqueueCommand(client, {
      ...base,
      executionId,
      kind: "start_execution",
      payload: {
        directionId: args.directionId,
        body,
        model: args.model,
        effort: args.effort,
        resumeSessionId
      },
      idempotencyKey: `start:${args.directionId}`
    });
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      executionId,
      kind: "execution.requested",
      actorKind: "user",
      actorId: actor.userId,
      actorLogin: actor.login,
      causeDirectionId: args.directionId,
      causeLeaseId: access.leaseId,
      payload: { harness: "claude-code", model: args.model, effort: args.effort }
    });
    return { executionId, commandId, deferred: null };
  });
}

/** The harness settings this lane last ran with, so applying a queued
 *  direction does not silently switch model or effort behind the controller. */
async function lastHarnessSettings(db: Db, workstreamId: string): Promise<{ model: string; effort: string }> {
  const result = await db.query(
    "select model, effort from executions where wst_id = $1 order by created_at desc limit 1",
    [workstreamId]
  );
  const row = result.rows[0];
  return {
    model: (row?.model as string | undefined) ?? DEFAULT_MODEL,
    effort: (row?.effort as string | undefined) ?? DEFAULT_EFFORT
  };
}

/** The mission a direction belongs to, before any authorization is computed. */
async function missionOfDirection(db: Db, directionId: string): Promise<string | null> {
  const result = await db.query("select mission_id from directions where dir_id = $1", [directionId]);
  return (result.rows[0]?.mission_id as string | undefined) ?? null;
}

export function registerExecutionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/direction", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    const body = DirectionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const message = body.success ? "Malformed mission id." : body.error.issues[0]?.message ?? "Invalid direction.";
      return deps.sendError(reply, params.success ? 422 : 400, "invalid_direction", message);
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "direction.submit");

    const actor = { userId: ctx.userId, login: ctx.login };
    const submitted = await submitDirection(deps.db, access, actor, body.data.body, {
      model: body.data.model,
      effort: body.data.effort
    });
    // Only the controller's own direction proceeds toward the harness; anyone
    // else's waits, visibly, for whoever holds the baton.
    const dispatch = submitted.authorIsController
      ? await dispatchDirection(deps, access, actor, {
          directionId: submitted.direction.directionId,
          model: body.data.model,
          effort: body.data.effort
        })
      : null;

    return {
      direction: submitted.direction,
      dispatched: dispatch !== null && dispatch.commandId !== null,
      deferred: dispatch?.deferred ?? null
    };
  });

  app.post("/directions/:directionId/resolve", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = DirectionParamsSchema.safeParse(request.params);
    const body = DirectionResolutionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed resolution.");
    }
    const missionId = await missionOfDirection(deps.db, params.data.directionId);
    if (!missionId) return deps.sendError(reply, 404, "not_found", "No such direction.");
    const access = await missionAccess(deps.db, ctx, missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such direction.");
    requireCapability(access, "direction.apply");

    const actor = { userId: ctx.userId, login: ctx.login };
    const resolved = await resolveDirection(
      deps.db,
      access,
      actor,
      params.data.directionId,
      body.data.action,
      body.data.reason
    );
    if (!resolved) return deps.sendError(reply, 404, "not_found", "No such direction.");
    if (body.data.action === "apply" && access.workstreamId) {
      const settings = await lastHarnessSettings(deps.db, access.workstreamId);
      await dispatchDirection(deps, access, actor, {
        directionId: params.data.directionId,
        model: settings.model,
        effort: settings.effort
      });
    }
    return { ok: true };
  });

  app.post("/directions/:directionId/cancel", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = DirectionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed direction id.");
    const missionId = await missionOfDirection(deps.db, params.data.directionId);
    if (!missionId) return deps.sendError(reply, 404, "not_found", "No such direction.");
    const access = await missionAccess(deps.db, ctx, missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such direction.");
    // Participation is the gate here; authorship is enforced inside, because
    // "only the author may cancel" is a rule about the row, not about a role.
    requireCapability(access, "mission.view");
    const cancelled = await cancelDirection(deps.db, access, { userId: ctx.userId, login: ctx.login }, params.data.directionId);
    if (!cancelled) return deps.sendError(reply, 404, "not_found", "No such direction.");
    return { ok: true };
  });

  app.post("/missions/:missionId/execution/stop", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "execution.stop");
    const workstreamId = access.workstreamId;
    if (!workstreamId) return { ok: true };

    await withTransaction(deps.db, async (client) => {
      const running = await client.query(
        "select exe_id, runner_id from executions where wst_id = $1 and state = any($2::text[]) for update",
        [workstreamId, ACTIVE_EXECUTION_STATES]
      );
      const row = running.rows[0];
      // Nothing is running: stopping is already true, so say so by doing
      // nothing rather than recording a stop that never happened.
      if (!row) return;
      const executionId = row.exe_id as string;

      const runner = await client.query(
        `select runner_id, last_seen_at from runners
          where wst_id = $1 and revoked_at is null and expires_at > now()
          order by created_at desc limit 1`,
        [workstreamId]
      );
      const lastSeen = (runner.rows[0]?.last_seen_at as Date | null | undefined) ?? null;
      const online = lastSeen !== null && Date.now() - lastSeen.getTime() < RUNNER_OFFLINE_AFTER_MS;
      const runnerId = (runner.rows[0]?.runner_id as string | undefined) ?? (row.runner_id as string | null);

      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId,
        kind: "execution.stop_requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { runnerOnline: online }
      });

      // A Stop settles the questions the turn was blocked on, in the same
      // transaction that decides it. Waiting for the runner's terminal report
      // would leave the room saying *Needs approval* about a turn a participant
      // has already ended, and would let a decision made in that window be
      // enqueued toward a harness that is being interrupted (D-056).
      await settlePendingApprovals(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId,
        outcome: "cancelled",
        reason: "A participant stopped the execution before this was answered."
      });

      if (!online) {
        // Waiting for a machine that has gone would leave the workstream
        // blocked by the active-execution index with no way back. D-034's
        // honest reading: a lost host ends the execution as an explicit
        // interrupted outcome, never a silent stall.
        await client.query(
          `update executions
              set state = 'interrupted', ended_at = now(),
                  exit_outcome = 'interrupted', failure_reason = $2
            where exe_id = $1`,
          [executionId, RUNNER_GONE]
        );
        await recordEvent(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          executionId,
          kind: "execution.interrupted",
          actorKind: "system",
          actorId: "control-plane",
          payload: { reason: RUNNER_GONE }
        });
        return;
      }

      await client.query("update executions set state = 'stopping' where exe_id = $1", [executionId]);
      if (runnerId) {
        await enqueueCommand(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          executionId,
          runnerId,
          kind: "stop_execution",
          payload: { executionId },
          idempotencyKey: `stop:${executionId}`
        });
      }
    });
    return { ok: true };
  });

  app.get("/file-changes/:changeId", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = ChangeParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed change id.");
    const result = await deps.db.query(
      "select chg_id, mission_id, path, diff, is_binary, truncated from file_changes where chg_id = $1",
      [params.data.changeId]
    );
    const row = result.rows[0];
    if (!row) return deps.sendError(reply, 404, "not_found", "No such change.");
    // A change id is not a capability: the viewer must participate in the
    // mission the change belongs to.
    const access = await missionAccess(deps.db, ctx, row.mission_id as string);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such change.");

    const response: FileDiffResponse = {
      changeId: row.chg_id as string,
      path: row.path as string,
      diff: (row.diff as string | null) ?? null,
      binary: Boolean(row.is_binary),
      truncated: Boolean(row.truncated)
    };
    return response;
  });
}
