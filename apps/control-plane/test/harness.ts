import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.ts";
import { createPool, migrate, type Db } from "../src/db.ts";
import { buildServer } from "../src/server.ts";
import type { RepositoryProvider } from "../src/repo-provider.ts";

/**
 * Shared harness for deterministic control-plane tests against a real
 * PostgreSQL. Only GitHub's upstream is faked: flows, sessions, organizations,
 * membership, invitations, capability enforcement, and scoping all run for
 * real. Each suite owns its own database so suites never clobber each other.
 */

const ADMIN_URL = "postgres://novus:novus@127.0.0.1:5433/novus";

export interface Harness {
  db: Db;
  app: FastifyInstance;
  config: Config;
  /** Signs a deterministic identity in and returns its session. `as` picks
   *  which person, so a test can be two people. */
  signIn(as?: string): Promise<SignedIn>;
  close(): Promise<void>;
}

export interface SignedIn {
  token: string;
  orgId: string;
  userId: string;
  login: string;
}

async function ensureDatabase(name: string): Promise<string> {
  const admin = createPool(ADMIN_URL);
  const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (exists.rowCount === 0) await admin.query(`create database ${name}`);
  await admin.end();
  return `postgres://novus:novus@127.0.0.1:5433/${name}`;
}

export async function createHarness(
  databaseName: string,
  providerOverride?: RepositoryProvider
): Promise<Harness> {
  const url = await ensureDatabase(databaseName);
  const db = createPool(url);
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
  const config = loadConfig({
    ...process.env,
    NOVUS_FAKE_GITHUB: "1",
    NOVUS_DATABASE_URL: url,
    NODE_ENV: "test"
  });
  const app = buildServer(db, config, providerOverride);
  await app.ready();

  const signIn = async (as?: string): Promise<SignedIn> => {
    const start = await app.inject({
      method: "POST",
      url: "/auth/github/start",
      payload: as ? { as } : {}
    });
    expect(start.statusCode).toBe(200);
    const { state, authorizeUrl } = start.json();
    const authorize = new URL(authorizeUrl);
    const redirect = await app.inject({
      method: "GET",
      url: authorize.pathname + authorize.search
    });
    expect(redirect.statusCode).toBe(302);
    const callback = new URL(redirect.headers.location as string);
    const cb = await app.inject({ method: "GET", url: callback.pathname + callback.search });
    expect(cb.statusCode).toBe(200);
    const claim = await app.inject({ method: "POST", url: "/auth/github/claim", payload: { state } });
    expect(claim.statusCode).toBe(200);
    const body = claim.json();
    return {
      token: body.token,
      orgId: body.org.orgId,
      userId: body.user.userId,
      login: body.user.login
    };
  };

  return {
    db,
    app,
    config,
    signIn,
    close: async () => {
      await app.close();
      await db.end();
    }
  };
}

/** Convenience: authorization header for a signed-in session. */
export const bearer = (session: SignedIn) => ({ authorization: `Bearer ${session.token}` });
