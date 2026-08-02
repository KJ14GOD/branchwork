import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { SequencedRunnerEvent } from "@novus/contracts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The runner plane's control-plane half (D-035), against a real PostgreSQL.
 * What these tests are for: the credential is a real boundary, not a label.
 * They cover custody of the credential, rejection of every way a runner can be
 * the wrong one, ordering and idempotency of the command transport, and the
 * de-duplication that makes a replayed report after a partition harmless.
 *
 * They are deterministic evidence for those paths and nothing more: a real
 * desktop reporting a real turn is a separate claim (AGENTS.md rule 11).
 */

let harness: Harness;
let owner: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  missionBranch: string;
  credential: string;
  runnerId: string;
}

/** A local repository, its mission, and this machine enrolled as its runner —
 *  the only configuration in which anything actually runs today. */
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
      goal: "Make the runner plane real",
      successCriteria: "Events arrive attributed and once",
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
    payload: { workstreamId, label }
  });
  expect(enrolled.statusCode).toBe(200);
  const runner = enrolled.json();

  return {
    missionId: body.mission.missionId as string,
    workstreamId,
    missionBranch: body.workstream.missionBranch as string,
    credential: runner.credential as string,
    runnerId: runner.runnerId as string
  };
}

async function direct(missionId: string, body: string) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/direction`,
    headers: bearer(owner),
    payload: { body, model: "claude-fable-5", effort: "high" }
  });
}

async function commandsFor(credential: string) {
  const response = await harness.app.inject({
    method: "GET",
    url: "/runner/commands",
    headers: runnerAuth(credential)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function report(credential: string, executionId: string, events: SequencedRunnerEvent[]) {
  return harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
}

async function eventsOf(missionId: string) {
  const rows = await harness.db.query(
    "select kind, actor_kind, actor_id, origin_seq, payload, seq from events where mission_id = $1 order by seq",
    [missionId]
  );
  return rows.rows as {
    kind: string;
    actor_kind: string;
    actor_id: string;
    origin_seq: string | null;
    payload: Record<string, unknown>;
    seq: string;
  }[];
}

/** Starts a turn the way the product does: direction from the controller,
 *  which dispatches a start command and creates the execution. */
async function startExecution(lane: Lane, body = "Add a health check"): Promise<string> {
  const response = await direct(lane.missionId, body);
  expect(response.statusCode).toBe(200);
  expect(response.json().dispatched).toBe(true);
  const { commands } = await commandsFor(lane.credential);
  const start = commands.find((command: { kind: string }) => command.kind === "start_execution");
  expect(start).toBeTruthy();
  return start.executionId as string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_runner");
  owner = await harness.signIn("runner-owner");
});

afterAll(async () => {
  await harness.close();
});

describe("runner enrolment and credential custody", () => {
  it("stores only the credential hash and hands the credential over once", async () => {
    const lane = await createLane();
    const rows = await harness.db.query("select * from runners where runner_id = $1", [lane.runnerId]);
    const row = rows.rows[0];
    expect(row.credential_hash).toBe(createHash("sha256").update(lane.credential).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(lane.credential);

    // Nor anywhere else: not in the event log, not in a command payload.
    const anywhere = await harness.db.query(
      "select count(*)::int as hits from events where payload::text like $1",
      [`%${lane.credential}%`]
    );
    expect(anywhere.rows[0].hits).toBe(0);

    const kinds = (await eventsOf(lane.missionId)).map((event) => event.kind);
    expect(kinds).toContain("runner.registered");
  });

  it("refuses enrolment to someone who is not a participant", async () => {
    const lane = await createLane();
    const stranger = await harness.signIn("stranger");
    const response = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${lane.workstreamId}/runner`,
      headers: bearer(stranger),
      payload: { workstreamId: lane.workstreamId, label: "their-machine" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a label that could carry a filesystem path", async () => {
    const lane = await createLane();
    const response = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${lane.workstreamId}/runner`,
      headers: bearer(owner),
      payload: { workstreamId: lane.workstreamId, label: "/Users/someone/code" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("invalid_label");
  });

  it("rejects an unknown, a revoked, and an expired credential the same way", async () => {
    const lane = await createLane();
    const unknown = await harness.app.inject({
      method: "GET",
      url: "/runner/commands",
      headers: runnerAuth("not-a-real-credential-value-at-all")
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe("runner_unauthenticated");

    // Re-enrolment revokes the previous machine in the same transaction.
    const again = await harness.app.inject({
      method: "POST",
      url: `/workstreams/${lane.workstreamId}/runner`,
      headers: bearer(owner),
      payload: { workstreamId: lane.workstreamId, label: "replacement" }
    });
    expect(again.statusCode).toBe(200);
    const replacement = again.json().credential as string;

    const revoked = await harness.app.inject({
      method: "GET",
      url: "/runner/commands",
      headers: runnerAuth(lane.credential)
    });
    expect(revoked.statusCode).toBe(401);
    const live = await harness.db.query(
      "select count(*)::int as live from runners where wst_id = $1 and revoked_at is null",
      [lane.workstreamId]
    );
    expect(live.rows[0].live).toBe(1);

    await harness.db.query("update runners set expires_at = now() - interval '1 day' where wst_id = $1", [
      lane.workstreamId
    ]);
    const expired = await harness.app.inject({
      method: "GET",
      url: "/runner/commands",
      headers: runnerAuth(replacement)
    });
    expect(expired.statusCode).toBe(401);
  });

  it("marks the runner seen on every authenticated call", async () => {
    const lane = await createLane();
    const before = await harness.db.query("select last_seen_at from runners where runner_id = $1", [
      lane.runnerId
    ]);
    expect(before.rows[0].last_seen_at).toBeNull();
    const beat = await harness.app.inject({
      method: "POST",
      url: "/runner/heartbeat",
      headers: runnerAuth(lane.credential)
    });
    expect(beat.statusCode).toBe(200);
    const after = await harness.db.query("select last_seen_at from runners where runner_id = $1", [
      lane.runnerId
    ]);
    expect(after.rows[0].last_seen_at).not.toBeNull();
  });
});

describe("command transport", () => {
  it("delivers a runner only its own commands, in sequence, and marks them delivered", async () => {
    const first = await createLane();
    const second = await createLane();
    await startExecution(first, "First lane work");
    await direct(first.missionId, "Then this");
    await direct(first.missionId, "And this");
    await startExecution(second, "Second lane work");

    const mine = await commandsFor(first.credential);
    expect(mine.commands.length).toBe(3);
    expect(mine.commands.map((command: { kind: string }) => command.kind)).toEqual([
      "start_execution",
      "apply_direction",
      "apply_direction"
    ]);
    const sequences = mine.commands.map((command: { seq: number }) => command.seq);
    expect([...sequences].sort((a: number, b: number) => a - b)).toEqual(sequences);
    for (const command of mine.commands) expect(command.workstreamId).toBe(first.workstreamId);

    expect(mine.workstream).toMatchObject({
      workstreamId: first.workstreamId,
      missionId: first.missionId,
      missionBranch: first.missionBranch,
      provider: "local"
    });

    const theirs = await commandsFor(second.credential);
    expect(theirs.commands.length).toBe(1);
    expect(theirs.commands[0].workstreamId).toBe(second.workstreamId);

    const delivered = await harness.db.query(
      "select count(*)::int as pending from runner_commands where wst_id = $1 and state = 'pending'",
      [first.workstreamId]
    );
    expect(delivered.rows[0].pending).toBe(0);
  });

  it("is idempotent per direction and treats a re-ack of a settled command as a no-op", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const { commands } = await commandsFor(lane.credential);
    const commandId = commands[0].commandId as string;

    const ack = await harness.app.inject({
      method: "POST",
      url: `/runner/commands/${commandId}`,
      headers: runnerAuth(lane.credential),
      payload: { state: "completed", executionId }
    });
    expect(ack.statusCode).toBe(200);

    const replay = await harness.app.inject({
      method: "POST",
      url: `/runner/commands/${commandId}`,
      headers: runnerAuth(lane.credential),
      payload: { state: "failed", failureReason: "a stale retry after relaunch" }
    });
    expect(replay.statusCode).toBe(200);
    const settled = await harness.db.query(
      "select state, failure_reason from runner_commands where cmd_id = $1",
      [commandId]
    );
    expect(settled.rows[0].state).toBe("completed");
    expect(settled.rows[0].failure_reason).toBeNull();

    // A settled command is no longer offered, so a relaunched runner does not
    // re-run work it already finished.
    const after = await commandsFor(lane.credential);
    expect(after.commands.map((command: { commandId: string }) => command.commandId)).not.toContain(commandId);
  });

  it("hides another runner's command behind a 404", async () => {
    const mine = await createLane();
    const theirs = await createLane();
    await startExecution(theirs);
    const { commands } = await commandsFor(theirs.credential);
    const response = await harness.app.inject({
      method: "POST",
      url: `/runner/commands/${commands[0].commandId}`,
      headers: runnerAuth(mine.credential),
      payload: { state: "acknowledged" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps at most one active execution under a concurrent burst", async () => {
    const lane = await createLane();
    const bodies = Array.from({ length: 8 }, (_, index) => `Concurrent direction ${index}`);
    const responses = await Promise.all(bodies.map((body) => direct(lane.missionId, body)));
    for (const response of responses) expect(response.statusCode).toBe(200);

    const executions = await harness.db.query(
      "select exe_id, state from executions where wst_id = $1",
      [lane.workstreamId]
    );
    expect(executions.rowCount).toBe(1);

    const { commands } = await commandsFor(lane.credential);
    expect(commands.filter((command: { kind: string }) => command.kind === "start_execution").length).toBe(1);
    expect(commands.length).toBe(8);
  });
});

describe("event ingestion", () => {
  it("attributes actors server-side and orders an out-of-order batch by origin sequence", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const response = await report(lane.credential, executionId, [
      { originSeq: 3, event: { kind: "harness.text", payload: { text: "third" } } },
      { originSeq: 1, event: { kind: "execution.starting", payload: {} } },
      {
        originSeq: 2,
        event: {
          kind: "execution.running",
          payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
        }
      }
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, accepted: 3, duplicates: 0 });

    const recorded = (await eventsOf(lane.missionId)).filter((event) => event.origin_seq !== null);
    expect(recorded.map((event) => Number(event.origin_seq))).toEqual([1, 2, 3]);
    expect(recorded.map((event) => event.kind)).toEqual([
      "execution.starting",
      "execution.running",
      "harness.text"
    ]);
    // Attribution is the server's choice: what the harness said is the
    // harness's; what the machine observed is the runner's.
    const text = recorded[recorded.length - 1];
    expect(text?.actor_kind).toBe("harness");
    expect(text?.actor_id).toBe("claude-code");
    expect(recorded[0]?.actor_kind).toBe("runner");
    expect(recorded[0]?.actor_id).toBe(lane.runnerId);

    const execution = await harness.db.query("select state, started_at from executions where exe_id = $1", [
      executionId
    ]);
    expect(execution.rows[0].state).toBe("running");
    expect(execution.rows[0].started_at).not.toBeNull();
  });

  it("de-duplicates a replayed batch and applies its side effects exactly once", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const batch: SequencedRunnerEvent[] = [
      {
        originSeq: 1,
        event: {
          kind: "workspace.checkpoint",
          payload: {
            outcome: "committed",
            sha: "a".repeat(40),
            parentSha: "b".repeat(40),
            branch: lane.missionBranch,
            withheldSecrets: 1,
            uncommitted: false,
            error: null,
            files: [
              {
                path: "src/health.ts",
                previousPath: null,
                changeState: "added",
                additions: 12,
                deletions: 0,
                binary: false,
                diff: "@@ -0,0 +1,12 @@\n+export const ok = true;\n",
                truncated: false
              }
            ]
          }
        }
      }
    ];

    const first = await report(lane.credential, executionId, batch);
    expect(first.json()).toEqual({ ok: true, accepted: 1, duplicates: 0 });
    const replay = await report(lane.credential, executionId, batch);
    expect(replay.json()).toEqual({ ok: true, accepted: 0, duplicates: 1 });

    const checkpoints = await harness.db.query("select * from checkpoints where exe_id = $1", [executionId]);
    expect(checkpoints.rowCount).toBe(1);
    expect(checkpoints.rows[0].files_changed).toBe(1);
    expect(checkpoints.rows[0].additions).toBe(12);
    expect(checkpoints.rows[0].withheld_secrets).toBe(1);
    expect(checkpoints.rows[0].environment).not.toContain("/");

    const files = await harness.db.query("select * from file_changes where ckp_id = $1", [
      checkpoints.rows[0].ckp_id
    ]);
    expect(files.rowCount).toBe(1);
    expect(files.rows[0].path).toBe("src/health.ts");
    expect(files.rows[0].diff).toContain("export const ok = true;");

    const execution = await harness.db.query(
      "select latest_checkpoint_sha, last_origin_seq from executions where exe_id = $1",
      [executionId]
    );
    expect(execution.rows[0].latest_checkpoint_sha).toBe("a".repeat(40));
    expect(Number(execution.rows[0].last_origin_seq)).toBe(1);

    // The diff body is fetched on demand, and only by a participant.
    const diff = await harness.app.inject({
      method: "GET",
      url: `/file-changes/${files.rows[0].chg_id}`,
      headers: bearer(owner)
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().path).toBe("src/health.ts");
    const stranger = await harness.signIn("diff-stranger");
    const denied = await harness.app.inject({
      method: "GET",
      url: `/file-changes/${files.rows[0].chg_id}`,
      headers: bearer(stranger)
    });
    expect(denied.statusCode).toBe(404);
  });

  it("records verification only from what the runner observed", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [
      {
        originSeq: 1,
        event: {
          kind: "verification.observed",
          payload: {
            name: "pnpm test",
            category: "test",
            outcome: "passed",
            command: "pnpm test",
            output: "12 passed",
            truncated: false
          }
        }
      }
    ]);
    const checks = await harness.db.query("select * from verification_checks where exe_id = $1", [executionId]);
    expect(checks.rowCount).toBe(1);
    expect(checks.rows[0].category).toBe("test");
    expect(checks.rows[0].environment).toContain("local runner");
    expect(checks.rows[0].runner_id).toBe(lane.runnerId);
  });

  it("marks direction applied only on the runner's acknowledgement", async () => {
    const lane = await createLane();
    const submitted = await direct(lane.missionId, "Wire the health check");
    const directionId = submitted.json().direction.directionId as string;
    const { commands } = await commandsFor(lane.credential);
    const executionId = commands[0].executionId as string;

    const before = await harness.db.query("select state from directions where dir_id = $1", [directionId]);
    expect(before.rows[0].state).toBe("queued");

    await report(lane.credential, executionId, [
      { originSeq: 1, event: { kind: "direction.applied", payload: { directionId } } }
    ]);
    const after = await harness.db.query(
      "select state, applied_at, consumed_by_execution_id from directions where dir_id = $1",
      [directionId]
    );
    expect(after.rows[0].state).toBe("applied");
    expect(after.rows[0].applied_at).not.toBeNull();
    expect(after.rows[0].consumed_by_execution_id).toBe(executionId);
  });

  it("ignores a direction that belongs to another workstream", async () => {
    const mine = await createLane();
    const theirs = await createLane();
    const executionId = await startExecution(mine);
    const foreign = await direct(theirs.missionId, "Their instruction");
    const foreignId = foreign.json().direction.directionId as string;

    await report(mine.credential, executionId, [
      { originSeq: 9, event: { kind: "direction.applied", payload: { directionId: foreignId } } }
    ]);
    const state = await harness.db.query("select state from directions where dir_id = $1", [foreignId]);
    expect(state.rows[0].state).toBe("queued");
  });

  it("refuses events for an execution in another workstream", async () => {
    const mine = await createLane();
    const theirs = await createLane();
    const foreignExecution = await startExecution(theirs);
    const response = await report(mine.credential, foreignExecution, [
      { originSeq: 1, event: { kind: "harness.text", payload: { text: "not mine to report" } } }
    ]);
    expect(response.statusCode).toBe(404);
  });

  it("carries the harness session onto the workstream so the next turn resumes it", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [
      { originSeq: 1, event: { kind: "harness.session", payload: { sessionId: "sess-abc", resumed: false } } },
      { originSeq: 2, event: { kind: "execution.completed", payload: {} } }
    ]);
    const workstream = await harness.db.query("select harness_session_id from workstreams where wst_id = $1", [
      lane.workstreamId
    ]);
    expect(workstream.rows[0].harness_session_id).toBe("sess-abc");

    await direct(lane.missionId, "Follow-up turn");
    const { commands } = await commandsFor(lane.credential);
    const start = commands.filter((command: { kind: string }) => command.kind === "start_execution");
    expect(start.length).toBe(2);
    expect(start[1].payload.resumeSessionId).toBe("sess-abc");
  });

  it("records a gap honestly instead of repairing it", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [
      { originSeq: 4, event: { kind: "runner.gap", payload: { droppedFrom: 1, droppedTo: 3 } } }
    ]);
    const gap = (await eventsOf(lane.missionId)).find((event) => event.kind === "runner.gap");
    expect(gap?.payload).toEqual({ droppedFrom: 1, droppedTo: 3 });
    expect(gap?.actor_kind).toBe("runner");
  });

  it("stops an execution through a durable command", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    const stop = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/execution/stop`,
      headers: bearer(owner),
      payload: {}
    });
    expect(stop.statusCode).toBe(200);
    const state = await harness.db.query("select state from executions where exe_id = $1", [executionId]);
    expect(state.rows[0].state).toBe("stopping");
    const { commands } = await commandsFor(lane.credential);
    expect(commands.some((command: { kind: string }) => command.kind === "stop_execution")).toBe(true);

    await report(lane.credential, executionId, [
      { originSeq: 1, event: { kind: "execution.stopped", payload: { reason: "stopped by the controller" } } }
    ]);
    const ended = await harness.db.query(
      "select state, ended_at, exit_outcome, failure_reason from executions where exe_id = $1",
      [executionId]
    );
    expect(ended.rows[0].state).toBe("stopped");
    expect(ended.rows[0].ended_at).not.toBeNull();
    expect(ended.rows[0].exit_outcome).toBe("stopped");
  });

  it("keeps every reported payload free of absolute filesystem paths", async () => {
    const rows = await harness.db.query("select payload from events");
    const offenders: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        if (/^(\/|[A-Za-z]:\\)/.test(value) || /\/(Users|home|private|var\/folders)\//.test(value)) {
          offenders.push(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value)) walk(item);
      }
    };
    for (const row of rows.rows) walk(row.payload);
    expect(offenders).toEqual([]);
  });
});

