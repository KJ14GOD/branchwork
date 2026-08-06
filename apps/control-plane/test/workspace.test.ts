import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { DeclaredCommand, ReportableRunnerEvent, SequencedRunnerEvent } from "@novus/contracts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The workspace runtime's control-plane half (D-040 … D-042), against a real
 * PostgreSQL. What these tests are for:
 *
 *  - `workspace.command` is a real server-side gate, so "controlling a mission
 *    is not owning the host machine" survives a crafted request rather than
 *    living in a hidden button (D-042, AGENTS.md rule 13);
 *  - a command nothing can pick up is refused by name instead of enqueued into
 *    the void, and reaches only the machine it was meant for;
 *  - what the runner reports about the machine — readiness, processes, checks —
 *    lands once, monotonically, and attributed;
 *  - a check proves one revision and stops counting when the workstream moves
 *    past it, which is the difference between evidence and a green word.
 *
 * They are deterministic evidence for those paths and nothing more: a real
 * desktop running a real project command is a separate claim (AGENTS.md
 * rule 11).
 */

let harness: Harness;
/** The person whose machine hosts the workstream: creator, Mission Admin, and
 *  therefore the holder of the control lease. */
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

const HEAD_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
  runnerId: string;
}

async function createMissionLane(): Promise<Omit<Lane, "credential" | "runnerId">> {
  const localId = randomUUID();
  const headSha = sha(localId);
  const registered = await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  expect(registered.statusCode).toBe(200);

  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "Make the workspace runnable",
      successCriteria: "Declared commands run and report",
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

  // A local repository's mission branch is cut on the machine and reported
  // back; until then the mission is honestly *New mission* and has no
  // workspace to instruct.
  const branch = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/branch/report`,
    headers: bearer(kartik),
    payload: { status: "created" }
  });
  expect(branch.statusCode).toBe(200);

  return { missionId: body.mission.missionId as string, workstreamId };
}

/** A mission whose host machine is enrolled as the runner. */
async function createLane(label = "kartik-macbook"): Promise<Lane> {
  const lane = await createMissionLane();
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${lane.workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId: lane.workstreamId, label }
  });
  expect(enrolled.statusCode).toBe(200);
  const runner = enrolled.json();
  const credential = runner.credential as string;
  // A runner's first act on a workstream is to say what the project declares.
  // Nothing can be authorized before that, because there is nothing to pin an
  // authorization to (D-043) — so every lane starts the way a real one does.
  await report(credential, null, [
    { originSeq: DECLARED_SEQ, event: { kind: "workspace.declared", payload: { commands: DECLARED } } }
  ]);
  return { ...lane, credential, runnerId: runner.runnerId as string };
}

/** The three commands this suite's imaginary project declares, sealed the way
 *  the runner seals them. The digests are fixed strings: the control plane
 *  never recomputes one, it only carries it. */
function declare(
  kind: "setup" | "run" | "verification",
  name: string,
  command: string,
  extra: Partial<DeclaredCommand> = {}
): DeclaredCommand {
  return {
    kind,
    name,
    command,
    cwd: null,
    timeoutMs: kind === "run" ? null : 900_000,
    category: kind === "verification" ? "test" : null,
    port: null,
    previewUrl: null,
    readiness: null,
    digest: createHash("sha256").update(`${kind}:${name}:${command}`).digest("hex").slice(0, 16),
    ...extra
  };
}

const DECLARED: DeclaredCommand[] = [
  declare("setup", "setup", "pnpm install"),
  declare("run", "dev", "pnpm dev"),
  declare("run", "worker", "pnpm worker"),
  declare("verification", "unit", "pnpm test"),
  declare("verification", "lint", "pnpm lint")
];
/** Ahead of every sequence the tests use, so publishing never collides with a
 *  report a test writes itself. */
const DECLARED_SEQ = 900;

/** Invitation and redemption is the only way a second person participates. */
async function addParticipant(missionId: string, who: string, role: string): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(kartik),
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

async function invoke(
  actor: SignedIn,
  missionId: string,
  payload: { kind: "setup" | "run" | "verification"; name?: string }
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/workspace/command`,
    headers: bearer(actor),
    payload
  });
}

