import { describe, expect, it } from "vitest";
import {
  MissionDetailResponseSchema,
  PullRequestSchema,
  type MissionDetailResponse,
  type PullRequest
} from "@novus/contracts";
import { deriveStateLine } from "../src/components/derive";

/**
 * What the room says about a published decision (D-099), pinned pure. The
 * fixtures parse through the contract schema, so a shape this suite invents
 * cannot drift from the wire. The rules under test: an open request is the
 * mission's state and its sentence names where merging happens; a resolved
 * one returns the mission to the decision, whose sentence names how
 * publication ended — never "not published yet" after a merge, which would
 * be a lie.
 */

const SHA = "b".repeat(40);
const NOW = "2026-08-09T12:00:00.000Z";
const KARTIK = "usr_kartik";

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return PullRequestSchema.parse({
    pullRequestId: "pr_one",
    missionId: "msn_one",
    workstreamId: "wst_one",
    decisionId: "dec_one",
    number: 4,
    url: "https://github.com/novus/demo-app/pull/4",
    state: "draft",
    mergeable: "unknown",
    title: "Ship the change",
    body: "## What this is\nthe change",
    baseRef: "main",
    headRef: "novus/m-one",
    headSha: SHA,
    requestedReviewers: [],
    reviewThreads: [],
    createdBy: KARTIK,
    createdByLogin: "kartik",
    mergedBy: null,
    mergedAt: null,
    closedAt: null,
    createdAt: NOW,
    lastSyncedAt: null,
    ...overrides
  });
}

function detail(overrides: Record<string, unknown> = {}): MissionDetailResponse {
  const lane = {
    workstreamId: "wst_one",
    missionId: "msn_one",
    name: "Current work",
    baseRef: "main",
    baseSha: SHA,
    missionBranch: "novus/m-one",
    branchStatus: "created",
    branchError: null,
    approach: false,
    intent: null,
    forkedFromWorkstreamId: null,
    originSha: null,
    remoteHeadSha: SHA
  };
  return MissionDetailResponseSchema.parse({
    mission: {
      missionId: "msn_one",
      orgId: "org_one",
      goal: "Ship the change",
      successCriteria: "It ships",
      primaryState: "decision_recorded",
      createdBy: KARTIK,
      createdByLogin: "kartik",
      createdAt: NOW,
      repository: null,
      archivedAt: null,
      archivedByLogin: null,
      attention: null
    },
    workstream: lane,
    workstreams: [lane],
    sessions: [],
    approaches: [
      {
        workstreamId: "wst_one",
        name: "Current work",
        intent: null,
        approach: false,
        missionBranch: "novus/m-one",
        originSha: null,
        forkPointSha: SHA,
        state: "decision_recorded",
        controllerLogin: "kartik",
        checkpointSha: SHA,
        filesChanged: 2,
        additions: 10,
        deletions: 3,
        paths: ["server/api.ts"],
        checksRun: 1,
        checksPassed: 1,
        checksFailed: 0,
        unresolvedChecks: 0,
        directions: 1,
        approvalsAnswered: 0,
        stops: 0,
        usage: {},
        startedAt: null,
        endedAt: null
      }
    ],
    contested: [],
    decisions: [
      {
        decisionId: "dec_one",
        missionId: "msn_one",
        workstreamId: "wst_one",
        checkpointSha: SHA,
        decidedBy: KARTIK,
        decidedByLogin: "kartik",
        rationale: "It holds.",
        acceptedRisks: null,
        unresolvedCheckIds: [],
        unresolvedSummary: [],
        decidedAt: NOW,
        supersededAt: null
      }
    ],
    preparedPullRequest: null,
    pullRequest: null,
    branchPush: { state: "completed", remoteHeadSha: SHA, failureReason: null },
    events: [],
    participants: [],
    directions: [],
    executions: [],
    control: {
      leaseId: "lease-1",
      holderUserId: KARTIK,
      holderLogin: "kartik",
      state: "held",
      openRequests: [],
      liveOffer: null
    },
    checkpoints: [],
    checks: [],
    approvals: [],
    runner: null,
    workspace: null,
    processes: [],
    capabilities: ["pr.manage", "review.approve"],
    viewerUserId: KARTIK,
    state: "decision_recorded",
    overlays: [],
    ...overrides
  });
}

