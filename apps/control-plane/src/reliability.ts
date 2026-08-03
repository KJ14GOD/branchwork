import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";

/**
 * The two failure paths the canonical documents promise and the product did
 * not keep: a host that disappears, and a controller who does.
 *
 * Both are swept rather than triggered, because both are defined by the
 * *absence* of something — no heartbeat, no activity — and an absence has no
 * event to hang a handler on. Every transition is a compare-and-swap taken
 * under the per-mission ordering point, so two sweeps, or a sweep racing a
 * runner that just came back, resolve deterministically: one wins and the
 * other changes nothing.
 */

/**
 * A runner unheard from for longer than this reads as offline in the room.
 * The same number `mission-detail.ts` renders from, so what a participant sees
 * and what the sweep believes cannot disagree.
 */
const RUNNER_OFFLINE_AFTER_MS = 30_000;
// Referenced by RELIABILITY_THRESHOLDS so the room and the sweep quote one number.

/**
 * How long an execution's runner must be silent before Novus ends the
 * execution on its behalf. Deliberately longer than the offline threshold: a
 * participant pressing Stop has decided, and `executions.ts` acts on the 30
 * seconds immediately. Nobody has decided here, so the sweep waits until the
 * machine is not plausibly coming back before writing an outcome nobody asked
 * for.
 */
const RECOVERY_AFTER_MS = 90_000;

/**
 * How long a control lease survives without its holder doing anything. The
 * lease is a durable grant, not a connection (PRODUCT.md#control) — a
 * disconnected controller keeps the baton, and only a genuinely absent one
 * loses it.
 */
const LEASE_TTL_MS = 30 * 60 * 1000;

/** Said in the log when the machine that was working never answered again. */
const RUNNER_GONE =
  "The runner stopped responding, so the execution ended without a reported outcome.";

export interface SweepResult {
  interrupted: number;
  expired: number;
}

/**
 * Ends executions whose runner has gone silent. This is D-034's promise kept:
 * losing the host is an explicit interrupted outcome, never a room left
 * claiming "running" forever.
 */
export async function sweepRunners(db: Db, now = new Date()): Promise<number> {
  const stale = await db.query(
    `select e.exe_id, e.org_id, e.mission_id, e.wst_id
       from executions e
       left join runners r on r.runner_id = e.runner_id and r.revoked_at is null
      where e.state in ('requested', 'starting', 'running', 'needs_direction', 'needs_approval', 'stopping')
        -- A runner that has enrolled but not yet polled has no last-seen time.
        -- It is newly arrived, not gone: fall back to when it enrolled, or a
        -- machine would be declared dead the moment it registered.
        and (r.runner_id is null or coalesce(r.last_seen_at, r.created_at) < $1)`,
    [new Date(now.getTime() - RECOVERY_AFTER_MS)]
  );

  let interrupted = 0;
  for (const row of stale.rows) {
    const ended = await withTransaction(db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [row.mission_id]);
      // The guard is the whole safety property: a runner that reported a
      // terminal outcome a moment ago, or a second sweep, finds nothing to do.
      const moved = await client.query(
        `update executions
            set state = 'interrupted', ended_at = now(),
                exit_outcome = 'interrupted', failure_reason = $2
          where exe_id = $1
            and state in ('requested', 'starting', 'running', 'needs_direction', 'needs_approval', 'stopping')
          returning exe_id`,
        [row.exe_id, RUNNER_GONE]
      );
      if (moved.rowCount === 0) return false;
      await recordEvent(client, {
        orgId: row.org_id,
        missionId: row.mission_id,
        workstreamId: row.wst_id,
        executionId: row.exe_id,
        kind: "execution.interrupted",
        actorKind: "system",
        actorId: "control-plane",
        payload: { reason: RUNNER_GONE, detectedBy: "runner heartbeat watchdog" }
      });
      return true;
    });
    if (ended) interrupted += 1;
  }
  return interrupted;
}

/**
 * Expires control leases whose holder has been silent past the TTL. It touches
 * no execution: authority lapsing is not a stop signal, and work already
 * authorized keeps running (D-034). What it removes is the ability to issue
 * privileged commands from this moment on.
 *
 * After expiry the workstream has no controller, which the existing control
 * request route already reads as claimable — a request against an unheld lease
 * is fulfilled immediately, first accepted wins.
 */
export async function sweepLeases(db: Db, now = new Date()): Promise<number> {
  const stale = await db.query(
    `select l.lease_id, l.org_id, l.mission_id, l.wst_id, u.login
       from control_leases l
       join users u on u.user_id = l.holder_user_id
      where l.state in ('held', 'releasing')
        and coalesce(l.last_heartbeat_at, l.created_at) < $1`,
    [new Date(now.getTime() - LEASE_TTL_MS)]
  );

  let expired = 0;
  for (const row of stale.rows) {
    const moved = await withTransaction(db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [row.mission_id]);
      const released = await client.query(
        `update control_leases set state = 'expired', ended_at = now()
          where lease_id = $1 and state in ('held', 'releasing') returning lease_id`,
        [row.lease_id]
      );
      if (released.rowCount === 0) return false;
      // A handoff that was mid-flight cannot complete onto a lease that no
      // longer exists; it fails visibly rather than silently never landing.
      await client.query(
        `update handoff_offers set state = 'failed', ended_at = now()
          where wst_id = $1 and state in ('open', 'accepted', 'waiting_for_boundary')`,
        [row.wst_id]
      );
      await recordEvent(client, {
        orgId: row.org_id,
        missionId: row.mission_id,
        workstreamId: row.wst_id,
        kind: "control.expired",
        actorKind: "system",
        actorId: "control-plane",
        causeLeaseId: row.lease_id,
        payload: {
          holderLogin: row.login,
          reason: "the controller was silent past the lease's time to live"
        }
      });
      return true;
    });
    if (moved) expired += 1;
  }
  return expired;
}

/** Refreshes a lease holder's liveness. Called wherever a holder exercises
 *  their authority, so a working controller never loses the baton. */
export async function touchLease(db: Db, leaseId: string): Promise<void> {
  await db.query(
    "update control_leases set last_heartbeat_at = now() where lease_id = $1 and state in ('held', 'releasing')",
    [leaseId]
  );
}

export async function sweepOnce(db: Db, now = new Date()): Promise<SweepResult> {
  return {
    interrupted: await sweepRunners(db, now),
    expired: await sweepLeases(db, now)
  };
}

/**
 * Runs the sweep on an interval and returns the stop function. The caller must
 * call it: a timer that outlives its server keeps a test process alive for
 * ever, which is a far more common failure than the ones this module exists to
 * catch.
 */
export function startReliabilitySweep(db: Db, everyMs = 15_000): () => void {
  const timer = setInterval(() => {
    void sweepOnce(db).catch((error: unknown) => {
      console.error("reliability sweep failed:", error instanceof Error ? error.message : error);
    });
  }, everyMs);
  // Never hold the process open on its own account.
  timer.unref?.();
  return () => clearInterval(timer);
}

export const RELIABILITY_THRESHOLDS = {
  RUNNER_OFFLINE_AFTER_MS,
  RECOVERY_AFTER_MS,
  LEASE_TTL_MS
};
