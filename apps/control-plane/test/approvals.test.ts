import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent, SequencedRunnerEvent } from "@novus/contracts";
import { buildServer } from "../src/server.ts";
import { sweepRunners, RELIABILITY_THRESHOLDS } from "../src/reliability.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Harness approvals in the control plane (D-056), against a real PostgreSQL.
 *
 * `needs_approval` has existed in PRODUCT.md's state model since the beginning
 * and nothing ever entered it. What these tests are for is the half of that gap
 * the server owns: the question is durable, the answer is attributed and
 * settled exactly once, and **only the controller** can give it — which is what
 * PRODUCT.md's capability table has always said and what nothing enforced,
 * because the verb had no route.
 *
 * Deterministic evidence for those paths and nothing more: a real desktop
 * routing a real Claude Code permission prompt is a separate claim
 * (AGENTS.md rule 11).
 */

let harness: Harness;
let owner: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
  runnerId: string;
}

async function createLane(label = "test-machine"): Promise<Lane> {
  const localId = randomUUID();
  const headSha = sha(localId);
  const registered = await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(owner),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  expect(registered.statusCode).toBe(200);
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(owner),
    payload: {
      goal: "Route approvals to a person",
      successCriteria: "Nothing is written without somebody saying so",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  // The desktop reports the branch it made; without it the mission is honestly
  // *New mission* and never reaches a state an approval could be asked in.
  const branch = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${body.workstream.workstreamId}/branch/report`,
    headers: bearer(owner),
    payload: { status: "created" }
  });
  expect(branch.statusCode).toBe(200);
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${body.workstream.workstreamId}/runner`,
    headers: bearer(owner),
    payload: { workstreamId: body.workstream.workstreamId, label }
  });
  expect(enrolled.statusCode).toBe(200);
  return {
    missionId: body.mission.missionId as string,
    workstreamId: body.workstream.workstreamId as string,
    credential: enrolled.json().credential as string,
    runnerId: enrolled.json().runnerId as string
  };
}

async function addParticipant(missionId: string, who: string, role = "contributor"): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(owner),
    payload: { role }
  });
  expect(created.statusCode).toBe(201);
  const redeemed = await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token: created.json().token }
  });
  expect(redeemed.statusCode).toBe(200);
  return joiner;
}

async function commandsFor(credential: string) {
  const response = await harness.app.inject({
    method: "GET",
    url: "/runner/commands",
    headers: runnerAuth(credential)
  });
  expect(response.statusCode).toBe(200);
  return response.json().commands as { commandId: string; kind: string; payload: Record<string, unknown> }[];
}

async function report(credential: string, executionId: string, events: ReportableRunnerEvent[]) {
  return harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
}

async function startExecution(lane: Lane): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(owner),
    payload: { body: "Write a file", model: "claude-fable-5", effort: "high" }
  });
  expect(response.statusCode).toBe(200);
  const commands = await commandsFor(lane.credential);
  const start = commands.find((command) => command.kind === "start_execution") as
    | { executionId: string }
    | undefined;
  expect(start).toBeTruthy();
  return (start as unknown as { executionId: string }).executionId;
}

let nextSeq = 0;

/** The runner reporting the accounts a turn carried (D-217), so a later
 *  connector question is answerable by its lender. Runs the turn's own
 *  running event with the lent list — the same the respond route reads. */
async function reportRunningWithConnectors(
  lane: Lane,
  executionId: string,
  connectors: string[]
): Promise<void> {
  nextSeq += 1;
  const response = await report(lane.credential, executionId, [
    {
      originSeq: nextSeq,
      event: {
        kind: "execution.running",
        payload: { harness: "claude-code", model: "claude-fable-5", effort: "high", connectors }
      }
    }
  ]);
  expect(response.statusCode).toBe(200);
}


