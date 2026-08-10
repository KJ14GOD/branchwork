import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BranchPush, MergeReadiness, PullRequest, ReviewThread } from "@novus/contracts";
import {
  MergeInputSchema,
  MergeReadinessSchema,
  PullCommentInputSchema,
  PullMetadataInputSchema,
  RequestReviewInputSchema,
  ReviewThreadSchema
} from "@novus/contracts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { withTransaction, type Db } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newCommandId, newPullRequestId } from "./ids.ts";
import { getMission } from "./missions.ts";
import {
  FakeRepositoryProvider,
  MergeRefusedError,
  ProviderTransientError,
  PullRequestExistsError,
  UnknownPullRequestError,
  UnknownRepositoryError,
  type HostPullRequest,
  type RepositoryProvider
} from "./repo-provider.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * The tracked pull request (PRODUCT.md#domain-model, D-099).
 *
 * The row starts existing when a request is actually opened on the host
 * (D-075's promise); from then on the mission tracks it. This module owns:
 *
 *   POST /missions/:missionId/pull-request/push    (pr.manage — the remote-head guarantee)
 *   POST /missions/:missionId/pull-request         (pr.manage — open the draft)
 *   POST /pull-requests/:pullRequestId/request-review  (pr.manage)
 *   POST /pull-requests/:pullRequestId/ready           (pr.manage)
 *
 * and the poll that ingests the host's side of the story. There is no merge
 * route, no merge function, and no path that could grow one by accident —
 * merging happens on GitHub, by humans, and Novus records who (the absence is
 * asserted by the suite the way D-063 asserts the absent delete).
 */

export interface PullRequestRow {
  pr_id: string;
  mission_id: string;
  wst_id: string;
  dec_id: string;
  provider_number: number;
  url: string;
  state: string;
  mergeable: string;
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  head_sha: string | null;
  requested_reviewers: unknown;
  review_threads: unknown;
  labels?: unknown;
  readiness?: unknown;
  created_by: string;
  created_by_login?: string;
  merged_by: string | null;
  merged_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  last_synced_at: Date | null;
}

function readinessOf(raw: unknown): MergeReadiness | null {
  if (raw === null || raw === undefined) return null;
  const parsed = MergeReadinessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function threads(raw: unknown): ReviewThread[] {
  if (!Array.isArray(raw)) return [];
  const parsed: ReviewThread[] = [];
  for (const entry of raw.slice(0, 50)) {
    const thread = ReviewThreadSchema.safeParse(entry);
    if (thread.success) parsed.push(thread.data);
  }
  return parsed;
}

export function toPullRequest(row: PullRequestRow): PullRequest {
  return {
    pullRequestId: row.pr_id,
    missionId: row.mission_id,
    workstreamId: row.wst_id,
    decisionId: row.dec_id,
    number: row.provider_number,
    url: row.url,
    state: row.state as PullRequest["state"],
    mergeable: row.mergeable as PullRequest["mergeable"],
    title: row.title,
    body: row.body,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    headSha: row.head_sha,
    requestedReviewers: Array.isArray(row.requested_reviewers)
      ? (row.requested_reviewers as string[]).slice(0, 15).map(String)
      : [],
    reviewThreads: threads(row.review_threads),
    labels: Array.isArray(row.labels) ? (row.labels as string[]).slice(0, 20).map(String) : [],
    readiness: readinessOf(row.readiness),
    createdBy: row.created_by,
    createdByLogin: row.created_by_login ?? "unknown",
    mergedBy: row.merged_by,
    mergedAt: row.merged_at ? row.merged_at.toISOString() : null,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null
  };
}

const PR_SELECT = `select p.*, u.login as created_by_login
     from pull_requests p
     join users u on u.user_id = p.created_by`;

/**
 * The lane's pull request, for the room: the open one where one is open,
 * otherwise the most recently created — a merged or closed request is still
 * what the mission's publication story is about.
 */
export async function pullRequestForLane(
  db: Db,
  workstreamId: string
): Promise<PullRequest | null> {
  const result = await db.query(
    `${PR_SELECT}
      where p.wst_id = $1
      order by (p.state in ('draft', 'ready')) desc, p.created_at desc
      limit 1`,
    [workstreamId]
  );
  const row = result.rows[0] as PullRequestRow | undefined;
  return row ? toPullRequest(row) : null;
}

export async function pullRequestById(db: Db, pullRequestId: string): Promise<PullRequest | null> {
  const result = await db.query(`${PR_SELECT} where p.pr_id = $1`, [pullRequestId]);
  const row = result.rows[0] as PullRequestRow | undefined;
  return row ? toPullRequest(row) : null;
}

/**
 * Where the lane's branch stands on the remote (D-099): the recorded remote
 * head, and the one push command in flight when one is. The push's lifecycle
 * is the runner command's own — pending until the runner settles it, failed
 * with the runner's reason — so the surface never invents progress.
 */
export async function branchPushFor(
  db: Db,
  workstreamId: string,
  remoteHeadSha: string | null
): Promise<BranchPush> {
  const result = await db.query(
    `select state, failure_reason from runner_commands
      where wst_id = $1 and kind = 'push_branch'
      order by created_at desc, cmd_id desc limit 1`,
    [workstreamId]
  );
  const row = result.rows[0] as { state: string; failure_reason: string | null } | undefined;
  if (!row) return { state: "none", remoteHeadSha, failureReason: null };
  if (row.state === "completed") return { state: "completed", remoteHeadSha, failureReason: null };
  if (row.state === "failed") {
    return {
      state: "failed",
      remoteHeadSha,
      failureReason: row.failure_reason?.slice(0, 400) ?? "The push did not finish."
    };
  }
  return { state: "pending", remoteHeadSha, failureReason: null };
}

// --- Publishing --------------------------------------------------------------

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });
const PullParamsSchema = z.object({ pullRequestId: z.string().startsWith("pr_") });
const LaneBodySchema = z.object({ workstreamId: z.string().startsWith("wst_").optional() });