async function stopCommand(actor: SignedIn, missionId: string, name: string) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/workspace/stop`,
    headers: bearer(actor),
    payload: { name }
  });
}

async function commandsFor(credential: string) {
  const response = await harness.app.inject({
    method: "GET",
    url: "/runner/commands",
    headers: runnerAuth(credential)
  });
  expect(response.statusCode).toBe(200);
  return response.json().commands as {
    commandId: string;
    kind: string;
    executionId: string | null;
    payload: Record<string, unknown>;
  }[];
}

async function settle(credential: string, commandId: string, state: "completed" | "failed") {
  const response = await harness.app.inject({
    method: "POST",
    url: `/runner/commands/${commandId}`,
    headers: runnerAuth(credential),
    payload: { state }
  });
  expect(response.statusCode).toBe(200);
}

/**
 * Reports runner events. `executionId: null` is a workspace-scoped report —
 * the machine talking about itself, with no turn behind it — and is how every
 * command a participant invokes comes back. An execution id is named only when
 * the report really is about a turn, which here is only the checkpoint that
 * gives the workstream a head.
 */
async function report(
  credential: string,
  executionId: string | null,
  events: ReportableRunnerEvent[]
) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { accepted: number; duplicates: number };
}

/** Starts a turn the way the product does. Needed only where the test needs a
 *  checkpoint, because a checkpoint is something a turn produces. */
async function startExecution(lane: Lane): Promise<string> {
  const directed = await harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(kartik),
    payload: { body: "Wire the health check", model: "claude-fable-5", effort: "high" }
  });
  expect(directed.statusCode).toBe(200);
  const commands = await commandsFor(lane.credential);
  const start = commands.find((command) => command.kind === "start_execution");
  expect(start?.executionId).toBeTruthy();
  return start?.executionId as string;
}

async function detail(actor: SignedIn, missionId: string) {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${missionId}`,
    headers: bearer(actor)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function enqueuedCommands(workstreamId: string) {
  const rows = await harness.db.query(
    "select cmd_id, kind, exe_id, payload, state, idempotency_key from runner_commands where wst_id = $1 order by seq",
    [workstreamId]
  );
  return rows.rows as {
    cmd_id: string;
    kind: string;
    exe_id: string | null;
    payload: Record<string, unknown>;
    state: string;
    idempotency_key: string;
  }[];
}

async function eventsOf(missionId: string) {
  const rows = await harness.db.query(
    "select kind, actor_kind, actor_id, actor_login, payload from events where mission_id = $1 order by seq",
    [missionId]
  );
  return rows.rows as {
    kind: string;
    actor_kind: string;
    actor_id: string;
    actor_login: string | null;
    payload: Record<string, unknown>;
  }[];
}

/** A committed checkpoint, so the workstream has a head a check can prove. */
function checkpointAt(originSeq: number, at: string): SequencedRunnerEvent {
  return {
    originSeq,
    event: {
      kind: "workspace.checkpoint",
      payload: {
        outcome: "committed",
        sha: at,
        parentSha: null,
        branch: "novus/mission",
        withheldSecrets: 0,
        uncommitted: false,
        error: null,
        files: [
          {
            path: "src/health.ts",
            previousPath: null,
            changeState: "added",
            additions: 4,
            deletions: 0,
            binary: false,
            diff: null,
            truncated: false
          }
        ]
      }
    }
  };
}

function completedCheck(
  originSeq: number,
  args: { name: string; outcome: "passed" | "failed"; checkpointSha: string | null }
): SequencedRunnerEvent {
  return {
    originSeq,
    event: {
      kind: "verification.completed",
      payload: {
        name: args.name,
        category: "test",
        outcome: args.outcome,
        command: "pnpm test",
        exitCode: args.outcome === "passed" ? 0 : 1,
        output: "12 passed",
        truncated: false,
        startedAt: "2026-08-02T10:00:00.000Z",
        completedAt: "2026-08-02T10:00:04.500Z",
        durationMs: 4500,
        checkpointSha: args.checkpointSha,
        ending: "exit"
      }
    }
  };
}

beforeAll(async () => {
  harness = await createHarness("novus_test_workspace");
  kartik = await harness.signIn("kartik");
});

afterAll(async () => {
  await harness.close();
});

