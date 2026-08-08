import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Multiplayer projections across competing approaches (D-074, D-080).
 *
 * Two rules, both already product truth and neither previously implemented:
 *
 *  - **The mission's list state reads every lane.** PRODUCT.md's state model
 *    says a mission with several workstreams projects with fixed precedence —
 *    attention-demanding states, then running, then waiting. Before this, the
 *    list read the latest execution mission-wide, so a background Alternative
 *    blocked on an approval was invisible behind whichever lane ran last, and
 *    the rail's needs-attention lens never surfaced a closed mission.
 *  - **Reading the mission is the heartbeat for every baton the reader holds
 *    in it.** ARCHITECTURE.md defines the lease heartbeat as the holder's
 *    client being alive. Before this, only the *selected lane's* lease was
 *    touched, so a controller watching a sibling lane for half an hour lost
 *    their background baton to the sweep while present.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_attention", new FakeRepositoryProvider());
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** A local mission with this machine enrolled as its runner. */
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
      goal: "Keep the background lane visible",
      successCriteria: "No lane waits unseen",
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

/** A direction on a named lane, which starts that lane's execution. */
async function direct(lane: Lane, body: string, as: SignedIn = kartik): Promise<string> {
  const submitted = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(as),
    payload: { body, model: "claude-fable-5", effort: "high", workstreamId: lane.workstreamId }
  });
  expect(submitted.statusCode).toBe(200);
  const row = await harness.db.query(
    "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
    [lane.workstreamId]
  );
  return row.rows[0].exe_id as string;
}

async function report(credential: string, executionId: string, events: ReportableRunnerEvent[]) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
  expect(response.statusCode).toBe(200);
}

const live = (originSeq: number): ReportableRunnerEvent[] => [
  { originSeq, event: { kind: "execution.starting", payload: {} } },
  {
    originSeq: originSeq + 1,
    event: {
      kind: "execution.running",
      payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
    }
  }
];

const completed = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "execution.completed", payload: {} }
});

function checkpoint(originSeq: number, at: string, path: string): ReportableRunnerEvent {
  return {
    originSeq,
    event: {
      kind: "workspace.checkpoint",
      payload: {
        outcome: "committed",
        sha: at,
        parentSha: null,
        branch: "novus/mission",
        withheldSecrets: 0,
        uncommitted: false,
        error: null,
        files: [
          {
            path,
            previousPath: null,
            changeState: "modified",
            additions: 7,
            deletions: 2,
            binary: false,
            diff: null,
            truncated: false
          }
        ]
      }
    }
  };
}

const approvalRequested = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: {
    kind: "approval.requested",
    payload: {
      requestId: `harness-request-${originSeq}`,
      toolUseId: `toolu_${originSeq}`,
      toolName: "Write",
      displayName: "Write",
      summary: "the mission worktree/PROBE.md"
    }
  }
});

/** A lane whose one turn has committed a checkpoint and finished. */
async function laneWithFinishedTurn(): Promise<{ lane: Lane; sha: string }> {
  const lane = await mission();
  const executionId = await direct(lane, "Harden the session guard");
  const at = sha(`${lane.workstreamId}-first`);
  await report(lane.credential, executionId, [
    ...live(1),
    checkpoint(3, at, "src/session.ts"),
    completed(4)
  ]);
  return { lane, sha: at };
}

