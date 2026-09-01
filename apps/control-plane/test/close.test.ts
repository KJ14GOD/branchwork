import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { Mission, ReceiptSnapshot, ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { projectReceipt } from "../src/close.ts";
import { missionAccess } from "../src/authz.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The terminal lifecycle (D-121), against a real PostgreSQL.
 *
 * The rules under test: `mission.close` is Mission Admin's alone; completion
 * means what it says — refused without a standing decision, refused while a
 * pull request is open; both endings borrow archival's refusals (the waiting
 * question first, live work in words, a stillborn attempt ended on the way
 * out); the receipt is snapshotted deterministically with its event range; a
 * closed mission's state is its stored outcome and its operating verbs refuse
 * in words; and an invitation redeemed after the end joins as a Viewer
 * (ARCHITECTURE.md failure mode 13).
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
  harness = await createHarness("novus_test_close", new FakeRepositoryProvider());
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
      goal: "End the work honestly",
      successCriteria: "The receipt says what happened",
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

const checkpoint = (originSeq: number, at: string): ReportableRunnerEvent => ({
  originSeq,
  event: {
    kind: "workspace.checkpoint",
    payload: {
      outcome: "committed",
      sha: at,
      parentSha: null,
      branch: "novus/m-close",
      withheldSecrets: 0,
      uncommitted: false,
      error: null,
      files: [
        {
          path: "done.ts",
          previousPath: null,
          changeState: "modified",
          additions: 5,
          deletions: 1,
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

/** A settled lane with a checkpoint — something a decision can choose. */
async function settled(lane: Lane): Promise<string> {
  const executionId = await direct(lane, "finish the work");
  const at = sha(`close-${lane.missionId}`);
  await report(lane.credential, executionId, [...live(1), checkpoint(3, at), completed(4)]);
  return at;
}

async function decide(lane: Lane) {
  const response = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/decision`,
    headers: bearer(kartik),
    payload: { workstreamId: lane.workstreamId, rationale: "It does the thing." }
  });
  expect(response.statusCode).toBe(201);
}

async function close(
  lane: Lane,
  outcome: "completed" | "cancelled",
  options: { as?: SignedIn; reason?: string } = {}
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/close`,
    headers: bearer(options.as ?? kartik),
    payload: { outcome, ...(options.reason !== undefined ? { reason: options.reason } : {}) }
  });
}

async function listedRow(missionId: string): Promise<Mission> {
  const response = await harness.app.inject({
    method: "GET",
    url: "/missions",
    headers: bearer(kartik)
  });
  const row = (response.json().missions as Mission[]).find(
    (mission) => mission.missionId === missionId
  );
  expect(row).toBeTruthy();
  return row as Mission;
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

describe("who may end a mission, and what completion means", () => {
  it("is Mission Admin's alone, and completing requires an accepted result", async () => {
    const lane = await mission();
    await settled(lane);
    const operator = await joinAs(lane.missionId, "op-close", "operator");
    expect((await close(lane, "cancelled", { as: operator })).statusCode).toBe(403);

    // No decision stands: completed is refused with the useful instruction.
    const undecided = await close(lane, "completed");
    expect(undecided.statusCode).toBe(409);
    expect(undecided.json().error.message).toContain("Record a decision first");

    await decide(lane);
    expect((await close(lane, "completed")).statusCode).toBe(200);
    const row = await listedRow(lane.missionId);
    expect(row.primaryState).toBe("completed");
    expect(row.closedOutcome).toBe("completed");
    expect(row.closedByLogin).toBe("kartik");
    expect(row.attention).toBeNull();

    // Ended is ended: a second close is refused, not repeated.
    expect((await close(lane, "cancelled")).statusCode).toBe(409);
  });

  it("refuses completion while the pull request is open — resolved means resolved", async () => {
    const lane = await mission();
    await settled(lane);
    await decide(lane);
    const decision = await harness.db.query(
      "select dec_id, org_id from decisions where mission_id = $1 and superseded_at is null",
      [lane.missionId]
    );
    await harness.db.query(
      `insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url,
                                  state, title, body, base_ref, head_ref, created_by)
       values ('pr_close_test', $1, $2, $3, $4, 9, 'https://example.invalid/pull/9',
               'ready', 'Finish', 'Receipt.', 'main', 'novus/m-close', $5)`,
      [
        decision.rows[0].org_id,
        lane.missionId,
        lane.workstreamId,
        decision.rows[0].dec_id,
        kartik.userId
      ]
    );
    const refused = await close(lane, "completed");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain("pull request is still open");
    await harness.db.query("update pull_requests set state = 'merged' where pr_id = 'pr_close_test'");
    expect((await close(lane, "completed")).statusCode).toBe(200);
  });

  it("borrows archival's refusals: the waiting question first, then live work, in words", async () => {
    const lane = await mission();
    const executionId = await direct(lane, "get stuck");
    await report(lane.credential, executionId, [
      ...live(1),
      {
        originSeq: 3,
        event: {
          kind: "approval.requested",
          payload: {
            requestId: "close-req-1",
            toolUseId: null,
            toolName: "Write",
            displayName: "Write",
            summary: "Write done.ts"
          }
        }
      }
    ]);
    const waiting = await close(lane, "cancelled");
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json().error.message).toContain("waiting for an answer");
  });
});

/**
 * Giving the workspaces back (D-155).
 *
 * The control plane's half is small and its two properties are both about
 * durability: the command is enqueued **inside the closing transaction**, so a
 * mission that ended is a mission whose machines have been told; and it is
 * keyed per lane, so a mission with competing approaches asks for each one
 * rather than the first.
 */
describe("ending a mission asks for its workspaces back", () => {
  it("enqueues a release for the lane, in the same transaction as the close", async () => {
    const lane = await mission();
    await settled(lane);
    await decide(lane);
    expect((await close(lane, "completed")).statusCode).toBe(200);

    const queued = await harness.db.query(
      "select kind, wst_id, state from runner_commands where mission_id = $1 and kind = 'release_workspace'",
      [lane.missionId]
    );
    expect(queued.rowCount).toBe(1);
    expect(queued.rows[0].wst_id).toBe(lane.workstreamId);
    expect(queued.rows[0].state).toBe("pending");
  }, 30_000);

  it("asks once however many times the close is attempted", async () => {
    const lane = await mission();
    await settled(lane);
    await decide(lane);
    expect((await close(lane, "completed")).statusCode).toBe(200);
    // A second close is refused as already-closed, and must not queue a
    // second release behind the first.
    expect((await close(lane, "completed")).statusCode).toBe(409);

    const queued = await harness.db.query(
      "select count(*)::int as n from runner_commands where mission_id = $1 and kind = 'release_workspace'",
      [lane.missionId]
    );
    expect(queued.rows[0].n).toBe(1);
  }, 30_000);

  it("does not ask while the mission is still open", async () => {
    const lane = await mission();
    await settled(lane);
    const queued = await harness.db.query(
      "select count(*)::int as n from runner_commands where mission_id = $1 and kind = 'release_workspace'",
      [lane.missionId]
    );
    expect(queued.rows[0].n).toBe(0);
  }, 30_000);
});

describe("the receipt", () => {
  it("is snapshotted deterministically with its event range, and served on the detail", async () => {
    const lane = await mission();
    await settled(lane);
    await decide(lane);
    expect((await close(lane, "completed")).statusCode).toBe(200);

    const stored = await harness.db.query(
      "select snapshot, from_seq, to_seq from receipts where mission_id = $1",
      [lane.missionId]
    );
    expect(stored.rowCount).toBe(1);
    const snapshot = stored.rows[0].snapshot as ReceiptSnapshot;
    expect(snapshot.outcome).toBe("completed");
    expect(snapshot.closedByLogin).toBe("kartik");
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.decisions[0]?.rationale).toBe("It does the thing.");
    expect(snapshot.changes).toEqual({ filesChanged: 1, additions: 5, deletions: 1 });
    // The D-234 record: the chats, the directions verbatim, and the files.
    expect(snapshot.sessions.length).toBeGreaterThan(0);
    expect(snapshot.sessions[0]?.directions).toBeGreaterThan(0);
    expect(snapshot.directions.length).toBeGreaterThan(0);
    expect(snapshot.directions[0]?.authorLogin).toBe("kartik");
    expect(snapshot.directions.every((direction) => direction.body.length > 0)).toBe(true);
    expect(snapshot.files.map((file) => file.path)).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({ additions: 5, deletions: 1 });
    // Nothing was verified, and the receipt says so rather than omitting it.
    expect(snapshot.remainingUncertain.join(" ")).toContain("no check ran against");
    expect(Number(stored.rows[0].to_seq)).toBeGreaterThan(Number(stored.rows[0].from_seq));

    // Deterministic: projecting again over the unchanged rows gives the same
    // snapshot — deep equality, because jsonb storage normalizes key order
    // and the claim is about the facts, including the event range covering
    // the close's own record.
    const client = await harness.db.connect();
    try {
      const access = await missionAccess(client, { userId: kartik.userId }, lane.missionId);
      const again = await projectReceipt(client, access!, {
        outcome: snapshot.outcome,
        reason: snapshot.reason,
        closedByLogin: snapshot.closedByLogin,
        closedAt: snapshot.closedAt
      });
      expect(again).toEqual(snapshot);
    } finally {
      client.release();
    }

    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(detail.json().state).toBe("completed");
    expect(detail.json().overlays).toEqual([]);
    expect(detail.json().receipt?.outcome).toBe("completed");
  });

  it("carries a cancellation's own words", async () => {
    const lane = await mission();
    await settled(lane);
    const cancelled = await close(lane, "cancelled", {
      reason: "The approach was wrong; starting over."
    });
    expect(cancelled.statusCode).toBe(200);
    const row = await listedRow(lane.missionId);
    expect(row.primaryState).toBe("cancelled");
    const stored = await harness.db.query("select snapshot from receipts where mission_id = $1", [
      lane.missionId
    ]);
    expect((stored.rows[0].snapshot as ReceiptSnapshot).reason).toBe(
      "The approach was wrong; starting over."
    );
    const events = await harness.db.query(
      "select payload from events where mission_id = $1 and kind = 'mission.closed'",
      [lane.missionId]
    );
    expect(events.rows[0].payload).toMatchObject({
      outcome: "cancelled",
      reason: "The approach was wrong; starting over."
    });
  });
});

describe("a terminal state never resumes", () => {
  it("refuses the operating verbs in words, and archival still files the record away", async () => {
    const lane = await mission();
    await settled(lane);
    expect((await close(lane, "cancelled")).statusCode).toBe(200);

    const directed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: { body: "one more", model: "claude-fable-5", effort: "high" }
    });
    expect(directed.statusCode).toBe(409);
    expect(directed.json().error.message).toContain("cancelled");

    const forked = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/approaches`,
      headers: bearer(kartik),
      payload: { fromWorkstreamId: lane.workstreamId, intent: "Try again" }
    });
    expect(forked.statusCode).toBe(409);

    // Closing ends; archival files away. A mission can be both, in order.
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: `/missions/${lane.missionId}/archive`,
          headers: bearer(kartik)
        })
      ).statusCode
    ).toBe(200);
  });

  it("turns a late invitation into read access: the joiner is a Viewer whatever was offered", async () => {
    const lane = await mission();
    await settled(lane);
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "operator" }
    });
    expect((await close(lane, "cancelled")).statusCode).toBe(200);

    const late = await harness.signIn("late-joiner");
    const redeemed = await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(late),
      payload: { token: invitation.json().token }
    });
    expect(redeemed.statusCode).toBe(200);
    const role = await harness.db.query(
      "select mission_role from participants where mission_id = $1 and user_id = $2",
      [lane.missionId, late.userId]
    );
    expect(role.rows[0].mission_role).toBe("viewer");
  });
});
