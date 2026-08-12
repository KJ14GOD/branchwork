import { ADMIN_ONLY_PERMISSION_PROFILES, PermissionProfileSchema } from "@novus/contracts";
import { z } from "zod";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";

/**
 * OWNER of POST /missions/:missionId/workstreams/:workstreamId/policy (D-115).
 *
 * A lane's permission profile is Novus's own standing answer policy for the
 * harness's permission questions. Setting it is a **policy act, not an
 * operating one** — it decides what gets asked, where the baton decides who
 * answers — so it is `policy.set`, held by Mission Admin and Operator and
 * never granted by the lease (the approach.create reasoning). One tier
 * further: `dont_ask` hands the policy a person's whole answer, shell
 * commands included, and is Mission Admin's alone — refused in words for an
 * Operator, with the tier list read from the contracts package so the route
 * and the renderer cannot disagree.
 *
 * The change is event-recorded with the exact warning sentence the person
 * acknowledged (the D-100 acceptedBlockers pattern), and applies from the
 * next dispatched turn: a running turn keeps the profile pinned at its own
 * dispatch, exactly as a scope edit mid-turn changes the next turn (D-097,
 * D-043's pattern). No profile touches server authorization — this route
 * changes one column the dispatcher pins, and every capability check
 * everywhere else is untouched by it.
 */
export function registerPolicyRoutes(
  app: import("fastify").FastifyInstance,
  deps: import("./routes.ts").RouteDeps
): void {
  app.post("/missions/:missionId/workstreams/:workstreamId/policy", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = z
      .object({
        missionId: z.string().startsWith("msn_"),
        workstreamId: z.string().startsWith("wst_")
      })
      .safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed id.");
    const body = z
      .object({
        profile: PermissionProfileSchema,
        /** The warning sentence the person confirmed, for profiles that warn.
         *  Bounded like a denial reason; recorded verbatim on the event. */
        acknowledged: z.string().trim().max(500).nullable().default(null)
      })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_profile",
        "That is not a permission profile Novus offers. There is deliberately no bypass: the harness always asks, and a profile only changes who answers."
      );
    }

    // Resolved against the named lane (ARCHITECTURE.md#authorization): a lane
    // that is not this mission's is "no such mission", never the default
    // lane's authority under the wrong name.
    const access = await missionAccess(deps.db, ctx, params.data.missionId, params.data.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "policy.set");
    if (ADMIN_ONLY_PERMISSION_PROFILES.includes(body.data.profile) && access.role !== "mission_admin") {
      return deps.sendError(
        reply,
        403,
        "admin_only_profile",
        "Only a Mission Admin can set Don't ask — it answers every question, shell commands included."
      );
    }
    // A dangerous profile is set with its warning in hand: the route refuses
    // the change until the exact sentence the person confirmed travels with
    // it, and records that sentence — what was accepted, verbatim (D-100).
    if (
      ADMIN_ONLY_PERMISSION_PROFILES.includes(body.data.profile) &&
      (body.data.acknowledged === null || body.data.acknowledged.length === 0)
    ) {
      return deps.sendError(
        reply,
        409,
        "unacknowledged",
        "Setting Don't ask requires confirming what it means; nothing was acknowledged."
      );
    }

    await withTransaction(deps.db, async (client) => {
      const current = await client.query(
        "select permission_profile from workstreams where wst_id = $1 for update",
        [params.data.workstreamId]
      );
      const from = current.rows[0]?.permission_profile as string | undefined;
      // Same word twice is not a change: nothing moves and nothing is
      // recorded, so a double-click cannot write a second event.
      if (from === body.data.profile) return;
      await client.query("update workstreams set permission_profile = $2 where wst_id = $1", [
        params.data.workstreamId,
        body.data.profile
      ]);
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: params.data.workstreamId,
        kind: "policy.changed",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: {
          workstreamId: params.data.workstreamId,
          from: from ?? null,
          to: body.data.profile,
          acknowledged: body.data.acknowledged
        }
      });
    });
    return { ok: true };
  });
}