describe("D-042: who may run a declared command", () => {
  it("lets the controller invoke a verification command the project declared", async () => {
    const lane = await createLane();
    const response = await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const commands = await enqueuedCommands(lane.workstreamId);
    const verification = commands.filter((command) => command.kind === "run_verification");
    expect(verification.length).toBe(1);
    expect(verification[0]?.payload.name).toBe("unit");
    // A check has to record who asked for it, so the requester travels with
    // the command; a run command is not an execution, so there is no exe_id.
    expect(verification[0]?.payload.requestedBy).toBe(kartik.userId);
    expect(verification[0]?.exe_id).toBeNull();
    // And the exact command being authorized travels with it, so the runner
    // executes what this person saw rather than whatever the file says by the
    // time it gets there (D-043).
    expect(verification[0]?.payload.command).toMatchObject({
      kind: "verification",
      name: "unit",
      command: "pnpm test",
      digest: DECLARED.find((entry) => entry.name === "unit")?.digest
    });

    // Touching the workspace creates it, honestly unconfigured.
    const workspace = await harness.db.query("select * from workspaces where wst_id = $1", [
      lane.workstreamId
    ]);
    expect(workspace.rowCount).toBe(1);
    expect(workspace.rows[0].wsp_id).toMatch(/^wsp_/);
    expect(workspace.rows[0].readiness).toBe("unconfigured");

    const requested = (await eventsOf(lane.missionId)).find(
      (event) => event.kind === "workspace.command_requested"
    );
    expect(requested?.actor_kind).toBe("user");
    expect(requested?.actor_login).toBe(kartik.login);
    // The digest is what lets the record answer "which command was this?"
    // months later, when the configuration has moved on.
    expect(requested?.payload).toEqual({
      kind: "verification",
      name: "unit",
      digest: DECLARED.find((entry) => entry.name === "unit")?.digest
    });
  });

  it("refuses a contributor who does not hold the lease, and enqueues nothing", async () => {
    const lane = await createLane();
    const maya = await addParticipant(lane.missionId, "maya", "contributor");

    const response = await invoke(maya, lane.missionId, { kind: "verification", name: "unit" });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
    expect(await enqueuedCommands(lane.workstreamId)).toEqual([]);

    // Nor by the back door: stopping acts on the same machine.
    const stopped = await stopCommand(maya, lane.missionId, "dev");
    expect(stopped.statusCode).toBe(403);
    expect(await enqueuedCommands(lane.workstreamId)).toEqual([]);
  });

  it("tells a non-participant the mission does not exist", async () => {
    const lane = await createLane();
    const stranger = await harness.signIn("stranger");
    const response = await invoke(stranger, lane.missionId, { kind: "setup" });
    // 404, never 403: a mission id must not be probeable (D-036).
    expect(response.statusCode).toBe(404);
    expect(await enqueuedCommands(lane.workstreamId)).toEqual([]);
  });

  it("offers no shell path to authorize incorrectly", async () => {
    const lane = await createLane();
    for (const path of ["shell", "terminal", "exec"]) {
      const response = await harness.app.inject({
        method: "POST",
        url: `/missions/${lane.missionId}/workspace/${path}`,
        headers: bearer(kartik),
        payload: { command: "cat ~/.ssh/id_rsa" }
      });
      expect(response.statusCode).toBe(404);
    }
    // And no command kind smuggles one in.
    const smuggled = await invoke(
      kartik,
      lane.missionId,
      { kind: "shell", name: "bash" } as unknown as { kind: "run" }
    );
    expect(smuggled.statusCode).toBe(422);
  });
});

