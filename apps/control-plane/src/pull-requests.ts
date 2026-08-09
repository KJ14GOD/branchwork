import type { BranchPush, PullRequest, ReviewThread } from "@novus/contracts";
import { ReviewThreadSchema } from "@novus/contracts";
import type { Db } from "./db.ts";

/**
 * The tracked pull request (PRODUCT.md#domain-model, D-099) — reading half.
 *
 * The row starts existing when a request is actually opened on the host
 * (D-075's promise); from then on the mission tracks it. Everything here only
 * SELECTs, like mission-detail: the routes that create and steward one, and
 * the poller that ingests the host's side of the story, live with the route
 * module. There is no merge function in this file or any other — merging
 * happens on GitHub, by humans, and Novus records who.
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
  created_by: string;
  created_by_login?: string;
  merged_by: string | null;
  merged_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  last_synced_at: Date | null;
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
