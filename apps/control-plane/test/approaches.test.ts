import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Competing approaches, and the decision between them (D-074, D-075).
 *
 * What these tests are for, in order of how badly it would matter if they
 * stopped holding:
 *
 *  - **An approach is isolated.** Its own branch, its own lease, its own
 *    everything, forked from a recorded revision. Two lanes sharing a branch or
 *    a controller would make "competing approaches" a word rather than a thing.
 *  - **Nothing ranks.** The comparison is creation order and each lane's own
 *    evidence. A test asserts the order does not move when one lane's checks
 *    pass and the other's fail, because that is exactly where a helpful sort
 *    would appear.
 *  - **A decision is a judgment with a rationale**, capturing what was
 *    unverified *at that moment*, and it does not publish anything.
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
  harness = await createHarness("novus_test_approaches");
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
      goal: "Make the session guard hold",
      successCriteria: "Sessions expire when they should",
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

/** A direction from the controller, which starts the lane's execution. */
async function direct(lane: Lane, body: string): Promise<string> {
  const submitted = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(kartik),
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

/** The evidence an approach is compared on: a commit that touched files. */
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

function check(
  originSeq: number,
  args: { name: string; outcome: "passed" | "failed"; checkpointSha: string }
): ReportableRunnerEvent {
  return {
    originSeq,
    event: {
      kind: "verification.completed",
      payload: {
        name: args.name,
        category: "test",
        outcome: args.outcome,
        command: "pnpm test",
        exitCode: args.outcome === "passed" ? 0 : 1,
        ending: "exit",
        output: null,
        truncated: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1200,
        checkpointSha: args.checkpointSha
      }
    }
  };
}

/** A lane that has produced one checkpoint, so it can be forked and chosen. */
async function laneWithWork(path = "src/session.ts"): Promise<{ lane: Lane; sha: string }> {
  const lane = await mission();
  const executionId = await direct(lane, "Harden the session guard");
  const at = sha(`${lane.workstreamId}-first`);
  await report(lane.credential, executionId, [checkpoint(1, at, path)]);
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

const detailOf = async (lane: Lane, as: SignedIn = kartik) => {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}`,
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

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

describe("starting a competing approach", () => {
  it("gives it its own branch, its own baton, and the revision it forked at", async () => {
    const { lane, sha: origin } = await laneWithWork();
    const created = await fork(lane, "Try it without the migration");
    expect(created.statusCode).toBe(201);
    const approach = created.json().workstream;

    expect(approach.approach).toBe(true);
    expect(approach.intent).toBe("Try it without the migration");
    expect(approach.originSha).toBe(origin);
    expect(approach.forkedFromWorkstreamId).toBe(lane.workstreamId);
    // Its own branch, beside the one it forked rather than replacing it.
    const branches = await harness.db.query(
      "select mission_branch from workstreams where mission_id = $1 order by created_at",
      [lane.missionId]
    );
    expect(new Set(branches.rows.map((row) => row.mission_branch)).size).toBe(2);

    // Its own lease, and the lane it forked keeps its own untouched.
    const leases = await harness.db.query(
      `select wst_id, holder_user_id from control_leases
        where mission_id = $1 and state = 'held' order by created_at`,
      [lane.missionId]
    );
    expect(leases.rowCount).toBe(2);
    expect(new Set(leases.rows.map((row) => row.wst_id)).size).toBe(2);
  });

  it("refuses an approach nobody could tell apart from its sibling", async () => {
    const { lane } = await laneWithWork();
    const empty = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/approaches`,
      headers: bearer(kartik),
      payload: { fromWorkstreamId: lane.workstreamId, intent: "   " }
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.message).toMatch(/differ/i);
    const lanes = await harness.db.query("select count(*)::int as n from workstreams where mission_id = $1", [
      lane.missionId
    ]);
    expect(lanes.rows[0].n).toBe(1);
  });

  it("refuses to fork a lane that has produced nothing to fork from", async () => {
    const lane = await mission();
    const refused = await fork(lane, "Try the other library");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("nothing_to_fork");
  });

  it("is a role's act, not the baton's: a contributor is refused", async () => {
    const { lane } = await laneWithWork();
    const maya = await joinAs(lane.missionId, "maya-contrib", "contributor");
    const refused = await fork(lane, "Try it with a queue", maya);
    expect(refused.statusCode).toBe(403);
  });
});

