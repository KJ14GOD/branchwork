import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Permission profiles (D-115).
 *
 * The rules under test at the control plane: a profile is a role act —
 * `policy.set`, Mission Admin and Operator, never the baton — with `dont_ask`
 * tiered to Mission Admin alone and refused until its warning is acknowledged;
 * `bypass` is not a value the wire can even parse; a change is event-recorded
 * with what was acknowledged, verbatim; and the profile a turn runs under is
 * pinned at dispatch — onto the execution row and the start command — so a
 * change mid-turn speaks from the next turn. The runner-side half (what each
 * profile answers at the control channel) is proven in the desktop suites.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_policy", new FakeRepositoryProvider());
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function mission(): Promise<Lane> {
  const localId = randomUUID();
  const headSha = sha(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "Choose how much the harness asks",
      successCriteria: "Every grant on the record",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const workstreamId = created.json().workstream.workstreamId as string;
  await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/branch/report`,
    headers: bearer(kartik),
    payload: { status: "created" }
  });
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId, label: "kartik-macbook" }
  });
  expect(enrolled.statusCode).toBe(200);
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId,
    credential: enrolled.json().credential as string
  };
}

async function joinAs(missionId: string, who: string, role: string): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(kartik),
    payload: { role }
  });
  await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token: created.json().token }
  });
  return joiner;
}

async function setProfile(
  lane: Lane,
  profile: string,
  options: { as?: SignedIn; acknowledged?: string | null } = {}
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/workstreams/${lane.workstreamId}/policy`,
    headers: bearer(options.as ?? kartik),
    payload: { profile, ...(options.acknowledged !== undefined ? { acknowledged: options.acknowledged } : {}) }
  });
}

