import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  MergeInputSchema,
  PullCommentInputSchema,
  PullMetadataInputSchema,
  RequestReviewInputSchema
} from "@novus/contracts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { getMission } from "./missions.ts";
import {
  closePull,
  deleteBranch,
  editMetadata,
  loadPullContext,
  markReady,
  mergePull,
  openDraft,
  pullRequestById,
  requestPush,
  requestReviewers,
  resolveThread,
  sendComment,
  syncPullRow,
  adoptPullRequestsOnce,
  adoptDownstreamOnce,
  updateBranch,
  SYNC_SELECT,
  type PullContext,
  type Steward,
  type SyncRow
} from "./publication.ts";
import {
  FakeRepositoryProvider,
  MergeRefusedError,
  ProviderTransientError,
  RepoTokenMissingError,
  UnknownPullRequestError
} from "./repo-provider.ts";
import { repoActorOf } from "./auth.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * The publication surface's HTTP shell (D-099, D-100). This file parses,
 * authorizes, and maps outcomes to status codes; every domain operation —
 * SQL, provider calls, event recording, the gates themselves — lives in
 * publication.ts and returns a typed outcome this file translates. Routes
 * owned here:
 *
 *   POST /missions/:missionId/pull-request/push        (pr.manage)
 *   POST /missions/:missionId/pull-request             (pr.manage — open the draft)
 *   POST /pull-requests/:pullRequestId/{request-review, ready, merge,
 *        update-branch, close, delete-branch, comment, resolve-thread,
 *        metadata}                                     (pr.manage)
 *   GET  /pull-requests/:pullRequestId/files
 *   POST /webhooks/github                              (signature-verified)
 *
 * plus the fake host's own driver routes under NOVUS_FAKE_GITHUB. There is
 * deliberately no route the domain module does not have a verb for.
 */

// Test suites reach the sweep through this module's name; the machinery
// itself lives with the domain.
export { sweepPullRequestsOnce, startPullRequestSweep } from "./publication.ts";

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });
const PullParamsSchema = z.object({ pullRequestId: z.string().startsWith("pr_") });
const LaneBodySchema = z.object({ workstreamId: z.string().startsWith("wst_").optional() });

/**
 * The one translation of the provider's transport errors. Domain refusals are
 * outcomes; these are the host being somewhere else — unknown to it, or
 * unreachable — and every verb maps them identically.
 */
async function hostErrorReply(deps: RouteDeps, reply: FastifyReply, error: unknown): Promise<void> {
  if (error instanceof MergeRefusedError) {
    return deps.sendError(reply, 409, "host_refuses", error.message);
  }
  if (error instanceof UnknownPullRequestError) {
    return deps.sendError(reply, 404, "unknown_pull_request", error.message);
  }
  if (error instanceof RepoTokenMissingError) {
    return deps.sendError(reply, 403, "repo_token_missing", error.message);
  }
  if (error instanceof ProviderTransientError) {
    return deps.sendError(reply, 502, "provider_unavailable", error.message);
  }
  throw error;
}

interface StewardingContext {
  pull: PullContext;
  by: Steward;
}

/** The shared front half of every stewarding verb: resolve, authorize on
 *  pr.manage, and check the request is in a state the act makes sense for. */
async function stewardingAct(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  gate: { openOnly?: boolean; resolvedOnly?: boolean; reviewOnly?: boolean }
): Promise<StewardingContext | null> {
  const ctx = await deps.requireAuth(request, reply);
  if (!ctx) return null;
  const params = PullParamsSchema.safeParse(request.params);
  if (!params.success) {
    await deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    return null;
  }
  const pull = await loadPullContext(deps.db, params.data.pullRequestId);
  if (!pull) {
    await deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    return null;
  }
  const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
  if (!access) {
    await deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    return null;
  }
  requireCapability(access, "pr.manage");
  // A downstream request (D-209) is somebody else's process: the mission's
  // work is *in* it, but opening, readying, merging, closing, or deleting
  // it is the reviewer's call on the host, not this room's. Review acts —
  // a comment, resolving a thread — are exactly what the room is for and
  // pass. Enforced here, so hiding the buttons is not the enforcement.
  if (pull.downstream && !gate.reviewOnly) {
    await deps.sendError(
      reply,
      409,
      "downstream",
      "This request carries the mission's work onward; it is reviewed and merged where it was opened, not from here."
    );
    return null;
  }
  if (gate.openOnly && (pull.state === "merged" || pull.state === "closed")) {
    await deps.sendError(reply, 409, "resolved", "This pull request is already resolved on GitHub.");
    return null;
  }
  if (gate.resolvedOnly && pull.state !== "merged" && pull.state !== "closed") {
    await deps.sendError(
      reply,
      409,
      "still_open",
      "The branch is still an open pull request's; resolve the request before deleting it."
    );
    return null;
  }
  return { pull, by: { userId: ctx.userId, login: ctx.login, leaseId: access.leaseId } };
}

