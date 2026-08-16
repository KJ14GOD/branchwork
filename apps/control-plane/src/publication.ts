import type { BranchPush, MergeReadiness, PullRequest, ReviewThread } from "@novus/contracts";
import { MergeReadinessSchema, ReviewThreadSchema } from "@novus/contracts";
import { withMission, withTransaction, type Db, type Queryable } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newPullRequestId } from "./ids.ts";
import { activeRunner, enqueueRepeatable } from "./runners.ts";
import { laneRepository } from "./workstreams.ts";
import { standingDecision } from "./approaches.ts";
import {
  MergeRefusedError,
  PullRequestExistsError,
  UnknownRepositoryError,
  type HostPullRequest,
  type RepositoryProvider
} from "./repo-provider.ts";

/**
 * OWNER: the publication domain (D-099, D-100) — what a decision becomes.
 * Every verb here is a domain operation returning a **typed outcome**: the
 * refusals a person can read ("no decision", "branch not pushed", "blockers
 * outstanding") are values, never HTTP. The route file (pull-requests.ts)
 * maps outcomes to status codes and owns nothing else; provider *transport*
 * errors (unknown request, host unavailable) propagate as the provider's own
 * exceptions for the shell's one translator.
 *
 * The invariants live here with the SQL that keeps them: a request is only
 * opened at the decided revision the remote actually serves (the remote-head
 * guarantee), merging is two-tiered — the host's own refusals absolute, every
 * other blocker named and deliberately accepted on the record — and the
 * host's side of the story is ingested as `actor.kind: external`, quoted and
 * never invented.
 */

// --- The tracked row ---------------------------------------------------------

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
    // Filled from the live attachment rows where the caller serves a mission
    // detail (D-122); the tracked row itself never stores the relationship.
    artifactIds: [],
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
  db: Queryable,
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

export async function pullRequestById(db: Queryable, pullRequestId: string): Promise<PullRequest | null> {
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
  db: Queryable,
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

export interface PullContext {
  pullRequestId: string;
  missionId: string;
  workstreamId: string;
  orgId: string;
  providerRepoId: string;
  providerKind: string;
  number: number;
  state: string;
}

/** The tracked request with its lane's repository — everything a stewarding
 *  verb needs to name the request to the host and the record. */
export async function loadPullContext(db: Queryable, pullRequestId: string): Promise<PullContext | null> {
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

// --- The verbs ---------------------------------------------------------------

/** Who is acting, and under what standing. Resolved by the shell; every verb
 *  records through it so attribution and causation stay uniform. */
export interface Steward {
  userId: string;
  login: string;
  leaseId: string | null;
}

async function recordAct(
  db: Db,
  pull: PullContext,
  by: Steward,
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
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number, ...payload }
    });
  });
}

export type PushOutcome =
  | { kind: "no_workstream" }
  | { kind: "not_publishable" }
  | { kind: "no_decision" }
  | { kind: "no_checkpoint" }
  | { kind: "no_runner" }
  | { kind: "already_queued" }
  | { kind: "enqueued" };

/**
 * The push half of publishing (D-099): enqueues `push_branch` toward the
 * runner holding the worktree, carrying the exact revision the current
 * decision chose. The runner pushes with a write-scoped per-operation
 * credential and reports `workspace.pushed`; nothing here touches git.
 */