describe("comparing them", () => {
  it("reports each lane's own evidence, in creation order, with no ranking anywhere", async () => {
    const { lane, sha: origin } = await laneWithWork("src/session.ts");
    const created = await fork(lane, "Do it in the middleware instead");
    const approachId = created.json().workstream.workstreamId as string;
    await harness.app.inject({
      method: "POST",
      url: `/workstreams/${approachId}/branch/report`,
      headers: bearer(kartik),
      payload: { status: "created" }
    });
    const enrolled = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${approachId}/runner`,
      headers: bearer(kartik),
      payload: { workstreamId: approachId, label: "kartik-macbook" }
    });
    const approachLane: Lane = {
      missionId: lane.missionId,
      workstreamId: approachId,
      credential: enrolled.json().credential as string
    };

    // The baseline's check fails; the approach's passes. If anything anywhere
    // ranked, this is the shape that would reveal it.
    const baseExecution = await harness.db.query(
      "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
      [lane.workstreamId]
    );
    await report(lane.credential, baseExecution.rows[0].exe_id as string, [
      check(2, { name: "unit", outcome: "failed", checkpointSha: origin })
    ]);

    const approachExecution = await direct(approachLane, "Try the middleware");
    const approachSha = sha(`${approachId}-work`);
    await report(approachLane.credential, approachExecution, [
      checkpoint(1, approachSha, "src/session.ts"),
      check(2, { name: "unit", outcome: "passed", checkpointSha: approachSha })
    ]);

    const detail = await detailOf(lane);
    expect(detail.approaches).toHaveLength(2);
    const [first, second] = detail.approaches;
    // Creation order, always: the lane that started the mission is first even
    // though its checks failed and the other's passed.
    expect(first.workstreamId).toBe(lane.workstreamId);
    expect(second.workstreamId).toBe(approachId);
    expect(first.approach).toBe(false);
    expect(second.intent).toBe("Do it in the middleware instead");

    // Each lane's own evidence, not the mission's pooled together.
    expect(first.checksFailed).toBe(1);
    expect(first.checksPassed).toBe(0);
    expect(second.checksPassed).toBe(1);
    expect(second.checksFailed).toBe(0);
    expect(first.filesChanged).toBe(1);
    expect(second.filesChanged).toBe(1);

    // Nothing in the payload ranks, scores, or recommends.
    const serialized = JSON.stringify(detail.approaches);
    expect(serialized).not.toMatch(/score|rank|winner|recommend|better/i);

    // A file both lanes changed is named as contested and resolved by nobody.
    expect(detail.contested).toHaveLength(1);
    expect(detail.contested[0].path).toBe("src/session.ts");
    expect(detail.contested[0].workstreamIds).toHaveLength(2);
  });

  it("keeps one lane's direction out of the other's count", async () => {
    const { lane } = await laneWithWork();
    const created = await fork(lane, "Try it as a background job");
    const approachId = created.json().workstream.workstreamId as string;
    const detail = await detailOf(lane);
    const baseline = detail.approaches.find(
      (approach: { workstreamId: string }) => approach.workstreamId === lane.workstreamId
    );
    const approach = detail.approaches.find(
      (entry: { workstreamId: string }) => entry.workstreamId === approachId
    );
    expect(baseline.directions).toBe(1);
    expect(approach.directions).toBe(0);
    expect(approach.checkpointSha).toBeNull();
    // An approach with nothing in it says so rather than borrowing its
    // sibling's evidence.
    expect(approach.filesChanged).toBe(0);
    expect(approach.checksRun).toBe(0);
  });
});

describe("the decision between them", () => {
  it("records the rationale, the revision, and what was unverified at that moment", async () => {
    const { lane, sha: at } = await laneWithWork();
    const executionId = await harness.db.query(
      "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
      [lane.workstreamId]
    );
    await report(lane.credential, executionId.rows[0].exe_id as string, [
      check(2, { name: "unit", outcome: "failed", checkpointSha: at }),
      check(3, { name: "lint", outcome: "passed", checkpointSha: at })
    ]);

    const decided = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: lane.workstreamId,
        rationale: "The failing unit test is a fixture problem, not the change.",
        acceptedRisks: "We ship without the unit suite green."
      }
    });
    expect(decided.statusCode).toBe(201);

    const detail = await detailOf(lane);
    const decision = detail.decisions.find((entry: { supersededAt: null }) => entry.supersededAt === null);
    expect(decision.rationale).toMatch(/fixture problem/);
    expect(decision.acceptedRisks).toMatch(/without the unit suite/);
    expect(decision.checkpointSha).toBe(at);
    expect(decision.decidedByLogin).toBe("kartik");
    // Captured then, not recomputed later: the failing check is in the record.
    expect(decision.unresolvedSummary.join(" ")).toMatch(/unit/);
    expect(decision.unresolvedSummary.join(" ")).not.toMatch(/lint/);

    // The mission says what happened, and says nothing has been published.
    expect(detail.state).toBe("decision_recorded");
    expect(detail.preparedPullRequest).not.toBeNull();
    expect(detail.preparedPullRequest.body).toMatch(/fixture problem/);
    expect(detail.preparedPullRequest.body).toMatch(/Not verified/);
    expect(detail.preparedPullRequest.body).toMatch(/Prepared, not published/);
    // A folder on a machine has no host that could receive this.
    expect(detail.preparedPullRequest.publishable).toBe(false);
  });

  it("refuses a decision with no rationale", async () => {
    const { lane } = await laneWithWork();
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/decision`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, rationale: "   " }
    });
    expect(refused.statusCode).toBe(422);
    const decisions = await harness.db.query("select count(*)::int as n from decisions where mission_id = $1", [
      lane.missionId
    ]);
    expect(decisions.rows[0].n).toBe(0);
  });

  it("supersedes an earlier decision and keeps it", async () => {
    const { lane } = await laneWithWork();
    const record = (rationale: string) =>
      harness.app.inject({
        method: "POST",
        url: `/missions/${lane.missionId}/decision`,
        headers: bearer(kartik),
        payload: { workstreamId: lane.workstreamId, rationale }
      });
    await record("First read: this is the one.");
    await record("Second read: still this one, for a better reason.");

    const detail = await detailOf(lane);
    expect(detail.decisions).toHaveLength(2);
    expect(detail.decisions.filter((entry: { supersededAt: string | null }) => entry.supersededAt === null))
      .toHaveLength(1);
    const current = detail.decisions.find((entry: { supersededAt: null }) => entry.supersededAt === null);
    expect(current.rationale).toMatch(/better reason/);
    // The reversal is part of the record rather than an overwrite.
    expect(detail.decisions[0].rationale).toMatch(/First read/);
  });

  it("withdraws the decision when a revision is asked for instead", async () => {
    const { lane } = await laneWithWork();
    await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/decision`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, rationale: "Good enough to ship." }
    });
    const asked = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/revision`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, reason: "The error path is untested." }
    });
    expect(asked.statusCode).toBe(200);

    const detail = await detailOf(lane);
    expect(detail.decisions.every((entry: { supersededAt: string | null }) => entry.supersededAt !== null)).toBe(
      true
    );
    // A mission cannot be both decided and awaiting changes.
    expect(detail.state).not.toBe("decision_recorded");
    expect(detail.preparedPullRequest).toBeNull();
    const events = await harness.db.query(
      "select payload from events where mission_id = $1 and kind = 'revision.requested'",
      [lane.missionId]
    );
    expect(events.rows[0].payload.reason).toMatch(/error path/);
  });

  it("is refused for a role that cannot resolve the mission", async () => {
    const { lane } = await laneWithWork();
    const maya = await joinAs(lane.missionId, "maya-viewer", "viewer");
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/decision`,
      headers: bearer(maya),
      payload: { workstreamId: lane.workstreamId, rationale: "I like this one." }
    });
    expect(refused.statusCode).toBe(403);
  });
});