describe("enqueueing a declared command", () => {
  it("refuses by name when no machine is running the workstream, and enqueues nothing", async () => {
    const lane = await createMissionLane();
    const response = await invoke(kartik, lane.missionId, { kind: "setup" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("no_runner");
    expect(await enqueuedCommands(lane.workstreamId)).toEqual([]);
  });

  it("sends the command only to the runner of that workstream", async () => {
    const mine = await createLane("mine");
    const theirs = await createLane("theirs");
    expect((await invoke(kartik, mine.missionId, { kind: "run", name: "dev" })).statusCode).toBe(200);

    const delivered = await commandsFor(mine.credential);
    expect(delivered.some((command) => command.kind === "run_command")).toBe(true);
    const other = await commandsFor(theirs.credential);
    expect(other).toEqual([]);
  });

  it("collapses a double-click into one command, and allows the same check again later", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);

    const first = await enqueuedCommands(lane.workstreamId);
    expect(first.length).toBe(1);
    // One command, and one line in the log: a double-click is one request.
    const requests = (await eventsOf(lane.missionId)).filter(
      (event) => event.kind === "workspace.command_requested"
    );
    expect(requests.length).toBe(1);

    // Still one while the runner is working on it.
    await commandsFor(lane.credential);
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    expect((await enqueuedCommands(lane.workstreamId)).length).toBe(1);

    // Once it settles the same check must be runnable again — which is why the
    // key is not the direction-style stable one.
    await settle(lane.credential, first[0]?.cmd_id as string, "completed");
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    const after = await enqueuedCommands(lane.workstreamId);
    expect(after.length).toBe(2);
    expect(after[0]?.idempotency_key).not.toBe(after[1]?.idempotency_key);
  });

  it("maps each declared kind onto its own runner command", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "setup" })).statusCode).toBe(200);
    expect((await invoke(kartik, lane.missionId, { kind: "run", name: "dev" })).statusCode).toBe(200);
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    expect((await stopCommand(kartik, lane.missionId, "dev")).statusCode).toBe(200);

    const kinds = (await enqueuedCommands(lane.workstreamId)).map((command) => command.kind);
    expect(kinds).toEqual(["run_setup", "run_command", "run_verification", "stop_command"]);

    const stopped = (await eventsOf(lane.missionId)).find(
      (event) => event.kind === "workspace.stop_requested"
    );
    expect(stopped?.payload).toEqual({ name: "dev" });
  });
});

