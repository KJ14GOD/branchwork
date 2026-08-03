import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import type { CloneCredential, CloneCredentialMinter } from "../src/repo-clone.ts";

/**
 * The credential that lets a runner put a GitHub repository on the machine it
 * runs on, against a real PostgreSQL.
 *
 * What these are for: the token is the one thing in this slice that could turn
 * a collaboration product into a credential-distribution service. So they
 * assert the boundary rather than the happy path — who may ask, for what, and
 * where the answer is not allowed to appear.
 *
 * They are deterministic evidence for those paths and nothing more. A real
 * GitHub App minting a real installation token against a real repository is a
 * separate claim, and it is not made here (AGENTS.md rule 11).
 */

const TOKEN = "ghs_only_a_runner_should_ever_see_this";

/** The fake repository provider, plus the one capability the live GitHub App
 *  adapter adds: minting a credential for a single repository. */
class MintingProvider extends FakeRepositoryProvider implements CloneCredentialMinter {
  readonly minted: string[] = [];
  async mintCloneCredential(providerRepoId: string): Promise<CloneCredential> {
    this.minted.push(providerRepoId);
    return {
      remoteUrl: `https://github.com/novus/repo-${providerRepoId}.git`,
      username: "x-access-token",
      token: TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    };
  }
}

let harness: Harness;
let provider: MintingProvider;
let owner: SignedIn;

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
}

async function createGithubLane(providerRepoId: string, goal: string): Promise<Lane> {
  const base = await harness.app.inject({
    method: "GET",
    url: `/repositories/available/${providerRepoId}/base`,
    headers: bearer(owner)
  });
  expect(base.statusCode).toBe(200);
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(owner),
    payload: {
      goal,
      successCriteria: "The repository is on the machine that runs it",
      provider: "github",
      providerRepoId,
      baseRef: base.json().ref,
      baseSha: base.json().sha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  return {
    missionId: body.mission.missionId as string,
    workstreamId: body.workstream.workstreamId as string,
    credential: await enrol(body.workstream.workstreamId as string)
  };
}

async function createLocalLane(): Promise<Lane> {
  const localId = randomUUID();
  const headSha = "b".repeat(40);
  const registered = await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(owner),
    payload: { localId, name: "novus/on-this-machine", defaultBranch: "main", headSha }
  });
  expect(registered.statusCode).toBe(200);
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(owner),
    payload: {
      goal: "Work a folder that is already here",
      successCriteria: "Nothing is fetched",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  return {
    missionId: body.mission.missionId as string,
    workstreamId: body.workstream.workstreamId as string,
    credential: await enrol(body.workstream.workstreamId as string)
  };
}

async function enrol(workstreamId: string): Promise<string> {
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(owner),
    payload: { workstreamId, label: "test-machine" }
  });
  expect(enrolled.statusCode).toBe(200);
  return enrolled.json().credential as string;
}

async function askForCredential(credential: string, payload: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: "POST",
    url: "/runner/clone-credential",
    headers: { authorization: `Runner ${credential}` },
    payload
  });
}

beforeAll(async () => {
  provider = new MintingProvider();
  harness = await createHarness("novus_repo_clone_test", provider);
  owner = await harness.signIn();
});

afterAll(async () => {
  await harness.close();
});

