import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * A chat runs alongside the workspace's turn, read-only (D-095).
 *
 * The rule under test, end to end at the control plane: writes stay exclusive
 * — one live write execution per lane, because one worktree has one git index
 * and checkpoint capture must never commit one chat's half-done edits as
 * another's evidence — while a read turn starts immediately, blocks nothing,
 * frees nothing, and can never move the baton. The runner-side halves (the
 * denied permission requests, the skipped checkpoint) are proven in the
 * desktop suites; what this file pins is dispatch, state, stop, and boundary
 * authority.
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
  harness = await createHarness("novus_test_alongside", new FakeRepositoryProvider());
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
      goal: "Answer questions while the work continues",
      successCriteria: "The review chat is never a queue",
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

async function direct(
  lane: Lane,
  body: string,
  options: { as?: SignedIn; sessionId?: string; newSession?: boolean; alongside?: boolean } = {}
) {
  const response = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(options.as ?? kartik),
    payload: {
      body,
      model: "claude-fable-5",
      effort: "high",
      workstreamId: lane.workstreamId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.newSession ? { newSession: true } : {}),
      ...(options.alongside ? { alongside: true } : {})
    }
  });
  return response;
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

interface ExecutionRow {
  exe_id: string;
  session_id: string;
  state: string;
  access: string;
}

async function executionsOf(lane: Lane): Promise<ExecutionRow[]> {
  const rows = await harness.db.query(
    "select exe_id, session_id, state, access from executions where wst_id = $1 order by created_at",
    [lane.workstreamId]
  );
  return rows.rows as ExecutionRow[];
}

/** A lane whose first chat's write turn is live and reporting. */
async function laneWithRunningTurn(): Promise<{ lane: Lane; writeExecution: string; writeSession: string }> {
  const lane = await mission();
  const submitted = await direct(lane, "Harden the session guard");
  expect(submitted.statusCode).toBe(200);
  const [write] = await executionsOf(lane);
  expect(write).toBeDefined();
  await report(lane.credential, write!.exe_id, live(1));
  return { lane, writeExecution: write!.exe_id, writeSession: write!.session_id };
}

