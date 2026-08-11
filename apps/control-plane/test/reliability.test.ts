import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";
import { RELIABILITY_THRESHOLDS, sweepLeases, sweepOnce, sweepRunners } from "../src/reliability.ts";

/**
 * The two absences: a host that stops answering, and a controller who does.
 *
 * Nothing here waits on real time. Liveness is pushed into the past with SQL
 * and the sweep is called directly, so these tests state the rule rather than
 * the clock.
 */

let harness: Harness;
let owner: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const agesAgo = (ms: number) => new Date(Date.now() - ms - 5_000).toISOString();

beforeAll(async () => {
  harness = await createHarness("novus_test_reliability");
  owner = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** A second participant, through the only path there is: an invitation. */
async function joinAs(missionId: string, who: string): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(owner),
    payload: { role: "contributor" }
  });
  await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token: created.json().token }
  });
  return joiner;
}

/** A local mission with this machine enrolled, and optionally a live turn. */
async function lane(): Promise<{
  missionId: string;
  workstreamId: string;
  runnerId: string;
  credential: string;
}> {
  const localId = randomUUID();
  const headSha = sha(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(owner),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(owner),
    payload: {
      goal: "Keep the room honest when a machine disappears",
      successCriteria: "No execution is left claiming to run",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  const workstreamId = body.workstream.workstreamId as string;
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(owner),
    payload: { workstreamId, label: "test-machine" }
  });
  expect(enrolled.statusCode).toBe(200);
  return {
    missionId: body.mission.missionId as string,
    workstreamId,
    runnerId: enrolled.json().runnerId as string,
    credential: enrolled.json().credential as string
  };
}

