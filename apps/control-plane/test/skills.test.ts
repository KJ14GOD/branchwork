import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectSkill } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Project skills (D-118).
 *
 * The rules under test at the control plane: the runner publishes the
 * worktree's `.claude/skills` manifest beside the declared commands (D-043's
 * pattern) and the control plane stores it verbatim; enabling is `skills.set`
 * — Mission Admin and Operator, never the baton — and every entry must match
 * the published manifest at exactly the digest the person was shown, because
 * what is approved is what was reviewed; a change is one recorded
 * `skills.changed` event with both sets verbatim; and the set a turn runs
 * with is pinned at dispatch, so an enablement mid-turn speaks from the next
 * turn. The runner-side half — composing the skills-only plugin directory and
 * dropping a stale digest by name — is proven in the desktop suites.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
}

/** The manifest this suite's imaginary project publishes: two skills, sealed
 *  the way the runner seals them — the digest is of the SKILL.md bytes, and
 *  the control plane only ever carries it. */
const skill = (name: string, body: string, description: string | null = null): ProjectSkill => ({
  name,
  description,
  digest: sha256(body),
  bytes: Buffer.byteLength(body)
});
const ZEPHYR = skill("zephyr-codes", "The codeword is XILOPHONE-72.", "Codewords for releases.");
const RELEASE = skill("release-notes", "Write the notes in the changelog voice.");

let seq = 0;

beforeAll(async () => {
  harness = await createHarness("novus_test_skills", new FakeRepositoryProvider());
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
      goal: "Teach the harness this project's own procedures",
      successCriteria: "Only what a person enabled is carried",
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

/** The runner saying what the worktree holds — commands and skills in the one
 *  `workspace.declared` publish (D-043, D-118). */
async function publish(lane: Lane, skills: ProjectSkill[]) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(lane.credential),
    payload: {
      executionId: null,
      events: [
        {
          originSeq: (seq += 1),
          event: { kind: "workspace.declared", payload: { commands: [], skills } }
        }
      ]
    }
  });
  expect(response.statusCode).toBe(200);
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

