import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AvailableRepository, BaseRevision } from "@novus/contracts";
import { loadConfig, type Config } from "../src/config.ts";
import { createPool, migrate, type Db } from "../src/db.ts";
import { buildServer } from "../src/server.ts";
import {
  BranchConflictError,
  FakeRepositoryProvider,
  UnconfiguredRepositoryProvider,
  type RepositoryProvider
} from "../src/repo-provider.ts";

// Deterministic tests for the repository/workstream slice against a real
// PostgreSQL (novus_test). One FakeRepositoryProvider instance is held across
// the whole suite so provider-side state (branches, transient failures) can be
// asserted directly. slice.test.ts owns auth and the base mission lifecycle;
// this file owns repositories, base pinning, idempotency, branch outcomes.

let db: Db;
let app: FastifyInstance;
let config: Config;
let provider: FakeRepositoryProvider;
let auth: { token: string; orgId: string; userId: string };

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

async function resolveBase(server: FastifyInstance, providerRepoId: string): Promise<{ ref: string; sha: string }> {
  const base = await server.inject({
    method: "GET",
    url: `/repositories/available/${providerRepoId}/base`,
    headers: { authorization: `Bearer ${auth.token}` }
  });
  expect(base.statusCode).toBe(200);
  return base.json();
}

async function missionPayload(
  server: FastifyInstance,
  providerRepoId: string,
  overrides: Record<string, unknown> = {}
) {
  const { ref, sha } = await resolveBase(server, providerRepoId);
  return {
    goal: "Rotate the signing keys",
    successCriteria: "All services verify with the new key",
    providerRepoId,
    baseRef: ref,
    baseSha: sha,
    creationKey: crypto.randomUUID(),
    ...overrides
  };
}

async function postMission(server: FastifyInstance, payload: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/missions",
    headers: { authorization: `Bearer ${auth.token}` },
    payload
  });
}

async function tableCounts(): Promise<{ missions: number; workstreams: number; events: number }> {
  const result = await db.query(
    `select (select count(*)::int from missions) as missions,
            (select count(*)::int from workstreams) as workstreams,
            (select count(*)::int from events) as events`
  );
  return result.rows[0];
}

