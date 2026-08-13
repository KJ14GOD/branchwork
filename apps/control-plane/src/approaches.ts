import type { FastifyInstance } from "fastify";
import {
  CreateApproachInputSchema,
  EnabledSkillsSchema,
  RecordDecisionInputSchema,
  RequestRevisionInputSchema,
  type ApproachSummary,
  type ContestedPath,
  type Decision,
  type MissionState,
  type PreparedPullRequest,
  type VerificationCheck,
  type Workstream
} from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newDecisionId, newLeaseId, newWorkstreamId } from "./ids.ts";
import { insertSession } from "./sessions.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: competing approaches and the decision between them (D-074, D-075).
 * Paths owned here:
 *
 *   POST /missions/:missionId/approaches        (approach.create)
 *   POST /missions/:missionId/decision          (review.approve)
 *   POST /missions/:missionId/revision          (review.approve)
 *
 * Three rules carry this module's weight:
 *
 *  - **An approach is a sibling, not a fork of authority.** It gets its own
 *    branch, its own lease held by whoever created it, and its own everything.
 *    It never touches the lane it forked from.
 *  - **Nothing is scored.** There is no code path here that compares two
 *    approaches and prefers one. `summarizeApproaches` reports each lane's own
 *    evidence in the same shape; the ordering is creation order and nothing
 *    else (PRODUCT.md#scope-and-non-goals).
 *  - **Choosing is not applying.** Recording a decision writes a row and moves
 *    no code anywhere. What Novus prepares afterwards is a *projection* of a
 *    pull request nobody has opened.
 */

const MissionParams = z.object({ missionId: z.string().startsWith("msn_") });

/** How many lanes one mission may hold. Not a product rule about ambition —
 *  a bound so a loop cannot mint branches without end. */
const MAX_LANES = 8;

// --- Reading -----------------------------------------------------------------

export async function listWorkstreams(db: Db, missionId: string): Promise<Workstream[]> {
  const result = await db.query(
    `select * from workstreams where mission_id = $1 order by created_at, wst_id`,
    [missionId]
  );
  return result.rows.map(toWorkstream);
}

export function toWorkstream(row: Record<string, unknown>): Workstream {
  return {
    workstreamId: row.wst_id as string,
    missionId: row.mission_id as string,
    name: row.name as string,
    baseRef: row.base_ref as string,
    baseSha: row.base_sha as string,
    missionBranch: row.mission_branch as string,
    branchStatus: row.branch_status as Workstream["branchStatus"],
    branchError: (row.branch_error as string | null) ?? null,
    approach: Boolean(row.approach_flag),
    intent: (row.intent as string | null) ?? null,
    forkedFromWorkstreamId: (row.forked_from_wst_id as string | null) ?? null,
    originSha: (row.origin_sha as string | null) ?? null,
    remoteHeadSha: (row.remote_head_sha as string | null) ?? null,
    // The lane's standing answer policy (D-115); the DB CHECK owns validity.
    permissionProfile:
      (row.permission_profile as Workstream["permissionProfile"] | null) ?? "manual",
    // The skills a person enabled on this lane (D-118); malformed reads none.
    enabledSkills: EnabledSkillsSchema.catch([]).parse(row.enabled_skills ?? [])
  };
}

/**
 * Everything the comparison reads, already attributed to a lane by the caller.
 *
 * Deliberately not the contract shapes: a checkpoint knows its execution and an
 * execution knows its workstream, and doing that join here would put a second
 * copy of that mapping in the one module that must not get it wrong.
 */
export interface ApproachInputs {
  workstreams: Workstream[];
  executions: {
    workstreamId: string;
    startedAt: string | null;
    endedAt: string | null;
    usage: ApproachSummary["usage"];
  }[];
  checkpoints: {
    workstreamId: string | null;
    sha: string | null;
    additions: number;
    deletions: number;
    paths: string[];
  }[];
  checks: { workstreamId: string | null; outcome: VerificationCheck["outcome"]; stale: boolean }[];
  directions: { workstreamId: string }[];
  approvalsAnswered: { workstreamId: string }[];
  stops: { workstreamId: string }[];
  controllers: Map<string, string | null>;
  stateOf: (workstreamId: string) => MissionState;
}

/**
 * Each lane's own evidence, in one shape, in creation order.
 *
 * Read the ordering rule literally: creation order, always. Sorting by checks
 * passed, by files changed, or by anything else would be a ranking, and a
 * ranking is a recommendation however carefully it is worded (D-074).
 */
export function summarizeApproaches(input: ApproachInputs): ApproachSummary[] {
  return input.workstreams.map((workstream) => {
    const lane = workstream.workstreamId;
    const executions = input.executions.filter((execution) => execution.workstreamId === lane);
    const checkpoints = input.checkpoints.filter((checkpoint) => checkpoint.workstreamId === lane);
    const latest = [...checkpoints].reverse().find((checkpoint) => checkpoint.sha !== null) ?? null;
    const checks = input.checks.filter((check) => check.workstreamId === lane);
    // Split so that what did not happen is as countable as what did: a check
    // that errored, was skipped, or proves a revision this lane has moved past
    // is *not* evidence for what is there now (PRODUCT.md#domain-model).
    const passed = checks.filter((check) => check.outcome === "passed" && !check.stale).length;
    const failed = checks.filter((check) => check.outcome === "failed" && !check.stale).length;
    const unresolved = checks.length - passed - failed;

    const usage = executions.reduce(
      (total, execution) => ({
        inputTokens: add(total.inputTokens, execution.usage.inputTokens),
        outputTokens: add(total.outputTokens, execution.usage.outputTokens),
        cacheReadTokens: add(total.cacheReadTokens, execution.usage.cacheReadTokens),
        cacheCreationTokens: add(total.cacheCreationTokens, execution.usage.cacheCreationTokens),
        costUsd: add(total.costUsd, execution.usage.costUsd),
        durationMs: add(total.durationMs, execution.usage.durationMs),
        turns: add(total.turns, execution.usage.turns)
      }),
      {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        durationMs: null,
        turns: null
      } as ApproachSummary["usage"]
    );

    const paths = [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.paths))].sort();
    return {
      workstreamId: lane,
      name: workstream.name,
      intent: workstream.intent,
      approach: workstream.approach,
      missionBranch: workstream.missionBranch,
      originSha: workstream.originSha,
      // One rule, computed here and enforced by the creation route: a fork
      // beside this lane starts from what this lane *shares* — its own origin
      // where it has one, its latest checkpoint otherwise (D-079).
      forkPointSha: sharedForkPoint(
        { approach: workstream.approach, originSha: workstream.originSha },
        latest?.sha ?? null
      ),
      state: input.stateOf(lane),
      controllerLogin: input.controllers.get(lane) ?? null,
      checkpointSha: latest?.sha ?? null,
      filesChanged: paths.length,
      additions: checkpoints.reduce((sum, checkpoint) => sum + checkpoint.additions, 0),
      deletions: checkpoints.reduce((sum, checkpoint) => sum + checkpoint.deletions, 0),
      paths: paths.slice(0, 200),
      checksRun: checks.length,
      checksPassed: passed,
      checksFailed: failed,
      unresolvedChecks: unresolved,
      directions: input.directions.filter((direction) => direction.workstreamId === lane).length,
      approvalsAnswered: input.approvalsAnswered.filter((approval) => approval.workstreamId === lane).length,
      stops: input.stops.filter((stop) => stop.workstreamId === lane).length,
      usage,
      startedAt: executions[0]?.startedAt ?? null,
      endedAt: executions[executions.length - 1]?.endedAt ?? null
    };
  });
}