export async function requestPush(
  db: Db,
  scope: { orgId: string; missionId: string; workstreamId: string },
  by: Steward
): Promise<PushOutcome> {
  return withMission(db, scope.missionId, async (client) => {
    const lane = await laneRepository(client, scope.workstreamId);
    if (!lane) return { kind: "no_workstream" as const };
    if (lane.provider !== "github") return { kind: "not_publishable" as const };
    const decision = await standingDecision(client, scope.missionId, scope.workstreamId);
    if (!decision) return { kind: "no_decision" as const };
    if (!decision.checkpointSha) return { kind: "no_checkpoint" as const };
    const runner = await activeRunner(client, scope.workstreamId);
    if (!runner) return { kind: "no_runner" as const };

    // A push follows every new decision, so it rides the transport's
    // repeatable mode: an unsettled push is reused, and a settled one —
    // completed or failed — makes the next request a genuinely new command.
    const enqueued = await enqueueRepeatable(client, {
      orgId: scope.orgId,
      missionId: scope.missionId,
      workstreamId: scope.workstreamId,
      runnerId: runner.runnerId,
      kind: "push_branch",
      name: null,
      payload: {
        branch: lane.missionBranch,
        sha: decision.checkpointSha,
        requestedBy: by.userId
      }
    });
    if (enqueued.kind === "already_queued") return { kind: "already_queued" as const };
    await recordEvent(client, {
      orgId: scope.orgId,
      missionId: scope.missionId,
      workstreamId: scope.workstreamId,
      kind: "pr.push_requested",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { branch: lane.missionBranch, sha: decision.checkpointSha }
    });
    return { kind: "enqueued" as const };
  });
}

export interface OpenDraftInputs {
  prepared: {
    publishable: boolean;
    title: string;
    body: string;
    headRef: string;
    baseRef: string;
  } | null;
  decision: { decisionId: string; workstreamId: string; checkpointSha: string | null } | null;
  lane: { workstreamId: string; remoteHeadSha: string | null } | null;
}

export type OpenDraftOutcome =
  | { kind: "no_decision" }
  | { kind: "not_publishable" }
  | { kind: "wrong_lane" }
  | { kind: "no_checkpoint" }
  | { kind: "branch_never_pushed" }
  | { kind: "branch_stale" }
  | { kind: "already_open"; number: number }
  | { kind: "host_already_open"; message: string }
  | { kind: "no_repository" }
  | { kind: "unknown_repository"; message: string }
  | { kind: "opened"; pullRequest: PullRequest | null };

/**
 * Opens the draft (D-099). Refused in words until the remote head equals the
 * decided checkpoint — a request naming a revision the host does not serve
 * would be the product's central lie — and always opened as a draft:
 * readiness is a person's own later claim. `PullRequestExistsError` and
 * `UnknownRepositoryError` are domain answers here, not transport noise, so
 * they surface as outcomes the shell maps; only transient host failure
 * propagates.
 */
export async function openDraft(
  db: Db,
  provider: RepositoryProvider,
  scope: { orgId: string; missionId: string; workstreamId: string },
  by: Steward,
  inputs: OpenDraftInputs
): Promise<OpenDraftOutcome> {
  const { prepared, decision, lane } = inputs;
  if (!prepared || !decision || !lane) return { kind: "no_decision" };
  if (!prepared.publishable) return { kind: "not_publishable" };
  if (decision.workstreamId !== lane.workstreamId) return { kind: "wrong_lane" };
  if (!decision.checkpointSha) return { kind: "no_checkpoint" };
  if (lane.remoteHeadSha !== decision.checkpointSha) {
    // The remote-head guarantee, stated as the next action.
    return lane.remoteHeadSha === null ? { kind: "branch_never_pushed" } : { kind: "branch_stale" };
  }
  const existing = await pullRequestForLane(db, scope.workstreamId);
  if (existing && (existing.state === "draft" || existing.state === "ready")) {
    return { kind: "already_open", number: existing.number };
  }

  const laneRepo = await laneRepository(db, scope.workstreamId);
  if (!laneRepo) return { kind: "no_repository" };

  let opened: HostPullRequest;
  try {
    opened = await provider.createPullRequest(laneRepo.providerRepoId, {
      title: prepared.title,
      body: prepared.body,
      headRef: prepared.headRef,
      baseRef: prepared.baseRef
    });
  } catch (error) {
    if (error instanceof PullRequestExistsError) {
      return { kind: "host_already_open", message: error.message };
    }
    if (error instanceof UnknownRepositoryError) {
      return { kind: "unknown_repository", message: error.message };
    }
    throw error;
  }

  const pullRequestId = newPullRequestId();
  await withMission(db, scope.missionId, async (client) => {
    await client.query(
      `insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url,
                                  state, mergeable, title, body, base_ref, head_ref, head_sha,
                                  requested_reviewers, review_threads, created_by, last_synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '[]'::jsonb, '[]'::jsonb, $15, now())`,
      [
        pullRequestId,
        scope.orgId,
        scope.missionId,
        scope.workstreamId,
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
        by.userId
      ]
    );
    await recordEvent(client, {
      orgId: scope.orgId,
      missionId: scope.missionId,
      workstreamId: scope.workstreamId,
      kind: "pr.opened",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: {
        pullRequestId,
        number: opened.number,
        url: opened.url,
        headSha: lane.remoteHeadSha,
        decisionId: decision.decisionId
      }
    });
  });

  return { kind: "opened", pullRequest: await pullRequestById(db, pullRequestId) };
}

