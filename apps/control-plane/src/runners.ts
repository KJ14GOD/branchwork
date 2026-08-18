import type pg from "pg";
import type { RunnerCommandKind } from "@novus/contracts";
import type { Queryable } from "./db.ts";
import { newCommandId } from "./ids.ts";

/**
 * OWNER: the lane's runner, and the durable command transport toward it
 * (D-035). This module is the single place that knows two facts every
 * dispatching path used to restate for itself:
 *
 *   1. what "the lane's runner" means — in both of its deliberate senses, and
 *   2. how a command becomes a `runner_commands` row — in both of its
 *      deliberate idempotency modes.
 *
 * No other module answers "which runner is the lane's?" or inserts into
 * `runner_commands`. Enrollment, credential auth, and the runner-facing routes
 * stay in runner.ts, which owns the `runners` table's writes. If either rule
 * above changes, it changes here once.
 */

/**
 * A runner unheard from for longer than this reads as offline in the room, is
 * treated as gone by Stop, and is recovered by the reliability sweep. One
 * number, so what a participant sees and what the machinery believes cannot
 * disagree.
 */
export const RUNNER_OFFLINE_AFTER_MS = 30_000;

/** Whether a runner's heartbeat is recent enough to call it online. */
export function runnerOnline(lastSeenAt: Date | null): boolean {
  return lastSeenAt !== null && Date.now() - lastSeenAt.getTime() < RUNNER_OFFLINE_AFTER_MS;
}

export interface ActiveRunner {
  runnerId: string;
  label: string;
  lastSeenAt: Date | null;
}

/**
 * The lane's *dispatchable* runner: registered, unrevoked, unexpired, newest
 * first. This is the rule every enqueueing path shares — a command is never
 * addressed to a registration that has lapsed. Liveness of the *connection* is
 * a separate question (`runnerOnline`); refusing a command because a heartbeat
 * is a few seconds stale would make a freshly launched desktop look broken.
 */
