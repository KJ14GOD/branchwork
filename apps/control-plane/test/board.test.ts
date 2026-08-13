import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { Mission, ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The Home board's list projection (D-120), against a real PostgreSQL.
 *
 * The rules under test: the list carries the board's facts — when the mission
 * last said anything, what its work has touched (churn, stated as churn), the
 * baton only where it is one fact, verification tallied at the lanes' current
 * heads only — and the projection now reaches the decided states the room has
 * always projected and the list never did: an open pull request, then a
 * standing decision, each outranked by attention and by running. Absence
 * stays absent: nulls, never rows of zeros.
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
  harness = await createHarness("novus_test_board", new FakeRepositoryProvider());
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
      goal: "Organize the work at the team level",
      successCriteria: "Home answers what needs a person",
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

async function direct(lane: Lane, body: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(kartik),
    payload: { body, model: "claude-fable-5", effort: "high", workstreamId: lane.workstreamId }
  });
  expect(response.statusCode).toBe(200);
  const execution = await harness.db.query(
    "select exe_id from executions where wst_id = $1 order by created_at desc limit 1",
    [lane.workstreamId]
  );
  return execution.rows[0].exe_id as string;
}

async function report(credential: string, executionId: string | null, events: ReportableRunnerEvent[]) {
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

const checkpoint = (originSeq: number, at: string, path: string): ReportableRunnerEvent => ({
  originSeq,
  event: {
    kind: "workspace.checkpoint",
    payload: {
      outcome: "committed",
      sha: at,
      parentSha: null,
      branch: "novus/m-board",
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
      ],
      driftPaths: []
    }
  }
});

const completed = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "execution.completed", payload: {} }
});

async function listedRow(missionId: string): Promise<Mission> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/missions",
    headers: bearer(kartik)
  });
  expect(response.statusCode).toBe(200);
  const row = (response.json().missions as Mission[]).find(
    (mission) => mission.missionId === missionId
  );
  expect(row).toBeTruthy();
  return row as Mission;
}

/** A check bound to a revision, inserted at the projection's own tables: the
 *  tally is a read-side fact and this suite tests the reading. */
async function checkAt(lane: Lane, executionId: string, at: string, outcome: "passed" | "failed") {
  await harness.db.query(
    `insert into verification_checks (chk_id, org_id, mission_id, exe_id, wst_id, name, category,
                                      outcome, command, environment, checkpoint_sha)
     select 'chk_' || md5(random()::text), m.org_id, m.mission_id, $2, $3, 'tests', 'test',
            $4, 'pnpm test', 'local', $5
       from missions m where m.mission_id = $1`,
    [lane.missionId, executionId, lane.workstreamId, outcome, at]
  );
}

