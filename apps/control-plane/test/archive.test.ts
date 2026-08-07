import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Filing a mission away, and taking it back out (D-063).
 *
 * The assertions that matter are the refusals and the absences — what archival
 * must *not* do. It is not deletion, so every direction, event, check and
 * approval stays exactly where it was and the mission is still readable. It is
 * not a way to walk away from running work, so it is refused while an execution
 * is live or a question is waiting. And there is no delete verb at all, which
 * is asserted by asking for one.
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




beforeAll(async () => {
  harness = await createHarness("novus_test_archive");
  owner = await harness.signIn("archive-owner");
});

afterAll(async () => {
  await harness.close();
});

describe("filing a mission away", () => {
  const archive = (missionId: string, as: SignedIn) =>
    harness.app.inject({ method: "POST", url: `/missions/${missionId}/archive`, headers: bearer(as), payload: {} });
  const restore = (missionId: string, as: SignedIn) =>
    harness.app.inject({ method: "POST", url: `/missions/${missionId}/restore`, headers: bearer(as), payload: {} });
  const listed = async (as: SignedIn, filter?: string) => {
    const response = await harness.app.inject({
      method: "GET",
      url: filter ? `/missions?filter=${filter}` : "/missions",
      headers: bearer(as)
    });
    expect(response.statusCode).toBe(200);
    return (response.json().missions as { missionId: string }[]).map((mission) => mission.missionId);
  };

  it("takes it out of the ordinary list, keeps it in Archived, and puts it back", async () => {
    const lane = await createLane();
    expect(await listed(owner)).toContain(lane.missionId);

    expect((await archive(lane.missionId, owner)).statusCode).toBe(200);
    expect(await listed(owner)).not.toContain(lane.missionId);
    expect(await listed(owner, "archived")).toContain(lane.missionId);

    // Filed away is not hidden: reading it still works, exactly as before.
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(owner)
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().mission.archivedAt).not.toBeNull();
    expect(read.json().mission.archivedByLogin).toBe("archive-owner");

    expect((await restore(lane.missionId, owner)).statusCode).toBe(200);
    expect(await listed(owner)).toContain(lane.missionId);
    expect(await listed(owner, "archived")).not.toContain(lane.missionId);
  });

  it("destroys nothing — the whole record is still there afterwards", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const approvalId = await askApproval(lane, executionId);
    await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(owner),
      payload: { decision: "deny" }
    });
    await report(lane.credential, executionId, [
      { originSeq: 900, event: { kind: "execution.completed", payload: {} } }
    ]);

    const before = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(owner)
    });
    const was = before.json();

    expect((await archive(lane.missionId, owner)).statusCode).toBe(200);

    const after = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(owner)
    });
    const now = after.json();
    expect(now.events.length).toBeGreaterThanOrEqual(was.events.length);
    expect(now.directions.length).toBe(was.directions.length);
    expect(now.executions.length).toBe(was.executions.length);
    expect(now.participants.length).toBe(was.participants.length);
    // The decision somebody made is part of the record, not a detail of a view.
    expect(now.approvals.length).toBe(was.approvals.length);
    expect(now.approvals[0].state).toBe("denied");
    expect(now.approvals[0].respondedByLogin).toBe("archive-owner");
  });

  it("refuses while the execution is still working, and says which thing to do", async () => {
    const lane = await createLane();
    await startExecution(lane);

    const refused = await archive(lane.missionId, owner);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("execution_active");
    expect(refused.json().error.message).toContain("Stop the execution");
    expect(await listed(owner)).toContain(lane.missionId);
  });

  it("refuses while the harness is waiting for an answer", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await askApproval(lane, executionId);

    const refused = await archive(lane.missionId, owner);
    expect(refused.statusCode).toBe(409);
    // Not "stop it" — the thing to do here is answer the question.
    expect(refused.json().error.code).toBe("approval_pending");
    expect(refused.json().error.message).toContain("Answer it");
  });

  it("files away a mission wedged by an attempt that was never given a command", async () => {
    // The shape a real session produced: a direction applied twice, where the
    // second attempt's start command collided with the first's idempotency key
    // and was swallowed. The execution sat in `requested` with nothing to run
    // it, the room said Starting for ever, and archival refused because it
    // looked like work. The key is fixed; this is about the rows it left.
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [
      {
        originSeq: 700,
        event: { kind: "execution.failed", payload: { classification: "internal", reason: "no branch" } }
      }
    ]);
    // An attempt with no command of its own, exactly as that collision left it.
    const stranded = `exe_${"stranded".padEnd(20, "0")}`;
    await harness.db.query(
      `insert into executions (exe_id, org_id, mission_id, wst_id, session_id, harness, model, effort,
                               runner_id, state, started_by)
       select $1, org_id, mission_id, wst_id, session_id, harness, model, effort, runner_id, 'requested', started_by
         from executions where exe_id = $2`,
      [stranded, executionId]
    );

    const archived = await archive(lane.missionId, owner);
    expect(archived.statusCode).toBe(200);

    // Filed away, and the dead attempt is ended honestly rather than left
    // sitting in `requested` where the room would go on saying Starting.
    const rows = await harness.db.query(
      "select state, failure_reason from executions where exe_id = $1",
      [stranded]
    );
    expect(rows.rows[0].state).toBe("interrupted");
    expect(rows.rows[0].failure_reason).toContain("Never started");
  });

  it("refuses a participant whose role does not carry it, on the server", async () => {
    const lane = await createLane();
    const contributor = await addParticipant(lane.missionId, "archive-contributor", "contributor");

    const refused = await archive(lane.missionId, contributor);
    expect(refused.statusCode).toBe(403);
    expect(await listed(owner)).toContain(lane.missionId);

    // Holding the baton does not grant it either: filing a mission away is a
    // decision about the mission, not an operating verb on its workstream.
    const asOwner = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(contributor)
    });
    expect(asOwner.json().capabilities).not.toContain("mission.archive");
  });

  it("tells a non-participant it does not exist rather than that they may not", async () => {
    const lane = await createLane();
    const outsider = await harness.signIn("archive-outsider");
    const refused = await archive(lane.missionId, outsider);
    expect(refused.statusCode).toBe(404);
  });

  it("records who filed it away, and who took it back out", async () => {
    const lane = await createLane();
    await archive(lane.missionId, owner);
    await restore(lane.missionId, owner);
    const events = await harness.db.query(
      "select kind, actor_id from events where mission_id = $1 and kind in ('mission.archived','mission.restored') order by seq",
      [lane.missionId]
    );
    expect(events.rows.map((row) => row.kind)).toEqual(["mission.archived", "mission.restored"]);
    expect(new Set(events.rows.map((row) => row.actor_id)).size).toBe(1);
  });

  it("is idempotent, and restoring one that is not archived does nothing", async () => {
    const lane = await createLane();
    expect((await archive(lane.missionId, owner)).statusCode).toBe(200);
    expect((await archive(lane.missionId, owner)).statusCode).toBe(200);
    expect((await restore(lane.missionId, owner)).statusCode).toBe(200);
    expect((await restore(lane.missionId, owner)).statusCode).toBe(200);
    const events = await harness.db.query(
      "select kind from events where mission_id = $1 and kind in ('mission.archived','mission.restored')",
      [lane.missionId]
    );
    // One of each: the second call changed nothing, so it recorded nothing.
    expect(events.rows.length).toBe(2);
  });

  it("offers no way to delete a mission at all", async () => {
    const lane = await createLane();
    for (const method of ["DELETE", "POST"] as const) {
      const attempt = await harness.app.inject({
        method,
        url: method === "DELETE" ? `/missions/${lane.missionId}` : `/missions/${lane.missionId}/delete`,
        headers: bearer(owner),
        payload: {}
      });
      expect(attempt.statusCode).toBe(404);
    }
    // And the row is still there, which is the point of the assertion above.
    const rows = await harness.db.query("select 1 from missions where mission_id = $1", [lane.missionId]);
    expect(rows.rowCount).toBe(1);
  });
});
