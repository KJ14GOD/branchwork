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

/** A local mission with this machine enrolled, and optionally a live turn. */
async function lane(): Promise<{ missionId: string; workstreamId: string; runnerId: string }> {
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
    runnerId: enrolled.json().runnerId as string
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
