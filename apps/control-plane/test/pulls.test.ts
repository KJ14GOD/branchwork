import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { sweepPullRequestsOnce } from "../src/pull-requests.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Publishing a decision as a tracked pull request (D-099), against a real
 * PostgreSQL and the fake host. What these tests are for, in order of how
 * badly it would matter if they stopped holding:
 *
 *  - **Novus never merges.** There is no merge route, and the suite asks for
 *    one and requires a 404 — the D-063 absent-verb pattern, because "we
 *    chose not to expose it" and "it does not exist" are different
 *    guarantees.
 *  - **The remote-head guarantee.** A pull request is refused until the host
 *    serves exactly the decided checkpoint. A request naming a revision the
 *    host does not have would be the product's central lie.
 *  - **Publication is a decision's act**, gated on pr.manage and refused in
 *    words without a decision, and what is sent is snapshotted verbatim.
 *  - **The host's side is ingested, never invented**: comments, conflicts,
 *    merges and closes arrive by poll as external-actor events.
 */

let harness: Harness;
let kartik: SignedIn;
let provider: FakeRepositoryProvider;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  missionBranch: string;
  credential: string;
  checkpointSha: string;
}

beforeAll(async () => {
  provider = new FakeRepositoryProvider();
  harness = await createHarness("novus_test_pulls", provider);
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** A GitHub-backed mission with a runner, one committed checkpoint, and a
 *  completed turn — everything a decision needs to exist. */
async function githubMission(): Promise<Lane> {
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: `Ship the change ${randomUUID().slice(0, 8)}`,
      successCriteria: "The change is on a reviewable pull request",
      provider: "github",
      providerRepoId: "9001",
      baseRef: "main",
      baseSha: sha("demo-app@main"),
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const missionId = created.json().mission.missionId as string;
  const workstreamId = created.json().workstream.workstreamId as string;
  const lane = await harness.db.query("select mission_branch from workstreams where wst_id = $1", [
    workstreamId
  ]);
  const missionBranch = lane.rows[0].mission_branch as string;
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId, label: "kartik-macbook" }
  });
  expect(enrolled.statusCode).toBe(200);
  const credential = enrolled.json().credential as string;

  const submitted = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/direction`,
    headers: bearer(kartik),
    payload: { body: "Make the change", model: "claude-fable-5", effort: "high", workstreamId }
  });
  expect(submitted.statusCode).toBe(200);
  const row = await harness.db.query(
    "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
    [workstreamId]
  );
  const executionId = row.rows[0].exe_id as string;
  const checkpointSha = sha(`checkpoint:${workstreamId}`);
  const events: ReportableRunnerEvent[] = [
    { originSeq: 1, event: { kind: "execution.starting", payload: {} } },
    {
      originSeq: 2,
      event: {
        kind: "workspace.checkpoint",
        payload: {
          outcome: "committed",
          sha: checkpointSha,
          parentSha: null,
          branch: missionBranch,
          withheldSecrets: 0,
          uncommitted: false,
          error: null,
          files: [
            {
              path: "server/api.ts",
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
    },
    {
      originSeq: 3,
      event: { kind: "execution.completed", payload: {} }
    }
  ];
  const reported = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
  expect(reported.statusCode).toBe(200);
  return { missionId, workstreamId, missionBranch, credential, checkpointSha };
}

async function decide(lane: Lane): Promise<void> {
  const decided = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/decision`,
    headers: bearer(kartik),
    payload: { workstreamId: lane.workstreamId, rationale: "It holds and the checks agree." }
  });
  expect(decided.statusCode).toBe(201);
}

/** The runner's own report that the branch landed on the host. */
async function reportPushed(lane: Lane, pushedSha: string, branch = lane.missionBranch): Promise<void> {
  const reported = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(lane.credential),
    payload: {
      // A workspace-scoped report: a push is not part of any turn.
      executionId: null,
      events: [
        {
          originSeq: Math.floor(Math.random() * 1_000_000) + 10,
          event: { kind: "workspace.pushed", payload: { branch, sha: pushedSha } }
        }
      ]
    }
  });
  expect(reported.statusCode).toBe(200);
}