export async function activeRunner(q: Queryable, workstreamId: string): Promise<ActiveRunner | null> {
  const result = await q.query(
    `select runner_id, label, last_seen_at from runners
      where wst_id = $1 and revoked_at is null and expires_at > now()
      order by created_at desc limit 1`,
    [workstreamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runnerId: row.runner_id as string,
    label: row.label as string,
    lastSeenAt: (row.last_seen_at as Date | null) ?? null
  };
}

export interface RegisteredRunner {
  runnerId: string;
  label: string;
  ownerLogin: string;
  lastSeenAt: Date | null;
}

/**
 * The lane's runner as the room *shows* it: unrevoked, newest first —
 * expiry deliberately not filtered. A registration that has lapsed still
 * names the machine the work last happened on, and the room says "runner
 * offline" about it honestly instead of showing nothing at all. Dispatchers
 * must use `activeRunner`; this lookup exists only for display.
 */
export async function registeredRunner(
  q: Queryable,
  workstreamId: string
): Promise<RegisteredRunner | null> {
  const result = await q.query(
    `select r.runner_id, r.label, r.last_seen_at, u.login
       from runners r join users u on u.user_id = r.owner_user_id
      where r.wst_id = $1 and r.revoked_at is null
      order by r.created_at desc limit 1`,
    [workstreamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runnerId: row.runner_id as string,
    label: row.label as string,
    ownerLogin: row.login as string,
    lastSeenAt: (row.last_seen_at as Date | null) ?? null
  };
}

/** Everything the transport can carry — the contract's own vocabulary, so a
 *  kind cannot exist here that the runner's schema would refuse. */
export type CommandKind = RunnerCommandKind;

export interface EnqueueArgs {
  orgId: string;
  missionId: string;
  workstreamId: string;
  executionId: string | null;
  runnerId: string;
  kind: CommandKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Durable transport, control plane → runner, for commands that happen **once
 * for all time** (a direction is applied once; an approval is answered once).
 * The idempotency key is what makes a retried dispatch after a partition apply
 * once: the second insert loses to the unique index and the caller gets the
 * command that already exists.
 */
/**
 * Tells the machine holding this lane that work is waiting (D-154).
 *
 * Sent inside the enqueueing transaction, so Postgres delivers it on commit
 * and never on rollback — a runner is never woken for a command that does not
 * exist. The payload is an address and nothing more: the runner still asks
 * `GET /runner/commands` under its own credential, so the durable queue, its
 * idempotency keys, its ordering and its acknowledgement lifecycle are all
 * exactly as they were. This only removes the waiting.
 */
export const RUNNER_COMMAND_CHANNEL = "novus_runner_command";

async function notifyRunner(client: pg.PoolClient, workstreamId: string): Promise<void> {
  await client.query("select pg_notify($1, $2)", [
    RUNNER_COMMAND_CHANNEL,
    JSON.stringify({ workstreamId })
  ]);
}

export async function enqueueCommand(client: pg.PoolClient, args: EnqueueArgs): Promise<string> {
  const commandId = newCommandId();
  const inserted = await client.query(
    `insert into runner_commands (cmd_id, org_id, mission_id, wst_id, exe_id, runner_id, kind,
                                  payload, idempotency_key, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     on conflict (wst_id, idempotency_key) do nothing
     returning cmd_id`,
    [
      commandId,
      args.orgId,
      args.missionId,
      args.workstreamId,
      args.executionId,
      args.runnerId,
      args.kind,
      JSON.stringify(args.payload),
      args.idempotencyKey
    ]
  );
  const fresh = inserted.rows[0]?.cmd_id as string | undefined;
  if (fresh) {
    await notifyRunner(client, args.workstreamId);
    return fresh;
  }
  const existing = await client.query(
    "select cmd_id from runner_commands where wst_id = $1 and idempotency_key = $2",
    [args.workstreamId, args.idempotencyKey]
  );
  return existing.rows[0].cmd_id as string;
}

export type RepeatableOutcome =
  | { kind: "enqueued"; commandId: string }
  | { kind: "already_queued" };

/**
 * The transport's other idempotency mode, for commands that are **meant to run
 * again** (a verification runs after every change; a push follows every new
 * decision). A stable key would let such a command run once per workstream and
 * then silently collapse into the row that already exists, so the key carries
 * a fresh command id and the double-click case is answered by *state* instead:
 * an unsettled command of the same kind and name is reused rather than
 * duplicated (D-043's pattern). Once it completes or fails, the next request
 * is a genuinely new command with a new key.
 *
 * `name` distinguishes siblings of one kind (two declared verification
 * commands); pass null for kinds that have no siblings, and put no `name` in
 * the payload of such kinds so the pending match stays honest.
 */
export async function enqueueRepeatable(
  client: pg.PoolClient,
  args: {
    orgId: string;
    missionId: string;
    workstreamId: string;
    runnerId: string;
    kind: CommandKind;
    name: string | null;
    payload: Record<string, unknown>;
  }
): Promise<RepeatableOutcome> {
  const pending = await client.query(
    `select cmd_id from runner_commands
      where wst_id = $1 and kind = $2 and payload->>'name' is not distinct from $3
        and state in ('pending', 'delivered', 'acknowledged')
      limit 1`,
    [args.workstreamId, args.kind, args.name]
  );
  if (pending.rows[0] !== undefined) return { kind: "already_queued" };

  const commandId = newCommandId();
  await client.query(
    `insert into runner_commands (cmd_id, org_id, mission_id, wst_id, exe_id, runner_id, kind,
                                  payload, idempotency_key, state)
     values ($1, $2, $3, $4, null, $5, $6, $7, $8, 'pending')`,
    [
      commandId,
      args.orgId,
      args.missionId,
      args.workstreamId,
      args.runnerId,
      args.kind,
      JSON.stringify(args.payload),
      `${args.kind}:${args.name ?? "*"}:${commandId}`
    ]
  );
  await notifyRunner(client, args.workstreamId);
  return { kind: "enqueued", commandId };
}
