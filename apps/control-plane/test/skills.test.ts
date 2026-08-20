import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectSkill } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Project skills and the manifests around them (D-118, D-186, D-187, D-193).
 *
 * What the control plane still owes after D-193 removed the skill and
 * command enablement routes: the runner publishes what the worktree holds and
 * what the machine holds, and the control plane stores it verbatim and serves
 * it to every participant. Nothing here gates a skill any more — every
 * declared skill is carried, and the turn's own record names what ran. MCP
 * servers keep their gate and their tests, one tier up.
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
  bytes: Buffer.byteLength(body),
  // Whether the harness may reach for it unasked (D-192); the runner reads it
  // from the SKILL.md, and the wire carries it like every other fact.
  modelInvocable: true
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
  });

  it("carries the runner machine's global skills for display, apart from the enableable list (D-186)", async () => {
    const lane = await mission();
    const response = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(lane.credential),
      payload: {
        executionId: null,
        events: [
          {
            originSeq: (seq += 1),
            event: {
              kind: "workspace.declared",
              payload: { commands: [], skills: [ZEPHYR], globalSkills: [RELEASE] }
            }
          }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const detail = await detailOf(lane);
    expect(detail.workspace.skills).toEqual([ZEPHYR]);
    expect(detail.workspace.globalSkills).toEqual([RELEASE]);
  });
});




describe("project MCP servers (D-119)", () => {
  const DOCS = {
    name: "docs",
    transport: "stdio" as const,
    command: "node mcp/docs.js",
    args: [],
    env: [],
    url: null,
    digest: sha256("stdio:node mcp/docs.js")
  };

  async function publishMcp(lane: Lane, servers: unknown[]) {
    const response = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(lane.credential),
      payload: {
        executionId: null,
        events: [
          {
            originSeq: (seq += 1),
            event: { kind: "workspace.declared", payload: { commands: [], mcpServers: servers } }
          }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
  }

  async function setMcp(lane: Lane, servers: { name: string; digest: string }[], as: SignedIn = kartik) {
    return harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/workstreams/${lane.workstreamId}/mcp`,
      headers: bearer(as),
      payload: { servers }
    });
  }

  it("is Mission Admin's alone: an Operator is refused in words, and the wire carries the tier", async () => {
    const lane = await mission();
    await publishMcp(lane, [DOCS]);
    const operator = await joinAs(lane.missionId, "op-mcp", "operator");
    const entry = [{ name: DOCS.name, digest: DOCS.digest }];
    // An Operator may set skills (D-118) and may not set servers: new tool
    // surface is the room's biggest standing grant.
    expect((await setMcp(lane, entry, operator)).statusCode).toBe(403);
    const detailOperator = await detailOf(lane, operator);
    expect(detailOperator.capabilities).toContain("skills.set");
    expect(detailOperator.capabilities).not.toContain("mcp.set");
    const enabled = await setMcp(lane, entry);
    expect(enabled.statusCode).toBe(200);
    const detail = await detailOf(lane);
    expect(detail.workspace.mcpServers).toEqual([DOCS]);
    expect(detail.workstream.enabledMcpServers).toEqual(entry);
    const changes = await eventsOf(lane, "mcp.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({ from: [], to: entry });
  });

  it("refuses a stale digest and an unpublished server, in words", async () => {
    const lane = await mission();
    await publishMcp(lane, [DOCS]);
    const stale = await setMcp(lane, [{ name: DOCS.name, digest: "0".repeat(64) }]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toContain("changed since it was reviewed");
    const unknown = await setMcp(lane, [{ name: "elsewhere", digest: DOCS.digest }]);
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().error.message).toContain("elsewhere");
    expect((await detailOf(lane)).workstream.enabledMcpServers).toEqual([]);
  });

  it("refuses a manifest whose remote server is not https away from loopback", async () => {
    const lane = await mission();
    // The wire itself refuses the entry: a runner cannot publish an
    // uncredentialed-plaintext remote, so nothing unreviewable can ever be
    // enabled. The report is rejected wholesale (422 at the events route).
    const response = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(lane.credential),
      payload: {
        executionId: null,
        events: [
          {
            originSeq: (seq += 1),
            event: {
              kind: "workspace.declared",
              payload: {
                commands: [],
                mcpServers: [
                  {
                    name: "plain",
                    transport: "http",
                    command: null,
                    args: [],
                    env: [],
                    url: "http://mcp.example.com",
                    digest: sha256("x")
                  }
                ]
              }
            }
          }
        ]
      }
    });
    expect(response.statusCode).toBe(422);
    expect((await detailOf(lane)).workspace?.mcpServers ?? []).toEqual([]);
  });

  it("pins the enabled set into the turn, and a change speaks from the next turn", async () => {
    const lane = await mission();
    await publishMcp(lane, [DOCS]);
    const entry = [{ name: DOCS.name, digest: DOCS.digest }];
    expect((await setMcp(lane, entry)).statusCode).toBe(200);
    const first = await direct(lane, "use the docs server");
    expect(first.statusCode).toBe(200);
    const detail = await detailOf(lane);
    const execution = detail.executions[0];
    const command = await harness.db.query(
      "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [execution.executionId]
    );
    expect((command.rows[0].payload as { mcpServers?: unknown }).mcpServers).toEqual(entry);
    expect((await setMcp(lane, [])).statusCode).toBe(200);
    expect((await detailOf(lane)).workstream.enabledMcpServers).toEqual([]);
    const pinned = await harness.db.query(
      "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [execution.executionId]
    );
    expect((pinned.rows[0].payload as { mcpServers?: unknown }).mcpServers).toEqual(entry);
  });
});