/** The runner reporting the question the harness is blocked on. */
async function askApproval(
  lane: Lane,
  executionId: string,
  overrides: Partial<{ requestId: string; toolName: string; summary: string }> = {}
): Promise<string> {
  nextSeq += 1;
  const requestSeq = nextSeq;
  nextSeq += 1;
  // Both events, in the order the runner actually sends them: a harness waiting
  // on a permission prompt is at a safe boundary, and the runner declares it.
  const response = await report(lane.credential, executionId, [
    {
      originSeq: requestSeq,
      event: {
        kind: "approval.requested",
        payload: {
          requestId: overrides.requestId ?? `harness-request-${requestSeq}`,
          toolUseId: `toolu_${requestSeq}`,
          toolName: overrides.toolName ?? "Write",
          displayName: overrides.toolName ?? "Write",
          summary: overrides.summary ?? "the mission worktree/PROBE.md — PROBE.md"
        }
      }
    },
    {
      originSeq: nextSeq,
      event: { kind: "boundary.reached", payload: { reason: "permission prompt pending" } }
    }
  ]);
  expect(response.statusCode).toBe(200);
  const rows = await harness.db.query(
    "select apr_id from approval_requests where exe_id = $1 order by requested_at desc limit 1",
    [executionId]
  );
  return rows.rows[0].apr_id as string;
}

async function respond(
  actor: SignedIn,
  approvalId: string,
  decision: "approve" | "deny",
  reason?: string
) {
  return harness.app.inject({
    method: "POST",
    url: `/approvals/${approvalId}/respond`,
    headers: bearer(actor),
    payload: reason === undefined ? { decision } : { decision, reason }
  });
}