describe("the board's facts on the list", () => {
  it("carries activity, churn, and the single-lane baton — and absence stays null", async () => {
    const lane = await mission();
    const fresh = await listedRow(lane.missionId);
    // Nothing has happened: churn and checks are null, never zeros. Creation
    // itself is an event, so the mission has already said something.
    expect(fresh.churn).toBeNull();
    expect(fresh.checks).toBeNull();
    expect(fresh.working).toBeNull();
    expect(fresh.lastActivityAt).not.toBeNull();
    // The creator committed the first lease in the creating transaction, and
    // with one lane the baton is one fact.
    expect(fresh.controllerLogin).toBe("kartik");

    const executionId = await direct(lane, "touch the file");
    const at = sha("board-head-1");
    await report(lane.credential, executionId, [...live(1), checkpoint(3, at, "src/board.ts"), completed(4)]);
    const row = await listedRow(lane.missionId);
    expect(row.churn).toEqual({ filesChanged: 1, additions: 7, deletions: 2 });
    expect(Date.parse(row.lastActivityAt as string)).toBeGreaterThan(
      Date.parse(fresh.lastActivityAt as string) - 1
    );
  });

  it("names the running lane and its chat, the running mirror of attention", async () => {
    const lane = await mission();
    const executionId = await direct(lane, "keep working on the board");
    await report(lane.credential, executionId, live(1));
    const row = await listedRow(lane.missionId);
    expect(row.primaryState).toBe("agent_running");
    expect(row.working).toMatchObject({
      workstreamId: lane.workstreamId,
      workstreamName: "Current work",
      sessionTitle: "keep working on the board"
    });
    expect(row.attention).toBeNull();
  });

  it("tallies checks at the lane's current head only — a superseded head's checks are history", async () => {
    const lane = await mission();
    const executionId = await direct(lane, "verify the thing");
    const first = sha("board-head-a");
    await report(lane.credential, executionId, [...live(1), checkpoint(3, first, "a.ts"), completed(4)]);
    await checkAt(lane, executionId, first, "passed");
    await checkAt(lane, executionId, first, "failed");
    expect((await listedRow(lane.missionId)).checks).toEqual({ passed: 1, total: 2 });

    // The lane moves past that revision: the tally empties rather than
    // going on counting stale proof.
    const second = await direct(lane, "keep going");
    await report(lane.credential, second, [
      ...live(1),
      checkpoint(3, sha("board-head-b"), "b.ts"),
      completed(4)
    ]);
    expect((await listedRow(lane.missionId)).checks).toBeNull();
  });

  it("keeps the baton unstated where a mission holds two lanes — two batons are not one fact", async () => {
    const lane = await mission();
    const executionId = await direct(lane, "make something to fork from");
    await report(lane.credential, executionId, [
      ...live(1),
      checkpoint(3, sha("board-fork"), "seed.ts"),
      completed(4)
    ]);
    const forked = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/approaches`,
      headers: bearer(kartik),
      payload: { fromWorkstreamId: lane.workstreamId, intent: "Try the other shape" }
    });
    expect(forked.statusCode).toBe(201);
    const row = await listedRow(lane.missionId);
    expect(row.workstreamCount).toBe(2);
    expect(row.controllerLogin).toBeNull();
  });

  it("projects the decided states the room always had: a decision, then an open pull request over it", async () => {
    const lane = await mission();
    const executionId = await direct(lane, "finish the work");
    const at = sha("board-decided");
    await report(lane.credential, executionId, [...live(1), checkpoint(3, at, "done.ts"), completed(4)]);
    const decided = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/decision`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, rationale: "It does the thing and says so." }
    });
    expect(decided.statusCode).toBe(201);
    expect((await listedRow(lane.missionId)).primaryState).toBe("decision_recorded");

    // An opened draft outranks the bare decision; the row is inserted at the
    // table because opening a real one needs a host, and this suite tests
    // the projection's reading.
    const decision = await harness.db.query(
      "select dec_id, org_id from decisions where mission_id = $1 and superseded_at is null",
      [lane.missionId]
    );
    await harness.db.query(
      `insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url,
                                  state, title, body, base_ref, head_ref, created_by)
       values ('pr_board_test', $1, $2, $3, $4, 7, 'https://example.invalid/pull/7',
               'draft', 'Finish the work', 'The receipt.', 'main', 'novus/m-board', $5)`,
      [
        decision.rows[0].org_id,
        lane.missionId,
        lane.workstreamId,
        decision.rows[0].dec_id,
        kartik.userId
      ]
    );
    expect((await listedRow(lane.missionId)).primaryState).toBe("pull_request_open");

    // Attention still outranks decided: a new turn that stops at a question
    // pulls the mission back to Needs you.
    const blocked = await direct(lane, "one more change");
    await report(lane.credential, blocked, [
      ...live(1),
      {
        originSeq: 3,
        event: {
          kind: "approval.requested",
          payload: {
            requestId: "board-req-1",
            toolUseId: null,
            toolName: "Write",
            displayName: "Write",
            summary: "Write done.ts"
          }
        }
      }
    ]);
    const row = await listedRow(lane.missionId);
    expect(row.primaryState).toBe("needs_approval");
    expect(row.attention).not.toBeNull();
  });
});