describe("who may obtain repository access", () => {
  it("issues a repository-scoped credential to the authenticated runner", async () => {
    const lane = await createGithubLane("9001", "Fetch demo-app onto this machine");
    const response = await askForCredential(lane.credential);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toBe(TOKEN);
    expect(body.username).toBe("x-access-token");
    // Plain: a URL with a secret in its authority ends up in .git/config.
    expect(body.remoteUrl).toBe("https://github.com/novus/repo-9001.git");
    expect(body.remoteUrl).not.toContain("@");
    expect(typeof body.expiresAt).toBe("string");
    // Scoped to the repository behind this runner's own workstream.
    expect(provider.minted.at(-1)).toBe("9001");
  });

  it("refuses a user session — a person is not a runner", async () => {
    const lane = await createGithubLane("9002", "A session must not be able to ask");
    const response = await harness.app.inject({
      method: "POST",
      url: "/runner/clone-credential",
      headers: bearer(owner),
      payload: { workstreamId: lane.workstreamId }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("runner_unauthenticated");
    expect(response.body).not.toContain(TOKEN);
  });

  it("refuses an unknown, revoked, or expired credential the same way", async () => {
    const lane = await createGithubLane("9003", "A stale credential buys nothing");
    await harness.db.query("update runners set revoked_at = now() where wst_id = $1", [lane.workstreamId]);

    const revoked = await askForCredential(lane.credential);
    const unknown = await askForCredential("not-a-credential-anyone-ever-issued");
    expect(revoked.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe(unknown.json().error.code);
  });
});

describe("what a runner may obtain it for", () => {
  it("refuses a workstream that is not this runner's", async () => {
    const mine = await createGithubLane("9001", "My lane");
    const other = await createGithubLane("9002", "Someone else's lane");
    const before = provider.minted.length;

    const response = await askForCredential(mine.credential, { workstreamId: other.workstreamId });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    expect(response.body).not.toContain(TOKEN);
    // Refused before anything was minted: not answered with the wrong lane's
    // credential, and not answered with the right one either.
    expect(provider.minted.length).toBe(before);
  });

  it("answers only for the repository its own credential names", async () => {
    const mine = await createGithubLane("9002", "Only my repository");
    const response = await askForCredential(mine.credential);
    expect(response.statusCode).toBe(200);
    expect(provider.minted.at(-1)).toBe("9002");
  });

  it("tells a local repository's runner there is nothing to fetch", async () => {
    const local = await createLocalLane();
    const before = provider.minted.length;

    const response = await askForCredential(local.credential);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("clone_not_needed");
    expect(provider.minted.length).toBe(before);
  });
});

describe("where the token is not allowed to appear", () => {
  it("writes it to no event, no command, and no durable row", async () => {
    const lane = await createGithubLane("9001", "The token is spent, not stored");
    const issued = await askForCredential(lane.credential);
    expect(issued.statusCode).toBe(200);

    // Everything the control plane keeps about this mission, as text.
    const events = await harness.db.query("select payload::text as payload, kind from events where mission_id = $1", [
      lane.missionId
    ]);
    expect(events.rowCount).toBeGreaterThan(0);
    for (const row of events.rows) {
      expect(row.payload).not.toContain(TOKEN);
      expect(row.kind).not.toContain("clone");
    }

    const commands = await harness.db.query(
      "select payload::text as payload from runner_commands where wst_id = $1",
      [lane.workstreamId]
    );
    for (const row of commands.rows) expect(row.payload).not.toContain(TOKEN);

    const runners = await harness.db.query("select * from runners where wst_id = $1", [lane.workstreamId]);
    expect(JSON.stringify(runners.rows)).not.toContain(TOKEN);

    // And nothing a participant reads carries it either.
    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(owner)
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(TOKEN);
  });
});

describe("a deployment that cannot fetch anything", () => {
  it("refuses by name instead of pretending", async () => {
    // The deterministic fake has no repository to fetch and no credential to
    // mint — an unconfigured deployment must say so (D-031).
    const plain = await createHarness("novus_repo_clone_unconfigured_test", new FakeRepositoryProvider());
    try {
      const session = await plain.signIn();
      const base = await plain.app.inject({
        method: "GET",
        url: "/repositories/available/9001/base",
        headers: bearer(session)
      });
      const created = await plain.app.inject({
        method: "POST",
        url: "/missions",
        headers: bearer(session),
        payload: {
          goal: "A repository nothing can fetch",
          successCriteria: "The refusal has a name",
          provider: "github",
          providerRepoId: "9001",
          baseRef: base.json().ref,
          baseSha: base.json().sha,
          creationKey: randomUUID()
        }
      });
      expect(created.statusCode).toBe(201);
      const workstreamId = created.json().workstream.workstreamId as string;
      const enrolled = await plain.app.inject({
        method: "POST",
        url: `/workstreams/${workstreamId}/runner`,
        headers: bearer(session),
        payload: { workstreamId, label: "test-machine" }
      });
      expect(enrolled.statusCode).toBe(200);

      const response = await plain.app.inject({
        method: "POST",
        url: "/runner/clone-credential",
        headers: { authorization: `Runner ${enrolled.json().credential}` },
        payload: {}
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("clone_unavailable");
    } finally {
      await plain.close();
    }
  });
});