interface PullContext {
  pullRequestId: string;
  missionId: string;
  workstreamId: string;
  orgId: string;
  providerRepoId: string;
  providerKind: string;
  number: number;
  state: string;
}

async function loadPullContext(db: Db, pullRequestId: string): Promise<PullContext | null> {
  const result = await db.query(
    `select p.pr_id, p.mission_id, p.wst_id, p.org_id, p.provider_number, p.state,
            repo.provider_repo_id, repo.provider as provider_kind
       from pull_requests p
       join workstreams w on w.wst_id = p.wst_id
       join repositories repo on repo.repo_id = w.repo_id
      where p.pr_id = $1`,
    [pullRequestId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    pullRequestId: row.pr_id as string,
    missionId: row.mission_id as string,
    workstreamId: row.wst_id as string,
    orgId: row.org_id as string,
    providerRepoId: row.provider_repo_id as string,
    providerKind: row.provider_kind as string,
    number: row.provider_number as number,
    state: row.state as string
  };
}

/**
 * The second gating tier (D-100): blockers a person may accept deliberately,
 * each a named sentence. What the host itself refuses never appears here —
 * that tier refuses outright and is not acceptable by anyone.
 */
export function acceptableBlockers(
  readiness: MergeReadiness,
  row: PullRequest | null
): string[] {
  const blockers: string[] = [];
  if (readiness.changesRequested > 0) {
    blockers.push(
      `${readiness.changesRequested} change request${readiness.changesRequested === 1 ? "" : "s"} outstanding`
    );
  }
  const openThreads = row?.reviewThreads.filter((thread) => thread.state === "open").length ?? 0;
  if (openThreads > 0) {
    blockers.push(`${openThreads} review comment${openThreads === 1 ? "" : "s"} unresolved`);
  }
  const failing = readiness.checks.filter((check) => !check.required && check.status === "failed");
  for (const check of failing.slice(0, 5)) blockers.push(`check ${check.name} failing`);
  const pending = readiness.checks.filter((check) => check.status === "pending").length;
  if (pending > 0) blockers.push(`${pending} check${pending === 1 ? "" : "s"} still running`);
  if (readiness.behindBy !== null && readiness.behindBy > 0) {
    blockers.push(`the branch is ${readiness.behindBy} commit${readiness.behindBy === 1 ? "" : "s"} behind its base`);
  }
  return blockers;
}

interface StewardingContext {
  pull: PullContext;
  ctx: { userId: string; login: string };
  access: { leaseId: string | null };
}

/** The shared front half of every stewarding verb: resolve, authorize on
 *  pr.manage, and check the request is in a state the act makes sense for. */
async function stewardingAct(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  gate: { openOnly?: boolean; resolvedOnly?: boolean }
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
  return { pull, ctx, access };
}

async function recordAct(
  db: Db,
  pull: PullContext,
  ctx: { userId: string; login: string },
  leaseId: string | null,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  await withTransaction(db, async (client) => {
    await recordEvent(client, {
      orgId: pull.orgId,
      missionId: pull.missionId,
      workstreamId: pull.workstreamId,
      kind,
      actorKind: "user",
      actorId: ctx.userId,
      actorLogin: ctx.login,
      causeLeaseId: leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number, ...payload }
    });
  });
}