async function eventKinds(missionId: string): Promise<string[]> {
  const rows = await db.query("select kind from events where mission_id = $1 order by seq", [missionId]);
  return rows.rows.map((row) => row.kind as string);
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
  provider = new FakeRepositoryProvider();
  app = buildServer(db, config, provider);
  await app.ready();
  auth = await signIn(app);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("repository records", () => {
  it("records exactly one repositories row per provider repo across many missions", async () => {
    for (let i = 0; i < 3; i += 1) {
      const created = await postMission(app, await missionPayload(app, "9001", { goal: `Mission ${i} on demo-app` }));
      expect(created.statusCode).toBe(201);
    }
    const rows = await db.query(
      "select * from repositories where org_id = $1 and provider = 'github' and provider_repo_id = '9001'",
      [auth.orgId]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].name).toBe("novus/demo-app");
    expect(rows.rows[0].default_branch).toBe("main");
  });

  it("enforces repository identity with a unique index on (org, provider, provider_repo_id)", async () => {
    // The fake provider cannot rename a repository, so the identity guarantee
    // is asserted at its root: a second row for the same provider identity is
    // impossible regardless of name.
    await expect(
      db.query(
        `insert into repositories (repo_id, org_id, provider, provider_repo_id, name, default_branch, connected_by)
         values ('rep_duplicateidentity0', $1, 'github', '9001', 'renamed/demo-app', 'main', $2)`,
        [auth.orgId, auth.userId]
      )
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("exact base revisions", () => {
  it("persists the workstream base exactly as the base endpoint resolved it", async () => {
    const base = await resolveBase(app, "9001");
    expect(base.sha).toMatch(/^[0-9a-f]{40}$/);
    const created = await postMission(app, await missionPayload(app, "9001", { baseRef: base.ref, baseSha: base.sha }));
    expect(created.statusCode).toBe(201);
    const { workstream } = created.json();
    expect(workstream.baseSha).toBe(base.sha);
    expect(workstream.baseRef).toBe(base.ref);

    const row = await db.query("select base_ref, base_sha from workstreams where wst_id = $1", [
      workstream.workstreamId
    ]);
    expect(row.rows[0].base_sha).toBe(base.sha);
    expect(row.rows[0].base_ref).toBe(base.ref);
  });

  it("rejects a malformed base sha with 422, persisting nothing", async () => {
    const before = await tableCounts();
    const res = await postMission(app, await missionPayload(app, "9001", { baseSha: "abc123" }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_mission");
    expect(await tableCounts()).toEqual(before);
  });
});

describe("unknown repository", () => {
  it("rejects providerRepoId 9999 with unknown_repository, persisting nothing", async () => {
    const before = await tableCounts();
    // Borrow a real sha so only the repository id is wrong.
    const { sha } = await resolveBase(app, "9001");
    const res = await postMission(app, {
      goal: "Point at a repo that does not exist",
      successCriteria: "Refused cleanly",
      providerRepoId: "9999",
      baseRef: "main",
      baseSha: sha,
      creationKey: crypto.randomUUID()
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("unknown_repository");
    expect(await tableCounts()).toEqual(before);
  });
});

describe("idempotent creation", () => {
  it("returns the same mission for the same creationKey posted twice, minting nothing twice", async () => {
    const payload = await missionPayload(app, "9001", { goal: "Idempotent creation" });
    const first = await postMission(app, payload);
    const second = await postMission(app, payload);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const missionId = first.json().mission.missionId;
    expect(second.json().mission.missionId).toBe(missionId);

    const missions = await db.query("select mission_id from missions where creation_key = $1", [
      payload.creationKey
    ]);
    expect(missions.rowCount).toBe(1);
    const workstreams = await db.query("select mission_branch, base_sha from workstreams where mission_id = $1", [
      missionId
    ]);
    expect(workstreams.rowCount).toBe(1);

    // Exactly one branch exists in the provider: ensuring it again at the same
    // sha reports alreadyExisted, proving the second POST created nothing.
    const branch = workstreams.rows[0];
    await expect(provider.ensureBranch("9001", branch.mission_branch, branch.base_sha)).resolves.toEqual({
      alreadyExisted: true
    });

    expect(await eventKinds(missionId)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_created"
    ]);
  });

  it("keeps exactly one mission under five simultaneous posts of the same creationKey", async () => {
    const payload = await missionPayload(app, "9001", { goal: "Concurrent identical creation" });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postMission(app, { ...payload }))
    );
    const statuses = responses.map((res) => res.statusCode);

    // Invariants that must hold no matter how the race lands: one mission,
    // one workstream, one provider branch, and every winner agrees on the id.
    const missions = await db.query("select mission_id from missions where creation_key = $1", [
      payload.creationKey
    ]);
    expect(missions.rowCount).toBe(1);
    const missionId = missions.rows[0].mission_id as string;
    const workstreams = await db.query("select mission_branch, base_sha from workstreams where mission_id = $1", [
      missionId
    ]);
    expect(workstreams.rowCount).toBe(1);
    await expect(
      provider.ensureBranch("9001", workstreams.rows[0].mission_branch, workstreams.rows[0].base_sha)
    ).resolves.toEqual({ alreadyExisted: true });
    expect(await eventKinds(missionId)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_created"
    ]);

    // Observed behavior of the losers, captured exactly: at least one request
    // wins with 201; the rest either read the winner (201) or die on the
    // creation_key unique index as an unhandled 500. See the defect test below.
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of responses) {
      expect([201, 500]).toContain(res.statusCode);
      if (res.statusCode === 201) expect(res.json().mission.missionId).toBe(missionId);
    }
  });

  // DEFECT (documented, not fixed — src/ is frozen): createMission checks for
  // an existing creation_key before inserting, but concurrent requests all pass
  // that check before any of them commits. The losers then die on a 23505 that
  // nothing catches (missions.ts createMission, server.ts POST /missions), so
  // Fastify answers 500 instead of the idempotent 201 the creationKey contract
  // (D-031) promises. Observed bodies leak the raw constraint name to the
  // client: "missions_creation_key" when the repository row already exists,
  // "repositories_org_id_provider_provider_repo_id_key" when the burst is the
  // repo's first mission (upsertRepository select-then-insert has the same
  // race). Marked .fails: it passes the day the race is handled.
  it.fails("DEFECT: losing concurrent duplicates should get the idempotent 201, not 500", async () => {
    const payload = await missionPayload(app, "9001", { goal: "Concurrent losers deserve the winner" });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postMission(app, { ...payload }))
    );
    for (const res of responses) expect(res.statusCode).toBe(201);
  });
});

describe("retry after transient failure", () => {
  let missionId: string;
  let workstreamId: string;

  it("records the failed branch attempt on the flaky repository", async () => {
    const created = await postMission(app, await missionPayload(app, "9003", { goal: "Survive a flaky provider" }));
    expect(created.statusCode).toBe(201);
    const body = created.json();
    missionId = body.mission.missionId;
    workstreamId = body.workstream.workstreamId;
    expect(body.workstream.branchStatus).toBe("failed");
    expect(body.workstream.branchError).toBe("The provider timed out creating the branch.");
    expect(await eventKinds(missionId)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_failed"
    ]);
  });

  it("retries to created, appending branch_created after the failed event", async () => {
    const retry = await app.inject({
      method: "POST",
      url: `/workstreams/${workstreamId}/branch/retry`,
      headers: { authorization: `Bearer ${auth.token}` }
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().workstream.branchStatus).toBe("created");
    expect(retry.json().workstream.branchError).toBeNull();

    const events = await db.query("select kind, seq from events where mission_id = $1 order by seq", [missionId]);
    expect(events.rows.map((row) => row.kind)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_failed",
      "workstream.branch_created"
    ]);
    const seqs = events.rows.map((row) => Number(row.seq));
    expect(seqs).toEqual([1, 2, 3, 4]); // strictly ordered; created strictly after failed
  });

  it("keeps a second retry silent: still created, no duplicate events", async () => {
    const retry = await app.inject({
      method: "POST",
      url: `/workstreams/${workstreamId}/branch/retry`,
      headers: { authorization: `Bearer ${auth.token}` }
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().workstream.branchStatus).toBe("created");
    expect(await eventKinds(missionId)).toEqual([
      "mission.created",
      "workstream.created",
      "workstream.branch_failed",
      "workstream.branch_created"
    ]);
  });
});

describe("branch conflict", () => {
  class ConflictProvider implements RepositoryProvider {
    readonly kind = "fake" as const;
    async listRepositories(): Promise<AvailableRepository[]> {
      return [{ providerRepoId: "7001", name: "novus/occupied", defaultBranch: "main" }];
    }
    async resolveBase(): Promise<BaseRevision> {
      return { ref: "main", sha: "a".repeat(40) };
    }
    async ensureBranch(_repo: string, branch: string): Promise<{ alreadyExisted: boolean }> {
      throw new BranchConflictError(branch);
    }
  }

  it("lands on failed with the conflict message, and retry keeps failed without duplicating rows", async () => {
    const conflictApp = buildServer(db, config, new ConflictProvider());
    await conflictApp.ready();
    try {
      const created = await postMission(conflictApp, await missionPayload(conflictApp, "7001", { goal: "Collide with an occupied branch" }));
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.workstream.branchStatus).toBe("failed");
      expect(body.workstream.branchError).toMatch(/already exists at a different commit/);

      const retry = await conflictApp.inject({
        method: "POST",
        url: `/workstreams/${body.workstream.workstreamId}/branch/retry`,
        headers: { authorization: `Bearer ${auth.token}` }
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().workstream.branchStatus).toBe("failed");
      expect(retry.json().workstream.branchError).toMatch(/already exists at a different commit/);

      const missions = await db.query("select count(*)::int as n from missions where mission_id = $1", [
        body.mission.missionId
      ]);
      expect(missions.rows[0].n).toBe(1);
      const workstreams = await db.query("select count(*)::int as n from workstreams where mission_id = $1", [
        body.mission.missionId
      ]);
      expect(workstreams.rows[0].n).toBe(1);

      // Observed behavior, asserted exactly: every failed retry appends its own
      // branch_failed attempt event. The state does not duplicate; the attempt
      // log grows by one per retry.
      expect(await eventKinds(body.mission.missionId)).toEqual([
        "mission.created",
        "workstream.created",
        "workstream.branch_failed",
        "workstream.branch_failed"
      ]);
    } finally {
      await conflictApp.close();
    }
  });
});

describe("reconstruction depth", () => {
  it("serves both missions with repositories, workstreams, and ordered events from a cold server", async () => {
    const one = await postMission(app, await missionPayload(app, "9001", { goal: "Reconstruction on demo-app" }));
    const two = await postMission(app, await missionPayload(app, "9002", { goal: "Reconstruction on api" }));
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);

    // A brand-new server over the same database: nothing carried in memory.
    const cold = buildServer(db, config);
    await cold.ready();
    try {
      const list = await cold.inject({ method: "GET", url: "/missions", headers: { authorization: `Bearer ${auth.token}` } });
      expect(list.statusCode).toBe(200);
      const missions = list.json().missions;
      const byGoal = (goal: string) => missions.find((m: { goal: string }) => m.goal === goal);
      expect(byGoal("Reconstruction on demo-app").repository.name).toBe("novus/demo-app");
      expect(byGoal("Reconstruction on api").repository.name).toBe("novus/api");

      for (const created of [one, two]) {
        const posted = created.json();
        const detail = await cold.inject({
          method: "GET",
          url: `/missions/${posted.mission.missionId}`,
          headers: { authorization: `Bearer ${auth.token}` }
        });
        expect(detail.statusCode).toBe(200);
        const body = detail.json();
        expect(body.workstream.missionBranch).toBe(posted.workstream.missionBranch);
        expect(body.workstream.baseSha).toBe(posted.workstream.baseSha);
        expect(body.workstream.branchStatus).toBe("created");
        expect(body.events.map((event: { kind: string }) => event.kind)).toEqual([
          "mission.created",
          "workstream.created",
          "workstream.branch_created"
        ]);
        expect(body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3]);
      }
    } finally {
      await cold.close();
    }
  });
});

