import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";

// Set before the harness builds its config: the webhook endpoint exists only
// with a secret to verify against (D-101).
process.env.NOVUS_GITHUB_WEBHOOK_SECRET = "novus-test-webhook-secret";
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

  // The absence-of-merge test that stood here under D-099 was rewritten
  // deliberately under D-100, which reversed the absence into a gated verb:
  // what the tests now pin is that the merge is never silent and never the
  // host's to skip — the two-tier gate, the named blockers, the recorded
  // acceptance — and that no *runner* merge exists, which is still true and
  // still pinned in contracts.test.ts.

  it("hears the host's own knock: a signed webhook syncs exactly the named request (D-101)", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const number = created.json().pullRequest.number as number;

    // The host's story changes — and instead of waiting for the poll, GitHub
    // knocks. The signature is over the raw bytes with the shared secret.
    provider.fakeMerge("9001", number, "maya");
    const payload = JSON.stringify({
      action: "closed",
      repository: { id: 9001 },
      pull_request: { number, merged: true }
    });
    const signature = `sha256=${createHmac("sha256", "novus-test-webhook-secret").update(payload).digest("hex")}`;

    // A wrong signature is refused and syncs nothing.
    const forged = await harness.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      payload
    });
    expect(forged.statusCode).toBe(401);
    let detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("draft");

    // The genuine knock lands, and the row and events move without any sweep.
    const knocked = await harness.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": signature },
      payload
    });
    expect(knocked.statusCode).toBe(202);
    detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("merged");
    expect(detail.pullRequest.mergedBy).toBe("maya");
    const event = await harness.db.query(
      `select actor_kind from events where mission_id = $1 and kind = 'pr.merged'`,
      [lane.missionId]
    );
    expect(event.rows[0].actor_kind).toBe("external");

    // A request Novus does not track is not Novus's news.
    const strangerPayload = JSON.stringify({ action: "opened", repository: { id: 9001 }, pull_request: { number: 9999 } });
    const stranger = await harness.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "novus-test-webhook-secret").update(strangerPayload).digest("hex")}`
      },
      payload: strangerPayload
    });
    expect(stranger.statusCode).toBe(204);
  });

  it("merges only past the two-tier gate: host refusals outright, named blockers acknowledged (D-100)", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    expect(created.statusCode).toBe(201);
    const pullId = created.json().pullRequest.pullRequestId as string;
    const number = created.json().pullRequest.number as number;

    // A draft cannot merge, and the words say what to do instead.
    const draft = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash" }
    });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error.code).toBe("still_a_draft");

    await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/ready`,
      headers: bearer(kartik)
    });

    // A failing *required* check is the host's tier: refused, not acceptable.
    provider.fakeCheck("9001", number, {
      name: "ci",
      status: "failed",
      required: true,
      kind: "check",
      url: null
    });
    const protectedRefusal = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash", acknowledgeBlockers: true }
    });
    expect(protectedRefusal.statusCode).toBe(409);
    expect(protectedRefusal.json().error.code).toBe("host_refuses");

    // A failing non-required check and an open comment are the second tier:
    // named, and refused until deliberately acknowledged.
    provider.fakeCheck("9001", number, {
      name: "ci",
      status: "passed",
      required: true,
      kind: "check",
      url: null
    });
    provider.fakeCheck("9001", number, {
      name: "lint",
      status: "failed",
      required: false,
      kind: "check",
      url: null
    });
    provider.fakeComment("9001", number, { author: "maya", body: "One question." });
    await sweepPullRequestsOnce(harness.db, provider);

    const unacknowledged = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash" }
    });
    expect(unacknowledged.statusCode).toBe(409);
    expect(unacknowledged.json().error.code).toBe("blockers_outstanding");
    expect(unacknowledged.json().error.message).toContain("lint failing");
    expect(unacknowledged.json().error.message).toContain("1 review comment unresolved");

    // Acknowledged, the merge proceeds — and the event records exactly what
    // was accepted, so nothing about it is silent.
    const merged = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash", acknowledgeBlockers: true }
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().sha).toMatch(/^[0-9a-f]{40}$/);

    const detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("merged");
    const event = await harness.db.query(
      `select payload, actor_kind from events where mission_id = $1 and kind = 'pr.merge_performed'`,
      [lane.missionId]
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0].actor_kind).toBe("user");
    expect(event.rows[0].payload.method).toBe("squash");
    expect(event.rows[0].payload.acceptedBlockers.join(" ")).toContain("lint failing");

    // Merging twice is refused; the record stays what it was.
    const again = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash", acknowledgeBlockers: true }
    });
    expect(again.statusCode).toBe(409);
  });

  it("publishes again after a merge: a fulfilled decision is history, the next checkpoint decides anew, and PR #2 opens on the same branch (D-207)", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const first = await createPull(lane);
    expect(first.statusCode).toBe(201);
    const firstId = first.json().pullRequest.pullRequestId as string;
    const firstNumber = first.json().pullRequest.number as number;
    await harness.app.inject({ method: "POST", url: `/pull-requests/${firstId}/ready`, headers: bearer(kartik) });
    const merged = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${firstId}/merge`,
      headers: bearer(kartik),
      payload: { method: "squash" }
    });
    expect(merged.statusCode).toBe(200);

    // Merged with nothing after it: the decision still stands and the room
    // keeps saying how publication ended.
    let detail = await detailOf(lane);
    expect(detail.state).toBe("decision_recorded");
    expect(detail.pullRequest.state).toBe("merged");
    expect(detail.pullRequests.map((pull: { number: number }) => pull.number)).toEqual([firstNumber]);

    // The work goes on in the same mission: a second turn, a second checkpoint.
    const submitted = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: { body: "Now the favicon", model: "claude-fable-5", effort: "high", workstreamId: lane.workstreamId }
    });
    expect(submitted.statusCode).toBe(200);
    const row = await harness.db.query(
      "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
      [lane.workstreamId]
    );
    const secondSha = sha(`checkpoint-2:${lane.workstreamId}`);
    const reported = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(lane.credential),
      payload: {
        executionId: row.rows[0].exe_id,
        events: [
          { originSeq: 11, event: { kind: "execution.starting", payload: {} } },
          {
            originSeq: 12,
            event: {
              kind: "workspace.checkpoint",
              payload: {
                outcome: "committed",
                sha: secondSha,
                parentSha: lane.checkpointSha,
                branch: lane.missionBranch,
                withheldSecrets: 0,
                uncommitted: false,
                error: null,
                files: [
                  {
                    path: "app/favicon.ico",
                    previousPath: null,
                    changeState: "added",
                    additions: 1,
                    deletions: 0,
                    binary: true,
                    diff: null,
                    truncated: false
                  }
                ]
              }
            }
          },
          { originSeq: 13, event: { kind: "execution.completed", payload: {} } }
        ]
      }
    });
    expect(reported.statusCode).toBe(200);

    // The fulfilled decision is outrun: the mission reads as its work again,
    // the merged request is listed but is no longer "the" request.
    detail = await detailOf(lane);
    expect(detail.state).not.toBe("decision_recorded");
    expect(detail.state).not.toBe("pull_request_open");
    expect(detail.pullRequest).toBeNull();
    expect(detail.pullRequests).toHaveLength(1);
    expect(detail.preparedPullRequest).toBeNull();

    // Deciding again supersedes the fulfilled decision and prepares PR #2;
    // the remote-head guarantee holds for the new revision exactly as before.
    await decide(lane);
    detail = await detailOf(lane);
    expect(detail.state).toBe("decision_recorded");
    expect(detail.decisions.filter((entry: { supersededAt: string | null }) => entry.supersededAt !== null)).toHaveLength(1);
    expect(detail.preparedPullRequest).not.toBeNull();
    const stale = await createPull(lane);
    expect(stale.statusCode).toBe(409);
    await reportPushed(lane, secondSha);
    const second = await createPull(lane);
    expect(second.statusCode).toBe(201);
    expect(second.json().pullRequest.number).not.toBe(firstNumber);
    expect(second.json().pullRequest.headRef).toBe(lane.missionBranch);

    detail = await detailOf(lane);
    expect(detail.state).toBe("pull_request_open");
    expect(detail.pullRequest.number).toBe(second.json().pullRequest.number);
    expect(detail.pullRequests.map((pull: { state: string }) => pull.state)).toEqual(["merged", "draft"]);
  });

  it("refuses a merge the host reports conflicted, whatever anyone acknowledges", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    const pullId = created.json().pullRequest.pullRequestId as string;
    const number = created.json().pullRequest.number as number;
    await harness.app.inject({ method: "POST", url: `/pull-requests/${pullId}/ready`, headers: bearer(kartik) });
    provider.fakeConflict("9001", number);
    await sweepPullRequestsOnce(harness.db, provider);
    const refused = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/merge`,
      headers: bearer(kartik),
      payload: { method: "merge", acknowledgeBlockers: true }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("host_refuses");
    const detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("ready");
  });

  it("operates the rest in-house: update branch, comment with attribution, resolve, metadata, files, close, delete (D-100)", async () => {
    const lane = await githubMission();
    await decide(lane);
    await reportPushed(lane, lane.checkpointSha);
    const created = await createPull(lane);
    const pullId = created.json().pullRequest.pullRequestId as string;
    const number = created.json().pullRequest.number as number;

    // Behind its base: readiness says so after a sweep, update-branch fixes it.
    provider.fakeBehind("9001", number, 3);
    await sweepPullRequestsOnce(harness.db, provider);
    let detail = await detailOf(lane);
    expect(detail.pullRequest.readiness.behindBy).toBe(3);
    const updated = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/update-branch`,
      headers: bearer(kartik)
    });
    expect(updated.statusCode).toBe(200);
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    expect(detail.pullRequest.readiness.behindBy).toBe(0);

    // A comment from Novus is authored as the person themselves where their
    // OAuth token is held — which sign-in now stores (D-101, rewriting the
    // D-100 assertion that pinned the App-authored fallback with its prefix).
    const commented = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/comment`,
      headers: bearer(kartik),
      payload: { body: "Bounded at fifty, see the schema.", path: "live-change.txt", line: 1 }
    });
    expect(commented.statusCode).toBe(200);
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    const sent = detail.pullRequest.reviewThreads.find((thread: { body: string }) =>
      thread.body.includes("Bounded at fifty")
    );
    expect(sent.author).toBe("kartik");
    expect(sent.body).toBe("Bounded at fifty, see the schema.");
    expect(sent.state).toBe("open");

    // Without a held token — a person from before the scope existed — the
    // App authors it, attributed in the body, exactly the D-100 fallback.
    await harness.db.query("update users set github_token = null where user_id = $1", [kartik.userId]);
    const fallback = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/comment`,
      headers: bearer(kartik),
      payload: { body: "And bounded at twenty above." }
    });
    expect(fallback.statusCode).toBe(200);
    await sweepPullRequestsOnce(harness.db, provider);
    detail = await detailOf(lane);
    const appAuthored = detail.pullRequest.reviewThreads.find((thread: { body: string }) =>
      thread.body.includes("bounded at twenty")
    );
    expect(appAuthored.author).toBe("app/novus");
    expect(appAuthored.body).toContain("kartik via Novus:");
    await harness.db.query("update users set github_token = $2 where user_id = $1", [
      kartik.userId,
      "gho_fake_kartik"
    ]);

    // Resolving from Novus reflects immediately and lands on the host.
    const resolved = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/resolve-thread`,
      headers: bearer(kartik),
      payload: { threadId: sent.threadId }
    });
    expect(resolved.statusCode).toBe(200);
    detail = await detailOf(lane);
    expect(
      detail.pullRequest.reviewThreads.find((thread: { threadId: string }) => thread.threadId === sent.threadId)
        .state
    ).toBe("resolved");

    // Title and labels follow the host; the sent snapshot stays the receipt.
    const bodyBefore = detail.pullRequest.body as string;
    const edited = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/metadata`,
      headers: bearer(kartik),
      payload: { title: "Ship the session guard, retitled", labels: ["novus", "auth"] }
    });
    expect(edited.statusCode).toBe(200);
    detail = await detailOf(lane);
    expect(detail.pullRequest.title).toBe("Ship the session guard, retitled");
    expect(detail.pullRequest.labels).toEqual(["novus", "auth"]);
    expect(detail.pullRequest.body).toBe(bodyBefore);

    // The in-house diff: the host's files and commits, bounded.
    const files = await harness.app.inject({
      method: "GET",
      url: `/pull-requests/${pullId}/files`,
      headers: bearer(kartik)
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().files[0].path).toBe("live-change.txt");
    expect(files.json().files[0].patch).toContain("@@");
    expect(files.json().commits.length).toBeGreaterThan(0);

    // Deleting the branch is gated on resolution: refused while open, in words.
    const early = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/delete-branch`,
      headers: bearer(kartik)
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("still_open");

    const closed = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/close`,
      headers: bearer(kartik)
    });
    expect(closed.statusCode).toBe(200);
    detail = await detailOf(lane);
    expect(detail.pullRequest.state).toBe("closed");

    const deleted = await harness.app.inject({
      method: "POST",
      url: `/pull-requests/${pullId}/delete-branch`,
      headers: bearer(kartik)
    });
    expect(deleted.statusCode).toBe(200);
    const kinds = await harness.db.query(
      `select kind from events where mission_id = $1 and kind like 'pr.%' order by seq`,
      [lane.missionId]
    );
    const list = kinds.rows.map((row) => row.kind as string);
    expect(list).toContain("pr.branch_updated");
    expect(list).toContain("pr.comment_sent");
    expect(list).toContain("pr.thread_resolved");
    expect(list).toContain("pr.metadata_edited");
    expect(list).toContain("pr.close_performed");
    expect(list).toContain("pr.branch_deleted");
  });
});