export function registerPullRequestRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /**
   * The push half of publishing (D-099): enqueues `push_branch` toward the
   * runner holding the worktree, carrying the exact revision the current
   * decision chose. The runner pushes with a write-scoped per-operation
   * credential and reports `workspace.pushed`; nothing here touches git.
   */
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

    const outcome = await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      const laneRow = await client.query(
        `select w.mission_branch, repo.provider
           from workstreams w join repositories repo on repo.repo_id = w.repo_id
          where w.wst_id = $1`,
        [workstreamId]
      );
      const lane = laneRow.rows[0] as { mission_branch: string; provider: string } | undefined;
      if (!lane) return { kind: "no_workstream" as const };
      if (lane.provider !== "github") return { kind: "not_publishable" as const };
      const decisionRow = await client.query(
        `select dec_id, checkpoint_sha from decisions
          where mission_id = $1 and wst_id = $2 and superseded_at is null`,
        [access.missionId, workstreamId]
      );
      const decision = decisionRow.rows[0] as { dec_id: string; checkpoint_sha: string | null } | undefined;
      if (!decision) return { kind: "no_decision" as const };
      if (!decision.checkpoint_sha) return { kind: "no_checkpoint" as const };
      const runnerRow = await client.query(
        `select runner_id from runners
          where wst_id = $1 and revoked_at is null and expires_at > now()
          order by created_at desc limit 1`,
        [workstreamId]
      );
      const runnerId = (runnerRow.rows[0]?.runner_id as string | undefined) ?? null;
      if (!runnerId) return { kind: "no_runner" as const };

      // The double-click is answered by state, the workspace-command way
      // (D-043's pattern): an unsettled push is reused, and a settled one —
      // completed or failed — makes the next request a genuinely new command.
      const pending = await client.query(
        `select cmd_id from runner_commands
          where wst_id = $1 and kind = 'push_branch'
            and state in ('pending', 'delivered', 'acknowledged')
          limit 1`,
        [workstreamId]
      );
      if (pending.rows[0] !== undefined) return { kind: "already_queued" as const };

      const commandId = newCommandId();
      await client.query(
        `insert into runner_commands (cmd_id, org_id, mission_id, wst_id, exe_id, runner_id, kind,
                                      payload, idempotency_key, state)
         values ($1, $2, $3, $4, null, $5, 'push_branch', $6, $7, 'pending')`,
        [
          commandId,
          access.orgId,
          access.missionId,
          workstreamId,
          runnerId,
          JSON.stringify({
            branch: lane.mission_branch,
            sha: decision.checkpoint_sha,
            requestedBy: ctx.userId
          }),
          `push:${workstreamId}:${decision.checkpoint_sha}:${commandId}`
        ]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        kind: "pr.push_requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { branch: lane.mission_branch, sha: decision.checkpoint_sha }
      });
      return { kind: "enqueued" as const };
    });

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

  /**
   * Opens the draft (D-099). Refused in words until the remote head equals
   * the decided checkpoint — a request naming a revision the host does not
   * serve would be the product's central lie — and always opened as a draft:
   * readiness is a person's own later claim.
   */
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
    const prepared = detail.preparedPullRequest;
    const decision = detail.decisions.find((entry) => entry.supersededAt === null) ?? null;
    const lane = detail.workstream;
    if (!prepared || !decision || !lane) {
      return deps.sendError(reply, 409, "no_decision", "Record a decision first: publishing is what a decision becomes.");
    }
    if (!prepared.publishable) {
      return deps.sendError(
        reply,
        409,
        "not_publishable",
        "This repository is a folder on a machine rather than a host that could receive a pull request."
      );
    }
    if (decision.workstreamId !== lane.workstreamId) {
      return deps.sendError(
        reply,
        409,
        "wrong_lane",
        "The current decision chose a different approach; open the pull request from that lane."
      );
    }
    if (!decision.checkpointSha) {
      return deps.sendError(reply, 409, "no_checkpoint", "The decision names no checkpoint, so there is nothing to publish.");
    }
    if (lane.remoteHeadSha !== decision.checkpointSha) {
      // The remote-head guarantee, stated as the next action.
      return deps.sendError(
        reply,
        409,
        "branch_not_pushed",
        lane.remoteHeadSha === null
          ? "The branch has never been pushed to GitHub. Push it first, so the request serves the decided revision."
          : "The branch on GitHub does not serve the decided revision. Push it first."
      );
    }
    const existing = await pullRequestForLane(deps.db, workstreamId);
    if (existing && (existing.state === "draft" || existing.state === "ready")) {
      return deps.sendError(reply, 409, "already_open", `PR #${existing.number} is already open for this approach.`);
    }

    const repoRow = await deps.db.query(
      `select repo.provider_repo_id from workstreams w
         join repositories repo on repo.repo_id = w.repo_id
        where w.wst_id = $1`,
      [workstreamId]
    );
    const providerRepoId = repoRow.rows[0]?.provider_repo_id as string | undefined;
    if (!providerRepoId) return deps.sendError(reply, 409, "no_workstream", "This mission has no repository.");

    let opened: HostPullRequest;
    try {
      opened = await deps.provider.createPullRequest(providerRepoId, {
        title: prepared.title,
        body: prepared.body,
        headRef: prepared.headRef,
        baseRef: prepared.baseRef
      });
    } catch (error) {
      if (error instanceof PullRequestExistsError) {
        return deps.sendError(reply, 409, "already_open", error.message);
      }
      if (error instanceof UnknownRepositoryError) {
        return deps.sendError(reply, 404, "unknown_repository", error.message);
      }
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", `GitHub could not open the request: ${error.message}`);
      }
      throw error;
    }

    const pullRequestId = newPullRequestId();
    await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      await client.query(
        `insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url,
                                    state, mergeable, title, body, base_ref, head_ref, head_sha,
                                    requested_reviewers, review_threads, created_by, last_synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '[]'::jsonb, '[]'::jsonb, $15, now())`,
        [
          pullRequestId,
          access.orgId,
          access.missionId,
          workstreamId,
          decision.decisionId,
          opened.number,
          opened.url,
          opened.state,
          opened.mergeable,
          prepared.title,
          prepared.body,
          prepared.baseRef,
          prepared.headRef,
          lane.remoteHeadSha,
          ctx.userId
        ]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        kind: "pr.opened",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: {
          pullRequestId,
          number: opened.number,
          url: opened.url,
          headSha: lane.remoteHeadSha,
          decisionId: decision.decisionId
        }
      });
    });

    const created = await pullRequestById(deps.db, pullRequestId);
    return reply.code(201).send({ pullRequest: created });
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
    const pull = await loadPullContext(deps.db, params.data.pullRequestId);
    if (!pull) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    requireCapability(access, "pr.manage");
    if (pull.state === "merged" || pull.state === "closed") {
      return deps.sendError(reply, 409, "resolved", "This pull request is already resolved on GitHub.");
    }
    try {
      await deps.provider.requestReviewers(pull.providerRepoId, pull.number, body.data.reviewers);
    } catch (error) {
      if (error instanceof UnknownPullRequestError) {
        return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      }
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", error.message);
      }
      throw error;
    }
    await withTransaction(deps.db, async (client) => {
      await client.query(
        `update pull_requests
            set requested_reviewers = (
              select coalesce(jsonb_agg(distinct reviewer), '[]'::jsonb)
                from (
                  select jsonb_array_elements_text(requested_reviewers) as reviewer from pull_requests where pr_id = $1
                  union
                  select unnest($2::text[])
                ) merged
            )
          where pr_id = $1`,
        [pull.pullRequestId, body.data.reviewers]
      );
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.review_requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { pullRequestId: pull.pullRequestId, number: pull.number, reviewers: body.data.reviewers }
      });
    });
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/ready", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = PullParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed pull request id.");
    const pull = await loadPullContext(deps.db, params.data.pullRequestId);
    if (!pull) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    requireCapability(access, "pr.manage");
    if (pull.state !== "draft") {
      return deps.sendError(reply, 409, "not_a_draft", "Only a draft can be marked ready, and this one no longer is one.");
    }
    try {
      await deps.provider.markPullRequestReady(pull.providerRepoId, pull.number);
    } catch (error) {
      if (error instanceof UnknownPullRequestError) {
        return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      }
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", error.message);
      }
      throw error;
    }
    await withTransaction(deps.db, async (client) => {
      await client.query(`update pull_requests set state = 'ready' where pr_id = $1 and state = 'draft'`, [
        pull.pullRequestId
      ]);
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.marked_ready",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { pullRequestId: pull.pullRequestId, number: pull.number }
      });
    });
    return reply.send({ ok: true });
  });

  // --- Completion (D-100) ----------------------------------------------------
  // Explicit human acts GitHub performs underneath. The two-tier gate is the
  // honesty: what the host itself cannot do — a draft, a conflict, a failing
  // *required* check — is refused outright in words; every other blocker is
  // named, and proceeding requires acknowledging exactly the named set, which
  // the event then records. Nothing here is ever automatic or silent.

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
    const pull = await loadPullContext(deps.db, params.data.pullRequestId);
    if (!pull) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    const access = await missionAccess(deps.db, ctx, pull.missionId, pull.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    requireCapability(access, "pr.manage");

    if (pull.state === "merged") return deps.sendError(reply, 409, "resolved", "This pull request is already merged.");
    if (pull.state === "closed") return deps.sendError(reply, 409, "resolved", "This pull request is closed.");
    if (pull.state === "draft") {
      return deps.sendError(reply, 409, "still_a_draft", "A draft cannot be merged; mark it ready first.");
    }

    // Fresh readiness at the moment of asking, never a stale row.
    let readiness: MergeReadiness;
    try {
      readiness = await deps.provider.getMergeReadiness(pull.providerRepoId, pull.number);
    } catch (error) {
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", error.message);
      }
      throw error;
    }
    if (!readiness.allowedMergeMethods.includes(body.data.method)) {
      return deps.sendError(
        reply,
        409,
        "method_not_allowed",
        `This repository does not allow ${body.data.method} merges; it allows ${readiness.allowedMergeMethods.join(", ")}.`
      );
    }
    const requiredFailing = readiness.checks.filter(
      (check) => check.required && check.status === "failed"
    );
    if (requiredFailing.length > 0) {
      return deps.sendError(
        reply,
        409,
        "host_refuses",
        `A required check is failing (${requiredFailing[0]?.name}); branch protection refuses the merge.`
      );
    }
    const row = await pullRequestById(deps.db, pull.pullRequestId);
    if (row?.mergeable === "conflict") {
      return deps.sendError(
        reply,
        409,
        "host_refuses",
        "The branch has conflicts with its base that must be resolved first."
      );
    }

    // The second tier: named, acceptable, never silent.
    const blockers = acceptableBlockers(readiness, row);
    if (blockers.length > 0 && !body.data.acknowledgeBlockers) {
      return deps.sendError(
        reply,
        409,
        "blockers_outstanding",
        `Outstanding before this merges: ${blockers.join("; ")}. Confirm with the blockers acknowledged to proceed deliberately.`
      );
    }

    let merged: { sha: string | null };
    try {
      merged = await deps.provider.mergePullRequest(pull.providerRepoId, pull.number, body.data.method);
    } catch (error) {
      if (error instanceof MergeRefusedError) {
        return deps.sendError(reply, 409, "host_refuses", error.message);
      }
      if (error instanceof UnknownPullRequestError) {
        return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      }
      if (error instanceof ProviderTransientError) {
        return deps.sendError(reply, 502, "provider_unavailable", error.message);
      }
      throw error;
    }

    // The host performed it; ingest the host's own account immediately.
    const host = await deps.provider.getPullRequest(pull.providerRepoId, pull.number).catch(() => null);
    await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [pull.missionId]);
      await client.query(
        `update pull_requests
            set state = 'merged',
                merged_by = $2,
                merged_at = coalesce($3::timestamptz, now()),
                mergeable = 'clean',
                last_synced_at = now()
          where pr_id = $1`,
        [pull.pullRequestId, host?.mergedBy ?? "app/novus", host?.mergedAt ?? null]
      );
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.merge_performed",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: {
          pullRequestId: pull.pullRequestId,
          number: pull.number,
          method: body.data.method,
          sha: merged.sha,
          // Exactly what was accepted, durable: "merged with two open
          // comments" is a sentence, never a secret (D-100).
          acceptedBlockers: blockers
        }
      });
    });
    return reply.send({ sha: merged.sha });
  });

  app.post("/pull-requests/:pullRequestId/update-branch", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    const { pull, ctx, access } = acted;
    try {
      await deps.provider.updatePullRequestBranch(pull.providerRepoId, pull.number);
    } catch (error) {
      if (error instanceof MergeRefusedError) return deps.sendError(reply, 409, "host_refuses", error.message);
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
    }
    await recordAct(deps.db, pull, ctx, access.leaseId, "pr.branch_updated", {});
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/close", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    const { pull, ctx, access } = acted;
    try {
      await deps.provider.closePullRequest(pull.providerRepoId, pull.number);
    } catch (error) {
      if (error instanceof MergeRefusedError) return deps.sendError(reply, 409, "host_refuses", error.message);
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
    }
    await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [pull.missionId]);
      await client.query(
        `update pull_requests set state = 'closed', closed_at = now(), last_synced_at = now() where pr_id = $1`,
        [pull.pullRequestId]
      );
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.close_performed",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { pullRequestId: pull.pullRequestId, number: pull.number }
      });
    });
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/delete-branch", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { resolvedOnly: true });
    if (!acted) return;
    const { pull, ctx, access } = acted;
    const row = await pullRequestById(deps.db, pull.pullRequestId);
    if (!row) return deps.sendError(reply, 404, "not_found", "No such pull request in your organization.");
    try {
      await deps.provider.deleteBranchRef(pull.providerRepoId, row.headRef);
    } catch (error) {
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      // A ref already gone is the asked-for end state, said plainly.
      return deps.sendError(reply, 409, "branch_missing", "That branch no longer exists on the host.");
    }
    await recordAct(deps.db, pull, ctx, access.leaseId, "pr.branch_deleted", { branch: row.headRef });
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
      return await deps.provider.listPullFiles(pull.providerRepoId, pull.number);
    } catch (error) {
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
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
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    const { pull, access } = acted;
    try {
      await deps.provider.createPullComment(pull.providerRepoId, pull.number, {
        // Authored by the App, attributed in the body until user-token
        // identity exists (D-100).
        body: `**${ctx.login} via Novus:** ${body.data.body}`,
        ...(body.data.path !== undefined ? { path: body.data.path } : {}),
        ...(body.data.line !== undefined ? { line: body.data.line } : {})
      });
    } catch (error) {
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
    }
    await recordAct(deps.db, pull, ctx, access.leaseId, "pr.comment_sent", {
      path: body.data.path ?? null,
      line: body.data.line ?? null
    });
    return reply.send({ ok: true });
  });

  app.post("/pull-requests/:pullRequestId/resolve-thread", async (request, reply) => {
    const acted = await stewardingAct(deps, request, reply, { openOnly: true });
    if (!acted) return;
    const { pull, ctx, access } = acted;
    const body = z.object({ threadId: z.string().min(1).max(200) }).safeParse(request.body);
    if (!body.success) return deps.sendError(reply, 400, "bad_thread", "Malformed thread id.");
    try {
      await deps.provider.resolveReviewThread(pull.providerRepoId, body.data.threadId);
    } catch (error) {
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_thread", "No such review thread.");
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
    }
    await withTransaction(deps.db, async (client) => {
      // Reflect immediately rather than waiting a poll: the person just did it.
      await client.query(
        `update pull_requests
            set review_threads = (
              select coalesce(jsonb_agg(
                case when thread->>'threadId' = $2 then jsonb_set(thread, '{state}', '"resolved"') else thread end
              ), '[]'::jsonb)
              from jsonb_array_elements(review_threads) as thread
            )
          where pr_id = $1`,
        [pull.pullRequestId, body.data.threadId]
      );
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.thread_resolved",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { pullRequestId: pull.pullRequestId, number: pull.number, threadId: body.data.threadId }
      });
    });
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
    const { pull, access } = acted;
    try {
      await deps.provider.setPullRequestMetadata(pull.providerRepoId, pull.number, {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.body !== undefined ? { body: body.data.body } : {}),
        ...(body.data.labels !== undefined ? { labels: body.data.labels } : {})
      });
    } catch (error) {
      if (error instanceof UnknownPullRequestError) return deps.sendError(reply, 404, "unknown_pull_request", error.message);
      if (error instanceof ProviderTransientError) return deps.sendError(reply, 502, "provider_unavailable", error.message);
      throw error;
    }
    await withTransaction(deps.db, async (client) => {
      // The title and labels follow the host; the stored body stays the
      // snapshot of what was *sent* at publication — that is the receipt, and
      // editing the host's description does not rewrite history (D-100).
      if (body.data.title !== undefined) {
        await client.query(`update pull_requests set title = $2 where pr_id = $1`, [
          pull.pullRequestId,
          body.data.title
        ]);
      }
      if (body.data.labels !== undefined) {
        await client.query(`update pull_requests set labels = $2::jsonb where pr_id = $1`, [
          pull.pullRequestId,
          JSON.stringify(body.data.labels.slice(0, 20))
        ]);
      }
      await recordEvent(client, {
        orgId: pull.orgId,
        missionId: pull.missionId,
        workstreamId: pull.workstreamId,
        kind: "pr.metadata_edited",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: {
          pullRequestId: pull.pullRequestId,
          number: pull.number,
          edited: [
            ...(body.data.title !== undefined ? ["title"] : []),
            ...(body.data.body !== undefined ? ["description"] : []),
            ...(body.data.labels !== undefined ? ["labels"] : [])
          ]
        }
      });
    });
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