describe("the state line while a request is open (D-099)", () => {
  it("a draft is the mission's state, and the sentence says where merging happens", () => {
    const line = deriveStateLine(detail({ state: "pull_request_open", pullRequest: pull() }));
    expect(line.name).toBe("Pull request open");
    expect(line.detail).toContain("PR #4 is a draft");
    expect(line.detail).toContain("merging happens on GitHub");
  });

  it("a ready request awaits review, counts its open comments, and names a conflict", () => {
    const line = deriveStateLine(
      detail({
        state: "pull_request_open",
        pullRequest: pull({
          state: "ready",
          mergeable: "conflict",
          reviewThreads: [
            {
              author: "maya",
              body: "Is this bounded?",
              path: "server/api.ts",
              state: "open",
              url: null,
              postedAt: NOW
            }
          ]
        })
      })
    );
    expect(line.name).toBe("Pull request ready");
    expect(line.detail).toContain("awaits review");
    expect(line.detail).toContain("1 open comment");
    expect(line.detail).toContain("conflicts with its base");
  });
});

describe("the sentence after publication resolved (D-099)", () => {
  it("a merged request is named on the decision — never 'not published yet'", () => {
    const line = deriveStateLine(
      detail({ pullRequest: pull({ state: "merged", mergedBy: "maya", mergedAt: NOW }) })
    );
    expect(line.name).toBe("Decision recorded");
    expect(line.detail).toContain("published as PR #4, merged by maya on GitHub");
    expect(line.detail).not.toContain("not published yet");
  });

  it("a closed request says so plainly", () => {
    const line = deriveStateLine(detail({ pullRequest: pull({ state: "closed", closedAt: NOW }) }));
    expect(line.detail).toContain("PR #4 was closed on GitHub without merging");
  });

  it("no request at all keeps the honest 'not published yet'", () => {
    const line = deriveStateLine(detail());
    expect(line.detail).toContain("not published yet");
  });
});

describe("the merge confirm's named blockers (D-100)", () => {
  // The server recomputes and is the authority; this pins that the confirm
  // names the same facts a person is about to accept — never a summary color.
  it("names change requests, open comments, non-required failures, running checks, and a stale branch", async () => {
    const { namedBlockers } = await import("../src/components/pull-request");
    const blockers = namedBlockers(
      pull({
        state: "ready",
        reviewThreads: [
          {
            threadId: "thr_1",
            author: "maya",
            body: "One question.",
            path: null,
            line: null,
            state: "open",
            url: null,
            postedAt: NOW
          }
        ],
        readiness: {
          checks: [
            { name: "lint", status: "failed", required: false, kind: "check", url: null },
            { name: "e2e", status: "pending", required: false, kind: "check", url: null },
            { name: "ci", status: "passed", required: true, kind: "check", url: null }
          ],
          reviewDecision: "changes_requested",
          approvals: 0,
          changesRequested: 1,
          behindBy: 2,
          aheadBy: 1,
          allowedMergeMethods: ["merge", "squash"],
          syncedAt: NOW
        }
      })
    );
    expect(blockers).toContain("1 change request outstanding");
    expect(blockers).toContain("1 review comment unresolved");
    expect(blockers).toContain("check lint failing");
    expect(blockers).toContain("1 check still running");
    expect(blockers).toContain("the branch is 2 commits behind its base");
    // The required check that passed is nobody's blocker, and a required
    // *failure* would never appear here — that is the host's tier.
    expect(blockers.join(" ")).not.toContain("ci");
  });

  it("names nothing when the gate is green", async () => {
    const { namedBlockers } = await import("../src/components/pull-request");
    expect(
      namedBlockers(
        pull({
          state: "ready",
          readiness: {
            checks: [{ name: "ci", status: "passed", required: true, kind: "check", url: null }],
            reviewDecision: "approved",
            approvals: 1,
            changesRequested: 0,
            behindBy: 0,
            aheadBy: 1,
            allowedMergeMethods: ["merge"],
            syncedAt: NOW
          }
        })
      )
    ).toEqual([]);
  });
});