function add(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return (current ?? 0) + value;
}

/**
 * The checkpoint a new approach created beside this lane starts from (D-079).
 *
 * An approach forks from the last checkpoint the read lane *shares* with the
 * lane it was itself created beside — which for an approach is its recorded
 * origin, and for the lane the mission started with is simply its latest
 * checkpoint. Work that exists only in the lane being read stays there: a
 * sibling that inherited it would not be a competing approach to the same
 * problem, it would be a continuation wearing the name.
 */
export function sharedForkPoint(
  lane: { approach: boolean; originSha: string | null },
  latestCheckpointSha: string | null
): string | null {
  if (lane.approach && lane.originSha !== null) return lane.originSha;
  return latestCheckpointSha;
}

/** Files more than one lane changed. Novus points at them and merges nothing. */
export function contestedPaths(approaches: ApproachSummary[]): ContestedPath[] {
  if (approaches.length < 2) return [];
  const byPath = new Map<string, string[]>();
  for (const approach of approaches) {
    for (const path of approach.paths) {
      byPath.set(path, [...(byPath.get(path) ?? []), approach.workstreamId]);
    }
  }
  return [...byPath.entries()]
    .filter(([, lanes]) => lanes.length > 1)
    .map(([path, workstreamIds]) => ({ path, workstreamIds }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function listDecisions(db: Db, missionId: string): Promise<Decision[]> {
  const result = await db.query(
    `select d.*, u.login from decisions d join users u on u.user_id = d.decided_by
      where d.mission_id = $1 order by d.decided_at, d.dec_id`,
    [missionId]
  );
  return result.rows.map((row) => ({
    decisionId: row.dec_id as string,
    missionId: row.mission_id as string,
    workstreamId: row.wst_id as string,
    checkpointSha: (row.checkpoint_sha as string | null) ?? null,
    decidedBy: row.decided_by as string,
    decidedByLogin: row.login as string,
    rationale: row.rationale as string,
    acceptedRisks: (row.accepted_risks as string | null) ?? null,
    unresolvedCheckIds: (row.unresolved_check_ids as string[]) ?? [],
    unresolvedSummary: (row.unresolved_summary as string[]) ?? [],
    decidedAt: (row.decided_at as Date).toISOString(),
    supersededAt: row.superseded_at ? (row.superseded_at as Date).toISOString() : null
  }));
}

/**
 * The pull request a decision *would* open (D-075).
 *
 * A projection, computed on read, never stored and never sent. It says what
 * was decided, why, what risk was accepted, and what was never verified —
 * because a pull request that omitted the last one would be the claim this
 * product exists to not make.
 */
export function preparePullRequest(
  goal: string,
  decision: Decision | null,
  approach: ApproachSummary | undefined,
  workstream: Workstream | undefined,
  provider: string | null
): PreparedPullRequest | null {
  if (!decision || !approach || !workstream) return null;
  const lines = [
    `## What this is`,
    "",
    goal,
    "",
    `## Why this approach`,
    "",
    decision.rationale,
    ""
  ];
  if (approach.intent) lines.push(`Its stated intent was: ${approach.intent}`, "");
  lines.push(`## Evidence`, "");
  lines.push(
    `- ${approach.filesChanged} file${approach.filesChanged === 1 ? "" : "s"} changed (+${approach.additions} −${approach.deletions})`
  );
  lines.push(
    approach.checksRun === 0
      ? "- No verification ran against this revision."
      : `- ${approach.checksPassed} check${approach.checksPassed === 1 ? "" : "s"} passed, ${approach.checksFailed} failed, ${approach.unresolvedChecks} unresolved`
  );
  if (approach.checkpointSha) lines.push(`- Chosen revision: \`${approach.checkpointSha}\``);
  lines.push("");
  lines.push(`## Not verified`, "");
  lines.push(
    decision.unresolvedSummary.length === 0
      ? "Nothing was recorded as unresolved when this was decided."
      : decision.unresolvedSummary.map((entry) => `- ${entry}`).join("\n")
  );
  lines.push("");
  if (decision.acceptedRisks) lines.push(`## Accepted risk`, "", decision.acceptedRisks, "");
  lines.push(
    `Decided by ${decision.decidedByLogin} on ${decision.decidedAt.slice(0, 10)} in Novus. Prepared, not published: nothing here has been sent to a repository host, and no merge has happened.`
  );
  return {
    title: goal.length > 72 ? `${goal.slice(0, 71)}…` : goal,
    body: lines.join("\n"),
    baseRef: workstream.baseRef,
    headRef: workstream.missionBranch,
    // A local folder has no host to receive this, and the surface says so
    // rather than offering an action that could only fail.
    publishable: provider === "github"
  };
}

// --- Writing -----------------------------------------------------------------

export function registerApproachRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/approaches", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    const body = CreateApproachInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const message = body.success
        ? "Malformed mission id."
        : body.error.issues[0]?.message ?? "Malformed approach.";
      return deps.sendError(reply, params.success ? 422 : 400, "invalid_approach", message);
    }
    // Resolved against the lane being forked, so a mission with several lanes
    // cannot be forked from one the caller named but does not belong to.
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.fromWorkstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "approach.create");

    const outcome = await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      const lanes = await client.query(
        `select wst_id, repo_id, base_ref, base_sha, branch_status, approach_flag, origin_sha
           from workstreams where mission_id = $1 order by created_at`,
        [access.missionId]
      );
      if ((lanes.rowCount ?? 0) >= MAX_LANES) return { error: "too_many_lanes" as const };
      const source = lanes.rows.find((row) => row.wst_id === body.data.fromWorkstreamId);
      if (!source) return { error: "no_source" as const };

      // The origin: the exact revision this approach starts from — the last
      // checkpoint the source lane shares with the lane *it* forked beside,
      // never the source's own later work (D-079). Without one there is
      // nothing to have started beside, and a comparison would be between two
      // different problems (D-074).
      const checkpoint = await client.query(
        `select c.sha from checkpoints c
           join executions e on e.exe_id = c.exe_id
          where e.wst_id = $1 and c.sha is not null
          order by c.created_at desc limit 1`,
        [body.data.fromWorkstreamId]
      );
      const originSha = sharedForkPoint(
        {
          approach: Boolean(source.approach_flag),
          originSha: (source.origin_sha as string | null) ?? null
        },
        (checkpoint.rows[0]?.sha as string | undefined) ?? null
      );
      if (originSha === null) return { error: "nothing_to_fork" as const };
      // The revision the person was shown is the revision they get, or nothing:
      // silently forking from a checkpoint nobody looked at is how "changes
      // made only in the current lane stay there" stops being true (D-079).
      if (body.data.expectedOriginSha && body.data.expectedOriginSha !== originSha) {
        return { error: "origin_moved" as const, originSha };
      }

      const workstreamId = newWorkstreamId();
      const ordinal = (lanes.rowCount ?? 0) + 1;
      // Named beside its sibling rather than replacing it: the branch says
      // which mission and which lane, and the server allocates both (D-031).
      const missionBranch = `novus/m-${access.missionId.slice(4, 12)}-a${ordinal}`;
      await client.query(
        `insert into workstreams (wst_id, mission_id, repo_id, name, approach_flag, intent,
                                  forked_from_wst_id, origin_sha, base_ref, base_sha,
                                  mission_branch, branch_status)
         values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, 'pending')`,
        [
          workstreamId,
          access.missionId,
          source.repo_id,
          // "Alternative", then "Alternative 2": the first lane already reads
          // as the current work, and a fork is an alternative to it (D-079).
          body.data.name ?? (ordinal === 2 ? "Alternative" : `Alternative ${ordinal - 1}`),
          body.data.intent,
          body.data.fromWorkstreamId,
          originSha,
          // The approach's base is the revision it forked at, recorded as its
          // own base so every downstream guard reads one number.
          source.base_ref,
          originSha,
          missionBranch
        ]
      );
      // Every workstream holds at least one session, born with it (D-083).
      await insertSession(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        createdBy: ctx.userId
      });
      // Its own lease, held by whoever created it: a lane is never born
      // without a controller (PRODUCT.md#control), and forking does not move
      // the baton on the lane that was forked.
      const leaseId = newLeaseId();
      await client.query(
        `insert into control_leases (lease_id, org_id, mission_id, wst_id, holder_user_id, state)
           values ($1, $2, $3, $4, $5, 'held')`,
        [leaseId, access.orgId, access.missionId, workstreamId, ctx.userId]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        kind: "approach.created",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: {
          intent: body.data.intent,
          forkedFrom: body.data.fromWorkstreamId,
          originSha,
          missionBranch
        }
      });
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        kind: "control.granted",
        actorKind: "system",
        actorId: "control-plane",
        causeLeaseId: leaseId,
        payload: { holderLogin: ctx.login, reason: "approach_created" }
      });
      return { workstreamId, missionBranch, originSha };
    });

    if ("error" in outcome) {
      if (outcome.error === "too_many_lanes") {
        return deps.sendError(reply, 409, "too_many_approaches", "This mission already has as many approaches as Novus carries.");
      }
      if (outcome.error === "no_source") {
        return deps.sendError(reply, 404, "not_found", "No such workstream in this mission.");
      }
      if (outcome.error === "origin_moved") {
        return deps.sendError(
          reply,
          409,
          "origin_moved",
          `The shared checkpoint moved to ${outcome.originSha.slice(0, 8)} since you looked. Nothing was created — review the new checkpoint and start the approach again.`
        );
      }
      return deps.sendError(
        reply,
        409,
        "nothing_to_fork",
        "There is no shared checkpoint to start from yet — this lane has not checkpointed any work."
      );
    }

    // The branch is cut on the machine that holds the checkout and reported
    // back, whichever provider the repository came from: the origin is a
    // checkpoint a runner committed locally, so the provider has never seen
    // the commit and is never asked (D-080). The lane stays `pending` until a
    // machine reports.
    const created = await deps.db.query("select * from workstreams where wst_id = $1", [
      outcome.workstreamId
    ]);
    reply.code(201);
    return { workstream: toWorkstream(created.rows[0]) };
  });

  app.post("/missions/:missionId/decision", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    const body = RecordDecisionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const message = body.success
        ? "Malformed mission id."
        : body.error.issues[0]?.message ?? "Malformed decision.";
      return deps.sendError(reply, params.success ? 422 : 400, "invalid_decision", message);
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "review.approve");

    const decided = await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      const checkpoint = await client.query(
        `select c.sha from checkpoints c
           join executions e on e.exe_id = c.exe_id
          where e.wst_id = $1 and c.sha is not null
          order by c.created_at desc limit 1`,
        [body.data.workstreamId]
      );
      const checkpointSha = (checkpoint.rows[0]?.sha as string | undefined) ?? null;
      const unresolved = await unresolvedChecksFor(client, body.data.workstreamId, checkpointSha);

      // A later decision supersedes an earlier one and neither is rewritten:
      // reversals are part of the record (D-075).
      await client.query(
        "update decisions set superseded_at = now() where mission_id = $1 and superseded_at is null",
        [access.missionId]
      );
      const decisionId = newDecisionId();
      await client.query(
        `insert into decisions (dec_id, org_id, mission_id, wst_id, checkpoint_sha, decided_by,
                                rationale, accepted_risks, unresolved_check_ids, unresolved_summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
        [
          decisionId,
          access.orgId,
          access.missionId,
          body.data.workstreamId,
          checkpointSha,
          ctx.userId,
          body.data.rationale,
          body.data.acceptedRisks ?? null,
          JSON.stringify(unresolved.ids),
          JSON.stringify(unresolved.summary)
        ]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: body.data.workstreamId,
        kind: "decision.recorded",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: {
          decisionId,
          checkpointSha,
          rationale: body.data.rationale.slice(0, 400),
          acceptedRisks: body.data.acceptedRisks?.slice(0, 400) ?? null,
          unresolved: unresolved.summary.length
        }
      });
      return decisionId;
    });

    reply.code(201);
    return { decisionId: decided };
  });

  app.post("/missions/:missionId/revision", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    const body = RequestRevisionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const message = body.success
        ? "Malformed mission id."
        : body.error.issues[0]?.message ?? "Malformed request.";
      return deps.sendError(reply, params.success ? 422 : 400, "invalid_revision", message);
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "review.approve");

    await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      // Asking for a revision withdraws the current decision rather than
      // sitting beside it: a mission cannot be both decided and awaiting
      // changes, and the record keeps the superseded row.
      await client.query(
        "update decisions set superseded_at = now() where mission_id = $1 and superseded_at is null",
        [access.missionId]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: body.data.workstreamId,
        kind: "revision.requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { reason: body.data.reason.slice(0, 1000) }
      });
    });
    return { ok: true };
  });
}

/**
 * What this lane has *not* verified, at this moment.
 *
 * Everything that is not a pass against the current revision: failures, errors,
 * skips, and passes that prove a revision the lane has moved past. Captured
 * when the decision is made rather than recomputed on read, because the
 * honest question a receipt answers is what was outstanding *then* (D-075).
 */
async function unresolvedChecksFor(
  client: pg.PoolClient,
  workstreamId: string,
  currentSha: string | null
): Promise<{ ids: string[]; summary: string[] }> {
  // By lane, not by execution: a participant-run check has no execution at
  // all, and with a second approach in the mission it would otherwise belong
  // to nothing (D-074).
  const result = await client.query(
    `select v.chk_id, v.name, v.outcome, v.checkpoint_sha
       from verification_checks v
       left join executions e on e.exe_id = v.exe_id
      where coalesce(v.wst_id, e.wst_id) = $1
      order by v.observed_at`,
    [workstreamId]
  );
  const ids: string[] = [];
  const summary: string[] = [];
  for (const row of result.rows) {
    const sha = (row.checkpoint_sha as string | null) ?? null;
    const stale = currentSha === null || sha === null ? sha !== null : sha !== currentSha;
    const passed = row.outcome === "passed" && !stale;
    if (passed) continue;
    ids.push(row.chk_id as string);
    summary.push(
      `${row.name as string} — ${stale && row.outcome === "passed" ? "proved an earlier revision" : (row.outcome as string)}`
    );
  }
  return { ids: ids.slice(0, 200), summary: summary.slice(0, 200) };
}
