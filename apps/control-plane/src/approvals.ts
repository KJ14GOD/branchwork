import type { FastifyInstance } from "fastify";
import {
  MAX_APPROVAL_SUMMARY,
  RespondApprovalInputSchema,
  type ApprovalRequest,
  type RunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { Queryable } from "./db.ts";
import { withMission } from "./db.ts";
import { recordEvent } from "./events.ts";
import { activeRunner, enqueueCommand } from "./runners.ts";
import { newApprovalId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: harness approvals (D-056). Paths owned here:
 *
 *   POST /approvals/:approvalId/respond      (lease holder only)
 *
 * The harness asks before it acts, Novus routes the question to the person
 * holding the baton, and the answer travels back as a runner command. Three
 * properties carry the weight:
 *
 *  - **Nothing is auto-approved.** There is no path in this module that settles
 *    a request as approved without a named person and a compare-and-swap.
 *  - **Settlement is once.** Every transition is a CAS on `state = 'pending'`,
 *    so a duplicate answer, a late answer, and two clients answering at once
 *    all resolve to one outcome and one runner command.
 *  - **Authority is read at command time**, not when the question was asked. If
 *    control transfers while a request is open, the new controller may answer
 *    and the previous one may not — with no state to migrate, because the
 *    capability is computed from the current lease (ARCHITECTURE.md#authorization).
 */

const ApprovalParamsSchema = z.object({ approvalId: z.string().startsWith("apr_") });

/** Non-terminal execution states, from the same list the rest of the control
 *  plane uses; a terminal execution never moves again. */
const LIVE_EXECUTION_STATES = [
  "requested",
  "starting",
  "running",
  "needs_direction",
  "needs_approval",
  "stopping"
];

/**
 * Why a pending request ended without an answer.
 *
 * `cancelled` and `expired` are separated on purpose. Cancelled means the work
 * ended for a reason of its own — a Stop, a completion, a failure, the host
 * quitting — and the question stopped mattering. Expired means the machine that
 * asked was declared gone by the liveness sweep, so no answer could ever have
 * reached it. Both are honest; they are not the same fact, and a receipt that
 * conflated them could not say whether anybody was ever asked.
 */
export type ApprovalSettlement = "cancelled" | "expired";

export interface SettleArgs {
  orgId: string;
  missionId: string;
  workstreamId: string;
  executionId: string;
  outcome: ApprovalSettlement;
  reason: string;
}

/**
 * Ends every open question for one execution.
 *
 * Called from each path that ends an execution — the runner's terminal report,
 * the Stop route on both its branches, and the runner-liveness sweep — so a
 * request can never outlive the turn it belongs to and sit pending for ever in
 * a room nobody can answer from. Idempotent: the CAS finds nothing the second
 * time.
 */
export async function settlePendingApprovals(
  client: pg.PoolClient,
  args: SettleArgs
): Promise<number> {
  const settled = await client.query(
    `update approval_requests
        set state = $2, responded_at = now(), resolution = $3
      where exe_id = $1 and state = 'pending'
      returning apr_id, harness_request_id, tool_name`,
    [args.executionId, args.outcome, args.reason.slice(0, 400)]
  );
  for (const row of settled.rows) {
    await recordEvent(client, {
      orgId: args.orgId,
      missionId: args.missionId,
      workstreamId: args.workstreamId,
      executionId: args.executionId,
      kind: "approval.settled",
      actorKind: "system",
      actorId: "control-plane",
      payload: {
        approvalId: row.apr_id as string,
        toolName: row.tool_name as string,
        outcome: args.outcome,
        reason: args.reason.slice(0, 400)
      }
    });
  }
  return settled.rowCount ?? 0;
}

/**
 * Records a question the harness is blocked on, and puts the execution into
 * *Needs approval* so the room says so.
 *
 * The insert is idempotent on (execution, harness request id): a replayed
 * report of the same question is the same row. The state change is guarded on
 * the execution still being live, because a report that arrives after a Stop
 * must not reopen it — the same rule every other runner-reported side effect
 * follows (D-053).
 */
export async function recordApprovalRequest(
  client: pg.PoolClient,
  ctx: { orgId: string; missionId: string; workstreamId: string; runnerId: string },
  executionId: string,
  payload: Extract<RunnerEvent, { kind: "approval.requested" }>["payload"]
): Promise<void> {
  await client.query(
    `insert into approval_requests (apr_id, org_id, mission_id, wst_id, exe_id, runner_id,
                                    harness_request_id, tool_use_id, tool_name, display_name,
                                    summary, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     on conflict (exe_id, harness_request_id) do nothing`,
    [
      newApprovalId(),
      ctx.orgId,
      ctx.missionId,
      ctx.workstreamId,
      executionId,
      ctx.runnerId,
      payload.requestId,
      payload.toolUseId,
      payload.toolName,
      payload.displayName,
      // Bounded again here. The runner already bounded it, and a runner is
      // semi-trusted by design (ARCHITECTURE.md#the-three-planes).
      payload.summary.slice(0, MAX_APPROVAL_SUMMARY)
    ]
  );
  await client.query(
    `update executions set state = 'needs_approval'
      where exe_id = $1 and state = any($2::text[])`,
    [executionId, LIVE_EXECUTION_STATES]
  );
}

/**
 * The harness stopped waiting without an answer — the turn ended, or the
 * protocol interrupt took the question with it. Reported by the runner, so it
 * settles only what is still pending and never contradicts a decision the
 * control plane already recorded.
 */
export async function cancelApprovalByHarnessRequest(
  client: pg.PoolClient,
  ctx: { orgId: string; missionId: string; workstreamId: string },
  executionId: string,
  payload: Extract<RunnerEvent, { kind: "approval.cancelled" }>["payload"]
): Promise<void> {
  const settled = await client.query(
    `update approval_requests
        set state = 'cancelled', responded_at = now(), resolution = $3
      where exe_id = $1 and harness_request_id = $2 and state = 'pending'
      returning apr_id, tool_name`,
    [executionId, payload.requestId, payload.reason.slice(0, 400)]
  );
  const row = settled.rows[0];
  if (!row) return;
  await recordEvent(client, {
    orgId: ctx.orgId,
    missionId: ctx.missionId,
    workstreamId: ctx.workstreamId,
    executionId,
    kind: "approval.settled",
    actorKind: "runner",
    actorId: "runner",
    payload: {
      approvalId: row.apr_id as string,
      toolName: row.tool_name as string,
      outcome: "cancelled",
      reason: payload.reason.slice(0, 400)
    }
  });
  await resumeIfNothingPending(client, executionId);
}

/**
 * A turn with no open question is working again, not waiting. Only moves an
 * execution that is actually in *Needs approval*, and only while it is live: a
 * stopped turn stays stopped however its questions were settled, which is what
 * stops a late approval from resuming something a participant ended.
 */
async function resumeIfNothingPending(client: pg.PoolClient, executionId: string): Promise<void> {
  await client.query(
    `update executions set state = 'running'
      where exe_id = $1 and state = 'needs_approval'
        and not exists (
          select 1 from approval_requests
           where exe_id = $1 and state = 'pending')`,
    [executionId]
  );
}

/** Every question this mission has been asked, oldest first. Settled ones stay:
 *  the record has to be able to answer who allowed what. */
export async function listApprovals(db: Queryable, missionId: string): Promise<ApprovalRequest[]> {
  const result = await db.query(
    `select a.*, u.login as responded_by_login
       from approval_requests a
       left join users u on u.user_id = a.responded_by
      where a.mission_id = $1
      order by a.requested_at, a.apr_id
      limit 200`,
    [missionId]
  );
  return result.rows.map((row) => ({
    approvalId: row.apr_id as string,
    executionId: row.exe_id as string,
    workstreamId: row.wst_id as string,
    harnessRequestId: row.harness_request_id as string,
    toolUseId: (row.tool_use_id as string | null) ?? null,
    toolName: row.tool_name as string,
    displayName: row.display_name as string,
    summary: row.summary as string,
    state: row.state as ApprovalRequest["state"],
    requestedAt: (row.requested_at as Date).toISOString(),
    respondedByLogin: (row.responded_by_login as string | null) ?? null,
    respondedAt: row.responded_at ? (row.responded_at as Date).toISOString() : null,
    resolution: (row.resolution as string | null) ?? null
  }));
}

export function registerApprovalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/approvals/:approvalId/respond", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = ApprovalParamsSchema.safeParse(request.params);
    const body = RespondApprovalInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed approval response.");
    }

    // The approval names its mission; the caller's standing in that mission is
    // then resolved the same way every other command resolves it. An approval
    // id is not a capability: a non-participant is told it does not exist.
    const found = await deps.db.query(
      "select mission_id, exe_id, wst_id, state from approval_requests where apr_id = $1",
      [params.data.approvalId]
    );
    const approval = found.rows[0];
    if (!approval) return deps.sendError(reply, 404, "not_found", "No such approval.");
    // Against the approval's own lane, not the mission's first: control is per
    // lane (D-074), so an Alternative's question is its own baton holder's to
    // answer, and the first lane's controller must not reach across (D-083's
    // routing audit).
    const access = await missionAccess(
      deps.db,
      ctx,
      approval.mission_id as string,
      approval.wst_id as string
    );
    if (!access) return deps.sendError(reply, 404, "not_found", "No such approval.");
    // Lease-held only. A Mission Admin who is not the controller is refused
    // here — they may revoke control and answer, which is visible and logged,
    // but they may not reach around the baton (PRODUCT.md#roles-and-capabilities).
    requireCapability(access, "approval.respond");

    const approved = body.data.decision === "approve";
    const reason = body.data.reason?.trim() || null;

    const outcome = await withMission(deps.db, access.missionId, async (client) => {
      // The same per-mission ordering point every other command takes, so two
      // clients answering at once resolve deterministically rather than both
      // passing the state check.

      // Compare-and-swap on `pending`. Zero rows is the whole story: already
      // answered, cancelled with its turn, or expired with its runner. The
      // second answer changes nothing and enqueues nothing.
      const settled = await client.query(
        `update approval_requests
            set state = $2, responded_by = $3, responded_at = now(), resolution = $4
          where apr_id = $1 and state = 'pending'
          returning exe_id, wst_id, harness_request_id, tool_name, display_name`,
        [
          params.data.approvalId,
          approved ? "approved" : "denied",
          ctx.userId,
          reason ?? (approved ? "Approved by the controller." : "Denied by the controller.")
        ]
      );
      const row = settled.rows[0];
      if (!row) return "already_settled" as const;

      const executionId = row.exe_id as string;
      const workstreamId = row.wst_id as string;

      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId,
        kind: "approval.responded",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: {
          approvalId: params.data.approvalId,
          decision: body.data.decision,
          toolName: row.tool_name as string,
          reason
        }
      });

      // Only a live execution is worth telling. A decision for a turn that has
      // already ended is recorded and goes no further — a late approval must
      // not restart anything, and there is nothing left to unblock.
      const live = await client.query(
        "select 1 from executions where exe_id = $1 and state = any($2::text[])",
        [executionId, LIVE_EXECUTION_STATES]
      );
      if (live.rowCount === 0) return "late" as const;

      const runner = await activeRunner(client, workstreamId);
      const runnerId = runner?.runnerId;
      if (runnerId) {
        await enqueueCommand(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          executionId,
          runnerId,
          kind: "respond_approval",
          payload: {
            approvalId: params.data.approvalId,
            harnessRequestId: row.harness_request_id as string,
            decision: body.data.decision,
            reason
          },
          // One answer, one command, for all time: a retried delivery after a
          // partition lands once (ARCHITECTURE.md#event-model).
          idempotencyKey: `approval:${params.data.approvalId}`
        });
      }

      await resumeIfNothingPending(client, executionId);
      return "settled" as const;
    });

    if (outcome === "already_settled") {
      return deps.sendError(
        reply,
        409,
        "already_settled",
        "That approval has already been answered."
      );
    }
    return { ok: true };
  });
}