export function registerPullRequestRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/pull-request/push", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = LaneBodySchema.safeParse(request.body ?? {});
    if (!body.success) return deps.sendError(reply, 400, "bad_lane", "Malformed workstream id.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId ?? null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "pr.manage");
    const workstreamId = access.workstreamId;
    if (!workstreamId) return deps.sendError(reply, 409, "no_workstream", "This mission has no workstream yet.");

    const outcome = await requestPush(
      deps.db,
      { orgId: access.orgId, missionId: access.missionId, workstreamId },
      { userId: ctx.userId, login: ctx.login, leaseId: access.leaseId }
    );
    switch (outcome.kind) {
      case "no_workstream":
        return deps.sendError(reply, 409, "no_workstream", "This mission has no workstream yet.");
      case "not_publishable":
        return deps.sendError(
          reply,
          409,
          "not_publishable",
          "This repository is a folder on a machine rather than a host that could receive a push."
        );
      case "no_decision":
        return deps.sendError(reply, 409, "no_decision", "Record a decision first: publishing is what a decision becomes.");
      case "no_checkpoint":
        return deps.sendError(
          reply,
          409,
          "no_checkpoint",
          "The decision names no checkpoint, so there is no revision to push."
        );
      case "no_runner":
        return deps.sendError(
          reply,
          409,
          "no_runner",
          "No machine is running this workstream, so there's nothing to push from."
        );
      case "already_queued":
      case "enqueued":
        return reply.code(202).send({ ok: true });
    }
  });

  app.post("/missions/:missionId/pull-request", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = LaneBodySchema.safeParse(request.body ?? {});
    if (!body.success) return deps.sendError(reply, 400, "bad_lane", "Malformed workstream id.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId ?? null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "pr.manage");
    const workstreamId = access.workstreamId;
    if (!workstreamId) return deps.sendError(reply, 409, "no_workstream", "This mission has no workstream yet.");

    // One source of truth for what gets sent: the same projection the room
    // shows as "prepared" (D-075). What is snapshotted is exactly what was
    // read.
    const detail = await getMission(deps.db, ctx, params.data.missionId, body.data.workstreamId);
    if (!detail) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");

    let outcome;
    try {
      outcome = await openDraft(
        deps.db,
        deps.provider,
        { orgId: access.orgId, missionId: access.missionId, workstreamId },
        { userId: ctx.userId, login: ctx.login, leaseId: access.leaseId },
        {
          prepared: detail.preparedPullRequest,
          decision: detail.decisions.find((entry) => entry.supersededAt === null) ?? null,
          lane: detail.workstream
        }
      );
    } catch (error) {
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", `GitHub could not open the request: ${error.message}`);
      }
      throw error;
    }
    switch (outcome.kind) {
      case "no_decision":
        return deps.sendError(reply, 409, "no_decision", "Record a decision first: publishing is what a decision becomes.");
      case "not_publishable":
        return deps.sendError(
          reply,
          409,
          "not_publishable",
          "This repository is a folder on a machine rather than a host that could receive a pull request."
        );
      case "wrong_lane":
        return deps.sendError(
          reply,
          409,
          "wrong_lane",
          "The current decision chose a different approach; open the pull request from that lane."
        );
      case "no_checkpoint":
        return deps.sendError(reply, 409, "no_checkpoint", "The decision names no checkpoint, so there is nothing to publish.");
      case "branch_never_pushed":
        return deps.sendError(
          reply,
          409,
          "branch_not_pushed",
          "The branch has never been pushed to GitHub. Push it first, so the request serves the decided revision."
        );
      case "branch_stale":
        return deps.sendError(
          reply,
          409,
          "branch_not_pushed",
          "The branch on GitHub does not serve the decided revision. Push it first."
        );
      case "already_open":
        return deps.sendError(reply, 409, "already_open", `PR #${outcome.number} is already open for this approach.`);
      case "already_merged":
        return deps.sendError(
          reply,
          409,
          "already_merged",
          `This revision is already on the base branch — it merged as PR #${outcome.number}. There is nothing left to publish until the lane checkpoints again.`
        );
      case "host_already_open":
        return deps.sendError(reply, 409, "already_open", outcome.message);
      case "no_repository":
        return deps.sendError(reply, 409, "no_workstream", "This mission has no repository.");
      case "unknown_repository":
        return deps.sendError(reply, 404, "unknown_repository", outcome.message);
      case "opened":
        return reply.code(201).send({ pullRequest: outcome.pullRequest });
    }
  });

  app.post("/pull-requests/:pullRequestId/request-review", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const body = RequestReviewInputSchema.safeParse({
      ...(request.body as Record<string, unknown> | null),
      pullRequestId: params.data.pullRequestId
    });
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_reviewers", body.error.issues[0]?.message ?? "Name at least one reviewer.");
    }
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    try {
      await requestReviewers(deps.db, deps.provider, acted.pull, acted.by, body.data.reviewers);
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/ready", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    if (acted.pull.state !== "draft") {
      return deps.sendError(reply, 409, "not_a_draft", "Only a draft can be marked ready, and this one no longer is one.");
    }
    try {
      await markReady(deps.db, deps.provider, acted.pull, acted.by);
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  // --- Completion (D-100) ----------------------------------------------------
  // Explicit human acts GitHub performs underneath; the two-tier gate lives in
  // publication.ts and comes back as outcomes this switch says in words.

  app.post("/pull-requests/:pullRequestId/merge", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const body = MergeInputSchema.safeParse({
      ...(request.body as Record<string, unknown> | null),
      pullRequestId: params.data.pullRequestId
    });
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_merge", body.error.issues[0]?.message ?? "Malformed merge request.");
    }
    const acted = await stewardingAct(deps, request, reply, {});
    if (!acted) return;

    let outcome;
    try {
      outcome = await mergePull(deps.db, deps.provider, acted.pull, acted.by, {
        method: body.data.method,
        acknowledgeBlockers: body.data.acknowledgeBlockers ?? false
      });
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    switch (outcome.kind) {
      case "resolved":
        return deps.sendError(
          reply,
          409,
          "resolved",
          outcome.state === "merged" ? "This pull request is already merged." : "This pull request is closed."
        );
      case "still_a_draft":
        return deps.sendError(reply, 409, "still_a_draft", "A draft cannot be merged; mark it ready first.");
      case "method_not_allowed":
        return deps.sendError(
          reply,
          409,
          "method_not_allowed",
          `This repository does not allow ${body.data.method} merges; it allows ${outcome.allowed.join(", ")}.`
        );
      case "host_refuses":
        return deps.sendError(reply, 409, "host_refuses", outcome.reason);
      case "blockers_outstanding":
        return deps.sendError(
          reply,
          409,
          "blockers_outstanding",
          `Outstanding before this merges: ${outcome.blockers.join("; ")}. Confirm with the blockers acknowledged to proceed deliberately.`
        );
      case "merged":
        return reply.send({ sha: outcome.sha });
    }
  });

  app.post("/pull-requests/:pullRequestId/update-branch", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    try {
      await updateBranch(deps.db, deps.provider, acted.pull, acted.by);
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/close", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    try {
      await closePull(deps.db, deps.provider, acted.pull, acted.by);
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/delete-branch", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { resolvedOnly: true });
    if (!acted) return;
    const row = await pullRequestById(deps.db, acted.pull.pullRequestId);
    if (!row) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    try {
      await deleteBranch(deps.db, deps.provider, acted.pull, acted.by, row.headRef);
    } catch (error) {
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      // A ref already gone is the asked-for end state, said plainly.
      return deps.sendError(reply, 409, "branch_missing", "That branch no longer exists on the host.");
    }
    return reply.send({ ok: true });
  });

  // --- Operating review in-house (D-100) ------------------------------------

  app.get("/pull-requests/:pullRequestId/files", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const pull = await loadPullContext(deps.db, params.data.pullRequestId);
    if (!pull) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    try {
      return await deps.provider.listPullFiles(await repoActorOf(deps.db, ctx.userId), pull.providerRepoId, pull.number);
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
  });

  app.post("/pull-requests/:pullRequestId/comment", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const body = PullCommentInputSchema.safeParse({
      ...(request.body as Record<string, unknown> | null),
      pullRequestId: params.data.pullRequestId
    });
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_comment", body.error.issues[0]?.message ?? "Say something.");
    }
    const acted = await stewardingAct(deps, request, reply, { openOnly: true, reviewOnly: true });
    if (!acted) return;
    try {
      await sendComment(deps.db, deps.provider, acted.pull, acted.by, {
        body: body.data.body,
        ...(body.data.path !== undefined ? { path: body.data.path } : {}),
        ...(body.data.line !== undefined ? { line: body.data.line } : {})
      });
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/resolve-thread", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true, reviewOnly: true });
    if (!acted) return;
    const body = z.object({ threadId: z.string().min(1).max(200) }).safeParse(request.body);
    if (!body.success) return deps.sendError(reply, 400, "bad_thread", "Malformed thread id.");
    try {
      await resolveThread(deps.db, deps.provider, acted.pull, acted.by, body.data.threadId);
    } catch (error) {
      if (error instanceof UnknownPullRequestError) {
        return deps.sendError(reply, 404, "unknown_thread", "No such review thread.");
      }
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/metadata", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const body = PullMetadataInputSchema.safeParse({
      ...(request.body as Record<string, unknown> | null),
      pullRequestId: params.data.pullRequestId
    });
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_metadata", body.error.issues[0]?.message ?? "Malformed metadata.");
    }
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    try {
      await editMetadata(deps.db, deps.provider, acted.pull, acted.by, {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.body !== undefined ? { body: body.data.body } : {}),
        ...(body.data.labels !== undefined ? { labels: body.data.labels } : {})
      });
    } catch (error) {
      return hostErrorReply(deps, reply, error);
    }
    return reply.send({ ok: true });
  });

  // --- The fake host's own side (NOVUS_FAKE_GITHUB only) ---------------------
  // A deterministic suite has to *be* GitHub — comment, resolve, merge,
  // close, conflict — or the ingestion half is untestable. Guarded twice:
  // config.fakeGithub can never be set in production, and the routes only
  // exist when the provider really is the in-memory fake.
  if (deps.config.fakeGithub && deps.provider instanceof FakeRepositoryProvider) {
    const provider = deps.provider;
    const FakeActSchema = z.object({
      providerRepoId: z.string().min(1),
      number: z.number().int().positive(),
      author: z.string().min(1).max(120).optional(),
      body: z.string().max(2_000).optional(),
      path: z.string().max(300).optional(),
      checkName: z.string().max(200).optional(),
      checkStatus: z.enum(["pending", "passed", "failed", "skipped"]).optional(),
      required: z.boolean().optional(),
      verdict: z.enum(["approve", "request_changes"]).optional(),
      behindBy: z.number().int().nonnegative().optional()
    });
    app.post("/fake/github/pulls/:action", async (request, reply) => {
      const action = (request.params as { action: string }).action;
      const body = FakeActSchema.safeParse(request.body);
      if (!body.success) return deps.sendError(reply, 400, "bad_fake_act", "Malformed fake host act.");
      try {
        if (action === "comment") {
          provider.fakeComment(body.data.providerRepoId, body.data.number, {
            author: body.data.author ?? "reviewer",
            body: body.data.body ?? "Looks close — one question.",
            path: body.data.path ?? null
          });
        } else if (action === "resolve") {
          provider.fakeResolveComments(body.data.providerRepoId, body.data.number);
        } else if (action === "merge") {
          provider.fakeMerge(body.data.providerRepoId, body.data.number, body.data.author ?? "maya");
        } else if (action === "close") {
          provider.fakeClose(body.data.providerRepoId, body.data.number);
        } else if (action === "conflict") {
          provider.fakeConflict(body.data.providerRepoId, body.data.number);
        } else if (action === "check") {
          // The host side of CI (D-100): a named check ran with a verdict.
          provider.fakeCheck(body.data.providerRepoId, body.data.number, {
            name: body.data.checkName ?? "ci",
            status: body.data.checkStatus ?? "passed",
            required: body.data.required ?? false,
            kind: "check",
            url: null
          });
        } else if (action === "review") {
          provider.fakeReview(
            body.data.providerRepoId,
            body.data.number,
            body.data.verdict ?? "approve"
          );
        } else if (action === "behind") {
          provider.fakeBehind(body.data.providerRepoId, body.data.number, body.data.behindBy ?? 1);
        } else {
          return deps.sendError(reply, 404, "unknown_act", "The fake host does not do that.");
        }
      } catch (error) {
        if (error instanceof UnknownPullRequestError) {
          return deps.sendError(reply, 404, "unknown_pull_request", error.message);
        }
        throw error;
      }
      return reply.send({ ok: true });
    });
  }
}