async function setSkills(
  lane: Lane,
  skills: { name: string; digest: string }[],
  options: { as?: SignedIn } = {}
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/workstreams/${lane.workstreamId}/skills`,
    headers: bearer(options.as ?? kartik),
    payload: { skills }
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
    payload: { body, model: "claude-fable-5", effort: "high", workstreamId: lane.workstreamId }
  });
}

const eventsOf = async (lane: Lane, kind: string) => {
  const result = await harness.db.query(
    "select payload, actor_kind from events where mission_id = $1 and kind = $2 order by seq",
    [lane.missionId, kind]
  );
  return result.rows as { payload: Record<string, unknown>; actor_kind: string }[];
};

describe("the published manifest", () => {
  it("reaches the wire beside the declared commands, and a lane starts with none enabled", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR, RELEASE]);
    const detail = await detailOf(lane);
    expect(detail.workspace.skills).toEqual([ZEPHYR, RELEASE]);
    expect(detail.workstream.enabledSkills).toEqual([]);
    expect(detail.capabilities).toContain("skills.set");
  });
});

describe("who may enable", () => {
  it("an Operator enables, the change is one recorded event, and a repeat records nothing", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR, RELEASE]);
    const operator = await joinAs(lane.missionId, "op-skills", "operator");
    const enabled = await setSkills(lane, [{ name: ZEPHYR.name, digest: ZEPHYR.digest }], {
      as: operator
    });
    expect(enabled.statusCode).toBe(200);
    const detail = await detailOf(lane);
    expect(detail.workstream.enabledSkills).toEqual([{ name: ZEPHYR.name, digest: ZEPHYR.digest }]);
    const changes = await eventsOf(lane, "skills.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({
      from: [],
      to: [{ name: ZEPHYR.name, digest: ZEPHYR.digest }]
    });
    expect(changes[0]?.actor_kind).toBe("user");
    // Same set twice is not a change: nothing is recorded for a repeat.
    expect(
      (await setSkills(lane, [{ name: ZEPHYR.name, digest: ZEPHYR.digest }], { as: operator }))
        .statusCode
    ).toBe(200);
    expect(await eventsOf(lane, "skills.changed")).toHaveLength(1);
  });

  it("a Contributor is refused — holding the baton included — and a stranger is told nothing exists", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR]);
    const contributor = await joinAs(lane.missionId, "con-skills", "contributor");
    const stranger = await harness.signIn("stranger-skills");
    const entry = [{ name: ZEPHYR.name, digest: ZEPHYR.digest }];
    expect((await setSkills(lane, entry, { as: contributor })).statusCode).toBe(403);
    expect((await setSkills(lane, entry, { as: stranger })).statusCode).toBe(404);
    // The ordinary handshake hands the contributor the baton; skills.set is
    // in no lease list, so the refusal stands (the policy.set rule, D-115).
    await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/request`,
      headers: bearer(contributor),
      payload: {}
    });
    await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/offer`,
      headers: bearer(kartik),
      payload: { toUserId: contributor.userId }
    });
    const offerId = (await detailOf(lane, contributor)).control.liveOffer.offerId as string;
    await harness.app.inject({
      method: "POST",
      url: `/control/offers/${offerId}/accept`,
      headers: bearer(contributor),
      payload: {}
    });
    const detail = await detailOf(lane, contributor);
    expect(detail.control.holderLogin).toBe("con-skills");
    expect(detail.capabilities).not.toContain("skills.set");
    expect((await setSkills(lane, entry, { as: contributor })).statusCode).toBe(403);
    expect((await detailOf(lane)).workstream.enabledSkills).toEqual([]);
  });
});

describe("what is approved is what was reviewed", () => {
  it("refuses a skill the manifest does not carry, in words", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR]);
    const refused = await setSkills(lane, [{ name: "release-notes", digest: RELEASE.digest }]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain("release-notes");
    expect((await detailOf(lane)).workstream.enabledSkills).toEqual([]);
  });

  it("refuses a stale digest, and accepts the skill as it is now", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR]);
    const rewritten = skill("zephyr-codes", "The codeword is different now.");
    // The agent rewrote the skill; the runner republished; the old review no
    // longer names what is in the worktree.
    await publish(lane, [rewritten]);
    const stale = await setSkills(lane, [{ name: ZEPHYR.name, digest: ZEPHYR.digest }]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toContain("changed since it was reviewed");
    const fresh = await setSkills(lane, [{ name: rewritten.name, digest: rewritten.digest }]);
    expect(fresh.statusCode).toBe(200);
    expect((await detailOf(lane)).workstream.enabledSkills).toEqual([
      { name: rewritten.name, digest: rewritten.digest }
    ]);
  });

  it("refuses a malformed set — a path for a name, a short digest — as unparseable", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR]);
    for (const skills of [
      [{ name: "../escape", digest: ZEPHYR.digest }],
      [{ name: ZEPHYR.name, digest: "short" }]
    ]) {
      const refused = await setSkills(lane, skills);
      expect(refused.statusCode).toBe(422);
    }
    expect((await detailOf(lane)).workstream.enabledSkills).toEqual([]);
  });
});

describe("pinned at dispatch", () => {
  it("a turn carries the set the lane stood under when it was authorized, and a change speaks from the next turn", async () => {
    const lane = await mission();
    await publish(lane, [ZEPHYR, RELEASE]);
    const entry = [{ name: ZEPHYR.name, digest: ZEPHYR.digest }];
    expect((await setSkills(lane, entry)).statusCode).toBe(200);
    const first = await direct(lane, "use the codeword skill");
    expect(first.statusCode).toBe(200);
    const detail = await detailOf(lane);
    const execution = detail.executions[0];
    const command = await harness.db.query(
      "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [execution.executionId]
    );
    expect(command.rowCount).toBe(1);
    expect((command.rows[0].payload as { skills?: unknown }).skills).toEqual(entry);
    // The lane's set changes; the running turn's pinned set does not.
    expect((await setSkills(lane, [])).statusCode).toBe(200);
    expect((await detailOf(lane)).workstream.enabledSkills).toEqual([]);
    const pinned = await harness.db.query(
      "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [execution.executionId]
    );
    expect((pinned.rows[0].payload as { skills?: unknown }).skills).toEqual(entry);
  });

  it("a foreign lane is answered as not found, never with the default lane's authority", async () => {
    const lane = await mission();
    const other = await mission();
    await publish(other, [ZEPHYR]);
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/workstreams/${other.workstreamId}/skills`,
      headers: bearer(kartik),
      payload: { skills: [{ name: ZEPHYR.name, digest: ZEPHYR.digest }] }
    });
    expect(refused.statusCode).toBe(404);
    expect((await detailOf(other)).workstream.enabledSkills).toEqual([]);
  });
});