const detail = async (actor: SignedIn, missionId: string) => {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${missionId}`,
    headers: bearer(actor)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

const approvalRow = async (approvalId: string) => {
  const rows = await harness.db.query("select * from approval_requests where apr_id = $1", [approvalId]);
  return rows.rows[0];
};

/**
 * Hands the baton over the whole request-offer-accept handshake, which is the
 * only way control actually moves.
 *
 * The last step is the runner answering the boundary request, which is what a
 * real one does the moment it is asked while blocked on an approval. Without
 * it the transfer waits for a turn that is waiting for the transfer.
 */
async function handControlTo(lane: Lane, recipient: SignedIn, executionId?: string): Promise<void> {
  const requested = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/control/request`,
    headers: bearer(recipient)
  });
  expect(requested.statusCode).toBe(200);
  const offered = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/control/offer`,
    headers: bearer(owner),
    payload: { toUserId: recipient.userId }
  });
  expect(offered.statusCode).toBe(200);
  const snapshot = await detail(owner, lane.missionId);
  const accepted = await harness.app.inject({
    method: "POST",
    url: `/control/offers/${snapshot.control.liveOffer.offerId}/accept`,
    headers: bearer(recipient)
  });
  expect(accepted.statusCode).toBe(200);

  if (executionId !== undefined) {
    const boundaryRequested = await commandsFor(lane.credential);
    expect(boundaryRequested.some((command) => command.kind === "boundary_request")).toBe(true);
    nextSeq += 1;
    await report(lane.credential, executionId, [
      {
        originSeq: nextSeq,
        event: { kind: "boundary.reached", payload: { reason: "permission prompt pending" } }
      }
    ]);
  }
}

beforeAll(async () => {
  harness = await createHarness("novus_test_approvals");
  owner = await harness.signIn("approval-owner");
});

afterAll(async () => {
  await harness.close();
});

describe("a question the harness is blocked on", () => {
  it("becomes a durable request and puts the mission in Needs approval", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    const row = await approvalRow(approvalId);
    expect(row.state).toBe("pending");
    expect(row.tool_name).toBe("Write");
    expect(row.summary).toBe("the mission worktree/PROBE.md — PROBE.md");
    expect(row.responded_by).toBeNull();
    expect(row.exe_id).toBe(executionId);

    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("needs_approval");

    // The state PRODUCT.md has always defined, entered for the first time.
    const room = await detail(owner, lane.missionId);
    expect(room.state).toBe("needs_approval");
    expect(room.approvals).toHaveLength(1);
    expect(room.approvals[0]).toMatchObject({
      approvalId,
      state: "pending",
      toolName: "Write",
      respondedByLogin: null
    });
  });

  it("is one row however many times the report is replayed", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    nextSeq += 1;
    const batch: SequencedRunnerEvent[] = [
      {
        originSeq: nextSeq,
        event: {
          kind: "approval.requested",
          payload: {
            requestId: "replayed-request",
            toolUseId: "toolu_replay",
            toolName: "Bash",
            displayName: "Bash",
            summary: "rm -rf build"
          }
        }
      }
    ];
    expect((await report(lane.credential, executionId, batch)).statusCode).toBe(200);
    expect((await report(lane.credential, executionId, batch)).statusCode).toBe(200);

    const rows = await harness.db.query(
      "select count(*)::int as n from approval_requests where exe_id = $1",
      [executionId]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("never records the tool's raw input, only the bounded summary", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    // A runner is semi-trusted, so the ceiling is enforced here as well as there.
    const over = await report(lane.credential, executionId, [
      {
        originSeq: 900 + (nextSeq += 1),
        event: {
          kind: "approval.requested",
          payload: {
            requestId: "too-long",
            toolUseId: null,
            toolName: "Write",
            displayName: "Write",
            summary: "x".repeat(401)
          }
        }
      }
    ]);
    expect(over.statusCode).toBe(422);
    const rows = await harness.db.query(
      "select count(*)::int as n from approval_requests where exe_id = $1",
      [executionId]
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("who may answer", () => {
  it("lets the controller approve, and carries the decision to the runner", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    const answered = await respond(owner, approvalId, "approve");
    expect(answered.statusCode).toBe(200);

    const row = await approvalRow(approvalId);
    expect(row.state).toBe("approved");
    expect(row.responded_by).toBe(owner.userId);
    expect(row.responded_at).not.toBeNull();

    // The turn is working again rather than still waiting.
    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("running");

    const commands = await commandsFor(lane.credential);
    const decision = commands.find((command) => command.kind === "respond_approval");
    expect(decision?.payload).toMatchObject({
      approvalId,
      decision: "approve",
      harnessRequestId: expect.stringContaining("harness-request-")
    });

    const room = await detail(owner, lane.missionId);
    expect(room.approvals[0]).toMatchObject({ state: "approved", respondedByLogin: owner.login });
    expect(room.events.some((event: { kind: string }) => event.kind === "approval.responded")).toBe(true);
  });

  it("lets the controller deny, and carries the reason", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    expect((await respond(owner, approvalId, "deny", "Not that file.")).statusCode).toBe(200);
    const row = await approvalRow(approvalId);
    expect(row.state).toBe("denied");
    expect(row.resolution).toBe("Not that file.");

    const commands = await commandsFor(lane.credential);
    const decision = commands.find((command) => command.kind === "respond_approval");
    expect(decision?.payload).toMatchObject({ decision: "deny", reason: "Not that file." });
  });

  it("refuses a participant who does not hold the baton, server-side", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    const contributor = await addParticipant(lane.missionId, "approval-contributor");

    const refused = await respond(contributor, approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe("Only the controller can do that.");
    expect((await approvalRow(approvalId)).state).toBe("pending");
    // Nothing was enqueued toward the machine either.
    expect((await commandsFor(lane.credential)).some((c) => c.kind === "respond_approval")).toBe(false);
  });

  it("refuses a Mission Admin who is not the controller — the baton is the gate", async () => {
    const lane = await createLane();
    // A second Mission Admin, so the refusal cannot be explained by a weak role.
    const admin = await addParticipant(lane.missionId, "approval-admin", "mission_admin");
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    const refused = await respond(admin, approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect((await approvalRow(approvalId)).state).toBe("pending");

    // The admin's own capability list agrees, which is what the interface renders
    // from — and the list is computed from the same place the refusal was.
    const room = await detail(admin, lane.missionId);
    expect(room.capabilities).not.toContain("approval.respond");
    expect((await detail(owner, lane.missionId)).capabilities).toContain("approval.respond");
  });

  it("tells a non-participant the approval does not exist", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    const stranger = await harness.signIn("approval-stranger");
    const refused = await respond(stranger, approvalId, "approve");
    // Never 403: an approval id must not be a way to confirm a mission exists.
    expect(refused.statusCode).toBe(404);
    expect((await approvalRow(approvalId)).state).toBe("pending");
  });
});

describe("a lent account's question is its owner's alone (D-217)", () => {
  it("lets the lending owner answer without the baton, and refuses everyone else", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    // The turn carried the owner's own Gmail; the question is for its tool.
    await reportRunningWithConnectors(lane, executionId, ["claude.ai Gmail"]);
    const approvalId = await askApproval(lane, executionId, {
      toolName: "mcp__claude_ai_Gmail__send_email",
      summary: "send a message to the team"
    });

    // Hand the baton to an operator: the owner (the lender) no longer holds
    // it. For an ordinary tool that would end their right to answer.
    const maya = await addParticipant(lane.missionId, "lend-maya", "operator");
    await handControlTo(lane, maya, executionId);
    expect((await detail(maya, lane.missionId)).control.holderUserId).toBe(maya.userId);

    // The baton holder is refused — it is not their account to spend — with
    // the lender named.
    const refused = await respond(maya, approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("lender_only");
    expect(refused.json().error.message).toContain(owner.login);
    expect((await approvalRow(approvalId)).state).toBe("pending");

    // The lender answers though they hold no baton at all.
    const allowed = await respond(owner, approvalId, "approve");
    expect(allowed.statusCode).toBe(200);
    const row = await approvalRow(approvalId);
    expect(row.state).toBe("approved");
    expect(row.responded_by).toBe(owner.userId);
    // The account-owner's answer still becomes a runner command.
    expect((await commandsFor(lane.credential)).some((c) => c.kind === "respond_approval")).toBe(true);
  });

  it("leaves an ordinary tool's question to the baton exactly as before, even on a turn that lent an account", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await reportRunningWithConnectors(lane, executionId, ["claude.ai Gmail"]);
    // A Write is not the lent account's tool, so the ordinary baton rule holds.
    const approvalId = await askApproval(lane, executionId, { toolName: "Write" });
    const contributor = await addParticipant(lane.missionId, "lend-contributor");
    const refused = await respond(contributor, approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe("Only the controller can do that.");
    // The controller (owner) answers it, baton rule intact.
    expect((await respond(owner, approvalId, "approve")).statusCode).toBe(200);
  });
});

describe("control moving while a question is open", () => {
  it("keeps the request pending, and swaps who may answer it", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    const maya = await addParticipant(lane.missionId, "approval-maya", "operator");

    await handControlTo(lane, maya, executionId);
    expect((await detail(maya, lane.missionId)).control.holderUserId).toBe(maya.userId);

    // The question survives the handoff untouched: it is about the harness, not
    // about who happened to be watching when it was asked.
    expect((await approvalRow(approvalId)).state).toBe("pending");

    // The previous controller may not answer any more, from this moment on.
    const refused = await respond(owner, approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect((await approvalRow(approvalId)).state).toBe("pending");

    // The new one may.
    const allowed = await respond(maya, approvalId, "approve");
    expect(allowed.statusCode).toBe(200);
    const row = await approvalRow(approvalId);
    expect(row.state).toBe("approved");
    expect(row.responded_by).toBe(maya.userId);
  });
});

describe("settling exactly once", () => {
  it("makes a duplicate answer a no-op with one command enqueued", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    expect((await respond(owner, approvalId, "approve")).statusCode).toBe(200);
    const second = await respond(owner, approvalId, "deny", "actually no");
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("already_settled");

    const row = await approvalRow(approvalId);
    expect(row.state).toBe("approved");
    expect(row.resolution).not.toBe("actually no");

    const decisions = (await commandsFor(lane.credential)).filter((c) => c.kind === "respond_approval");
    expect(decisions).toHaveLength(1);
  });

  it("records a late answer and sends nothing to a turn that is already over", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    nextSeq += 1;
    await report(lane.credential, executionId, [
      { originSeq: nextSeq, event: { kind: "execution.completed", payload: {} } }
    ]);

    // The turn took its open question with it.
    expect((await approvalRow(approvalId)).state).toBe("cancelled");
    const late = await respond(owner, approvalId, "approve");
    expect(late.statusCode).toBe(409);
    // And nothing was enqueued to restart anything.
    expect((await commandsFor(lane.credential)).some((c) => c.kind === "respond_approval")).toBe(false);
    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("completed");
  });

  it("does not resume a stopped execution when the answer lands after the stop", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    const stopped = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/execution/stop`,
      headers: bearer(owner),
      payload: {}
    });
    expect(stopped.statusCode).toBe(200);

    // A Stop settles the question in the same transaction that decides it.
    const row = await approvalRow(approvalId);
    expect(row.state).toBe("cancelled");
    expect(row.resolution).toContain("stopped the execution");

    expect((await respond(owner, approvalId, "approve")).statusCode).toBe(409);
    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("stopping");
    expect((await commandsFor(lane.credential)).some((c) => c.kind === "respond_approval")).toBe(false);
  });
});

