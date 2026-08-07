import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
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
  // A real provider stand-in, so a GitHub-backed mission can exist here too:
  // the branch-ownership rule below is about exactly that case.
  harness = await createHarness("novus_test_approaches", new FakeRepositoryProvider());
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

  it("forks beside an approach from the shared checkpoint, never the approach's own later work", async () => {
    const { lane, sha: shared } = await laneWithWork();
    const first = await fork(lane, "Try it in the middleware");
    expect(first.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, first.json().workstream.workstreamId as string);

    // The approach does its own work past the fork point.
    const executionId = await direct(approach, "Go the middleware way");
    const later = sha(`${approach.workstreamId}-later`);
    await report(approach.credential, executionId, [checkpoint(1, later, "src/middleware.ts")]);

    // Forking *beside the approach* starts from the checkpoint it shares with
    // the lane it forked beside — not from `later`, which exists only in it.
    const second = await fork(
      { ...lane, workstreamId: approach.workstreamId },
      "Try it as a background job"
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().workstream.originSha).toBe(shared);
    expect(second.json().workstream.originSha).not.toBe(later);
    expect(second.json().workstream.baseSha).toBe(shared);
    // Named as the next alternative, not a copy of the first.
    expect(second.json().workstream.name).toBe("Alternative 2");

    // And the summary states the same fork point the route used: the
    // approach's own head moved, its fork point did not.
    const detail = await detailOf(lane);
    const summarized = detail.approaches.find(
      (entry: { workstreamId: string }) => entry.workstreamId === approach.workstreamId
    );
    expect(summarized.checkpointSha).toBe(later);
    expect(summarized.forkPointSha).toBe(shared);
    const baseline = detail.approaches.find(
      (entry: { workstreamId: string }) => entry.workstreamId === lane.workstreamId
    );
    expect(baseline.forkPointSha).toBe(shared);
    expect(baseline.name).toBe("Current work");
    expect(summarized.name).toBe("Alternative");
  });

  it("refuses to fork from a revision the person was not shown", async () => {
    const { lane, sha: shared } = await laneWithWork();
    const stale = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/approaches`,
      headers: bearer(kartik),
      payload: {
        fromWorkstreamId: lane.workstreamId,
        intent: "Try it with a cache",
        expectedOriginSha: sha("some-other-revision")
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("origin_moved");
    expect(stale.json().error.message).toMatch(/Nothing was created/);
    const lanes = await harness.db.query(
      "select count(*)::int as n from workstreams where mission_id = $1",
      [lane.missionId]
    );
    expect(lanes.rows[0].n).toBe(1);

    // The pinned revision that matches is accepted.
    const pinned = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/approaches`,
      headers: bearer(kartik),
      payload: {
        fromWorkstreamId: lane.workstreamId,
        intent: "Try it with a cache",
        expectedOriginSha: shared
      }
    });
    expect(pinned.statusCode).toBe(201);
    expect(pinned.json().workstream.originSha).toBe(shared);
  });

  it("leaves a GitHub-backed approach's branch to the machine that holds the checkout", async () => {
    // A GitHub mission: the first lane's branch is the provider's to cut,
    // because its base is a commit the provider genuinely has.
    const base = await harness.app.inject({
      method: "GET",
      url: "/repositories/available/9001/base",
      headers: bearer(kartik)
    });
    expect(base.statusCode).toBe(200);
    const created = await harness.app.inject({
      method: "POST",
      url: "/missions",
      headers: bearer(kartik),
      payload: {
        goal: "Make the session guard hold on GitHub",
        successCriteria: "Sessions expire when they should",
        provider: "github",
        providerRepoId: "9001",
        baseRef: base.json().ref,
        baseSha: base.json().sha,
        creationKey: randomUUID()
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workstream.branchStatus).toBe("created");
    const lane = await enrol(
      created.json().mission.missionId as string,
      created.json().workstream.workstreamId as string
    );

    // A checkpoint the runner committed in its own checkout — a commit the
    // provider has never seen.
    const executionId = await direct(lane, "Harden the session guard");
    const localCommit = sha(`${lane.workstreamId}-local-only`);
    await report(lane.credential, executionId, [checkpoint(1, localCommit, "src/session.ts")]);

    // Forking must not ask the provider to cut a branch at that commit: the
    // lane stays pending for the machine that holds the checkout, with no
    // failure invented (D-080 — "the base revision no longer exists" was this
    // exact path).
    const forked = await fork(lane, "Try it in the middleware");
    expect(forked.statusCode).toBe(201);
    const approach = forked.json().workstream;
    expect(approach.originSha).toBe(localCommit);
    expect(approach.branchStatus).toBe("pending");
    expect(approach.branchError).toBeNull();
    const failures = await harness.db.query(
      "select count(*)::int as n from events where workstream_id = $1 and kind = 'workstream.branch_failed'",
      [approach.workstreamId]
    );
    expect(failures.rows[0].n).toBe(0);

    // Retry does not hand it to the provider either.
    const retried = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${approach.workstreamId}/branch/retry`,
      headers: bearer(kartik)
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().workstream.workstreamId).toBe(approach.workstreamId);
    expect(retried.json().workstream.branchStatus).toBe("pending");
    expect(retried.json().workstream.branchError).toBeNull();

    // The machine's report settles it, exactly as a local repository's does.
    const reported = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${approach.workstreamId}/branch/report`,
      headers: bearer(kartik),
      payload: { status: "created" }
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json().workstream.branchStatus).toBe("created");
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

describe("routing direction to a lane", () => {
  /** A mission with two lanes, both enrolled, ready to be directed. */
  async function forkedMission() {
    const { lane } = await laneWithWork();
    const created = await fork(lane, "Do it in the middleware instead");
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);
    return { lane, approach };
  }

  it("a direction naming a lane lands in that lane — its row, its events, its execution, its checkpoint", async () => {
    const { lane, approach } = await forkedMission();

    // Into the lane the mission started with.
    await direct(lane, "Keep going the guard way");
    // Into the alternative.
    const approachExecution = await direct(approach, "Go the middleware way");
    const at = sha(`${approach.workstreamId}-turn`);
    await report(approach.credential, approachExecution, [checkpoint(1, at, "src/middleware.ts")]);

    const rows = await harness.db.query(
      "select body, wst_id from directions where mission_id = $1 order by ordinal",
      [lane.missionId]
    );
    const byBody = new Map(rows.rows.map((row) => [row.body as string, row.wst_id as string]));
    expect(byBody.get("Keep going the guard way")).toBe(lane.workstreamId);
    expect(byBody.get("Go the middleware way")).toBe(approach.workstreamId);

    // The submitted events carry the lane the direction named.
    const events = await harness.db.query(
      "select workstream_id, payload from events where mission_id = $1 and kind = 'direction.submitted' order by seq",
      [lane.missionId]
    );
    const eventLane = new Map(
      events.rows.map((row) => [(row.payload as { body: string }).body, row.workstream_id as string])
    );
    expect(eventLane.get("Keep going the guard way")).toBe(lane.workstreamId);
    expect(eventLane.get("Go the middleware way")).toBe(approach.workstreamId);

    // Its execution and its checkpoint belong to the lane, not the mission's first.
    const executions = await harness.db.query(
      "select exe_id, wst_id from executions where mission_id = $1",
      [lane.missionId]
    );
    const laneOf = new Map(executions.rows.map((row) => [row.exe_id as string, row.wst_id as string]));
    expect(laneOf.get(approachExecution)).toBe(approach.workstreamId);
    const checkpoints = await harness.db.query(
      "select c.sha, e.wst_id from checkpoints c join executions e on e.exe_id = c.exe_id where c.mission_id = $1 and c.sha = $2",
      [lane.missionId, at]
    );
    expect(checkpoints.rows[0]?.wst_id).toBe(approach.workstreamId);
  });

  it("reading the mission for a lane returns that lane's own control, state, and workstream", async () => {
    const { lane, approach } = await forkedMission();
    // The alternative's lease is held by its creator; direct it so its state
    // diverges from the baseline's.
    await direct(approach, "Go the middleware way");

    const scoped = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}?workstream=${approach.workstreamId}`,
      headers: bearer(kartik)
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().workstream.workstreamId).toBe(approach.workstreamId);
    // The lane-scoped facts are the alternative's own.
    expect(["agent_starting", "agent_running"]).toContain(scoped.json().state);
    expect(scoped.json().control.holderLogin).toBe("kartik");

    const defaulted = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(defaulted.json().workstream.workstreamId).toBe(lane.workstreamId);

    // A lane that is not this mission's is no mission at all — never the
    // default lane's data under the wrong name.
    const other = await laneWithWork();
    const crossed = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}?workstream=${other.lane.workstreamId}`,
      headers: bearer(kartik)
    });
    expect(crossed.statusCode).toBe(404);
  });

  it("a role without direction.submit is refused on a named lane, and a foreign lane is 404", async () => {
    const { lane, approach } = await forkedMission();
    const viewer = await joinAs(lane.missionId, "maya-view-lane", "viewer");
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(viewer),
      payload: {
        body: "Try to steer the alternative",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: approach.workstreamId
      }
    });
    expect(refused.statusCode).toBe(403);

    const other = await laneWithWork();
    const crossed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: {
        body: "Land in the wrong mission's lane",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: other.lane.workstreamId
      }
    });
    expect(crossed.statusCode).toBe(404);
    const rows = await harness.db.query(
      "select count(*)::int as n from directions where mission_id = $1 and body like 'Land in%'",
      [lane.missionId]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("counts the mission's lanes for the rail", async () => {
    const { lane } = await forkedMission();
    const listed = await harness.app.inject({
      method: "GET",
      url: "/missions",
      headers: bearer(kartik)
    });
    const mission = listed
      .json()
      .missions.find((entry: { missionId: string }) => entry.missionId === lane.missionId);
    expect(mission.workstreamCount).toBe(2);
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