async function missionState(lane: Lane): Promise<string> {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}`,
    headers: bearer(kartik)
  });
  expect(response.statusCode).toBe(200);
  return response.json().state as string;
}

describe("a chat runs alongside, read-only", () => {
  it("the controller's alongside direction starts a read turn immediately, beside the write turn", async () => {
    const { lane, writeExecution } = await laneWithRunningTurn();

    const review = await direct(lane, "Explain the guard's design", {
      newSession: true,
      alongside: true
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().dispatched).toBe(true);
    expect(review.json().deferred).toBeNull();

    const executions = await executionsOf(lane);
    expect(executions).toHaveLength(2);
    const read = executions.find((execution) => execution.exe_id !== writeExecution);
    expect(read?.access).toBe("read");
    expect(read?.state).toBe("requested");
    // Both live at once — the exact thing the old lane-wide index forbade.
    expect(executions.filter((execution) => execution.state !== "completed")).toHaveLength(2);
    // And the write turn is untouched.
    expect(executions.find((execution) => execution.exe_id === writeExecution)?.state).toBe("running");
  });

  it("refuses alongside to anyone without the baton, in words", async () => {
    const { lane } = await laneWithRunningTurn();
    const maya = await harness.signIn("maya-alongside");
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "contributor" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invitation.json().token }
    });

    const refused = await direct(lane, "Explain this to me", {
      as: maya,
      newSession: true,
      alongside: true
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("not_controller");
    // Nothing was created for it: the refusal happened before the words landed.
    const executions = await executionsOf(lane);
    expect(executions).toHaveLength(1);
  });

  it("one turn per conversation: alongside into a busy chat defers in words", async () => {
    const { lane } = await laneWithRunningTurn();
    const review = await direct(lane, "Explain the guard's design", {
      newSession: true,
      alongside: true
    });
    const reviewSession = review.json().direction.sessionId as string;

    const second = await direct(lane, "And explain the tests too", {
      sessionId: reviewSession,
      alongside: true
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().dispatched).toBe(false);
    expect(second.json().deferred).toContain("already answering");
  });

  it("a read turn neither blocks a new write turn nor is the lane's state", async () => {
    const { lane, writeExecution, writeSession } = await laneWithRunningTurn();
    // The write turn finishes; only the read turn stays live.
    await report(lane.credential, writeExecution, [completed(3)]);
    const review = await direct(lane, "Walk me through the diff", {
      newSession: true,
      alongside: true
    });
    expect(review.json().dispatched).toBe(true);
    const reviewExecution = (await executionsOf(lane)).find(
      (execution) => execution.access === "read"
    );
    await report(lane.credential, reviewExecution!.exe_id, live(1));

    // The workspace is free and its state says so, read turn or no read
    // turn: this fixture's idle word (no workspace was ever configured and no
    // checkpoint reported) — and above all not "agent_running", which is what
    // an access-blind projection would say with a read turn live.
    expect(await missionState(lane)).toBe("workspace_needs_setup");

    // And a fresh direction takes the workspace immediately — the read turn
    // holds nothing.
    const next = await direct(lane, "Now tighten the naming", { sessionId: writeSession });
    expect(next.statusCode).toBe(200);
    expect(next.json().dispatched).toBe(true);
    const executions = await executionsOf(lane);
    expect(
      executions.filter(
        (execution) => execution.access === "write" && execution.state !== "completed"
      )
    ).toHaveLength(1);
  });

  it("stop names the conversation: the read turn ends, the write turn keeps working", async () => {
    const { lane, writeExecution } = await laneWithRunningTurn();
    const review = await direct(lane, "Explain the guard's design", {
      newSession: true,
      alongside: true
    });
    const reviewSession = review.json().direction.sessionId as string;
    const readExecution = (await executionsOf(lane)).find((execution) => execution.access === "read");
    await report(lane.credential, readExecution!.exe_id, live(1));

    const stopped = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/execution/stop`,
      headers: bearer(kartik),
      payload: { workstreamId: lane.workstreamId, sessionId: reviewSession }
    });
    expect(stopped.statusCode).toBe(200);

    const executions = await executionsOf(lane);
    const read = executions.find((execution) => execution.exe_id === readExecution!.exe_id);
    // No runner is polling in this harness, so the stop settles it as
    // interrupted rather than waiting on a machine that is not there —
    // either way, ended. The write turn is untouched.
    expect(["stopping", "interrupted"]).toContain(read?.state);
    expect(executions.find((execution) => execution.exe_id === writeExecution)?.state).toBe("running");
  });

  it("a read turn's boundary moves no baton: the handoff waits for the write turn", async () => {
    const { lane, writeExecution } = await laneWithRunningTurn();
    const maya = await harness.signIn("maya-boundary");
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "contributor" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invitation.json().token }
    });
    const mayaId = (
      await harness.db.query("select user_id from users where login = $1", ["maya-boundary"])
    ).rows[0].user_id as string;

    // The offer is accepted while the write turn runs, so the transfer waits
    // for a safe boundary (PRODUCT.md#control).
    await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/offer`,
      headers: bearer(kartik),
      payload: { toUserId: mayaId }
    });
    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(maya)
    });
    const offerId = detail.json().control.liveOffer.offerId as string;
    const accepted = await harness.app.inject({
      method: "POST",
      url: `/control/offers/${offerId}/accept`,
      headers: bearer(maya)
    });
    expect(accepted.statusCode).toBe(200);

    // A read turn starts, runs, and completes — reporting the boundary a
    // runner from before D-095 might have sent. The baton must not move: the
    // write turn is still mid-flight.
    const review = await direct(lane, "Summarize what changed so far", {
      newSession: true,
      alongside: true
    });
    expect(review.json().dispatched).toBe(true);
    const readExecution = (await executionsOf(lane)).find((execution) => execution.access === "read");
    await report(lane.credential, readExecution!.exe_id, [
      ...live(1),
      { originSeq: 3, event: { kind: "boundary.reached", payload: { reason: "turn complete" } } },
      completed(4)
    ]);

    const after = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(after.json().control.holderLogin).toBe("kartik");
    expect(after.json().control.state).toBe("releasing");

    // The write turn's own boundary is still the one that moves it.
    await report(lane.credential, writeExecution, [
      { originSeq: 3, event: { kind: "boundary.reached", payload: { reason: "turn complete" } } },
      completed(4)
    ]);
    const finished = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(finished.json().control.holderLogin).toBe("maya-boundary");
  });
});