/** Asks the host for reviewers, then reflects and records. */
export async function requestReviewers(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  reviewers: string[]
): Promise<void> {
  await provider.requestReviewers(pull.providerRepoId, pull.number, reviewers);
  await withTransaction(db, async (client) => {
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
      [pull.pullRequestId, reviewers]
    );
    await recordEvent(client, {
      orgId: pull.orgId,
      missionId: pull.missionId,
      workstreamId: pull.workstreamId,
      kind: "pr.review_requested",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number, reviewers }
    });
  });
}

/** Marks the draft ready on the host — readiness is a person's own claim — and
 *  reflects it. The shell has already refused a non-draft in words. */
export async function markReady(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward
): Promise<void> {
  await provider.markPullRequestReady(pull.providerRepoId, pull.number);
  await withTransaction(db, async (client) => {
    await client.query(`update pull_requests set state = 'ready' where pr_id = $1 and state = 'draft'`, [
      pull.pullRequestId
    ]);
    await recordEvent(client, {
      orgId: pull.orgId,
      missionId: pull.missionId,
      workstreamId: pull.workstreamId,
      kind: "pr.marked_ready",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number }
    });
  });
}

export type MergeOutcome =
  | { kind: "resolved"; state: "merged" | "closed" }
  | { kind: "still_a_draft" }
  | { kind: "method_not_allowed"; allowed: string[] }
  | { kind: "host_refuses"; reason: string }
  | { kind: "blockers_outstanding"; blockers: string[] }
  | { kind: "merged"; sha: string | null };

/**
 * The completion verb (D-100): explicit, two-tiered, never silent. What the
 * host itself cannot do — a draft, a conflict, a failing *required* check —
 * refuses outright in words; every other blocker is named, and proceeding
 * requires acknowledging exactly the named set, which the event records.
 */
export async function mergePull(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  input: { method: "merge" | "squash" | "rebase"; acknowledgeBlockers: boolean }
): Promise<MergeOutcome> {
  if (pull.state === "merged") return { kind: "resolved", state: "merged" };
  if (pull.state === "closed") return { kind: "resolved", state: "closed" };
  if (pull.state === "draft") return { kind: "still_a_draft" };

  // Fresh readiness at the moment of asking, never a stale row.
  const readiness = await provider.getMergeReadiness(pull.providerRepoId, pull.number);
  if (!readiness.allowedMergeMethods.includes(input.method)) {
    return { kind: "method_not_allowed", allowed: [...readiness.allowedMergeMethods] };
  }
  const requiredFailing = readiness.checks.filter(
    (check) => check.required && check.status === "failed"
  );
  if (requiredFailing.length > 0) {
    return {
      kind: "host_refuses",
      reason: `A required check is failing (${requiredFailing[0]?.name}); branch protection refuses the merge.`
    };
  }
  const row = await pullRequestById(db, pull.pullRequestId);
  if (row?.mergeable === "conflict") {
    return { kind: "host_refuses", reason: "The branch has conflicts with its base that must be resolved first." };
  }

  // The second tier: named, acceptable, never silent.
  const blockers = acceptableBlockers(readiness, row);
  if (blockers.length > 0 && !input.acknowledgeBlockers) {
    return { kind: "blockers_outstanding", blockers };
  }

  let merged: { sha: string | null };
  try {
    merged = await provider.mergePullRequest(pull.providerRepoId, pull.number, input.method);
  } catch (error) {
    if (error instanceof MergeRefusedError) return { kind: "host_refuses", reason: error.message };
    throw error;
  }

  // The host performed it; ingest the host's own account immediately.
  const host = await provider.getPullRequest(pull.providerRepoId, pull.number).catch(() => null);
  await withMission(db, pull.missionId, async (client) => {
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
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: {
        pullRequestId: pull.pullRequestId,
        number: pull.number,
        method: input.method,
        sha: merged.sha,
        // Exactly what was accepted, durable: "merged with two open
        // comments" is a sentence, never a secret (D-100).
        acceptedBlockers: blockers
      }
    });
  });
  return { kind: "merged", sha: merged.sha };
}