// --- The webhook receiver (D-101) --------------------------------------------
// GitHub's own notification that a request changed: verified against the
// shared secret over the raw bytes, then answered by syncing exactly the
// named request through the same path the poll uses. With no secret
// configured the endpoint does not exist — a local-first control plane has
// nothing a webhook could reach, and the poll is its transport.

export function registerWebhookRoutes(app: FastifyInstance, deps: RouteDeps): void {
  if (deps.config.githubWebhookSecret === "") return;
  const secret = deps.config.githubWebhookSecret;
  void app.register(async (scope) => {
    // Raw bytes inside this scope only: the signature is over the payload as
    // sent, and a re-serialized JSON body would verify nothing.
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    scope.post("/webhooks/github", async (request, reply) => {
      const raw = request.body as Buffer;
      const signature = request.headers["x-hub-signature-256"];
      const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (
        typeof signature !== "string" ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return reply.code(401).send({ error: { code: "bad_signature", message: "The signature does not verify." } });
      }
      const event = request.headers["x-github-event"];
      if (
        event !== "pull_request" &&
        event !== "pull_request_review" &&
        event !== "pull_request_review_comment" &&
        event !== "issue_comment"
      ) {
        return reply.code(204).send();
      }
      let payload: {
        repository?: { id?: number };
        pull_request?: { number?: number };
        issue?: { number?: number };
      };
      try {
        payload = JSON.parse(raw.toString("utf8")) as typeof payload;
      } catch {
        return reply.code(400).send({ error: { code: "bad_payload", message: "The payload is not JSON." } });
      }
      const repoId = payload.repository?.id;
      const number = payload.pull_request?.number ?? payload.issue?.number;
      if (repoId === undefined || number === undefined) return reply.code(204).send();
      const lookup = () =>
        deps.db.query(
          `${SYNC_SELECT} where repo.provider_repo_id = $1 and p.provider_number = $2`,
          [String(repoId), number]
        );
      let row = (await lookup()).rows[0] as SyncRow | undefined;
      if (!row) {
        // A request Novus holds no row for may still be Novus's news: one
        // opened by hand on a lane's branch (D-208), or one carrying a
        // mission's merged work onward (D-209). The host's own event is the
        // earliest moment to find out, so both adoption passes run here
        // rather than waiting for the sweep — a reviewer's first comment on
        // the downstream request then lands in the room, not on a timer.
        await adoptPullRequestsOnce(deps.db, deps.provider);
        await adoptDownstreamOnce(deps.db, deps.provider);
        row = (await lookup()).rows[0] as SyncRow | undefined;
      }
      // A request that is nobody's work here is not Novus's news.
      if (!row) return reply.code(204).send();
      await syncPullRow(deps.db, deps.provider, row);
      return reply.code(202).send({ ok: true });
    });
  });
}
