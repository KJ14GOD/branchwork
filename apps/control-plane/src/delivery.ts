import { createHash } from "node:crypto";
import { z } from "zod";
import { DeliveryResponseSchema, WorkflowDetailSchema, DeploymentReviewInputSchema, PullReviewInputSchema } from "@novus/contracts";
import type { RouteModule } from "./routes.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { loadPullContext } from "./publication.ts";
import { repoActorOf } from "./auth.ts";
import { withMission } from "./db.ts";
import { recordEvent } from "./events.ts";
import { MergeRefusedError, ProviderTransientError, RepoTokenMissingError } from "./repo-provider.ts";

const Params = z.object({ pullRequestId: z.string().startsWith("pr_") });
/** D-247: scoped GitHub reads and explicit, durably attributed reviews.
 * An uncertain remote outcome is never retried automatically. */
export const registerDeliveryRoutes: RouteModule = (app, deps) => {
  for (const action of ["delivery", "workflow", "review-deployment", "submit-review"] as const) {
    const write = action === "review-deployment" || action === "submit-review";
    app.route({ method: write ? "POST" : "GET", url: `/pull-requests/:pullRequestId/${action}`, handler: async (request, reply) => {
      const ctx = await deps.requireAuth(request, reply);
      if (!ctx) return;
      const params = Params.safeParse(request.params);
      if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
      const pull = await loadPullContext(deps.db, params.data.pullRequestId);
      if (!pull) return deps.sendError(reply, 404, "not_found", "No such pull request.");
      const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
      if (!access) return deps.sendError(reply, 404, "not_found", "No such pull request.");
      requireCapability(access, write ? "pr.manage" : "mission.view");
      if (write && action === "review-deployment" && pull.downstream) return deps.sendError(reply, 409, "downstream", "Review this downstream deployment on GitHub.");
      const actor = await repoActorOf(deps.db, ctx.userId);
      let operationId: string | null = null;
      try {
        if (action === "delivery") return DeliveryResponseSchema.parse(await deps.provider.delivery(actor, pull.providerRepoId, pull.number));
        if (action === "workflow") {
          const query = z.object({ runId: z.coerce.number().int().positive().safe() }).safeParse(request.query);
          if (!query.success) return deps.sendError(reply, 422, "invalid_run", "Malformed workflow run id.");
          return WorkflowDetailSchema.parse(await deps.provider.workflow(actor, pull.providerRepoId, pull.number, query.data.runId));
        }
        const body = (action === "review-deployment" ? DeploymentReviewInputSchema : PullReviewInputSchema).safeParse({
          ...(request.body as object), pullRequestId: pull.pullRequestId
        });
        if (!body.success) return deps.sendError(reply, 422, "invalid_review", "A review needs its exact revision, decision, comment, and request id.");
        const input = body.data;
        const digest = createHash("sha256").update(JSON.stringify({ action, userId: ctx.userId, input })).digest("hex");
        const reservation = await withMission(deps.db, pull.missionId, async client => {
          const current = await missionAccess(client, ctx, pull.missionId, pull.workstreamId);
          if (!current) return "denied";
          requireCapability(current, "pr.manage");
          const expired = await client.query("update delivery_operations set status = 'unknown' where pr_id = $1 and status = 'pending' and started_at < now() - interval '2 minutes' returning request_id", [pull.pullRequestId]);
          for (const row of expired.rows) await recordEvent(client, { orgId: pull.orgId, missionId: pull.missionId, workstreamId: pull.workstreamId,
            kind: "delivery.review_result", actorKind: "system", actorId: "delivery-recovery", payload: { pullRequestId: pull.pullRequestId, requestId: row.request_id, status: "unknown", reason: "The reserved review did not report an outcome within two minutes." } });
          const old = await client.query("select digest, status from delivery_operations where pr_id = $1 and request_id = $2", [pull.pullRequestId, input.requestId]);
          if (old.rows[0]) return old.rows[0].digest === digest ? String(old.rows[0].status) : "conflict";
          const busy = await client.query("select 1 from delivery_operations where pr_id = $1 and status = 'pending'", [pull.pullRequestId]);
          if (busy.rowCount) return "pending";
          await client.query("insert into delivery_operations (pr_id, request_id, digest, status) values ($1, $2, $3, 'pending')", [pull.pullRequestId, input.requestId, digest]);
          await recordEvent(client, { orgId: pull.orgId, missionId: pull.missionId, workstreamId: pull.workstreamId,
            kind: "delivery.review_requested", actorKind: "user", actorId: ctx.userId, actorLogin: ctx.login,
            payload: { action, ...input } });
          return "reserved";
        });
        if (reservation === "succeeded") return { ok: true };
        if (reservation !== "reserved") return deps.sendError(reply, 409, "review_not_repeated", "This review is already pending, was refused, or has an uncertain outcome. Check GitHub before making a new request.");
        operationId = input.requestId;
        if (action === "review-deployment") await deps.provider.reviewDeployment(actor, pull.providerRepoId, pull.number, DeploymentReviewInputSchema.parse(input));
        else await deps.provider.submitReview(actor, pull.providerRepoId, pull.number, PullReviewInputSchema.parse(input));
        await settle("succeeded");
        return { ok: true };
      } catch (error) {
        const refused = error instanceof MergeRefusedError || error instanceof RepoTokenMissingError;
        if (operationId) await settle(refused ? "refused" : "unknown").catch(() => undefined);
        if (operationId && !refused) return deps.sendError(reply, 502, "review_outcome_unknown", "GitHub's review outcome could not be confirmed. Check GitHub before submitting another review.");
        if (refused) return deps.sendError(reply, 409, "host_refuses", error.message);
        if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
        return deps.sendError(reply, 502, "delivery_unavailable", "GitHub Actions could not be read. Refresh or open GitHub to check its current state.");
      }
      async function settle(status: string) {
        await withMission(deps.db, pull!.missionId, async client => {
          await client.query("update delivery_operations set status = $3 where pr_id = $1 and request_id = $2", [pull!.pullRequestId, operationId, status]);
          await recordEvent(client, { orgId: pull!.orgId, missionId: pull!.missionId, workstreamId: pull!.workstreamId,
            kind: "delivery.review_result", actorKind: "user", actorId: ctx!.userId, actorLogin: ctx!.login,
            payload: { pullRequestId: pull!.pullRequestId, requestId: operationId, action, status } });
        });
      }
    }});
  }
};
