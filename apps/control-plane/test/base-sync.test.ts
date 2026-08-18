import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Following a moved base — the record half (D-144).
 *
 * The merges happen on the machine that holds the worktrees; what the control
 * plane owns is the pin, and these tests are about the ways moving it could
 * lie: a stale room moving the base to something nobody reviewed, a sync
 * recorded while a turn was running through the old base, a report that
 * skipped a lane so two approaches ended up standing on different ground, and
 * a viewer moving what only the mission's operators may move.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

interface Lane {
  missionId: string;
  workstreamId: string;
  baseSha: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_base_sync");
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
      goal: "Stay standing while the base moves",
      successCriteria: "The pin follows only a person's explicit act",
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
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId,
    baseSha: headSha
  };
}

function syncBody(lane: Lane, newBaseSha: string, overrides?: Record<string, unknown>) {
  return {
    expectedBaseSha: lane.baseSha,
    newBaseSha,
    lanes: [{ workstreamId: lane.workstreamId, headSha: sha("merge-of-" + lane.workstreamId) }],
    ...overrides
  };
}

async function pinnedSha(workstreamId: string): Promise<string> {
  const row = await harness.db.query("select base_sha from workstreams where wst_id = $1", [
    workstreamId
  ]);
  return row.rows[0].base_sha as string;
}

describe("recording a base sync", () => {
  it("moves the pin and says so as an event", async () => {
    const lane = await mission();
    const tip = sha("the base moved here");
    const response = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/base-sync`,
      headers: bearer(kartik),
      payload: syncBody(lane, tip)
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().baseSha).toBe(tip);
    expect(await pinnedSha(lane.workstreamId)).toBe(tip);
    const event = await harness.db.query(
      "select payload from events where mission_id = $1 and kind = 'workspace.base_synced'",
      [lane.missionId]
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0].payload.fromSha).toBe(lane.baseSha);
    expect(event.rows[0].payload.toSha).toBe(tip);
  });

  it("refuses a stale room: the pin is not where the asker last saw it", async () => {
    const lane = await mission();
    const response = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/base-sync`,
      headers: bearer(kartik),
      payload: syncBody(lane, sha("new tip"), { expectedBaseSha: sha("somewhere else") })
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_base");
    expect(await pinnedSha(lane.workstreamId)).toBe(lane.baseSha);
  });

  it("refuses a report that does not cover exactly this mission's lanes", async () => {
    const lane = await mission();
    const stranger = await mission();
    const response = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/base-sync`,
      headers: bearer(kartik),
      payload: syncBody(lane, sha("new tip"), {
        lanes: [
          { workstreamId: lane.workstreamId, headSha: sha("merge one") },
          { workstreamId: stranger.workstreamId, headSha: sha("merge two") }
        ]
      })
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("lanes_mismatch");
    expect(await pinnedSha(lane.workstreamId)).toBe(lane.baseSha);
  });

  it("refuses while a turn is running anywhere in the mission", async () => {
    const lane = await mission();
    const enrolled = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${lane.workstreamId}/runner`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, label: "kartik-macbook" }
    });
    expect(enrolled.statusCode).toBe(200);
    const directed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: {
        body: "Keep working",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: lane.workstreamId
      }
    });
    expect(directed.statusCode).toBe(200);

    const response = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/base-sync`,
      headers: bearer(kartik),
      payload: syncBody(lane, sha("new tip"))
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("turn_running");
    expect(await pinnedSha(lane.workstreamId)).toBe(lane.baseSha);
  });

  it("is refused to a viewer: base.sync is the operators' capability", async () => {
    const lane = await mission();
    const viewer = await harness.signIn("viewer-person");
    const invited = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "viewer" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(viewer),
      payload: { token: invited.json().token }
    });
    const response = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/base-sync`,
      headers: bearer(viewer),
      payload: syncBody(lane, sha("new tip"))
    });
    expect(response.statusCode).toBe(403);
    expect(await pinnedSha(lane.workstreamId)).toBe(lane.baseSha);
  });
});