/** Starts a turn by submitting direction the controller authored. */
async function startExecution(missionId: string): Promise<string> {
  const submitted = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/direction`,
    headers: bearer(owner),
    payload: { body: "Harden the session guard", model: "claude-fable-5", effort: "high" }
  });
  expect(submitted.statusCode).toBe(200);
  const row = await harness.db.query(
    "select exe_id from executions where mission_id = $1 order by created_at desc limit 1",
    [missionId]
  );
  return row.rows[0].exe_id as string;
}

const stateOf = async (executionId: string) =>
  (
    await harness.db.query("select state, failure_reason from executions where exe_id = $1", [
      executionId
    ])
  ).rows[0] as { state: string; failure_reason: string | null };

const silence = (runnerId: string, ms: number) =>
  harness.db.query("update runners set last_seen_at = $2 where runner_id = $1", [
    runnerId,
    agesAgo(ms)
  ]);

describe("the runner heartbeat watchdog", () => {
  it("interrupts an execution whose machine stopped answering, and says so", async () => {
    const { missionId, workstreamId, runnerId } = await lane();
    const executionId = await startExecution(missionId);
    await silence(runnerId, RELIABILITY_THRESHOLDS.RECOVERY_AFTER_MS);

    expect(await sweepRunners(harness.db)).toBeGreaterThanOrEqual(1);

    const after = await stateOf(executionId);
    expect(after.state).toBe("interrupted");
    expect(after.failure_reason).toMatch(/stopped responding/i);

    const events = await harness.db.query(
      "select kind, actor_kind, payload from events where mission_id = $1 and kind = 'execution.interrupted'",
      [missionId]
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].actor_kind).toBe("system");
    expect(events.rows[0].payload.detectedBy).toBe("runner heartbeat watchdog");
    expect(workstreamId).toBeTruthy();
  });

  it("leaves a fresh runner's execution entirely alone", async () => {
    const { missionId } = await lane();
    const executionId = await startExecution(missionId);
    // The runner reported a moment ago, which enrolment already recorded.
    expect(await sweepRunners(harness.db)).toBe(0);
    expect((await stateOf(executionId)).state).toBe("requested");
  });

  it("cannot be resurrected by a runner that comes back", async () => {
    const { missionId, runnerId } = await lane();
    const executionId = await startExecution(missionId);
    await silence(runnerId, RELIABILITY_THRESHOLDS.RECOVERY_AFTER_MS);
    await sweepRunners(harness.db);
    expect((await stateOf(executionId)).state).toBe("interrupted");

    // The machine wakes up and reports it is still working. Resume-or-restart
    // is a human choice made in a *new* execution, never a rewrite of a
    // settled one (PRODUCT.md#the-mission-state-model).
    await harness.db.query("update runners set last_seen_at = now() where runner_id = $1", [runnerId]);
    await sweepRunners(harness.db);
    expect((await stateOf(executionId)).state).toBe("interrupted");
  });

  it("is idempotent: a second sweep writes nothing and records nothing", async () => {
    const { missionId, runnerId } = await lane();
    await startExecution(missionId);
    await silence(runnerId, RELIABILITY_THRESHOLDS.RECOVERY_AFTER_MS);
    await sweepRunners(harness.db);
    const before = await harness.db.query("select count(*)::int as n from events where mission_id = $1", [
      missionId
    ]);
    expect(await sweepRunners(harness.db)).toBe(0);
    const after = await harness.db.query("select count(*)::int as n from events where mission_id = $1", [
      missionId
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("control lease expiry", () => {
  const ageLease = (workstreamId: string, ms: number) =>
    harness.db.query(
      "update control_leases set last_heartbeat_at = $2 where wst_id = $1 and state = 'held'",
      [workstreamId, agesAgo(ms)]
    );

  it("leaves the workstream with no controller, and records who lost it", async () => {
    const { missionId, workstreamId } = await lane();
    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);

    expect(await sweepLeases(harness.db)).toBeGreaterThanOrEqual(1);

    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(owner)
    });
    expect(detail.json().control.holderLogin).toBeNull();

    const events = await harness.db.query(
      "select payload from events where mission_id = $1 and kind = 'control.expired'",
      [missionId]
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].payload.holderLogin).toBe("kartik");
  });

  it("does not touch work the departed controller already authorized", async () => {
    const { missionId, workstreamId } = await lane();
    const executionId = await startExecution(missionId);
    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);

    await sweepLeases(harness.db);

    // Authority lapsing is not a stop signal (D-034). The execution is
    // untouched; what the holder lost is the right to issue new commands.
    expect((await stateOf(executionId)).state).toBe("requested");
  });

  it("makes the workstream claimable, and two claims resolve to one winner", async () => {
    const { missionId, workstreamId } = await lane();
    const maya = await harness.signIn("maya-claim");
    const invited = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/invitations`,
      headers: bearer(owner),
      payload: { role: "operator" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invited.json().token }
    });

    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);
    await sweepLeases(harness.db);

    const claim = () =>
      harness.app.inject({
        method: "POST",
        url: `/missions/${missionId}/control/request`,
        headers: bearer(maya)
      });
    const [first, second] = await Promise.all([claim(), claim()]);
    // One claim takes the baton; the other cannot also take it. Whichever way
    // the race falls, exactly one lease is current and it is hers.
    expect([first.statusCode, second.statusCode].filter((code) => code === 200).length).toBeGreaterThanOrEqual(1);

    const held = await harness.db.query(
      "select count(*)::int as n from control_leases where wst_id = $1 and state in ('held','releasing')",
      [workstreamId]
    );
    expect(held.rows[0].n).toBe(1);

    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(maya)
    });
    expect(detail.json().control.holderLogin).toBe("maya-claim");
  });

  it("fails a handoff that was in flight rather than landing it on a dead lease", async () => {
    const { missionId, workstreamId } = await lane();
    const maya = await harness.signIn("maya-handoff");
    const invited = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/invitations`,
      headers: bearer(owner),
      payload: { role: "operator" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invited.json().token }
    });
    const offered = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/control/offer`,
      headers: bearer(owner),
      payload: { toUserId: maya.userId }
    });
    expect(offered.statusCode).toBe(200);

    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);
    await sweepLeases(harness.db);

    const offer = await harness.db.query("select state from handoff_offers where wst_id = $1", [
      workstreamId
    ]);
    expect(offer.rows[0].state).toBe("failed");
  });

  it("leaves a lease whose holder is still working exactly where it is", async () => {
    const { missionId, workstreamId } = await lane();
    expect(workstreamId).toBeTruthy();
    await sweepOnce(harness.db);
    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(owner)
    });
    expect(detail.json().control.holderLogin).toBe("kartik");
  });
});

