import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { LearningExportInputSchema, type LearningManifest } from "@novus/contracts";
import type { RouteDeps } from "../routes.ts";
import { withTransaction } from "../db.ts";
import { exportMission, writeDataset, type Pair, type Trajectory } from "./export.ts";

/**
 * The export route (D-255): the organization owner's act, and nobody else's.
 * A member is refused 403 by name; a stranger finds nothing (404), because
 * an organization id is not a capability. Datasets land under the configured
 * learning directory, one directory per dataset id, and the manifest is the
 * answer — the shards are read by the trainer from disk, never served.
 */
export function registerLearningRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/orgs/:orgId/learning/exports", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const orgId = (request.params as { orgId: string }).orgId;
    const parsed = LearningExportInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return deps.sendError(reply, 422, "invalid_input", "Malformed export request.");
    const membership = await deps.db.query("select org_role from organization_members where org_id = $1 and user_id = $2", [orgId, ctx.userId]);
    const role = (membership.rows[0] as { org_role?: string } | undefined)?.org_role;
    if (!role) return deps.sendError(reply, 404, "not_found", "No such organization for you.");
    if (role !== "owner") {
      return deps.sendError(reply, 403, "forbidden", "Exporting the record for learning is the organization owner's; ask them.");
    }
    const datasetId = `ds_${randomBytes(8).toString("hex")}`;
    const root = join(deps.config.learningDir, datasetId);
    const manifest: LearningManifest = await withTransaction(deps.db, async (client) => {
      const missions = (
        await client.query(
          parsed.data.until
            ? "select mission_id from missions where org_id = $1 and created_at <= $2 order by created_at"
            : "select mission_id from missions where org_id = $1 order by created_at",
          parsed.data.until ? [orgId, parsed.data.until] : [orgId]
        )
      ).rows as { mission_id: string }[];
      const trajectories: Trajectory[] = [];
      const pairs: Pair[] = [];
      let fromEvent: string | null = null;
      let toEvent: string | null = null;
      for (const mission of missions) {
        const part = await exportMission(client, orgId, mission.mission_id);
        trajectories.push(...part.trajectories);
        pairs.push(...part.pairs);
        if (part.lastEventId) {
          fromEvent ??= part.lastEventId;
          toEvent = part.lastEventId;
        }
      }
      mkdirSync(root, { recursive: true });
      return writeDataset(root, {
        datasetId,
        orgId,
        writtenAt: new Date().toISOString(),
        missions: missions.length,
        trajectories,
        pairs,
        fromEvent,
        toEvent
      });
    });
    return reply.status(201).send({ manifest, path: root });
  });
}
