import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;

/**
 * One SQL-capable handle: the pool outside a transaction, a client inside one.
 * Read helpers take this so the same function serves a bare pool caller and a
 * snapshot read alike.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function migrate(pool: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

/**
 * The per-mission ordering point (ARCHITECTURE.md#authorization). Any command
 * that reads mission state and then writes it takes this first, so two accepts
 * — or an accept racing a revoke, or a runner reporting while a person
 * submits — serialize rather than interleave. It is the same lock event
 * recording takes, and advisory transaction locks are re-entrant within one
 * transaction. This is the only place the lock's SQL is written.
 */
export async function lockMission(client: pg.PoolClient, missionId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [missionId]);
}

/**
 * A mission mutation: one transaction, opened already holding the mission's
 * ordering point. The rule "a mission mutation takes the per-mission lock"
 * used to be a convention copied into every handler; going through here makes
 * forgetting it impossible rather than reviewable.
 */
export async function withMission<T>(
  pool: Db,
  missionId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await lockMission(client, missionId);
    return fn(client);
  });
}

export async function withTransaction<T>(
  pool: Db,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