describe("when the machine goes away", () => {
  it("expires the question rather than cancelling it, because nobody declined", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    // Backdate this runner past the recovery threshold: the machine is gone.
    await harness.db.query(
      "update runners set last_seen_at = $2, created_at = $2 where runner_id = $1",
      [lane.runnerId, new Date(Date.now() - RELIABILITY_THRESHOLDS.RECOVERY_AFTER_MS - 5_000)]
    );
    expect(await sweepRunners(harness.db)).toBeGreaterThan(0);

    const row = await approvalRow(approvalId);
    // `expired`, not `cancelled`: no answer could ever have been delivered, and
    // the record should not read as though somebody declined to give one.
    expect(row.state).toBe("expired");
    expect(row.responded_by).toBeNull();
    expect(row.resolution).toContain("stopped responding");
    expect((await respond(owner, approvalId, "approve")).statusCode).toBe(409);
  });
});

describe("what survives a restart", () => {
  it("reconstructs a pending question for a fresh control plane", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);

    // A second server over the same database: nothing about a pending approval
    // lives in the process that recorded it.
    const restarted = buildServer(harness.db, harness.config);
    await restarted.ready();
    try {
      const room = await restarted.inject({
        method: "GET",
        url: `/missions/${lane.missionId}`,
        headers: bearer(owner)
      });
      expect(room.statusCode).toBe(200);
      expect(room.json().state).toBe("needs_approval");
      expect(room.json().approvals[0]).toMatchObject({ approvalId, state: "pending" });

      const answered = await restarted.inject({
        method: "POST",
        url: `/approvals/${approvalId}/respond`,
        headers: bearer(owner),
        payload: { decision: "approve" }
      });
      expect(answered.statusCode).toBe(200);
    } finally {
      await restarted.close();
    }
    expect((await approvalRow(approvalId)).state).toBe("approved");
  });

  it("re-offers the decision to a runner that restarted before it acknowledged", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    expect((await respond(owner, approvalId, "approve")).statusCode).toBe(200);

    // First poll delivers it; the runner then dies without acknowledging.
    const first = (await commandsFor(lane.credential)).filter((c) => c.kind === "respond_approval");
    expect(first).toHaveLength(1);
    // A restarted runner polls again and is offered the same command, once.
    const second = (await commandsFor(lane.credential)).filter((c) => c.kind === "respond_approval");
    expect(second).toHaveLength(1);
    expect(second[0]?.commandId).toBe(first[0]?.commandId);

    await harness.app.inject({
      method: "POST",
      url: `/runner/commands/${second[0]?.commandId}`,
      headers: runnerAuth(lane.credential),
      payload: { state: "completed" }
    });
    expect((await commandsFor(lane.credential)).some((c) => c.kind === "respond_approval")).toBe(false);
  });

  it("settles the harness's own cancellation without contradicting a decision", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const requestId = `harness-cancels-${randomUUID()}`;
    const approvalId = await askApproval(lane, executionId, { requestId });

    // The runner reports that the harness stopped waiting — an interrupt took
    // the question with it.
    nextSeq += 1;
    await report(lane.credential, executionId, [
      {
        originSeq: nextSeq,
        event: {
          kind: "approval.cancelled",
          payload: { requestId, reason: "The turn ended before this was answered." }
        }
      }
    ]);
    expect((await approvalRow(approvalId)).state).toBe("cancelled");
    // The execution is working again rather than stuck saying it needs approval.
    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("running");

    // A cancellation never overwrites a decision that was already recorded.
    const second = await askApproval(lane, executionId, { requestId: `second-${randomUUID()}` });
    expect((await respond(owner, second, "deny", "no")).statusCode).toBe(200);
    nextSeq += 1;
    await report(lane.credential, executionId, [
      {
        originSeq: nextSeq,
        event: {
          kind: "approval.cancelled",
          payload: {
            requestId: (await approvalRow(second)).harness_request_id as string,
            reason: "too late"
          }
        }
      }
    ]);
    expect((await approvalRow(second)).state).toBe("denied");
  });
});