/** Update the branch from its base — the host does the work; the act is recorded. */
export async function updateBranch(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward
): Promise<void> {
  await provider.updatePullRequestBranch(pull.providerRepoId, pull.number);
  await recordAct(db, pull, by, "pr.branch_updated", {});
}

/** Close without merging: the host's act, reflected and recorded. */
export async function closePull(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward
): Promise<void> {
  await provider.closePullRequest(pull.providerRepoId, pull.number);
  await withMission(db, pull.missionId, async (client) => {
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
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number }
    });
  });
}

/** Delete the resolved request's remote branch, recording which one. */
export async function deleteBranch(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  headRef: string
): Promise<void> {
  await provider.deleteBranchRef(pull.providerRepoId, headRef);
  await recordAct(db, pull, by, "pr.branch_deleted", { branch: headRef });
}

/**
 * Sends a comment to the host as the person where their token is held
 * (D-101), as the App with in-body attribution otherwise. The token never
 * leaves this process: read here, handed to the provider call, never stored
 * anywhere new and never logged.
 */
export async function sendComment(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  input: { body: string; path?: string; line?: number }
): Promise<void> {
  const tokenRow = await db.query("select github_token from users where user_id = $1", [by.userId]);
  const userToken = (tokenRow.rows[0]?.github_token as string | null | undefined) ?? null;
  const asUser = userToken ? { token: userToken, login: by.login } : undefined;
  await provider.createPullComment(
    pull.providerRepoId,
    pull.number,
    {
      body: asUser ? input.body : `**${by.login} via Novus:** ${input.body}`,
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.line !== undefined ? { line: input.line } : {})
    },
    asUser
  );
  await recordAct(db, pull, by, "pr.comment_sent", {
    path: input.path ?? null,
    line: input.line ?? null,
    // Whether the host saw the person or the App as the author (D-101).
    authoredAs: asUser ? "user" : "app"
  });
}

/** Resolves one review thread on the host and reflects it immediately rather
 *  than waiting a poll: the person just did it. */
export async function resolveThread(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  threadId: string
): Promise<void> {
  await provider.resolveReviewThread(pull.providerRepoId, threadId);
  await withTransaction(db, async (client) => {
    await client.query(
      `update pull_requests
          set review_threads = (
            select coalesce(jsonb_agg(
              case when thread->>'threadId' = $2 then jsonb_set(thread, '{state}', '"resolved"') else thread end
            ), '[]'::jsonb)
            from jsonb_array_elements(review_threads) as thread
          )
        where pr_id = $1`,
      [pull.pullRequestId, threadId]
    );
    await recordEvent(client, {
      orgId: pull.orgId,
      missionId: pull.missionId,
      workstreamId: pull.workstreamId,
      kind: "pr.thread_resolved",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: { pullRequestId: pull.pullRequestId, number: pull.number, threadId }
    });
  });
}

/**
 * Edits the request's title, description, or labels on the host. The stored
 * title and labels follow the host; the stored body stays the snapshot of
 * what was *sent* at publication — that is the receipt, and editing the
 * host's description does not rewrite history (D-100).
 */