describe("what the runner reports about the machine", () => {
  // Every report in this block names no execution. That is the point: setup
  // and run commands happen before any turn has ever existed, and a workspace
  // that could only be described from inside a turn would be undescribable on
  // a fresh workstream.
  it("moves the workspace through unconfigured, configuring, and ready", async () => {
    const lane = await createLane();

    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "workspace.readiness",
          payload: {
            readiness: "configuring",
            portRangeStart: 4100,
            portRangeEnd: 4199,
            setupError: null
          }
        }
      }
    ]);
    let row = (await harness.db.query("select * from workspaces where wst_id = $1", [lane.workstreamId]))
      .rows[0];
    expect(row.readiness).toBe("configuring");
    expect(row.port_range_start).toBe(4100);
    expect(row.configured_at).toBeNull();
    expect(await detail(kartik, lane.missionId).then((body) => body.state)).toBe("provisioning_workspace");

    await report(lane.credential, null, [
      {
        originSeq: 2,
        event: {
          kind: "workspace.readiness",
          // A later report that omits the range must not forget the ports
          // already allocated to this workstream.
          payload: { readiness: "ready", portRangeStart: null, portRangeEnd: null, setupError: null }
        }
      }
    ]);
    row = (await harness.db.query("select * from workspaces where wst_id = $1", [lane.workstreamId])).rows[0];
    expect(row.readiness).toBe("ready");
    expect(row.port_range_start).toBe(4100);
    expect(row.port_range_end).toBe(4199);
    expect(row.configured_at).not.toBeNull();
    expect(row.setup_error).toBeNull();

    const workspace = (await detail(kartik, lane.missionId)).workspace;
    expect(workspace.workspaceId).toMatch(/^wsp_/);
    expect(workspace.readiness).toBe("ready");
    expect(workspace.portRangeStart).toBe(4100);
  });

  it("records the reason a workspace failed to become ready", async () => {
    const lane = await createLane();
    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "workspace.readiness",
          payload: {
            readiness: "failed",
            portRangeStart: null,
            portRangeEnd: null,
            setupError: "pnpm install exited 1"
          }
        }
      }
    ]);
    const row = (await harness.db.query("select * from workspaces where wst_id = $1", [lane.workstreamId]))
      .rows[0];
    expect(row.readiness).toBe("failed");
    expect(row.setup_error).toBe("pnpm install exited 1");
    expect((await detail(kartik, lane.missionId)).state).toBe("workspace_failed");
  });

  it("records a process once, ends it monotonically, and ignores a late duplicate exit", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "run", name: "dev" })).statusCode).toBe(200);
    const processId = "prc_devserver0000000000";

    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "process.started",
          payload: {
            processId,
            kind: "run",
            name: "dev",
            command: "pnpm dev",
            port: 4100,
            previewUrl: "http://localhost:4100",
            readiness: "not_required"
          }
        }
      }
    ]);

    let rows = await harness.db.query("select * from workspace_processes where wst_id = $1", [
      lane.workstreamId
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].state).toBe("running");
    expect(rows.rows[0].command).toBe("pnpm dev");
    expect(rows.rows[0].port).toBe(4100);
    // Attributed to whoever asked for it, from the durable command — never
    // from the report.
    expect(rows.rows[0].started_by).toBe(kartik.userId);

    const running = await detail(kartik, lane.missionId);
    expect(running.overlays).toContain("app_running");
    expect(running.processes[0].startedByLogin).toBe(kartik.login);

    await report(lane.credential, null, [
      {
        originSeq: 2,
        event: {
          kind: "process.exited",
          payload: { processId, state: "exited", exitCode: 0, ending: "exit", failureReason: null }
        }
      }
    ]);
    rows = await harness.db.query("select * from workspace_processes where prc_id = $1", [processId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].state).toBe("exited");
    expect(rows.rows[0].exit_code).toBe(0);
    const endedAt = rows.rows[0].ended_at as Date;
    expect(endedAt).not.toBeNull();

    // The machine wakes up and reports the end again, differently. A finished
    // process never returns to running and never changes its outcome.
    await report(lane.credential, null, [
      {
        originSeq: 3,
        event: {
          kind: "process.exited",
          payload: { processId, state: "failed", exitCode: 137, ending: "exit", failureReason: "killed" }
        }
      }
    ]);
    rows = await harness.db.query("select * from workspace_processes where prc_id = $1", [processId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].state).toBe("exited");
    expect(rows.rows[0].exit_code).toBe(0);
    expect(rows.rows[0].failure_reason).toBeNull();
    expect((rows.rows[0].ended_at as Date).getTime()).toBe(endedAt.getTime());

    expect((await detail(kartik, lane.missionId)).overlays).not.toContain("app_running");
  });

  it("takes a preview URL a running process only learned about later", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "run", name: "dev" })).statusCode).toBe(200);
    const processId = "prc_latepreview000000";
    const started = (seq: number, previewUrl: string | null, port: number | null): SequencedRunnerEvent => ({
      originSeq: seq,
      event: {
        kind: "process.started",
        payload: {
          processId,
          kind: "run",
          name: "dev",
          command: "pnpm dev",
          port,
          previewUrl,
          readiness: "not_required"
        }
      }
    });

    // A dev server prints its address seconds after it starts, and no other
    // event in the contract carries one, so the runner says it again.
    await report(lane.credential, null, [started(1, null, null)]);
    let shown = (await detail(kartik, lane.missionId)).processes.find(
      (process: { processId: string }) => process.processId === processId
    );
    expect(shown.previewUrl).toBeNull();
    expect(shown.state).toBe("running");

    await report(lane.credential, null, [started(2, "http://localhost:4100", 4100)]);
    shown = (await detail(kartik, lane.missionId)).processes.find(
      (process: { processId: string }) => process.processId === processId
    );
    expect(shown.previewUrl).toBe("http://localhost:4100");
    expect(shown.port).toBe(4100);
    // Still the one process, still the same one that is running: a second
    // report about a process is not a second process.
    expect(shown.state).toBe("running");
    const rows = await harness.db.query("select * from workspace_processes where wst_id = $1", [
      lane.workstreamId
    ]);
    expect(rows.rowCount).toBe(1);
    expect((await detail(kartik, lane.missionId)).overlays).toContain("app_running");

    // And a later report that knows less does not unlearn it.
    await report(lane.credential, null, [started(3, null, null)]);
    shown = (await detail(kartik, lane.missionId)).processes.find(
      (process: { processId: string }) => process.processId === processId
    );
    expect(shown.previewUrl).toBe("http://localhost:4100");
    expect(shown.port).toBe(4100);
  });

  it("never revives a finished process with a stale start report", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "run", name: "dev" })).statusCode).toBe(200);
    const processId = "prc_stalestart0000000";

    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "process.started",
          payload: {
            processId,
            kind: "run",
            name: "dev",
            command: "pnpm dev",
            port: null,
            previewUrl: null,
            readiness: "not_required"
          }
        }
      },
      {
        originSeq: 2,
        event: {
          kind: "process.exited",
          payload: { processId, state: "exited", exitCode: 0, ending: "exit", failureReason: null }
        }
      }
    ]);
    const ended = (
      await harness.db.query("select * from workspace_processes where prc_id = $1", [processId])
    ).rows[0];
    expect(ended.state).toBe("exited");

    // A report buffered before the process died arrives after it. The room
    // must not offer Open preview on something that is no longer there.
    await report(lane.credential, null, [
      {
        originSeq: 3,
        event: {
          kind: "process.started",
          payload: {
            processId,
            kind: "run",
            name: "dev",
            command: "pnpm dev",
            port: 4100,
            previewUrl: "http://localhost:4100",
            readiness: "not_required"
          }
        }
      }
    ]);
    const rows = await harness.db.query("select * from workspace_processes where prc_id = $1", [processId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].state).toBe("exited");
    expect(rows.rows[0].preview_url).toBeNull();
    expect(rows.rows[0].port).toBeNull();
    expect(rows.rows[0].exit_code).toBe(0);
    expect((rows.rows[0].ended_at as Date).getTime()).toBe((ended.ended_at as Date).getTime());

    const body = await detail(kartik, lane.missionId);
    expect(body.overlays).not.toContain("app_running");
    expect(
      body.processes.find((process: { processId: string }) => process.processId === processId).previewUrl
    ).toBeNull();
  });

  it("attributes a default run command to whoever asked, though they named nothing", async () => {
    const lane = await createLane();
    // "Run the project", with no name: the repository's configuration chooses
    // which command that is, and the process reports the concrete name it ran.
    expect((await invoke(kartik, lane.missionId, { kind: "run" })).statusCode).toBe(200);
    const processId = "prc_defaultrun00000000";

    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "process.started",
          payload: {
            processId,
            kind: "run",
            name: "dev",
            command: "pnpm dev",
            port: null,
            previewUrl: null,
            readiness: "not_required"
          }
        }
      }
    ]);
    const row = (
      await harness.db.query("select * from workspace_processes where prc_id = $1", [processId])
    ).rows[0];
    expect(row.name).toBe("dev");
    expect(row.started_by).toBe(kartik.userId);
  });

  it("persists a participant-run check with its requester, timing, and revision", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    // The checkpoint comes from a turn; the check does not, and says so by
    // naming no execution.
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [checkpointAt(1, HEAD_SHA)]);
    await report(lane.credential, null, [
      completedCheck(1, { name: "unit", outcome: "passed", checkpointSha: HEAD_SHA })
    ]);

    const rows = await harness.db.query(
      "select * from verification_checks where mission_id = $1 and origin = 'participant'",
      [lane.missionId]
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row.origin).toBe("participant");
    expect(row.requested_by).toBe(kartik.userId);
    expect(row.exit_code).toBe(0);
    expect(row.duration_ms).toBe(4500);
    expect(row.checkpoint_sha).toBe(HEAD_SHA);
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(row.environment).toContain("local runner");
    expect(row.environment).not.toContain("/");
    // A participant-run check is not part of a turn.
    expect(row.exe_id).toBeNull();

    const check = (await detail(kartik, lane.missionId)).checks.find(
      (candidate: { origin: string }) => candidate.origin === "participant"
    );
    expect(check.requestedByLogin).toBe(kartik.login);
    expect(check.executionId).toBeNull();
    expect(check.durationMs).toBe(4500);
  });

  it("de-duplicates a replayed report that has no execution behind it", async () => {
    const lane = await createLane();
    expect((await invoke(kartik, lane.missionId, { kind: "verification", name: "unit" })).statusCode).toBe(200);
    // A batch the runner sent, the acknowledgement of which was lost to a
    // partition, so the outbox sends it again. There is no execution to key
    // the replay against — the workstream's own sequence is what makes this
    // land once.
    const batch: SequencedRunnerEvent[] = [
      {
        originSeq: 1,
        event: {
          kind: "workspace.readiness",
          payload: { readiness: "ready", portRangeStart: 4200, portRangeEnd: 4299, setupError: null }
        }
      },
      {
        originSeq: 2,
        event: {
          kind: "process.started",
          payload: {
            processId: "prc_replayedcheck00000",
            kind: "verification",
            name: "unit",
            command: "pnpm test",
            port: null,
            previewUrl: null,
            readiness: "not_required"
          }
        }
      },
      completedCheck(3, { name: "unit", outcome: "passed", checkpointSha: HEAD_SHA })
    ];

    expect(await report(lane.credential, null, batch)).toEqual({
      ok: true,
      accepted: 3,
      duplicates: 0
    });
    expect(await report(lane.credential, null, batch)).toEqual({
      ok: true,
      accepted: 0,
      duplicates: 3
    });

    const checks = await harness.db.query(
      "select chk_id from verification_checks where mission_id = $1",
      [lane.missionId]
    );
    expect(checks.rowCount).toBe(1);
    const processes = await harness.db.query(
      "select prc_id from workspace_processes where wst_id = $1",
      [lane.workstreamId]
    );
    expect(processes.rowCount).toBe(1);
    const logged = (await eventsOf(lane.missionId)).filter((event) =>
      event.kind.startsWith("workspace.readiness")
    );
    expect(logged.length).toBe(1);
  });

  it("keeps a workspace report off the sequence cursor of the last turn", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, executionId, [
      { originSeq: 7, event: { kind: "harness.text", payload: { text: "working" } } }
    ]);
    // The workstream's own sequence is unrelated and much lower; writing it to
    // the execution would rewind the resume point of the turn still running.
    await report(lane.credential, null, [
      {
        originSeq: 1,
        event: {
          kind: "workspace.readiness",
          payload: { readiness: "ready", portRangeStart: null, portRangeEnd: null, setupError: null }
        }
      }
    ]);
    const cursor = await harness.db.query("select last_origin_seq from executions where exe_id = $1", [
      executionId
    ]);
    expect(Number(cursor.rows[0].last_origin_seq)).toBe(7);
  });
});

