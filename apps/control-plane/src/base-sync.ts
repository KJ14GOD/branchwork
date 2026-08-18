import { z } from "zod";
import { SyncBaseRequestSchema } from "@novus/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./routes.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { withMission } from "./db.ts";
import { recordEvent } from "./events.ts";
import { ACTIVE_EXECUTION_STATES } from "./executions.ts";

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });

/**
 * Following a moved base (D-144): the record half of the act.
 *
 * The merges themselves happen where the worktrees live — the runner merges
 * the base branch's new tip into every lane, a merge and never a rebase, so
 * every checkpoint SHA the record already holds stays true. This route is the
 * control plane's part: verify the asker holds `base.sync`, verify the room
 * they acted from was not stale, verify no lane holds a live turn, and move
 * every lane's pin in one transaction — all lanes or none, because two
 * approaches are comparable only while they stand on the same base.
 */
export function registerBaseSyncRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/base-sync", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = SyncBaseRequestSchema.safeParse(request.body);
    if (!body.success) return deps.sendError(reply, 400, "bad_sync", "Malformed base-sync request.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId, null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "base.sync");

    const outcome = await withMission(deps.db, access.missionId, async (client) => {
      const lanes = await client.query(
        "select wst_id, base_ref, base_sha from workstreams where mission_id = $1 for update",
        [access.missionId]
      );
      const reported = new Map(body.data.lanes.map((lane) => [lane.workstreamId, lane.headSha]));
      // Every lane moves or none does: a report that skips a lane, or names
      // one this mission does not hold, is a client that saw a different
      // mission than the record holds.
      if (
        lanes.rows.length !== reported.size ||
        !lanes.rows.every((row) => reported.has(row.wst_id as string))
      ) {
        return { kind: "lanes_mismatch" as const };
      }
      if (!lanes.rows.every((row) => row.base_sha === body.data.expectedBaseSha)) {
        return { kind: "stale" as const };
      }
      const live = await client.query(
        `select 1 from executions
          where wst_id in (select wst_id from workstreams where mission_id = $1)
            and state = any($2::text[]) limit 1`,
        [access.missionId, ACTIVE_EXECUTION_STATES]
      );
      if ((live.rowCount ?? 0) > 0) {
        return { kind: "turn_running" as const };
      }
      await client.query("update workstreams set base_sha = $2 where mission_id = $1", [
        access.missionId,
        body.data.newBaseSha
      ]);
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        kind: "workspace.base_synced",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: {
          baseRef: lanes.rows[0]?.base_ref ?? null,
          fromSha: body.data.expectedBaseSha,
          toSha: body.data.newBaseSha,
          lanes: body.data.lanes
        }
      });
      return { kind: "synced" as const };
    });

    switch (outcome.kind) {
      case "lanes_mismatch":
        return deps.sendError(
          reply,
          409,
          "lanes_mismatch",
          "The lanes reported do not match this mission's lanes — reload and try again."
        );
      case "stale":
        return deps.sendError(
          reply,
          409,
          "stale_base",
          "The pinned base is not where this room last saw it — reload before syncing."
        );
      case "turn_running":
        return deps.sendError(
          reply,
          409,
          "turn_running",
          "A turn is running in this mission. Syncing waits until every lane is quiet."
        );
      case "synced":
        return reply.send({ baseSha: body.data.newBaseSha });
    }
  });
}