async function fork(lane: Lane, intent: string, as: SignedIn = kartik) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/approaches`,
    headers: bearer(as),
    payload: { fromWorkstreamId: lane.workstreamId, intent }
  });
}

/** Enrols a freshly forked lane so it can be directed and can report. */
async function enrol(missionId: string, workstreamId: string): Promise<Lane> {
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
  return { missionId, workstreamId, credential: enrolled.json().credential as string };
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

/** The mission's row in the list this person's rail reads. */
async function listedState(missionId: string, as: SignedIn = kartik): Promise<string> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/missions",
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  const row = (response.json().missions as { missionId: string; primaryState: string }[]).find(
    (candidate) => candidate.missionId === missionId
  );
  expect(row).toBeDefined();
  return row!.primaryState;
}

describe("the mission's list state reads every lane", () => {
  it("a background approach waiting on an approval outranks a sibling's later finished turn", async () => {
    const { lane } = await laneWithFinishedTurn();

    const created = await fork(lane, "Do it in the middleware instead");
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);
    const blocked = await direct(approach, "Go the middleware way");
    await report(approach.credential, blocked, [...live(1), approvalRequested(3)]);

    // The first lane then takes — and finishes — a *later* turn, so the
    // mission-wide latest execution is a completed one. That is exactly the
    // shape the old projection read, and where it said "work finished" while
    // the Alternative sat blocked on a person.
    const later = await direct(lane, "Tidy the guard's naming");
    await report(lane.credential, later, [
      ...live(1),
      checkpoint(3, sha(`${lane.workstreamId}-second`), "src/session.ts"),
      completed(4)
    ]);

    expect(await listedState(lane.missionId)).toBe("needs_approval");
  });

  it("a waiting lane outranks nothing: a running sibling still reads as running", async () => {
    const { lane } = await laneWithFinishedTurn();
    const created = await fork(lane, "Try it as a background job");
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);

    // First lane idle after its finished turn (waiting class); the approach
    // mid-turn (running class). Running outranks waiting.
    const turn = await direct(approach, "Go the background-job way");
    await report(approach.credential, turn, live(1));

    expect(await listedState(lane.missionId)).toBe("agent_running");
  });

  it("attention outranks running, whichever lane is busy", async () => {
    const { lane } = await laneWithFinishedTurn();
    const created = await fork(lane, "Try it without the migration");
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);

    // The approach blocks on an approval, then the first lane starts a turn
    // that is still running. A busy lane must not drown a waiting person.
    const blocked = await direct(approach, "Go without the migration");
    await report(approach.credential, blocked, [...live(1), approvalRequested(3)]);
    const busy = await direct(lane, "Keep tightening the guard");
    await report(lane.credential, busy, live(1));

    expect(await listedState(lane.missionId)).toBe("needs_approval");
  });

  it("a mission that never forked projects exactly as before", async () => {
    const { lane } = await laneWithFinishedTurn();
    // One lane, one finished turn that changed files, nothing verified.
    expect(await listedState(lane.missionId)).toBe("work_completed_unverified");
  });
});

describe("reading the mission is the heartbeat for every held baton", () => {
  /** The lease's recorded heartbeat for one lane, as epoch millis. */
  async function heartbeatOf(workstreamId: string): Promise<number> {
    const row = await harness.db.query(
      `select last_heartbeat_at from control_leases
        where wst_id = $1 and state in ('held', 'releasing')`,
      [workstreamId]
    );
    expect(row.rowCount).toBe(1);
    return (row.rows[0].last_heartbeat_at as Date).getTime();
  }

  const backdate = (workstreamId: string) =>
    harness.db.query(
      `update control_leases set last_heartbeat_at = now() - interval '10 minutes'
        where wst_id = $1 and state in ('held', 'releasing')`,
      [workstreamId]
    );

  it("a holder reading the default lane keeps their background approach's baton alive", async () => {
    const { lane } = await laneWithFinishedTurn();
    const noor = await joinAs(lane.missionId, "noor-operator", "operator");
    const created = await fork(lane, "Do it in the middleware instead", noor);
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;

    await backdate(approachId);
    const stale = await heartbeatOf(approachId);

    // Noor reads the mission with no lane named — the default lane, whose
    // baton is Kartik's. Their presence is presence for the approach baton
    // they hold, whichever lane their room is showing.
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(noor)
    });
    expect(read.statusCode).toBe(200);

    expect(await heartbeatOf(approachId)).toBeGreaterThan(stale);
  });

  it("a read by someone who does not hold the baton renews nothing", async () => {
    const { lane } = await laneWithFinishedTurn();
    const noor = await joinAs(lane.missionId, "noor-operator", "operator");
    const created = await fork(lane, "Try it as a background job", noor);
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;

    await backdate(approachId);
    const stale = await heartbeatOf(approachId);

    // Kartik holds the first lane's baton, not the approach's. Reading the
    // mission — even the approach's own lane — is his heartbeat, never Noor's.
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}?workstream=${approachId}`,
      headers: bearer(kartik)
    });
    expect(read.statusCode).toBe(200);

    expect(await heartbeatOf(approachId)).toBe(stale);
  });
});