describe("a check proves one revision", () => {
  it("reads as stale once the workstream has moved past the revision it proved", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    // The workstream's head is this checkpoint; only a check that names it
    // still proves what is there now.
    await report(lane.credential, executionId, [checkpointAt(1, HEAD_SHA)]);
    await report(lane.credential, null, [
      completedCheck(1, { name: "old", outcome: "passed", checkpointSha: MOVED_SHA }),
      completedCheck(2, { name: "current", outcome: "passed", checkpointSha: HEAD_SHA })
    ]);

    const checks = (await detail(kartik, lane.missionId)).checks as {
      name: string;
      stale: boolean;
      checkpointSha: string | null;
    }[];
    expect(checks.find((check) => check.name === "old")?.stale).toBe(true);
    expect(checks.find((check) => check.name === "current")?.stale).toBe(false);
  });

  it("does not let a stale pass make the mission ready for review", async () => {
    const lane = await createLane();
    const executionId = await startExecution(lane);
    await report(lane.credential, null, [
      completedCheck(1, { name: "unit", outcome: "passed", checkpointSha: MOVED_SHA })
    ]);
    await report(lane.credential, executionId, [
      checkpointAt(1, HEAD_SHA),
      { originSeq: 2, event: { kind: "execution.completed", payload: {} } }
    ]);

    const body = await detail(kartik, lane.missionId);
    // Work landed and nothing current verifies it. Saying "ready for review"
    // here is the fabrication the ledger exists to prevent (D-037).
    expect(body.state).toBe("work_completed_unverified");
    expect(body.overlays).toContain("verification_stale");

    // The same check against the revision that is actually there does.
    await report(lane.credential, null, [
      completedCheck(2, { name: "unit", outcome: "passed", checkpointSha: HEAD_SHA })
    ]);
    const after = await detail(kartik, lane.missionId);
    expect(after.state).toBe("ready_for_review");
    expect(after.overlays).not.toContain("verification_stale");
  });
});