async function createPull(lane: Lane) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/pull-request`,
    headers: bearer(kartik),
    payload: { workstreamId: lane.workstreamId }
  });
}

async function detailOf(lane: Lane) {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}?workstream=${lane.workstreamId}`,
    headers: bearer(kartik)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("publishing a decision (D-099)", () => {
  it("refuses to open anything without a decision, and refuses a non-participant with a 404", async () => {
    const lane = await githubMission();
    const early = await createPull(lane);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("no_decision");

    const maya = await harness.signIn("maya");
    const stranger = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/pull-request`,
      headers: bearer(maya),
      payload: {}
    });
    expect(stranger.statusCode).toBe(404);
  });

  it("refuses a participant whose role does not carry pr.manage, in words", async () => {
    const lane = await githubMission();
    await decide(lane);
    const invited = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "contributor" }
    });
    expect(invited.statusCode).toBe(201);
    const token = invited.json().token as string;
    const maya = await harness.signIn("maya-contrib");
    const redeemed = await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token }
    });
    expect(redeemed.statusCode).toBe(200);
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/pull-request`,
      headers: bearer(maya),
      payload: { workstreamId: lane.workstreamId }
    });
    expect(refused.statusCode).toBe(403);
  });

  it("holds the remote-head guarantee: never pushed, wrongly pushed, then exactly the decided revision", async () => {
    const lane = await githubMission();
    await decide(lane);

    // Never pushed: refused with the next action in the words.
    const unpushed = await createPull(lane);
    expect(unpushed.statusCode).toBe(409);
    expect(unpushed.json().error.code).toBe("branch_not_pushed");
    expect(unpushed.json().error.message).toContain("never been pushed");

    // A report about some other branch moves nothing.
    await reportPushed(lane, sha("elsewhere"), "not-this-branch");
    const stillUnpushed = await harness.db.query(
      "select remote_head_sha from workstreams where wst_id = $1",
      [lane.workstreamId]
    );
    expect(stillUnpushed.rows[0].remote_head_sha).toBeNull();

    // Pushed, but not the decided revision: still refused.
    await reportPushed(lane, sha("some-earlier-commit"));
    const stale = await createPull(lane);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toContain("does not serve the decided revision");

    // The decided checkpoint lands, and the draft opens.
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const pull = created.json().pullRequest;
    expect(pull.state).toBe("draft");
    expect(pull.number).toBeGreaterThan(0);
    expect(pull.url).toContain("github.com/novus/demo-app/pull/");
    expect(pull.headSha).toBe(lane.checkpointSha);
    // The snapshot is exactly what the prepared projection said (D-075).
    expect(pull.body).toContain("## Why this approach");
    expect(pull.body).toContain("It holds and the checks agree.");
    expect(pull.title.length).toBeGreaterThan(0);

    // The mission's state is the tracked request now.
    const detail = await detailOf(lane);
    expect(detail.state).toBe("pull_request_open");
    expect(detail.pullRequest.pullRequestId).toBe(pull.pullRequestId);

    // And a second open request for the lane is refused by name.
    const again = await createPull(lane);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_open");
  });

  it("enqueues the push toward the runner and shows it as pending until the runner settles it", async () => {
    const lane = await githubMission();
    await decide(lane);
    const pushed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/pull-request/push`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId }
    });
    expect(pushed.statusCode).toBe(202);
    const command = await harness.db.query(
      `select payload, state from runner_commands where wst_id = $1 and kind = 'push_branch'`,
      [lane.workstreamId]
    );
    expect(command.rowCount).toBe(1);
    expect(command.rows[0].payload.branch).toBe(lane.missionBranch);
    expect(command.rows[0].payload.sha).toBe(lane.checkpointSha);
    const detail = await detailOf(lane);
    expect(detail.branchPush.state).toBe("pending");

    // Asking again while one is in flight reuses it rather than stacking.
    const again = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/pull-request/push`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId }
    });
    expect(again.statusCode).toBe(202);
    const still = await harness.db.query(
      `select count(*)::int as n from runner_commands where wst_id = $1 and kind = 'push_branch'`,
      [lane.workstreamId]
    );
    expect(still.rows[0].n).toBe(1);
  });

  it("stewards the request: reviewers on a person's ask, ready only from a draft", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const pullId = created.json().pullRequest.pullRequestId as string;

    const empty = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/request-review`,
      headers: bearer(kartik),
      payload: { reviewers: [] }
    });
    expect(empty.statusCode).toBe(422);

    const asked = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/request-review`,
      headers: bearer(kartik),
      payload: { reviewers: ["maya"] }
    });
    expect(asked.statusCode).toBe(200);
    const detailAfterAsk = await detailOf(lane);
    expect(detailAfterAsk.pullRequest.requestedReviewers).toContain("maya");

    const ready = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/ready`,
      headers: bearer(kartik)
    });
    expect(ready.statusCode).toBe(200);
    const detailAfterReady = await detailOf(lane);
    expect(detailAfterReady.pullRequest.state).toBe("ready");
    expect(detailAfterReady.state).toBe("pull_request_open");

    const notADraft = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/ready`,
      headers: bearer(kartik)
    });
    expect(notADraft.statusCode).toBe(409);
    expect(notADraft.json().error.code).toBe("not_a_draft");
  });

  it("ingests the host's story: comments, a conflict, and a human's merge, as external events", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const number = created.json().pullRequest.number as number;

    // Somebody comments on GitHub; the poll reflects it read-only.
    provider.fakeComment("9001", number, { author: "maya", body: "Is this bounded?", path: "server/api.ts" });
    await sweepPullRequestsOnce(harness.db, provider);
    let detail = await detailOf(lane);
    expect(detail.pullRequest.reviewThreads).toHaveLength(1);
    expect(detail.pullRequest.reviewThreads[0].author).toBe("maya");
    expect(detail.pullRequest.reviewThreads[0].state).toBe("open");

    // Resolution happens on the host and is reflected, never performed here.
    provider.fakeResolveComments("9001", number);
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    expect(detail.pullRequest.reviewThreads[0].state).toBe("resolved");

    // The base moved and the branch no longer merges: said as a fact.
    provider.fakeConflict("9001", number);
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    expect(detail.pullRequest.mergeable).toBe("conflict");

    // A human merges on GitHub. Novus observed it; nothing here performed it.
    provider.fakeMerge("9001", number, "maya");
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("merged");
    expect(detail.pullRequest.mergedBy).toBe("maya");
    // The mission returns to the decision, whose sentence names publication.
    expect(detail.state).toBe("decision_recorded");

    const kinds = await harness.db.query(
      `select kind, actor_kind from events where mission_id = $1 and kind like 'pr.%' order by seq`,
      [lane.missionId]
    );
    const byKind = new Map(kinds.rows.map((row) => [row.kind as string, row.actor_kind as string]));
    expect(byKind.get("pr.opened")).toBe("user");
    expect(byKind.get("pr.comments")).toBe("external");
    expect(byKind.get("pr.conflict")).toBe("external");
    expect(byKind.get("pr.merged")).toBe("external");
  });

  it("offers no way to merge a pull request at all", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const pullId = created.json().pullRequest.pullRequestId as string;

    // The D-063 pattern: the absence is asserted by asking. Every spelling a
    // merge verb could reasonably wear answers "no such thing".
    for (const attempt of [
      { method: "POST" as const, url: `/pull-requests/${pullId}/merge` },
      { method: "PUT" as const, url: `/pull-requests/${pullId}/merge` },
      { method: "POST" as const, url: `/missions/${lane.missionId}/merge` },
      { method: "POST" as const, url: `/missions/${lane.missionId}/pull-request/merge` }
    ]) {
      const response = await harness.app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: bearer(kartik),
        payload: {}
      });
      expect(response.statusCode, attempt.url).toBe(404);
    }
    // And the request is exactly as it was: still a draft, merged by nobody.
    const detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("draft");
    expect(detail.pullRequest.mergedBy).toBeNull();
  });
});
