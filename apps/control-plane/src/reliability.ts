import { settlePendingApprovals } from "./approvals.ts";
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

/**
 * How long an unanswered handoff offer stays open (D-092). An offer is an
 * interactive ask — "will you take this?" — not a durable grant: ten minutes
 * unanswered means the recipient is not there, and the controller deserves
 * their offer slot back (only one offer may be live per workstream). Once
 * accepted, the grant IS durable and survives disconnection to complete at
 * the boundary (PRODUCT.md#control), so only `open` offers expire.
 */
const OFFER_TTL_MS = 10 * 60 * 1000;

/**
 * A participant read the mission within this window: their client is polling
 * and they are connected. Wider than the poll interval by the presence write
 * throttle, so a quiet-but-present client never flickers to reconnecting.
 */
const PARTICIPANT_CONNECTED_WITHIN_MS = 30_000;

/**
 * Silent past the connected window but within this one: reconnecting — the
 * machine is plausibly coming back. Past it: offline. The same 90-second
 * judgment the runner sweep makes, for the same reason (D-091).
 */
const PARTICIPANT_OFFLINE_AFTER_MS = 90_000;

/** Said in the log when the machine that was working never answered again. */
const RUNNER_GONE =
  "The runner stopped responding, so the execution ended without a reported outcome.";

export interface SweepResult {
  interrupted: number;
  expired: number;
  offersExpired: number;
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
      // This is the one path that **expires** a question rather than cancelling
      // it, and the distinction is the whole reason `expired` exists: the
      // machine that asked is gone, so an answer could never have been
      // delivered — nobody declined to answer, and the record should not read
      // as though somebody did (D-056).
      await settlePendingApprovals(client, {
        orgId: row.org_id,
        missionId: row.mission_id,
        workstreamId: row.wst_id,
        executionId: row.exe_id,
        outcome: "expired",
        reason: "The machine that asked stopped responding, so no answer could reach it."
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
      // Is the harness sitting on a question nobody can now answer? The
      // approval is deliberately **not** settled — the request stays pending
      // and the process stays alive, because expiry removes authority and does
      // not end work (D-034). What it changes is that the room has to say so,
      // and the record has to explain why a mission suddenly needs someone.
      const waiting = await client.query(
        `select 1 from approval_requests a
           join executions e on e.exe_id = a.exe_id
          where a.wst_id = $1 and a.state = 'pending'
            and e.state not in ('completed', 'stopped', 'interrupted', 'failed')
          limit 1`,
        [row.wst_id]
      );
      const approvalWaiting = (waiting.rowCount ?? 0) > 0;
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
          reason: "the controller was silent past the lease's time to live",
          // Read by the room and by anyone reconstructing the mission later:
          // "the baton lapsed" and "the baton lapsed while the harness was
          // waiting to be answered" are different events to walk into.
          approvalWaiting
        }
      });
      return true;
    });
    if (moved) expired += 1;
  }
  return expired;
}

/**
 * Expires handoff offers nobody answered (D-092). Only `open` offers: an
 * accepted offer is a durable grant that completes at the boundary however
 * long the boundary takes (PRODUCT.md#control). The event is recorded so the
 * controller learns their offer lapsed rather than finding the room silently
 * reset, and the one-live-offer slot frees for a new offer.
 */
export async function sweepOffers(db: Db, now = new Date()): Promise<number> {
  const stale = await db.query(
    `select o.offer_id, o.org_id, o.mission_id, o.wst_id, f.login as from_login, t.login as to_login
       from handoff_offers o
       join users f on f.user_id = o.from_user_id
       join users t on t.user_id = o.to_user_id
      where o.state = 'open'
        and coalesce(o.expires_at, o.created_at + ($2 || ' milliseconds')::interval) < $1`,
    [now, OFFER_TTL_MS]
  );

  let expired = 0;
  for (const row of stale.rows) {
    const moved = await withTransaction(db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [row.mission_id]);
      const lapsed = await client.query(
        `update handoff_offers set state = 'expired', ended_at = now()
          where offer_id = $1 and state = 'open' returning offer_id`,
        [row.offer_id]
      );
      if (lapsed.rowCount === 0) return false;
      await recordEvent(client, {
        orgId: row.org_id,
        missionId: row.mission_id,
        workstreamId: row.wst_id,
        kind: "control.offer_expired",
        actorKind: "system",
        actorId: "control-plane",
        payload: {
          offerId: row.offer_id,
          fromLogin: row.from_login,
          toLogin: row.to_login,
          reason: "nobody answered the offer before it expired"
        }
      });
      return true;
    });
    if (moved) expired += 1;
  }
  return expired;
}

/**
 * Refreshes this participant's own last-seen time in the mission they are
 * reading — the signal presence is projected from (D-091). The same throttle
 * shape as the lease heartbeat below, with a tighter window because presence
 * distinguishes seconds where the lease distinguishes minutes: the room polls
 * every two seconds, and a write every poll would be presence-keeping as the
 * database's main workload.
 */
export async function touchPresence(db: Db, missionId: string, userId: string): Promise<void> {
  await db.query(
    `update participants set last_seen_at = now()
      where mission_id = $1 and user_id = $2
        and (last_seen_at is null or last_seen_at < now() - interval '10 seconds')`,
    [missionId, userId]
  );
}

/**
 * The connection state a participant's last read projects to
 * (PRODUCT.md#presence-and-connection). Never seen at all reads as offline,
 * not as unknown: a participant who has never opened the mission is exactly
 * as absent as one who left.
 */
export function projectConnection(
  lastSeenAt: Date | null,
  now = new Date()
): "connected" | "reconnecting" | "offline" {
  if (!lastSeenAt) return "offline";
  const silentFor = now.getTime() - lastSeenAt.getTime();
  if (silentFor < PARTICIPANT_CONNECTED_WITHIN_MS) return "connected";
  if (silentFor < PARTICIPANT_OFFLINE_AFTER_MS) return "reconnecting";
  return "offline";
}

/** Refreshes a lease holder's liveness — every lease this person holds in the
 *  mission they are reading, not only the lane their room is showing. The
 *  heartbeat is the holder's client being alive (ARCHITECTURE.md#persistence),
 *  and a person reading one approach of a mission is exactly as alive for the
 *  sibling lane whose baton they also hold; before this took the mission, a
 *  controller of a background lane who sat watching another lane for half an
 *  hour lost that baton to the sweep while present. */
export async function touchHeldLeases(db: Db, missionId: string, userId: string): Promise<void> {
  await db.query(
    `update control_leases l set last_heartbeat_at = now()
       from workstreams w
      where w.wst_id = l.wst_id and w.mission_id = $1
        and l.holder_user_id = $2 and l.state in ('held', 'releasing')
        -- The room polls every two seconds; the TTL is half an hour. Writing on
        -- every poll would be thirty times the writes for none of the accuracy,
        -- so a heartbeat that is already fresh is left alone.
        and (l.last_heartbeat_at is null or l.last_heartbeat_at < now() - interval '1 minute')`,
    [missionId, userId]
  );
}

export async function sweepOnce(db: Db, now = new Date()): Promise<SweepResult> {
  return {
    interrupted: await sweepRunners(db, now),
    expired: await sweepLeases(db, now),
    offersExpired: await sweepOffers(db, now)
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
  LEASE_TTL_MS,
  OFFER_TTL_MS,
  PARTICIPANT_CONNECTED_WITHIN_MS,
  PARTICIPANT_OFFLINE_AFTER_MS
};