export async function editMetadata(
  db: Db,
  provider: RepositoryProvider,
  pull: PullContext,
  by: Steward,
  input: { title?: string; body?: string; labels?: string[] }
): Promise<void> {
  await provider.setPullRequestMetadata(pull.providerRepoId, pull.number, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {})
  });
  await withTransaction(db, async (client) => {
    if (input.title !== undefined) {
      await client.query(`update pull_requests set title = $2 where pr_id = $1`, [
        pull.pullRequestId,
        input.title
      ]);
    }
    if (input.labels !== undefined) {
      await client.query(`update pull_requests set labels = $2::jsonb where pr_id = $1`, [
        pull.pullRequestId,
        JSON.stringify(input.labels.slice(0, 20))
      ]);
    }
    await recordEvent(client, {
      orgId: pull.orgId,
      missionId: pull.missionId,
      workstreamId: pull.workstreamId,
      kind: "pr.metadata_edited",
      actorKind: "user",
      actorId: by.userId,
      actorLogin: by.login,
      causeLeaseId: by.leaseId,
      payload: {
        pullRequestId: pull.pullRequestId,
        number: pull.number,
        edited: [
          ...(input.title !== undefined ? ["title"] : []),
          ...(input.body !== undefined ? ["description"] : []),
          ...(input.labels !== undefined ? ["labels"] : [])
        ]
      }
    });
  });
}

// --- Ingestion ---------------------------------------------------------------

/**
 * One poll pass over every open request (D-099): read the host's story, and
 * record what changed as events with `actor.kind: external` — the host is a
 * source Novus quotes, never an authority it invents. Poll-first because a
 * local-first control plane has no public webhook endpoint; a deployed one
 * grows webhooks with the same ingestion underneath (ARCHITECTURE.md).
 */
export interface SyncRow {
  pr_id: string;
  org_id: string;
  mission_id: string;
  wst_id: string;
  provider_number: number;
  state: string;
  mergeable: string;
  review_threads: unknown;
  provider_repo_id: string;
}

export const SYNC_SELECT = `select p.pr_id, p.org_id, p.mission_id, p.wst_id, p.provider_number, p.state, p.mergeable,
            p.review_threads, repo.provider_repo_id
       from pull_requests p
       join workstreams w on w.wst_id = p.wst_id
       join repositories repo on repo.repo_id = w.repo_id`;

export async function sweepPullRequestsOnce(db: Db, provider: RepositoryProvider): Promise<void> {
  const open = await db.query(`${SYNC_SELECT} where p.state in ('draft', 'ready')`);
  for (const row of open.rows as SyncRow[]) {
    await syncPullRow(db, provider, row);
  }
}

/** One request's sync — the sweep's body, callable for a single row so a
 *  webhook can poke exactly the request the host says changed (D-101). */
export async function syncPullRow(db: Db, provider: RepositoryProvider, row: SyncRow): Promise<void> {
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
    return;
  }
  const openThreads = host.reviewThreads.filter((thread) => thread.state === "open").length;

  await withMission(db, row.mission_id, async (client) => {
    // The comparison baseline is read under the lock, not from the caller's
    // snapshot: two deliveries for one merge arrive concurrently, and both
    // would measure change against the same stale 'ready' otherwise —
    // recording the merge twice.
    const held = await client.query(
      "select state, mergeable, review_threads from pull_requests where pr_id = $1",
      [row.pr_id]
    );
    if (held.rowCount === 0) return;
    const before = held.rows[0] as Pick<SyncRow, "state" | "mergeable" | "review_threads">;
    const knownThreads = Array.isArray(before.review_threads)
      ? (before.review_threads as unknown[]).length
      : 0;
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
    if (host.state === "merged" && before.state !== "merged") {
      await record("pr.merged", { mergedBy: host.mergedBy });
    } else if (host.state === "closed" && before.state !== "closed") {
      await record("pr.closed", {});
    } else if (host.state === "ready" && before.state === "draft") {
      // Marked ready on the host itself rather than through Novus — still
      // the host's news, still recorded.
      await record("pr.marked_ready_externally", {});
    }
    if (host.mergeable === "conflict" && before.mergeable !== "conflict") {
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