describe("unconfigured provider", () => {
  it("refuses listing and creation with 503 repo_unconfigured, persisting nothing", async () => {
    const before = await tableCounts();
    const unconfigured = buildServer(db, config, new UnconfiguredRepositoryProvider());
    await unconfigured.ready();
    try {
      const list = await unconfigured.inject({
        method: "GET",
        url: "/repositories/available",
        headers: { authorization: `Bearer ${auth.token}` }
      });
      expect(list.statusCode).toBe(503);
      expect(list.json().error.code).toBe("repo_unconfigured");

      const created = await postMission(unconfigured, {
        goal: "Create without a configured provider",
        successCriteria: "Refused with a named error",
        providerRepoId: "9001",
        baseRef: "main",
        baseSha: "b".repeat(40),
        creationKey: crypto.randomUUID()
      });
      expect(created.statusCode).toBe(503);
      expect(created.json().error.code).toBe("repo_unconfigured");
      expect(await tableCounts()).toEqual(before);
    } finally {
      await unconfigured.close();
    }
  });
});

describe("security", () => {
  it("never records anything credential-shaped in any event payload", async () => {
    const rows = await db.query("select payload::text as payload from events");
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      const text = row.payload as string;
      expect(text).not.toMatch(/bearer/i);
      expect(text).not.toMatch(/token/i);
      expect(text).not.toMatch(/secret/i);
      expect(text).not.toMatch(/ghp_|gho_/);
      expect(text).not.toContain(auth.token);
    }
  });
});