// --- Ingestion ---------------------------------------------------------------

/**
 * One poll pass over every open request (D-099): read the host's story, and
 * record what changed as events with `actor.kind: external` — the host is a
 * source Novus quotes, never an authority it invents. Poll-first because a
 * local-first control plane has no public webhook endpoint; a deployed one
 * grows webhooks with the same ingestion underneath (ARCHITECTURE.md).
 */
export async function sweepPullRequestsOnce(db: Db, provider: RepositoryProvider): Promise<void> {
  const open = await db.query(
    `select p.pr_id, p.org_id, p.mission_id, p.wst_id, p.provider_number, p.state, p.mergeable,
            p.review_threads, repo.provider_repo_id
       from pull_requests p
       join workstreams w on w.wst_id = p.wst_id
       join repositories repo on repo.repo_id = w.repo_id
      where p.state in ('draft', 'ready')`
  );
  for (const row of open.rows as {
    pr_id: string;
    org_id: string;
    mission_id: string;
    wst_id: string;
    provider_number: number;
    state: string;
    mergeable: string;
    review_threads: unknown;
    provider_repo_id: string;
  }[]) {
    let host: HostPullRequest;
    let readiness: MergeReadiness | null = null;
    try {
      host = await provider.getPullRequest(row.provider_repo_id, row.provider_number);
      // The gate rides the same poll (D-100). Its absence is survivable —
      // the row keeps its last answer and the surface says when it synced.
      readiness = await provider
        .getMergeReadiness(row.provider_repo_id, row.provider_number)
        .catch(() => null);
    } catch {
      // The host being unreachable is not news to record; the next pass asks
      // again and last_synced_at stays honest about staleness.
      continue;
    }
    const knownThreads = Array.isArray(row.review_threads) ? (row.review_threads as unknown[]).length : 0;
    const openThreads = host.reviewThreads.filter((thread) => thread.state === "open").length;

    await withTransaction(db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [row.mission_id]);
      await client.query(
        `update pull_requests
            set state = $2, mergeable = $3, review_threads = $4::jsonb,
                requested_reviewers = $5::jsonb,
                merged_by = coalesce($6, merged_by),
                merged_at = coalesce($7::timestamptz, merged_at),
                closed_at = coalesce($8::timestamptz, closed_at),
                readiness = coalesce($9::jsonb, readiness),
                last_synced_at = now()
          where pr_id = $1`,
        [
          row.pr_id,
          host.state,
          host.mergeable,
          JSON.stringify(host.reviewThreads.slice(0, 50)),
          JSON.stringify(host.requestedReviewers.slice(0, 15)),
          host.mergedBy,
          host.mergedAt,
          host.closedAt,
          readiness === null ? null : JSON.stringify(readiness)
        ]
      );
      const record = (kind: string, payload: Record<string, unknown>) =>
        recordEvent(client, {
          orgId: row.org_id,
          missionId: row.mission_id,
          workstreamId: row.wst_id,
          kind,
          actorKind: "external",
          actorId: "github",
          actorLogin: null,
          payload: { pullRequestId: row.pr_id, number: row.provider_number, ...payload }
        });
      if (host.state === "merged" && row.state !== "merged") {
        await record("pr.merged", { mergedBy: host.mergedBy });
      } else if (host.state === "closed" && row.state !== "closed") {
        await record("pr.closed", {});
      } else if (host.state === "ready" && row.state === "draft") {
        // Marked ready on the host itself rather than through Novus — still
        // the host's news, still recorded.
        await record("pr.marked_ready_externally", {});
      }
      if (host.mergeable === "conflict" && row.mergeable !== "conflict") {
        await record("pr.conflict", {});
      }
      if (host.reviewThreads.length > knownThreads) {
        await record("pr.comments", {
          added: host.reviewThreads.length - knownThreads,
          open: openThreads
        });
      }
    });
  }
}

/** Started from main.ts beside the reliability sweep; never from buildServer,
 *  so a server constructed for a test acquires no timer (main.ts's own rule). */
export function startPullRequestSweep(
  db: Db,
  provider: RepositoryProvider,
  everyMs = 15_000
): () => void {
  const timer = setInterval(() => {
    void sweepPullRequestsOnce(db, provider).catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
