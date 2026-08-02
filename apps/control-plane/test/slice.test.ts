import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.ts";
import { createPool, migrate, type Db } from "../src/db.ts";
import { buildServer } from "../src/server.ts";

// Deterministic tests against a real PostgreSQL (novus_test database).
// GitHub's upstream is replaced by the gated fake identity (config.ts);
// flows, sessions, org scoping, missions, and events all run for real.

let db: Db;
let app: FastifyInstance;
let config: Config;

async function ensureTestDatabase(): Promise<string> {
  const admin = createPool("postgres://novus:novus@127.0.0.1:5433/novus");
  const exists = await admin.query("select 1 from pg_database where datname = 'novus_test'");
  if (exists.rowCount === 0) await admin.query("create database novus_test");
  await admin.end();
  return "postgres://novus:novus@127.0.0.1:5433/novus_test";
}

async function signIn(server: FastifyInstance): Promise<{ token: string; orgId: string; userId: string }> {
  const start = await server.inject({ method: "POST", url: "/auth/github/start" });
  expect(start.statusCode).toBe(200);
  const { state, authorizeUrl } = start.json();
  const authorizePath = new URL(authorizeUrl).pathname + new URL(authorizeUrl).search;
  const authorize = await server.inject({ method: "GET", url: authorizePath });
  expect(authorize.statusCode).toBe(302);
  const callback = new URL(authorize.headers.location as string);
  const cb = await server.inject({ method: "GET", url: callback.pathname + callback.search });
  expect(cb.statusCode).toBe(200);
  const claim = await server.inject({ method: "POST", url: "/auth/github/claim", payload: { state } });
  expect(claim.statusCode).toBe(200);
  const body = claim.json();
  return { token: body.token, orgId: body.org.orgId, userId: body.user.userId };
}

