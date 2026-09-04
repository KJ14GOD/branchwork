import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Disconnecting a repository from its organization (D-235).
 *
 * As with archival, what matters is what disconnection must *not* do: it is
 * not deletion, so every mission the repository ever had stays readable and
 * filed exactly where it was; it is not a way to make live work vanish, so it
 * is refused while any mission is still listed; and it is not the end of the
 * repository, so connecting the same folder again — or restoring one of its
 * archived missions — brings the same row back. There is no delete verb.
 */

let harness: Harness;
let owner: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

async function connectLocal(name = "novus/local"): Promise<{ localId: string; repoId: string; headSha: string }> {
  const localId = randomUUID();
  const headSha = sha(localId);
  const registered = await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(owner),
    payload: { localId, name, defaultBranch: "main", headSha }
  });
  expect(registered.statusCode).toBe(200);
  return { localId, repoId: registered.json().repository.repoId as string, headSha };
}

async function createMission(repo: { localId: string; headSha: string }, goal = "Route approvals to a person") {
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(owner),
    payload: {
      goal,
      successCriteria: "Nothing is written without somebody saying so",
      provider: "local",
      providerRepoId: repo.localId,
      baseRef: "main",
      baseSha: repo.headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  return created.json().mission.missionId as string;
}

async function listedLocal(as: SignedIn = owner): Promise<string[]> {
  const listed = await harness.app.inject({ method: "GET", url: "/repositories/local", headers: bearer(as) });
  expect(listed.statusCode).toBe(200);
  return (listed.json().repositories as { repoId: string }[]).map((repo) => repo.repoId);
}

const disconnect = (repoId: string, as: SignedIn = owner) =>
  harness.app.inject({ method: "POST", url: `/repositories/${repoId}/disconnect`, headers: bearer(as) });

const archive = (missionId: string) =>
  harness.app.inject({ method: "POST", url: `/missions/${missionId}/archive`, headers: bearer(owner) });

beforeAll(async () => {
  harness = await createHarness("novus_test_repositories");
  owner = await harness.signIn();
});

afterAll(async () => {
  await harness.close();
});

describe("disconnecting a repository (D-235)", () => {
  it("refuses while a mission is still listed, in words, and disconnects once every mission is archived", async () => {
    const repo = await connectLocal();
    const missionId = await createMission(repo);
    expect(await listedLocal()).toContain(repo.repoId);

    const refused = await disconnect(repo.repoId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("missions_listed");
    expect(refused.json().error.message).toBe("This project still lists a mission. Archive it first.");
    // Refused means untouched: still connected, still listed.
    expect(await listedLocal()).toContain(repo.repoId);

    expect((await archive(missionId)).statusCode).toBe(200);
    const disconnected = await disconnect(repo.repoId);
    expect(disconnected.statusCode).toBe(200);
    expect(await listedLocal()).not.toContain(repo.repoId);

    // Not deletion: the archived mission is exactly where it was, readable by
    // the person who could read it before and still filed under Archived.
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(owner)
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().mission.archivedAt).not.toBeNull();
    expect(read.json().mission.repository?.repoId).toBe(repo.repoId);
    const filed = await harness.app.inject({
      method: "GET",
      url: "/missions?filter=archived",
      headers: bearer(owner)
    });
    expect((filed.json().missions as { missionId: string }[]).map((m) => m.missionId)).toContain(missionId);

    // The row carries who did it and when — attribution without a mission to
    // hang an event on.
    const row = await harness.db.query(
      "select disconnected_at, disconnected_by from repositories where repo_id = $1",
      [repo.repoId]
    );
    expect(row.rows[0].disconnected_at).not.toBeNull();
    expect(row.rows[0].disconnected_by).toBe(owner.userId);

    // Disconnecting again is what the caller asked for either way.
    expect((await disconnect(repo.repoId)).statusCode).toBe(200);
  });

  it("counts every listed mission, archived ones excepted", async () => {
    const repo = await connectLocal("novus/counted");
    const first = await createMission(repo, "first");
    await createMission(repo, "second");
    await createMission(repo, "third");
    expect((await archive(first)).statusCode).toBe(200);
    const refused = await disconnect(repo.repoId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe("This project still lists 2 missions. Archive them first.");
  });

  it("comes back on the same row when the same folder is connected again", async () => {
    const repo = await connectLocal("novus/again");
    expect((await disconnect(repo.repoId)).statusCode).toBe(200);
    expect(await listedLocal()).not.toContain(repo.repoId);

    const again = await harness.app.inject({
      method: "POST",
      url: "/repositories/local",
      headers: bearer(owner),
      payload: { localId: repo.localId, name: "novus/again", defaultBranch: "main", headSha: repo.headSha }
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().repository.repoId).toBe(repo.repoId);
    expect(await listedLocal()).toContain(repo.repoId);
    const row = await harness.db.query("select disconnected_at from repositories where repo_id = $1", [
      repo.repoId
    ]);
    expect(row.rows[0].disconnected_at).toBeNull();
  });

  it("reconnects when one of its archived missions is restored", async () => {
    const repo = await connectLocal("novus/restored");
    const missionId = await createMission(repo);
    expect((await archive(missionId)).statusCode).toBe(200);
    expect((await disconnect(repo.repoId)).statusCode).toBe(200);
    expect(await listedLocal()).not.toContain(repo.repoId);

    const restored = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/restore`,
      headers: bearer(owner)
    });
    expect(restored.statusCode).toBe(200);
    // A listed mission's project is connected by definition.
    expect(await listedLocal()).toContain(repo.repoId);
  });

  it("is the organization owner's alone: a member is refused by name, a stranger finds nothing", async () => {
    const repo = await connectLocal("novus/owned");
    const missionId = await createMission(repo);

    // A member: invited into a mission, which makes them a member of the
    // owner's organization (D-036) — and nothing more.
    const member = await harness.signIn("maya");
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/invitations`,
      headers: bearer(owner),
      payload: { role: "operator" }
    });
    expect(invitation.statusCode).toBe(201);
    const redeemed = await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(member),
      payload: { token: invitation.json().token }
    });
    expect(redeemed.statusCode).toBe(200);
    const memberRefused = await disconnect(repo.repoId, member);
    expect(memberRefused.statusCode).toBe(403);
    expect(memberRefused.json().error.code).toBe("forbidden");

    // A stranger: no membership, so no such repository — the id is never a
    // capability.
    const stranger = await harness.signIn("stranger");
    const strangerRefused = await disconnect(repo.repoId, stranger);
    expect(strangerRefused.statusCode).toBe(404);
    expect(strangerRefused.json().error.code).toBe("not_found");
    expect((await disconnect("rep_does_not_exist", stranger)).statusCode).toBe(404);

    // Neither touched anything.
    expect(await listedLocal()).toContain(repo.repoId);
  });

  it("offers no way to delete a repository at all", async () => {
    const repo = await connectLocal("novus/undeletable");
    for (const attempt of [
      { method: "DELETE" as const, url: `/repositories/${repo.repoId}` },
      { method: "POST" as const, url: `/repositories/${repo.repoId}/delete` },
      { method: "DELETE" as const, url: `/repositories/local/${repo.localId}` }
    ]) {
      const response = await harness.app.inject({ ...attempt, headers: bearer(owner) });
      expect(response.statusCode).toBe(404);
    }
    expect(await listedLocal()).toContain(repo.repoId);
  });
});