describe("D-033: a user session cannot speak as the harness", () => {
  it("rejects a session token on every runner route", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    for (const [method, url] of [
      ["GET", "/runner/commands"],
      ["POST", "/runner/events"],
      ["POST", "/runner/heartbeat"]
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: bearer(owner),
        payload: method === "POST" ? { executionId, events: [] } : undefined
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("runner_unauthenticated");
    }
  });

  it("offers no user-session route that accepts an arbitrary event kind", async () => {
    const lane = await createLane();
    const forged = {
      kind: "harness.text",
      payload: { text: "I finished and everything passes." }
    };
    for (const url of [
      `/missions/${lane.missionId}/events/report`,
      `/missions/${lane.missionId}/events`,
      `/workstreams/${lane.workstreamId}/events`
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url,
        headers: bearer(owner),
        payload: forged
      });
      expect(response.statusCode).toBe(404);
    }
    const harnessSpeech = await harness.db.query(
      "select count(*)::int as spoken from events where mission_id = $1 and actor_kind = 'harness'",
      [lane.missionId]
    );
    expect(harnessSpeech.rows[0].spoken).toBe(0);
  });

  it("refuses a credential borrowed from another workstream's runner", async () => {
    const mine = await createLane();
    const theirs = await createLane();
    const executionId = await startExecution(mine);
    const response = await report(theirs.credential, executionId, [
      { originSeq: 1, event: { kind: "harness.text", payload: { text: "borrowed voice" } } }
    ]);
    expect(response.statusCode).toBe(404);
  });
});
