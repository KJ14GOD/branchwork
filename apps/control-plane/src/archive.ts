import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { ExecutionStateSchema, TERMINAL_EXECUTION_STATES } from "@novus/contracts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * Filing a mission away, and taking it back out (D-063).
 *
 * Archival is not deletion and this module deliberately offers no deletion.
 * Nothing is destroyed: participants, directions, events, checkpoints, checks
 * and approval decisions all stay exactly where they were, the mission is
 * still reachable by anyone who could reach it before, and it can be restored.
 * What changes is one thing — it leaves the ordinary list.
 *
 * Two guards, both about the same idea: an archived mission must not be one
 * that is still doing something. A running execution is stopped first, and a
 * waiting approval is answered or cancelled first, because a mission filed
 * away while a harness is mid-turn is a process nobody is watching.
 *
 * Repository branches and worktrees are untouched. The mission branch is the
 * record of the work; a filing decision in Novus does not reach into a git
 * repository, and this is the module that would have to, so it is stated here.
 */

/** Derived from the contract, exactly as the dispatcher derives it: a
 *  hand-maintained copy here had already drifted twice — it listed `paused`,
 *  which no execution can enter, and omitted `needs_direction`, which the
 *  schema allows — so archive's "is anything still running?" answer could
 *  disagree with the dispatcher's (found by the D-109 audit). */
const ACTIVE_STATES: string[] = ExecutionStateSchema.options.filter(
  (state) => !TERMINAL_EXECUTION_STATES.includes(state)
);

export function registerArchiveRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/archive", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const missionId = (request.params as { missionId?: string }).missionId ?? "";
    const access = await missionAccess(deps.db, ctx, missionId);
    // A mission id is never a capability: someone who cannot see it is told it
    // is not there, exactly as every other route answers.
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "mission.archive");

    const outcome = await withTransaction(deps.db, async (client: pg.PoolClient) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [missionId]);

      const already = await client.query(
        "select archived_at from missions where mission_id = $1",
        [missionId]
      );
      if (already.rows[0]?.archived_at) return "already" as const;

      // Still working. Two refusals, because they are two different things for
      // a person to go and do — and the waiting question is checked *first*,
      // even though such an execution is also "active", because "answer it" is
      // the useful instruction and "stop the execution" is not.
      const waiting = await client.query(
        "select 1 from approval_requests where mission_id = $1 and state = 'pending' limit 1",
        [missionId]
      );
      if ((waiting.rowCount ?? 0) > 0) return "waiting" as const;

      // An execution that no runner was ever told to start is not work. It
      // cannot begin and cannot end, and refusing to file the mission away
      // because of one means a mission can be wedged out of the product by a
      // row nobody can act on. Novus creates the execution and its command in
      // one transaction, so a live `requested` execution always has one — an
      // execution without a command is a dead attempt, and it is ended here
      // rather than left saying Starting for ever.
      const stillborn = await client.query(
        `select e.exe_id from executions e
           join workstreams w on w.wst_id = e.wst_id
          where w.mission_id = $1 and e.state = 'requested'
            and not exists (select 1 from runner_commands c where c.exe_id = e.exe_id)`,
        [missionId]
      );
      for (const row of stillborn.rows) {
        await client.query(
          `update executions
              set state = 'interrupted', ended_at = now(), exit_outcome = 'interrupted',
                  failure_reason = 'Never started: no command was ever issued for this attempt.'
            where exe_id = $1 and state = 'requested'`,
          [row.exe_id]
        );
        await recordEvent(client, {
          orgId: access.orgId,
          missionId,
          workstreamId: null,
          executionId: row.exe_id as string,
          actorKind: "user",
          actorId: ctx.userId,
          kind: "execution.interrupted",
          payload: { reason: "Never started: no command was ever issued for this attempt." }
        });
      }

      const running = await client.query(
        `select 1 from executions e join workstreams w on w.wst_id = e.wst_id
          where w.mission_id = $1 and e.state = any($2::text[]) limit 1`,
        [missionId, ACTIVE_STATES]
      );
      if ((running.rowCount ?? 0) > 0) return "running" as const;

      await client.query(
        "update missions set archived_at = now(), archived_by = $2 where mission_id = $1",
        [missionId, ctx.userId]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId,
        workstreamId: null,
        executionId: null,
        actorKind: "user",
        actorId: ctx.userId,
        kind: "mission.archived",
        payload: {}
      });
      return "archived" as const;
    });

    if (outcome === "running") {
      return deps.sendError(
        reply,
        409,
        "execution_active",
        "This mission is still working. Stop the execution before filing it away."
      );
    }
    if (outcome === "waiting") {
      return deps.sendError(
        reply,
        409,
        "approval_pending",
        "The harness is waiting for an answer. Answer it, or stop the execution, before filing this away."
      );
    }
    // Archiving an archived mission is what the caller asked for either way.
    return reply.send({ ok: true });
  });

  app.post("/missions/:missionId/restore", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const missionId = (request.params as { missionId?: string }).missionId ?? "";
    const access = await missionAccess(deps.db, ctx, missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "mission.archive");

    await withTransaction(deps.db, async (client: pg.PoolClient) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [missionId]);
      const restored = await client.query(
        `update missions set archived_at = null, archived_by = null
          where mission_id = $1 and archived_at is not null returning mission_id`,
        [missionId]
      );
      if ((restored.rowCount ?? 0) === 0) return;
      await recordEvent(client, {
        orgId: access.orgId,
        missionId,
        workstreamId: null,
        executionId: null,
        actorKind: "user",
        actorId: ctx.userId,
        kind: "mission.restored",
        payload: {}
      });
    });

    return reply.send({ ok: true });
  });
}