const detailOf = async (lane: Lane, as: SignedIn = kartik) => {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}`,
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

async function direct(lane: Lane, body: string, as: SignedIn = kartik) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(as),
    payload: {
      body,
      model: "claude-fable-5",
      effort: "high",
      workstreamId: lane.workstreamId
    }
  });
}

const eventsOf = async (lane: Lane, kind: string) => {
  const result = await harness.db.query(
    "select payload, actor_kind from events where mission_id = $1 and kind = $2 order by seq",
    [lane.missionId, kind]
  );
  return result.rows as { payload: Record<string, unknown>; actor_kind: string }[];
};

describe("what a lane starts with", () => {
  it("is manual — every question asked — with the word on the wire", async () => {
    const lane = await mission();
    const detail = await detailOf(lane);
    expect(detail.workstream.permissionProfile).toBe("manual");
    expect(detail.capabilities).toContain("policy.set");
  });
});

describe("who may set it", () => {
  it("an Operator relaxes to accept_edits, and the change is one recorded event", async () => {
    const lane = await mission();
    const operator = await joinAs(lane.missionId, "op-profiles", "operator");
    const response = await setProfile(lane, "accept_edits", { as: operator });
    expect(response.statusCode).toBe(200);
    const detail = await detailOf(lane);
    expect(detail.workstream.permissionProfile).toBe("accept_edits");
    const changes = await eventsOf(lane, "policy.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({ from: "manual", to: "accept_edits" });
    expect(changes[0]?.actor_kind).toBe("user");
    // Same word twice is not a change: nothing is recorded for a repeat.
    expect((await setProfile(lane, "accept_edits", { as: operator })).statusCode).toBe(200);
    expect(await eventsOf(lane, "policy.changed")).toHaveLength(1);
  });

  it("a Contributor is refused, a Viewer is refused, a stranger is told nothing exists", async () => {
    const lane = await mission();
    const contributor = await joinAs(lane.missionId, "con-profiles", "contributor");
    const viewer = await joinAs(lane.missionId, "view-profiles", "viewer");
    const stranger = await harness.signIn("stranger-profiles");
    const refusedContributor = await setProfile(lane, "plan", { as: contributor });
    expect(refusedContributor.statusCode).toBe(403);
    const refusedViewer = await setProfile(lane, "plan", { as: viewer });
    expect(refusedViewer.statusCode).toBe(403);
    const refusedStranger = await setProfile(lane, "plan", { as: stranger });
    expect(refusedStranger.statusCode).toBe(404);
    const detail = await detailOf(lane, contributor);
    expect(detail.capabilities).not.toContain("policy.set");
    expect(detail.workstream.permissionProfile).toBe("manual");
  });

  it("the baton grants nothing here: a Contributor holding the lease is still refused", async () => {
    const lane = await mission();
    const contributor = await joinAs(lane.missionId, "con-baton-profiles", "contributor");
    // Request → offer → accept, the ordinary handshake; the lane is idle so
    // the transfer completes immediately.
    const requested = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/request`,
      headers: bearer(contributor),
      payload: {}
    });
    expect(requested.statusCode).toBe(200);
    const offered = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/offer`,
      headers: bearer(kartik),
      payload: { toUserId: contributor.userId }
    });
    expect(offered.statusCode).toBe(200);
    const offerId = (await detailOf(lane, contributor)).control.liveOffer.offerId as string;
    const accepted = await harness.app.inject({
      method: "POST",
      url: `/control/offers/${offerId}/accept`,
      headers: bearer(contributor),
      payload: {}
    });
    expect(accepted.statusCode).toBe(200);
    const detail = await detailOf(lane, contributor);
    expect(detail.control.holderLogin).toBe("con-baton-profiles");
    // Holding the baton, and still not this: policy.set is in no lease list.
    expect(detail.capabilities).not.toContain("policy.set");
    const refused = await setProfile(lane, "accept_edits", { as: contributor });
    expect(refused.statusCode).toBe(403);
  });
});

describe("the dangerous tier", () => {
  it("dont_ask is Mission Admin's alone, refused for an Operator in words", async () => {
    const lane = await mission();
    const operator = await joinAs(lane.missionId, "op-dontask", "operator");
    const refused = await setProfile(lane, "dont_ask", {
      as: operator,
      acknowledged: "Every act will be approved by this policy."
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain("Mission Admin");
    expect((await detailOf(lane)).workstream.permissionProfile).toBe("manual");
  });

  it("dont_ask is refused until its warning is acknowledged, then records the sentence verbatim", async () => {
    const lane = await mission();
    const unacknowledged = await setProfile(lane, "dont_ask");
    expect(unacknowledged.statusCode).toBe(409);
    const sentence =
      "Every act Claude asks about will be approved by this policy, shell commands included, until the profile changes.";
    const accepted = await setProfile(lane, "dont_ask", { acknowledged: sentence });
    expect(accepted.statusCode).toBe(200);
    expect((await detailOf(lane)).workstream.permissionProfile).toBe("dont_ask");
    const changes = await eventsOf(lane, "policy.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload.acknowledged).toBe(sentence);
  });

  it("bypass does not parse — by its own name or Claude's", async () => {
    const lane = await mission();
    for (const word of ["bypass", "bypassPermissions"]) {
      const refused = await setProfile(lane, word);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.message).toContain("bypass");
    }
    expect((await detailOf(lane)).workstream.permissionProfile).toBe("manual");
  });
});

describe("pinned at dispatch", () => {
  it("a turn carries the profile the lane stood under when it was authorized, and a change speaks from the next turn", async () => {
    const lane = await mission();
    expect((await setProfile(lane, "accept_edits")).statusCode).toBe(200);
    const first = await direct(lane, "write the thing");
    expect(first.statusCode).toBe(200);
    const detail = await detailOf(lane);
    const execution = detail.executions[0];
    expect(execution.permissionProfile).toBe("accept_edits");
    const command = await harness.db.query(
      "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [execution.executionId]
    );
    expect(command.rowCount).toBe(1);
    expect((command.rows[0].payload as { permissionProfile?: string }).permissionProfile).toBe(
      "accept_edits"
    );
    // The lane's word changes; the running turn's does not.
    expect((await setProfile(lane, "plan")).statusCode).toBe(200);
    const after = await detailOf(lane);
    expect(after.workstream.permissionProfile).toBe("plan");
    expect(after.executions[0].permissionProfile).toBe("accept_edits");
  });

  it("a foreign lane is answered as not found, never with the default lane's authority", async () => {
    const lane = await mission();
    const other = await mission();
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/workstreams/${other.workstreamId}/policy`,
      headers: bearer(kartik),
      payload: { profile: "plan" }
    });
    expect(refused.statusCode).toBe(404);
    expect((await detailOf(other)).workstream.permissionProfile).toBe("manual");
  });
});