describe("a lease the holder is still watching", () => {
  it("keeps it, because reading the room is the heartbeat", async () => {
    const held = await lane();

    // Backdate the heartbeat past the TTL, the way two hours at a desk would.
    await harness.db.query(
      "update control_leases set last_heartbeat_at = now() - interval '90 minutes' where wst_id = $1",
      [held.workstreamId]
    );

    // The room polls this endpoint while it is open. That is the heartbeat —
    // the verb existed from the day the sweep did and had no caller, so every
    // lease expired thirty minutes after it was created however present its
    // holder was, and every direction after that queued behind a controller who
    // no longer existed (D-051).
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${held.missionId}`,
      headers: bearer(owner)
    });
    expect(read.statusCode).toBe(200);

    expect(await sweepLeases(harness.db)).toBe(0);
    const after = await harness.db.query("select state from control_leases where wst_id = $1", [
      held.workstreamId
    ]);
    expect(after.rows[0].state).toBe("held");
  });

  it("does not keep it for somebody who merely has the mission open", async () => {
    const held = await lane();
    const maya = await joinAs(held.missionId, "maya");
    await harness.db.query(
      "update control_leases set last_heartbeat_at = now() - interval '90 minutes' where wst_id = $1",
      [held.workstreamId]
    );

    // Watching is not holding: a reader who is not the controller must not keep
    // somebody else's lease alive, or the TTL would never expire in any room
    // with two people in it.
    const read = await harness.app.inject({
      method: "GET",
      url: `/missions/${held.missionId}`,
      headers: bearer(maya)
    });
    expect(read.statusCode).toBe(200);
    expect(await sweepLeases(harness.db)).toBe(1);
  });
});

/**
 * The case D-062 left open and PROGRESS.md has carried as a known gap since:
 * the harness is blocked on a person, and that person's authority lapses.
 *
 * Nothing here may kill the harness. Expiry removes authority, not work
 * (D-034), so the question has to survive its asker's controller and be
 * answerable by whoever picks the baton up.
 */
describe("a question outliving the person who could answer it", () => {
  const ageLease = (workstreamId: string, ms: number) =>
    harness.db.query(
      "update control_leases set last_heartbeat_at = $2 where wst_id = $1 and state = 'held'",
      [workstreamId, agesAgo(ms)]
    );

  /** Puts the harness in *Needs approval*, the way the runner does. */
  async function askForPermission(credential: string, executionId: string): Promise<string> {
    const reported = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: { authorization: `Runner ${credential}` },
      payload: {
        executionId,
        events: [
          {
            originSeq: 1,
            event: {
              kind: "approval.requested",
              payload: {
                requestId: "harness-request-1",
                toolUseId: "toolu_1",
                toolName: "Write",
                displayName: "Write",
                summary: "AUTH.md"
              }
            }
          }
        ]
      }
    });
    expect(reported.statusCode).toBe(200);
    const row = await harness.db.query(
      "select apr_id from approval_requests where exe_id = $1 and state = 'pending'",
      [executionId]
    );
    expect(row.rowCount).toBe(1);
    return row.rows[0].apr_id as string;
  }

  it("keeps the question, kills nothing, and says a question was waiting", async () => {
    const { missionId, workstreamId, credential } = await lane();
    const executionId = await startExecution(missionId);
    const approvalId = await askForPermission(credential, executionId);

    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);
    expect(await sweepLeases(harness.db)).toBeGreaterThanOrEqual(1);

    // The three things that must not have happened.
    const approval = await harness.db.query("select state from approval_requests where apr_id = $1", [
      approvalId
    ]);
    expect(approval.rows[0].state).toBe("pending");
    expect((await stateOf(executionId)).state).toBe("needs_approval");
    const commands = await harness.db.query(
      "select kind from runner_commands where wst_id = $1 and kind = 'stop_execution'",
      [workstreamId]
    );
    expect(commands.rowCount).toBe(0);

    // And the one that must: the record explains why the room now needs
    // somebody, rather than leaving a bare "the lease expired".
    const expired = await harness.db.query(
      "select payload from events where mission_id = $1 and kind = 'control.expired'",
      [missionId]
    );
    expect(expired.rows[0].payload.approvalWaiting).toBe(true);
  });

  it("lets whoever claims the baton answer it, once, with their name on it", async () => {
    const { missionId, workstreamId, credential } = await lane();
    const executionId = await startExecution(missionId);
    const approvalId = await askForPermission(credential, executionId);
    const maya = await joinAs(missionId, "maya-answers");

    // Before the baton, the server refuses her — a question is not a capability.
    const early = await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(maya),
      payload: { decision: "approve" }
    });
    expect(early.statusCode).toBe(403);

    await ageLease(workstreamId, RELIABILITY_THRESHOLDS.LEASE_TTL_MS);
    await sweepLeases(harness.db);

    // A request against an unheld lease is a claim, and the server fulfils it.
    const claimed = await harness.app.inject({
      method: "POST",
      url: `/missions/${missionId}/control/request`,
      headers: bearer(maya)
    });
    expect(claimed.statusCode).toBe(200);

    const answered = await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(maya),
      payload: { decision: "approve" }
    });
    expect(answered.statusCode).toBe(200);

    const settled = await harness.db.query(
      `select a.state, u.login from approval_requests a
         join users u on u.user_id = a.responded_by where a.apr_id = $1`,
      [approvalId]
    );
    expect(settled.rows[0].state).toBe("approved");
    expect(settled.rows[0].login).toBe("maya-answers");

    // Answered once: the decision reached the machine as exactly one command.
    const carried = await harness.db.query(
      "select count(*)::int as n from runner_commands where wst_id = $1 and kind = 'respond_approval'",
      [workstreamId]
    );
    expect(carried.rows[0].n).toBe(1);

    // And the previous holder cannot answer it back: authority is read now.
    const late = await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(owner),
      payload: { decision: "deny" }
    });
    expect(late.statusCode).toBe(403);
  });
});

/**
 * *Execution stalled* (PRODUCT.md): the overlay that exists so a wedged turn is
 * a sentence rather than a mystery. It never stops anything — D-034 forbids a
 * Novus-imposed ceiling — and it is deliberately not entered for a harness that
 * is waiting on a person.
 */
describe("an execution that has gone quiet", () => {
  const backdateEvents = (executionId: string, ms: number) =>
    harness.db.query("update events set occurred_at = $2 where execution_id = $1", [
      executionId,
      agesAgo(ms)
    ]);

  const overlaysOf = async (missionId: string, who = owner): Promise<string[]> => {
    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(who)
    });
    expect(detail.statusCode).toBe(200);
    return detail.json().overlays as string[];
  };

  async function running(credential: string, executionId: string): Promise<void> {
    const reported = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: { authorization: `Runner ${credential}` },
      payload: {
        executionId,
        events: [
          {
            originSeq: 1,
            event: {
              kind: "execution.running",
              payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
            }
          }
        ]
      }
    });
    expect(reported.statusCode).toBe(200);
  }

  it("says nothing while the turn is reporting", async () => {
    const { missionId, credential } = await lane();
    const executionId = await startExecution(missionId);
    await running(credential, executionId);
    expect(await overlaysOf(missionId)).not.toContain("execution_stalled");
  });

  it("says so once nothing has been reported for long enough", async () => {
    const { missionId, credential } = await lane();
    const executionId = await startExecution(missionId);
    await running(credential, executionId);
    await backdateEvents(executionId, 11 * 60_000);

    expect(await overlaysOf(missionId)).toContain("execution_stalled");
    // Visible, and nothing else: the turn is still running and still the
    // workstream's active execution.
    expect((await stateOf(executionId)).state).toBe("running");
  });

  it("a heartbeat is liveness, never progress — the stall watch does not reset on a pulse (D-114)", async () => {
    const { missionId, credential } = await lane();
    const executionId = await startExecution(missionId);
    await running(credential, executionId);
    await backdateEvents(executionId, 11 * 60_000);
    // The process is alive and says so — but has reported no work. A pulse
    // that reset the clock would let a wedged-but-breathing turn dodge the
    // stall watch forever.
    await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: { authorization: `Runner ${credential}` },
      payload: {
        executionId,
        events: [{ originSeq: 9, event: { kind: "execution.heartbeat", payload: {} } }]
      }
    });

    expect(await overlaysOf(missionId)).toContain("execution_stalled");
  });

  it("never calls a harness waiting on a person stalled", async () => {
    const { missionId, workstreamId, credential } = await lane();
    const executionId = await startExecution(missionId);
    await running(credential, executionId);
    await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: { authorization: `Runner ${credential}` },
      payload: {
        executionId,
        events: [
          {
            originSeq: 2,
            event: {
              kind: "approval.requested",
              payload: {
                requestId: "harness-request-2",
                toolUseId: null,
                toolName: "Bash",
                displayName: "Bash",
                summary: "rm -rf build"
              }
            }
          }
        ]
      }
    });
    await backdateEvents(executionId, 30 * 60_000);

    // Waiting for a human is not a fault, however long it lasts. The room
    // already says *Needs approval*, which is the true and useful sentence.
    expect(await overlaysOf(missionId)).not.toContain("execution_stalled");
    expect(workstreamId).toBeTruthy();
  });
});

describe("the stranded-queue sweep (D-112)", () => {
  /** Reports events as the enrolled runner, the way the desktop does. */
  const report = (credential: string, executionId: string, events: unknown[]) =>
    harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: { authorization: `Runner ${credential}` },
      payload: { executionId, events }
    });

  it("re-drives a queue whose completed-turn dispatch was lost", async () => {
    const fixture = await lane();
    const first = await startExecution(fixture.missionId);
    // The controller queues a follow-up behind the running turn.
    const queued = await harness.app.inject({
      method: "POST",
      url: `/missions/${fixture.missionId}/direction`,
      headers: bearer(owner),
      payload: { body: "And then write the tests", model: "claude-fable-5", effort: "high", newSession: true }
    });
    expect(queued.json().dispatched).toBe(false);

    // The turn completes — and the dispatch that should have followed is
    // simulated lost by clearing the command it would have produced. The
    // ingest's own dispatch fires here; deleting its command and execution
    // reproduces the crash-in-the-window case the sweep exists for.
    await report(fixture.credential, first, [
      { originSeq: 1, event: { kind: "execution.starting", payload: {} } },
      {
        originSeq: 2,
        event: {
          kind: "execution.running",
          payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
        }
      },
      { originSeq: 3, event: { kind: "execution.completed", payload: {} } }
    ]);
    await harness.db.query(
      `delete from runner_commands where wst_id = $1 and exe_id is not null and exe_id <> $2`,
      [fixture.workstreamId, first]
    );
    await harness.db.query(
      `delete from executions where wst_id = $1 and exe_id <> $2`,
      [fixture.workstreamId, first]
    );

    const swept = await sweepOnce(harness.db);
    expect(swept.queuesDriven).toBe(1);

    // The queued direction now has a real execution and a real command.
    const revived = await harness.db.query(
      `select count(*)::int as live from executions where wst_id = $1 and state = 'requested'`,
      [fixture.workstreamId]
    );
    expect(revived.rows[0].live).toBe(1);

    // And the sweep is settled: a second pass finds nothing to drive.
    const again = await sweepOnce(harness.db);
    expect(again.queuesDriven).toBe(0);
  });

  it("never re-drives a queue behind a stop, failure, or interruption — D-083's rule stands", async () => {
    const fixture = await lane();
    const first = await startExecution(fixture.missionId);
    const queued = await harness.app.inject({
      method: "POST",
      url: `/missions/${fixture.missionId}/direction`,
      headers: bearer(owner),
      payload: { body: "And then write the tests", model: "claude-fable-5", effort: "high", newSession: true }
    });
    expect(queued.json().dispatched).toBe(false);

    await report(fixture.credential, first, [
      { originSeq: 1, event: { kind: "execution.starting", payload: {} } },
      {
        originSeq: 2,
        event: {
          kind: "execution.failed",
          payload: { classification: "harness_error", reason: "The harness reported an error." }
        }
      }
    ]);

    const swept = await sweepOnce(harness.db);
    expect(swept.queuesDriven).toBe(0);
    const still = await harness.db.query(
      `select state from directions where wst_id = $1 order by ordinal desc limit 1`,
      [fixture.workstreamId]
    );
    expect(still.rows[0].state).toBe("queued");
  });
});
