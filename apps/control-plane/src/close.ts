import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  CloseMissionInputSchema,
  ExecutionStateSchema,
  ReceiptSnapshotSchema,
  TERMINAL_EXECUTION_STATES,
  type ReceiptSnapshot
} from "@novus/contracts";
import { receiptArtifacts } from "./artifacts.ts";
import { missionAccess, require as requireCapability, type MissionAccess } from "./authz.ts";
import { withMission } from "./db.ts";
import { recordEvent } from "./events.ts";
import { standingDecision } from "./approaches.ts";
import { enqueueCommand } from "./runners.ts";
import { newReceiptId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * Ending a mission's work (D-121): the terminal lifecycle PRODUCT.md has
 * always named and nothing implemented. Two endings, one verb:
 *
 *  - **completed** — the result was accepted. Gated on its own meaning: a
 *    standing decision must exist (a result nobody chose is not accepted),
 *    and no pull request may still be open (resolved means resolved).
 *  - **cancelled** — deliberately ended without acceptance, with the person's
 *    own words about what was abandoned carried on the event and the receipt.
 *
 * Both borrow archival's refusals verbatim (D-063): a waiting approval is
 * checked first because "answer it" is the useful instruction, a stillborn
 * `requested` execution is ended on the way out rather than wedging the
 * mission, and genuinely live work refuses in words. Closing is Mission
 * Admin's alone (`mission.close`), and it is a different act from archival:
 * archival files the record away and ends nothing; closing ends the work and
 * files nothing away.
 *
 * At close the mission's **receipt** is snapshotted (ARCHITECTURE.md
 * #persistence): a deterministic projection of durable state with the event
 * range it covers — same rows, same receipt — validated through the contract
 * schema before it is stored, and served back verbatim on the detail. A
 * terminal state never resumes: the operating verbs check `closed_at` and
 * refuse in words, and an invitation redeemed afterwards joins as a Viewer
 * (ARCHITECTURE.md failure mode 13), which the redemption route enforces.
 */

const ACTIVE_STATES: string[] = ExecutionStateSchema.options.filter(
  (state) => !TERMINAL_EXECUTION_STATES.includes(state)
);

/**
 * The receipt, projected from durable rows only. Exported so the determinism
 * claim is testable: projecting twice over unchanged rows must give the same
 * snapshot, byte for byte once serialized.
 */
export async function projectReceipt(
  client: pg.PoolClient,
  access: MissionAccess,
  closing: {
    outcome: "completed" | "cancelled";
    reason: string | null;
    closedByLogin: string;
    closedAt: string;
  }
): Promise<ReceiptSnapshot> {
  const missionId = access.missionId;
  const mission = await client.query(
    "select goal, success_criteria from missions where mission_id = $1",
    [missionId]
  );
  const participants = await client.query(
    `select u.login, p.mission_role from participants p
       join users u on u.user_id = p.user_id
      where p.mission_id = $1 order by p.created_at, u.login limit 50`,
    [missionId]
  );
  const applied = await client.query(
    "select count(*)::int as n from directions where mission_id = $1 and state = 'applied'",
    [missionId]
  );
  const decisions = await client.query(
    `select w.name, d.checkpoint_sha, d.rationale, d.accepted_risks, u.login, d.decided_at,
            d.superseded_at is not null as superseded, d.artifact_ids
       from decisions d
       join workstreams w on w.wst_id = d.wst_id
       join users u on u.user_id = d.decided_by
      where d.mission_id = $1 order by d.decided_at, d.dec_id limit 20`,
    [missionId]
  );
  const churn = await client.query(
    `select (select count(distinct fc.path)::int from file_changes fc where fc.mission_id = $1) as files,
            (select coalesce(sum(c.additions), 0)::int from checkpoints c where c.mission_id = $1) as adds,
            (select coalesce(sum(c.deletions), 0)::int from checkpoints c where c.mission_id = $1) as dels`,
    [missionId]
  );
  // The ledger's final rows, each stating whether it still proved a lane's
  // current head at the moment of closing — the staleness rule, frozen.
  const checks = await client.query(
    `select v.name, v.outcome, v.origin, v.checkpoint_sha,
            v.checkpoint_sha is not null and v.checkpoint_sha = head.sha as current_at_close
       from verification_checks v
       left join lateral (
         select c.sha from checkpoints c
          where c.wst_id = coalesce(v.wst_id, (select e.wst_id from executions e where e.exe_id = v.exe_id))
            and c.sha is not null
          order by c.created_at desc limit 1
       ) head on true
      where v.mission_id = $1 order by v.observed_at, v.chk_id limit 100`,
    [missionId]
  );
  // What remains uncertain, mechanically: current-head checks that did not
  // pass, and lanes whose work no current check proves at all.
  const uncertain: string[] = [];
  for (const row of checks.rows) {
    if (row.current_at_close && row.outcome !== "passed") {
      uncertain.push(`"${row.name}" was ${row.outcome} against the latest work`.slice(0, 300));
    }
  }
  const unproven = await client.query(
    `select w.name from workstreams w
      where w.mission_id = $1
        and exists (select 1 from checkpoints c where c.wst_id = w.wst_id and c.sha is not null)
        and not exists (
          select 1 from verification_checks v
           where v.mission_id = $1
             and coalesce(v.wst_id, (select e.wst_id from executions e where e.exe_id = v.exe_id)) = w.wst_id
             and v.checkpoint_sha = (select c2.sha from checkpoints c2
                                      where c2.wst_id = w.wst_id and c2.sha is not null
                                      order by c2.created_at desc limit 1)
        )
      order by w.created_at limit 10`,
    [missionId]
  );
  for (const row of unproven.rows) {
    uncertain.push(`no check ran against ${row.name}'s latest work`.slice(0, 300));
  }
  const pull = await client.query(
    `select p.provider_number, p.state, p.url, p.merged_by, p.merged_at from pull_requests p
      where p.mission_id = $1 order by p.created_at desc limit 1`,
    [missionId]
  );
  // The conversations the work happened in (D-234), each with the harness
  // its latest turn ran on and how many directions it took.
  const sessions = await client.query(
    `select w.name as workstream_name, s.title, u.login,
            (select e.harness from executions e where e.session_id = s.csn_id
              order by e.created_at desc limit 1) as harness,
            (select count(*)::int from directions d where d.session_id = s.csn_id) as directions
       from workstream_sessions s
       join workstreams w on w.wst_id = s.wst_id
       join users u on u.user_id = s.created_by
      where s.mission_id = $1 order by w.created_at, s.created_at, s.csn_id limit 50`,
    [missionId]
  );
  // Every human direction, verbatim (D-234): the record of who steered what.
  const directions = await client.query(
    `select u.login, d.body, w.name as workstream_name, s.title as session_title,
            d.state, d.submitted_at, d.applied_at
       from directions d
       join users u on u.user_id = d.author_user_id
       join workstreams w on w.wst_id = d.wst_id
       left join workstream_sessions s on s.csn_id = d.session_id
      where d.mission_id = $1 order by d.ordinal limit 200`,
    [missionId]
  );
  // Every permission question and its answer (D-234). A policy-decided
  // answer has no responder; the resolution column says which profile.
  const approvals = await client.query(
    `select a.tool_name, a.display_name, a.summary, a.state, a.requested_at, a.responded_at,
            u.login as responded_by_login, a.resolution
       from approval_requests a
       left join users u on u.user_id = a.responded_by
      where a.mission_id = $1 order by a.requested_at, a.apr_id limit 200`,
    [missionId]
  );
  // The files, one row per path (D-234): the last checkpoint's state for the
  // path and the arithmetic summed across every checkpoint that touched it.
  const files = await client.query(
    `select fc.path,
            (array_agg(fc.change_state order by c.created_at desc))[1] as state,
            sum(fc.additions)::int as additions, sum(fc.deletions)::int as deletions
       from file_changes fc
       join checkpoints c on c.ckp_id = fc.ckp_id
      where fc.mission_id = $1
      group by fc.path order by fc.path limit 200`,
    [missionId]
  );
  const range = await client.query(
    "select coalesce(min(seq), 0)::bigint as from_seq, coalesce(max(seq), 0)::bigint as to_seq from events where mission_id = $1",
    [missionId]
  );

  return ReceiptSnapshotSchema.parse({
    goal: mission.rows[0]?.goal ?? "",
    successCriteria: mission.rows[0]?.success_criteria ?? "",
    outcome: closing.outcome,
    closedByLogin: closing.closedByLogin,
    closedAt: closing.closedAt,
    reason: closing.reason,
    participants: participants.rows.map((row) => ({
      login: row.login as string,
      role: row.mission_role as "mission_admin" | "operator" | "contributor" | "viewer"
    })),
    directionsApplied: Number(applied.rows[0]?.n ?? 0),
    decisions: decisions.rows.map((row) => ({
      workstreamName: row.name as string,
      checkpointSha: (row.checkpoint_sha as string | null) ?? null,
      rationale: (row.rationale as string).slice(0, 4000),
      acceptedRisks: ((row.accepted_risks as string | null) ?? null)?.slice(0, 4000) ?? null,
      decidedByLogin: row.login as string,
      decidedAt: (row.decided_at as Date).toISOString(),
      superseded: Boolean(row.superseded),
      artifactIds: ((row.artifact_ids as string[]) ?? []).slice(0, 20)
    })),
    changes: {
      filesChanged: Number(churn.rows[0]?.files ?? 0),
      additions: Number(churn.rows[0]?.adds ?? 0),
      deletions: Number(churn.rows[0]?.dels ?? 0)
    },
    checks: checks.rows.map((row) => ({
      name: (row.name as string).slice(0, 200),
      outcome: row.outcome as string,
      origin: row.origin as string,
      checkpointSha: (row.checkpoint_sha as string | null) ?? null,
      currentAtClose: Boolean(row.current_at_close)
    })),
    // The mission's visual evidence, frozen (D-122): references and
    // provenance only, never a blob and never a signed URL — reopening the
    // receipt reconstructs this exact set, and viewing mints a fresh grant.
    artifacts: await receiptArtifacts(client, missionId),
    remainingUncertain: uncertain.slice(0, 50),
    pullRequest: pull.rows[0]
      ? {
          number: Number(pull.rows[0].provider_number),
          state: pull.rows[0].state as string,
          url: ((pull.rows[0].url as string | null) ?? null)?.slice(0, 400) ?? null,
          mergedBy: ((pull.rows[0].merged_by as string | null) ?? null)?.slice(0, 120) ?? null,
          mergedAt: pull.rows[0].merged_at ? (pull.rows[0].merged_at as Date).toISOString() : null
        }
      : null,
    eventRange: {
      fromSeq: Number(range.rows[0]?.from_seq ?? 0),
      toSeq: Number(range.rows[0]?.to_seq ?? 0)
    },
    sessions: sessions.rows.map((row) => ({
      workstreamName: row.workstream_name as string,
      title: ((row.title as string | null) ?? null)?.slice(0, 200) ?? null,
      harness: (row.harness as string | null) ?? null,
      createdByLogin: row.login as string,
      directions: Number(row.directions ?? 0)
    })),
    directions: directions.rows.map((row) => ({
      authorLogin: row.login as string,
      body: (row.body as string).slice(0, 1000),
      workstreamName: row.workstream_name as string,
      sessionTitle: ((row.session_title as string | null) ?? null)?.slice(0, 200) ?? null,
      state: row.state as string,
      submittedAt: (row.submitted_at as Date).toISOString(),
      appliedAt: row.applied_at ? (row.applied_at as Date).toISOString() : null
    })),
    approvals: approvals.rows.map((row) => ({
      toolName: (row.tool_name as string).slice(0, 80),
      displayName: (row.display_name as string).slice(0, 120),
      summary: (row.summary as string).slice(0, 400),
      state: row.state as string,
      // A person's login, or the policy that answered for them (D-115),
      // read off the resolution when no responder is recorded.
      respondedByLogin:
        ((row.responded_by_login as string | null) ?? (row.resolution as string | null) ?? null)?.slice(0, 120) ??
        null,
      respondedAt: row.responded_at ? (row.responded_at as Date).toISOString() : null,
      requestedAt: (row.requested_at as Date).toISOString()
    })),
    files: files.rows.map((row) => ({
      path: (row.path as string).slice(0, 400),
      state: row.state as string,
      additions: Number(row.additions ?? 0),
      deletions: Number(row.deletions ?? 0)
    }))
  });
}

export function registerCloseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/close", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const missionId = (request.params as { missionId?: string }).missionId ?? "";
    const body = CloseMissionInputSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_close", "Say how the mission ends: completed or cancelled.");
    }
    const access = await missionAccess(deps.db, ctx, missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "mission.close");

    const outcome = await withMission(deps.db, missionId, async (client: pg.PoolClient) => {

      const already = await client.query("select closed_at from missions where mission_id = $1", [
        missionId
      ]);
      if (already.rows[0]?.closed_at) return "already" as const;

      // Archival's refusals, verbatim (D-063): the waiting question first,
      // because "answer it" is the useful instruction.
      const waiting = await client.query(
        "select 1 from approval_requests where mission_id = $1 and state = 'pending' limit 1",
        [missionId]
      );
      if ((waiting.rowCount ?? 0) > 0) return "waiting" as const;

      const stillborn = await client.query(
        `select e.exe_id from executions e
           join workstreams w on w.wst_id = e.wst_id
          where w.mission_id = $1 and e.state = 'requested'
            and not exists (select 1 from runner_commands c where c.exe_id = e.exe_id)`,
        [missionId]
      );
      for (const row of stillborn.rows) {
        await client.query(
          `update executions
              set state = 'interrupted', ended_at = now(), exit_outcome = 'interrupted',
                  failure_reason = 'Never started: no command was ever issued for this attempt.'
            where exe_id = $1 and state = 'requested'`,
          [row.exe_id]
        );
        await recordEvent(client, {
          orgId: access.orgId,
          missionId,
          workstreamId: null,
          executionId: row.exe_id as string,
          actorKind: "user",
          actorId: ctx.userId,
          kind: "execution.interrupted",
          payload: { reason: "Never started: no command was ever issued for this attempt." }
        });
      }

      const running = await client.query(
        `select 1 from executions e join workstreams w on w.wst_id = e.wst_id
          where w.mission_id = $1 and e.state = any($2::text[]) limit 1`,
        [missionId, ACTIVE_STATES]
      );
      if ((running.rowCount ?? 0) > 0) return "running" as const;

      // Completion's own gates: accepted means somebody accepted, resolved
      // means resolved.
      if (body.data.outcome === "completed") {
        const decision = await standingDecision(client, missionId);
        if (!decision) return "undecided" as const;
        const openPull = await client.query(
          "select 1 from pull_requests where mission_id = $1 and state in ('draft', 'ready') limit 1",
          [missionId]
        );
        if ((openPull.rowCount ?? 0) > 0) return "pull_open" as const;
      }

      const closedAt = new Date().toISOString();
      const reason = body.data.reason?.trim() ? body.data.reason.trim() : null;
      await client.query(
        `update missions set closed_at = $2, closed_by = $3, closed_outcome = $4
          where mission_id = $1`,
        [missionId, closedAt, ctx.userId, body.data.outcome]
      );
      // The closing event lands first, so the receipt's range covers the
      // record of the close itself — the receipt is the memory of the whole
      // mission, its own ending included, and re-projecting over the
      // unchanged log reproduces it exactly.
      await recordEvent(client, {
        orgId: access.orgId,
        missionId,
        workstreamId: null,
        executionId: null,
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        kind: "mission.closed",
        payload: { outcome: body.data.outcome, reason }
      });
      const snapshot = await projectReceipt(client, access, {
        outcome: body.data.outcome,
        reason,
        closedByLogin: ctx.login,
        closedAt
      });
      await client.query(
        `insert into receipts (rcp_id, org_id, mission_id, snapshot, from_seq, to_seq)
         values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          newReceiptId(),
          access.orgId,
          missionId,
          JSON.stringify(snapshot),
          snapshot.eventRange.fromSeq,
          snapshot.eventRange.toSeq
        ]
      );
      // Every lane's checkout is asked for back (D-155). Enqueued inside the
      // closing transaction, so a mission that ends is a mission whose
      // machines have been told — and the queue is durable, so a laptop that
      // is closed right now does the work when it next comes back. A lane
      // whose machine is gone for good leaves a pending command, which is the
      // same shape as every other command nobody is there to take.
      const lanes = await client.query(
        `select w.wst_id, r.runner_id
           from workstreams w
           join runners r on r.wst_id = w.wst_id and r.revoked_at is null
          where w.mission_id = $1`,
        [missionId]
      );
      for (const lane of lanes.rows as { wst_id: string; runner_id: string }[]) {
        await enqueueCommand(client, {
          orgId: access.orgId,
          missionId,
          workstreamId: lane.wst_id,
          executionId: null,
          runnerId: lane.runner_id,
          kind: "release_workspace",
          payload: {},
          idempotencyKey: `release:${lane.wst_id}`
        });
      }
      return "closed" as const;
    });

    if (outcome === "already") {
      return deps.sendError(reply, 409, "already_closed", "This mission's work has already ended.");
    }
    if (outcome === "waiting") {
      return deps.sendError(
        reply,
        409,
        "approval_pending",
        "The harness is waiting for an answer. Answer it, or stop the execution, before ending this mission."
      );
    }
    if (outcome === "running") {
      return deps.sendError(
        reply,
        409,
        "execution_active",
        "This mission is still working. Stop the execution before ending it."
      );
    }
    if (outcome === "undecided") {
      return deps.sendError(
        reply,
        409,
        "no_decision",
        "Completing a mission means a result was accepted, and none has been chosen. Record a decision first, or cancel instead."
      );
    }
    if (outcome === "pull_open") {
      return deps.sendError(
        reply,
        409,
        "pull_request_open",
        "The pull request is still open. Merge it or close it before completing the mission."
      );
    }
    return reply.send({ ok: true });
  });
}

/** Whether a mission's work has ended — the guard the operating verbs ask
 *  (D-121). One query, one sentence, used wherever a verb would act. */
export async function closedRefusal(
  db: { query: (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  missionId: string
): Promise<string | null> {
  const result = await db.query(
    "select closed_outcome from missions where mission_id = $1 and closed_at is not null",
    [missionId]
  );
  const outcome = result.rows[0]?.closed_outcome as string | undefined;
  if (!outcome) return null;
  return outcome === "completed"
    ? "This mission is completed. Its record is read-only; start a new mission for new work."
    : "This mission was cancelled. Its record is read-only; start a new mission for new work.";
}