beforeAll(async () => {
  const url = await ensureTestDatabase();
  db = createPool(url);
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
  config = loadConfig({
    ...process.env,
    NOVUS_FAKE_GITHUB: "1",
    NOVUS_DATABASE_URL: url,
    NODE_ENV: "test"
  });
  app = buildServer(db, config);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("authentication and sessions", () => {
  it("rejects requests without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/missions" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses to start real sign-in without OAuth credentials, with a named error", async () => {
    const unconfigured = buildServer(
      db,
      loadConfig({ ...process.env, NOVUS_FAKE_GITHUB: undefined, NOVUS_GITHUB_CLIENT_ID: "", NODE_ENV: "test" })
    );
    await unconfigured.ready();
    const res = await unconfigured.inject({ method: "POST", url: "/auth/github/start" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_unconfigured");
    await unconfigured.close();
  });

  it("issues a claimable session exactly once", async () => {
    const start = await app.inject({ method: "POST", url: "/auth/github/start" });
    const { state, authorizeUrl } = start.json();
    const url = new URL(authorizeUrl);
    const authorize = await app.inject({ method: "GET", url: url.pathname + url.search });
    const cb = new URL(authorize.headers.location as string);
    await app.inject({ method: "GET", url: cb.pathname + cb.search });

    const first = await app.inject({ method: "POST", url: "/auth/github/claim", payload: { state } });
    expect(first.statusCode).toBe(200);
    expect(first.json().token.length).toBeGreaterThanOrEqual(32);

    const second = await app.inject({ method: "POST", url: "/auth/github/claim", payload: { state } });
    expect(second.statusCode).toBe(410); // single-use: the flow is gone
  });

  it("reports pending while the browser leg is unfinished", async () => {
    const start = await app.inject({ method: "POST", url: "/auth/github/start" });
    const { state } = start.json();
    const res = await app.inject({ method: "POST", url: "/auth/github/claim", payload: { state } });
    expect(res.statusCode).toBe(202);
    expect(res.json().pending).toBe(true);
  });

  it("revokes sessions server-side on sign-out", async () => {
    const { token } = await signIn(app);
    const before = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/auth/signout", headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401); // the token is dead at the server, not the client
  });

  it("stores only a hash of the session token", async () => {
    const { token } = await signIn(app);
    const rows = await db.query("select token_hash from sessions");
    for (const row of rows.rows) {
      expect(row.token_hash).not.toBe(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

async function missionPayload(server: FastifyInstance, token: string, overrides: Record<string, unknown> = {}) {
  const base = await server.inject({
    method: "GET",
    url: "/repositories/available/9001/base",
    headers: { authorization: `Bearer ${token}` }
  });
  expect(base.statusCode).toBe(200);
  const { ref, sha } = base.json();
  return {
    goal: "Rotate the signing keys",
    successCriteria: "All services verify with the new key",
    providerRepoId: "9001",
    baseRef: ref,
    baseSha: sha,
    creationKey: crypto.randomUUID(),
    ...overrides
  };
}

describe("missions, events, and reconstruction", () => {
  it("creates a mission, workstream, and initial events in one transaction", async () => {
    const { token, orgId, userId } = await signIn(app);
    const created = await app.inject({
      method: "POST",
      url: "/missions",
      headers: { authorization: `Bearer ${token}` },
      payload: await missionPayload(app, token)
    });
    expect(created.statusCode).toBe(201);
    const { mission, workstream } = created.json();
    expect(mission.primaryState).toBe("new_mission");
    expect(mission.orgId).toBe(orgId);
    expect(mission.repository.name).toBe("novus/demo-app");
    expect(workstream.missionBranch).toMatch(/^novus\/m-/);
    expect(workstream.branchStatus).toBe("created");
    expect(workstream.baseSha).toMatch(/^[0-9a-f]{40}$/);

    const events = await db.query("select * from events where mission_id = $1 order by seq", [mission.missionId]);
    expect(events.rows.map((event) => event.kind)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_created"
    ]);
    expect(events.rows[0].actor_kind).toBe("user");
    expect(events.rows[0].actor_id).toBe(userId);

    const participants = await db.query("select mission_role from participants where mission_id = $1", [
      mission.missionId
    ]);
    expect(participants.rows[0].mission_role).toBe("mission_admin");
  });

  it("rejects an empty goal with a validation error, persisting nothing", async () => {
    const { token } = await signIn(app);
    const before = await db.query("select count(*)::int as n from missions");
    const res = await app.inject({
      method: "POST",
      url: "/missions",
      headers: { authorization: `Bearer ${token}` },
      payload: await missionPayload(app, token, { goal: "   " })
    });
    expect(res.statusCode).toBe(422);
    const after = await db.query("select count(*)::int as n from missions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("reconstructs the mission, repository, and workstream through a fresh server", async () => {
    const { token } = await signIn(app);
    const created = await app.inject({
      method: "POST",
      url: "/missions",
      headers: { authorization: `Bearer ${token}` },
      payload: await missionPayload(app, token, { goal: "Migrate the sessions table" })
    });
    const missionId = created.json().mission.missionId;

    // A brand-new server process over the same database: nothing in memory.
    const freshApp = buildServer(db, config);
    await freshApp.ready();
    const fetched = await freshApp.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(fetched.statusCode).toBe(200);
    const body = fetched.json();
    expect(body.mission.goal).toBe("Migrate the sessions table");
    expect(body.mission.repository.providerRepoId).toBe("9001");
    expect(body.workstream.missionBranch).toMatch(/^novus\/m-/);
    expect(body.events.map((event: { kind: string }) => event.kind)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_created"
    ]);
    await freshApp.close();
  });
});

describe("organization scoping", () => {
  it("hides another organization's missions entirely", async () => {
    const { token: tokenA } = await signIn(app);
    const created = await app.inject({
      method: "POST",
      url: "/missions",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: await missionPayload(app, tokenA, { goal: "Org A private mission", successCriteria: "Stays private" })
    });
    const missionId = created.json().mission.missionId;

    // A second, different identity in its own org.
    await db.query("update users set github_id = github_id + 1000000, login = login || '-b' where login = 'spike-user'");
    const { token: tokenB, orgId: orgB } = await signIn(app);
    const meB = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenB}` } });
    expect(meB.json().org.orgId).toBe(orgB);

    const list = await app.inject({ method: "GET", url: "/missions", headers: { authorization: `Bearer ${tokenB}` } });
    const goals = list.json().missions.map((m: { goal: string }) => m.goal);
    expect(goals).not.toContain("Org A private mission");

    const direct = await app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: { authorization: `Bearer ${tokenB}` }
    });
    expect(direct.statusCode).toBe(404); // not 403: outside your org it does not exist
  });
});
