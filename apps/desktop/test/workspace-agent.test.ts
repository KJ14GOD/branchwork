import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeclaredCommand,
  RunnerCommand,
  RunnerEvent,
  SequencedRunnerEvent
} from "@novus/contracts";
import type { ControlPlaneClient } from "../electron/api-client";
import { startRunnerAgent, type RunnerAgent, type RunnerHost } from "../electron/runner-agent";

/**
 * The four workspace commands driven through the agent itself, against a
 * stubbed control plane and a real repository.
 *
 * The pure modules being green is not the same as the agent being wired: the
 * bug this shape of test exists for is a command that is delivered,
 * acknowledged, and then produces nothing at all. It also pins the reporting
 * envelope — a workspace observation belongs to the workstream and is reported
 * with no execution, numbered in its own stream.
 */

const MISSION_ID = "msn_wsagent";
const WORKSTREAM_ID = "wst_wsagent";
const MISSION_BRANCH = "novus/m-w5ag3nt1";
const CREDENTIAL = "runner-credential-for-the-workspace-test";

let repo: string;
let userData: string;
let plane: FakeControlPlane;
let agent: RunnerAgent | null = null;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

interface QueuedCommand extends RunnerCommand {
  state: "pending" | "delivered" | "acknowledged" | "completed" | "failed";
}

interface Report {
  executionId: string | null;
  batch: SequencedRunnerEvent[];
}

class FakeControlPlane {
  readonly reported: Report[] = [];
  readonly commands: QueuedCommand[] = [];
  readonly failures = new Map<string, string>();

  enqueue(command: Omit<QueuedCommand, "state">): void {
    this.commands.push({ ...command, state: "pending" });
  }

  events(): SequencedRunnerEvent[] {
    return this.reported.flatMap((report) => report.batch);
  }

  kinds(): string[] {
    return this.events().map((item) => item.event.kind);
  }

  /** Every command this runner has said the project declares. The real control
   *  plane stores exactly this and hands one back with each authorization. */
  declared(): DeclaredCommand[] {
    return this.events()
      .filter((item) => item.event.kind === "workspace.declared")
      .flatMap((item) => (item.event as Extract<RunnerEvent, { kind: "workspace.declared" }>).payload.commands);
  }

  payloadsOf(kind: string): Record<string, unknown>[] {
    return this.events()
      .filter((item) => item.event.kind === kind)
      .map((item) => item.event.payload as Record<string, unknown>);
  }

  stateOf(commandId: string): string | undefined {
    return this.commands.find((command) => command.commandId === commandId)?.state;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const authorized = String((init?.headers as Record<string, string> | undefined)?.authorization);
    if (authorized !== `Runner ${CREDENTIAL}`) return json({ error: "no" }, 401);

    if (url.pathname === "/runner/commands") {
      const offered = this.commands.filter(
        (command) => command.state !== "completed" && command.state !== "failed"
      );
      for (const command of offered) if (command.state === "pending") command.state = "delivered";
      return json({
        commands: offered.map(({ state: _state, ...command }) => command),
        workstream: {
          workstreamId: WORKSTREAM_ID,
          missionId: MISSION_ID,
          missionBranch: MISSION_BRANCH,
          baseSha: "a".repeat(40),
          provider: "local",
          providerRepoId: "local-1",
          harnessSessionId: null
        }
      });
    }

    if (url.pathname.startsWith("/runner/commands/")) {
      const commandId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        state: QueuedCommand["state"];
        failureReason?: string;
      };
      const command = this.commands.find((candidate) => candidate.commandId === commandId);
      if (command && command.state !== "completed" && command.state !== "failed") command.state = body.state;
      if (body.failureReason !== undefined) this.failures.set(commandId, body.failureReason);
      return json({ ok: true });
    }

    if (url.pathname === "/runner/events") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        executionId: string | null;
        events: SequencedRunnerEvent[];
      };
      this.reported.push({ executionId: body.executionId, batch: body.events });
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeApi(): ControlPlaneClient {
  return {
    listMissions: async () => [
      { missionId: MISSION_ID, repository: { provider: "local", providerRepoId: "local-1" } }
    ],
    // Every lane of the mission, which is how the agent discovers what to
    // enrol for: one here, and one more for every approach (D-074).
    getMission: async () => ({
      workstream: { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" },
      workstreams: [
        { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" }
      ]
    }),
    registerRunner: async () => ({
      runnerId: "rnr_wsagent",
      credential: CREDENTIAL,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    })
  } as unknown as ControlPlaneClient;
}

function host(): RunnerHost {
  return {
    userDataPath: userData,
    isPackaged: false,
    label: "test-machine",
    repositoryPath: (providerRepoId) => (providerRepoId === "local-1" ? repo : null)
  };
}

function start(options: { fakeApproval?: boolean } = {}): RunnerAgent {
  agent = startRunnerAgent({
    api: fakeApi(),
    controlPlaneUrl: "http://control-plane.test",
    getToken: () => "a-session",
    host: host(),
    fetch: plane.fetch,
    fakeHarness: true,
    fakeApproval: options.fakeApproval ?? false
  });
  return agent;
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let nextCommand = 0;
const command = (kind: RunnerCommand["kind"], payload: Record<string, unknown> = {}): RunnerCommand => {
  nextCommand += 1;
  return {
    commandId: `cmd_ws${String(nextCommand).padStart(16, "0")}`,
    kind,
    workstreamId: WORKSTREAM_ID,
    missionId: MISSION_ID,
    // A workspace command belongs to no turn, which is the case the runtime
    // has to survive: a setup can happen before a turn has ever existed.
    executionId: null,
    seq: nextCommand,
    payload,
    createdAt: new Date().toISOString()
  };
};

/**
 * Enqueues a command the way the real control plane does (D-043): resolved
 * against what *this runner published*, and pinned to that exact snapshot.
 *
 * The waiting is the point rather than an inconvenience. A command can only be
 * authorized once Novus has read the project, because until then there is
 * nothing to authorize — which is the same order the product enforces.
 */
async function authorize(
  kind: RunnerCommand["kind"],
  declaredKind: DeclaredCommand["kind"],
  name?: string
): Promise<QueuedCommand> {
  await waitFor("the runner to publish what this project declares", () => plane.declared().length > 0);
  const ofKind = plane.declared().filter((entry) => entry.kind === declaredKind);
  const snapshot = (name === undefined ? ofKind[0] : ofKind.find((entry) => entry.name === name)) ?? null;
  const queued = command(kind, { name: name ?? snapshot?.name ?? null, command: snapshot });
  plane.enqueue(queued);
  return queued as QueuedCommand;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-wsagent-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-wsagent-userdata-"));
  plane = new FakeControlPlane();
  nextCommand = 0;

  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  mkdirSync(join(repo, ".novus"), { recursive: true });
  writeFileSync(
    join(repo, ".novus", "settings.toml"),
    [
      `[setup]`,
      `command = "echo installed > setup-ran.txt"`,
      ``,
      `[[run]]`,
      `name = "dev"`,
      `command = "echo started > dev-ran.txt; sleep 25"`,
      ``,
      `[[verify]]`,
      `name = "test"`,
      `command = "exit 0"`,
      `category = "test"`
    ].join("\n")
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
});

afterEach(async () => {
  await agent?.shutdown("test over");
  agent = null;
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe("workspace commands through the agent", () => {
  it("runs setup and reports readiness with no execution", async () => {
    start().discoverNow();
    const setupCommand = await authorize("run_setup", "setup");

    await waitFor("readiness to be reported", () =>
      plane.payloadsOf("workspace.readiness").some((payload) => payload.readiness === "ready")
    );

    const readiness = plane.payloadsOf("workspace.readiness");
    expect(readiness.map((payload) => payload.readiness)).toEqual(["configuring", "ready"]);
    expect(readiness[1]?.portRangeStart).toBeGreaterThan(3000);
    expect(existsSync(join(userData, "worktrees", WORKSTREAM_ID, "setup-ran.txt"))).toBe(true);
    // The command ran in the worktree, never in the user's own checkout.
    expect(existsSync(join(repo, "setup-ran.txt"))).toBe(false);

    // A workspace report belongs to the workstream: no execution, its own
    // sequence, starting at one.
    for (const report of plane.reported) expect(report.executionId).toBeNull();
    const sequences = plane.events().map((item) => item.originSeq);
    expect(sequences[0]).toBe(1);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);

    await waitFor("the command to settle", () => plane.stateOf(setupCommand.commandId) === "completed");
  }, 40_000);

  it("starts a run command, keeps it alive, and stops it on request", async () => {
    start().discoverNow();
    const startCommand = await authorize("run_command", "run");

    await waitFor("the run command to start", () => plane.kinds().includes("process.started"));
    const started = plane.payloadsOf("process.started")[0];
    expect(started?.kind).toBe("run");
    expect(started?.name).toBe("dev");
    expect(String(started?.processId)).toMatch(/^prc_/);
    await waitFor("the run command to write", () =>
      existsSync(join(userData, "worktrees", WORKSTREAM_ID, "dev-ran.txt"))
    );
    // The command is acknowledged while the process carries on: a run command
    // does not hold its acknowledgement for the life of the server.
    await waitFor("the start to settle", () => plane.stateOf(startCommand.commandId) === "completed");
    expect(plane.kinds()).not.toContain("process.exited");

    // Stopping names a live process rather than a command line, so it carries
    // no snapshot: what it can do is bounded by what is already running.
    plane.enqueue(command("stop_command", { name: "dev" }));
    await waitFor("the process to exit", () => plane.kinds().includes("process.exited"));
    expect(plane.payloadsOf("process.exited")[0]?.state).toBe("stopped");
    expect(plane.payloadsOf("process.exited")[0]?.processId).toBe(started?.processId);
  }, 40_000);

  it("runs a declared check and reports the revision it proves", async () => {
    start().discoverNow();
    await authorize("run_verification", "verification", "test");

    await waitFor("the check to complete", () => plane.kinds().includes("verification.completed"));
    const check = plane.payloadsOf("verification.completed")[0];
    expect(check?.name).toBe("test");
    expect(check?.outcome).toBe("passed");
    expect(check?.category).toBe("test");
    const head = (await git(join(userData, "worktrees", WORKSTREAM_ID), ["rev-parse", "HEAD"])).trim();
    expect(check?.checkpointSha).toBe(head);
  }, 40_000);

  it("refuses a command that arrives with no snapshot to run", async () => {
    // The real control plane refuses an undeclared name outright, so a command
    // reaching the runner without a snapshot means something upstream is wrong.
    // The runner does not fill the gap in by re-reading the file — that is the
    // exact behaviour pinning exists to prevent (D-043).
    start().discoverNow();
    await waitFor("the runner to publish", () => plane.declared().length > 0);
    const orphan = command("run_command", { name: "not-declared", command: null });
    plane.enqueue(orphan);

    await waitFor("the command to fail", () => plane.stateOf(orphan.commandId) === "failed");
    expect(plane.failures.get(orphan.commandId)).toContain("has not read this project's configuration");
    expect(plane.kinds()).not.toContain("process.started");
  }, 40_000);

  it("settles a command it already ran instead of running it twice", async () => {
    start().discoverNow();
    const setupCommand = await authorize("run_setup", "setup");
    await waitFor("setup to finish", () =>
      plane.payloadsOf("workspace.readiness").some((payload) => payload.readiness === "ready")
    );
    await waitFor("the command to settle", () => plane.stateOf(setupCommand.commandId) === "completed");
    await agent?.shutdown("relaunching");
    agent = null;

    // The control plane forgot the acknowledgement and offers it again.
    const stale = plane.commands.find((entry) => entry.commandId === setupCommand.commandId);
    if (stale) stale.state = "acknowledged";
    const before = plane.payloadsOf("workspace.readiness").length;

    start().discoverNow();
    await waitFor("the replay to settle", () => plane.stateOf(setupCommand.commandId) === "completed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plane.payloadsOf("workspace.readiness").length).toBe(before);
  }, 40_000);
});

/**
 * Checks that run themselves (the `automatic` origin).
 *
 * A turn that commits a checkpoint with changed files is work nothing has
 * verified, and that is the state most rooms used to end every turn in. The
 * claim under test is the whole loop: the scripted turn ends, its terminal
 * event is reported, and then — on the lane's own chain, from the runner's own
 * declared list — every verification command runs and reports with origin
 * `automatic`, bound to the checkpoint the turn just committed.
 */
describe("checks that run themselves after a checkpoint", () => {
  const EXECUTION_ID = "exe_autocheck0000001";

  const startExecution = (): RunnerCommand => ({
    ...command("start_execution", { body: "write the fake turn file", model: "", effort: "" }),
    executionId: EXECUTION_ID
  });

  /** Rewrites what the project declares and moves the mission branch to it,
   *  before the agent has made a worktree — the turn then works from here. */
  async function declare(lines: string[]): Promise<void> {
    writeFileSync(join(repo, ".novus", "settings.toml"), lines.join("\n"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "declare"]);
    await git(repo, ["branch", "-f", MISSION_BRANCH, "main"]);
  }

  it("runs every declared check, as itself, against the committed revision", async () => {
    await declare([
      `[[verify]]`,
      `name = "test"`,
      `command = "exit 0"`,
      `category = "test"`,
      ``,
      `[[verify]]`,
      `name = "types"`,
      `command = "exit 1"`,
      `category = "typecheck"`
    ]);
    start().discoverNow();
    plane.enqueue(startExecution());

    await waitFor("both checks to report", () => plane.payloadsOf("verification.completed").length >= 2);

    // The turn ends and reports first; the checks follow it.
    const kinds = plane.kinds();
    expect(kinds.indexOf("execution.completed")).toBeLessThan(kinds.indexOf("verification.completed"));

    // All of them, in declared order, each honestly its own verdict — and
    // none claiming a person asked for it.
    const checks = plane.payloadsOf("verification.completed");
    expect(checks.map((check) => check.name)).toEqual(["test", "types"]);
    expect(checks.map((check) => check.origin)).toEqual(["automatic", "automatic"]);
    expect(checks.map((check) => check.outcome)).toEqual(["passed", "failed"]);

    // Each check binds to the checkpoint the turn just committed.
    const checkpoint = plane.payloadsOf("workspace.checkpoint")[0];
    expect(checkpoint?.outcome).toBe("committed");
    expect(checkpoint?.sha).toBeTruthy();
    for (const check of checks) expect(check.checkpointSha).toBe(checkpoint?.sha);
  }, 40_000);

  it("does not start setup or run commands, only verification", async () => {
    // The default fixture declares all three kinds; only the check may run.
    start().discoverNow();
    plane.enqueue(startExecution());

    await waitFor("the check to report", () => plane.kinds().includes("verification.completed"));
    expect(plane.payloadsOf("verification.completed")[0]?.origin).toBe("automatic");
    const started = plane.payloadsOf("process.started");
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((process) => process.kind === "verification")).toBe(true);
  }, 40_000);

  it("runs nothing when the project declares no verification", async () => {
    await declare([`[[run]]`, `name = "dev"`, `command = "echo started; sleep 25"`]);
    start().discoverNow();
    plane.enqueue(startExecution());

    await waitFor("the turn to finish", () => plane.kinds().includes("execution.completed"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(plane.kinds()).not.toContain("verification.completed");
    expect(plane.kinds()).not.toContain("process.started");
  }, 40_000);

  it("stays quiet when the project turned automatic checks off", async () => {
    await declare([
      `autoVerify = false`,
      ``,
      `[[verify]]`,
      `name = "test"`,
      `command = "exit 0"`,
      `category = "test"`
    ]);
    start().discoverNow();
    plane.enqueue(startExecution());

    await waitFor("the turn to finish", () => plane.kinds().includes("execution.completed"));
    await waitFor("the check to be declared", () =>
      plane.declared().some((entry) => entry.kind === "verification")
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Declared, so the silence is the opt-out and not a missing declaration.
    expect(plane.kinds()).not.toContain("verification.completed");
  }, 40_000);
});

/**
 * Stop, driven through the agent rather than through the turn (D-053).
 *
 * `execution.test.ts` already proves that a turn told to stop kills its process
 * group and reports `execution.stopped`. That was never the broken half. The
 * broken half was between the command arriving and that call being made: a
 * `stop_execution` queued behind the turn it was meant to interrupt, and the
 * chain it queued on only resolved *after* the turn had been removed from the
 * active set — so the stop found nothing to stop and returned successfully. Not
 * a late interrupt; a guaranteed no-op, which is why nothing failed loudly.
 *
 * These tests enter where the bug was, which is the only place they could have
 * caught it.
 */
describe("stopping a coding-agent execution", () => {
  const EXECUTION_ID = "exe_stoptest0000001";

  function startExecution(executionId = EXECUTION_ID): RunnerCommand {
    return {
      ...command("start_execution", { body: "add a fake turn file", model: "", effort: "" }),
      executionId
    };
  }

  function stopExecution(executionId = EXECUTION_ID): RunnerCommand {
    return { ...command("stop_execution"), executionId };
  }

  /** Every terminal event this execution reported, in order. */
  const terminals = (): string[] =>
    plane
      .kinds()
      .filter((kind) =>
        ["execution.completed", "execution.stopped", "execution.failed", "execution.interrupted"].includes(kind)
      );

  it("reaches the execution in the same batch that started it, and no harness runs", async () => {
    start().discoverNow();
    // Both in one poll, which is the case a person actually produces: direct,
    // then think better of it. The start holds the workstream's lane; before
    // the fix the stop waited for that lane and arrived after everything.
    plane.enqueue(startExecution());
    plane.enqueue(stopExecution());

    await waitFor("the execution to end", () => terminals().length > 0);
    expect(terminals()).toEqual(["execution.stopped"]);
    expect(plane.payloadsOf("execution.stopped")[0]?.reason).toBe("Stopped by a participant.");

    // The strongest assertion here: the turn never ran at all. A stop that
    // merely killed the process afterwards would still have left this file.
    expect(existsSync(join(userData, "worktrees", WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(false);
    expect(plane.kinds()).not.toContain("harness.session");
  }, 40_000);

  it("is idempotent: two stops for one execution end it once", async () => {
    start().discoverNow();
    plane.enqueue(startExecution());
    plane.enqueue(stopExecution());
    plane.enqueue(stopExecution());

    await waitFor("the execution to end", () => terminals().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(terminals()).toEqual(["execution.stopped"]);
  }, 40_000);

  it("stops the execution it names and not whichever one is running", async () => {
    start().discoverNow();
    plane.enqueue(startExecution());
    // A stale stop for an execution that is not this one — re-offered after a
    // relaunch, say. Before the execution id was compared it would have killed
    // whatever turn happened to be in the active slot.
    plane.enqueue(stopExecution("exe_someothererun01"));

    await waitFor("the execution to end", () => terminals().includes("execution.completed"));
    // The running turn was never touched: it completed, and its file exists.
    expect(terminals()).not.toContain("execution.stopped");
    expect(existsSync(join(userData, "worktrees", WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(true);
    // And the stale stop is answered honestly rather than swallowed (D-111):
    // the turn it named is not here, and saying so is what unwedges a
    // server-side `stopping` that no sweep would ever end. The server's
    // terminal guard makes the report a no-op when that execution already
    // ended properly.
    await waitFor("the stale stop to be answered", () =>
      terminals().includes("execution.interrupted")
    );
    expect(plane.payloadsOf("execution.interrupted")[0]?.reason).toContain("found nothing running");
  }, 40_000);

  it("stops the harness and leaves the project's own processes alone", async () => {
    start().discoverNow();
    const runCommand = await authorize("run_command", "run");
    await waitFor("the run command to start", () => plane.kinds().includes("process.started"));
    await waitFor("the run command to settle", () => plane.stateOf(runCommand.commandId) === "completed");

    plane.enqueue(startExecution());
    plane.enqueue(stopExecution());
    await waitFor("the execution to end", () => terminals().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Stop is about the harness. A dev server a participant started is not part
    // of the turn and does not end with it (D-045).
    expect(plane.kinds()).not.toContain("process.exited");
  }, 40_000);

  it("settles the stop command itself, so it is not re-offered forever", async () => {
    start().discoverNow();
    plane.enqueue(startExecution());
    const stop = stopExecution();
    plane.enqueue(stop);

    await waitFor("the stop to settle", () => plane.stateOf(stop.commandId) === "completed");
  }, 40_000);
});

/**
 * Harness approvals, driven through the agent (D-056).
 *
 * The scripted harness asks before it writes, over the same parser and the same
 * control channel the real CLI uses, so what these tests exercise is the
 * production path from `respond_approval` arriving to the blocked turn being
 * released. The bug this shape of test exists for is the one D-053 found in
 * stop, and which is strictly worse here: a decision that queues behind the
 * turn it is meant to unblock does not arrive late, it never arrives at all.
 */
describe("approving what the harness asks to do", () => {
  const EXECUTION_ID = "exe_approvaltest0001";

  /** The harness's own id for the question, read from what it actually asked. */
  const requestedId = (): string =>
    String(plane.payloadsOf("approval.requested")[0]?.requestId ?? "missing");

  const startExecution = (executionId = EXECUTION_ID): RunnerCommand => ({
    ...command("start_execution", { body: "write the fake turn file", model: "", effort: "" }),
    executionId
  });

  const decide = (
    decision: "approve" | "deny",
    executionId = EXECUTION_ID,
    reason: string | null = null
  ): RunnerCommand => ({
    ...command("respond_approval", {
      approvalId: "apr_testapproval00001",
      harnessRequestId: requestedId(),
      decision,
      reason
    }),
    executionId
  });

  const stopExecution = (executionId = EXECUTION_ID): RunnerCommand => ({
    ...command("stop_execution"),
    executionId
  });

  const terminals = (): string[] =>
    plane
      .kinds()
      .filter((kind) =>
        ["execution.completed", "execution.stopped", "execution.failed", "execution.interrupted"].includes(kind)
      );

  const writtenFile = (): string => join(userData, "worktrees", WORKSTREAM_ID, "NOVUS_FAKE_TURN.md");

  it("reports the question and does nothing further until somebody answers", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());

    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));
    const asked = plane.payloadsOf("approval.requested")[0];
    expect(asked?.toolName).toBe("Write");
    expect(String(asked?.summary)).toContain("NOVUS_FAKE_TURN.md");
    // The whole point: it is *blocked*. Nothing has been written and the turn
    // has not ended, and it stays that way for as long as nobody answers.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(terminals()).toEqual([]);
    expect(existsSync(writtenFile())).toBe(false);
    // And nothing auto-approved it on the way past.
    expect(plane.kinds()).not.toContain("approval.cancelled");
  }, 40_000);

  it("carries an approval to the blocked turn, which then does the work", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));

    const decision = decide("approve");
    plane.enqueue(decision);

    await waitFor("the execution to end", () => terminals().length > 0);
    expect(terminals()).toEqual(["execution.completed"]);
    expect(existsSync(writtenFile())).toBe(true);
    await waitFor("the decision to settle", () => plane.stateOf(decision.commandId) === "completed");
  }, 40_000);

  it("carries a denial, and the work does not happen", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));

    plane.enqueue(decide("deny", EXECUTION_ID, "Not that file."));

    await waitFor("the execution to end", () => terminals().length > 0);
    // A denial is not a failure: the turn ran, was refused, and finished.
    expect(terminals()).toEqual(["execution.completed"]);
    expect(existsSync(writtenFile())).toBe(false);
    // The harness was told why, and said so in its own words.
    expect(JSON.stringify(plane.payloadsOf("harness.text"))).toContain("Not that file.");
    // The session is intact, so the next direction continues the conversation.
    expect(plane.kinds()).toContain("harness.session");
  }, 40_000);

  it("ignores a decision that names a different execution", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));

    // A stale decision re-offered after a relaunch must not be written into
    // whichever turn happens to be running now.
    const stale = decide("approve", "exe_someothererun01");
    plane.enqueue(stale);
    await waitFor("the stale decision to settle", () => plane.stateOf(stale.commandId) === "completed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(terminals()).toEqual([]);
    expect(existsSync(writtenFile())).toBe(false);
  }, 40_000);

  it("settles a decision that arrives after the turn is over, without reviving it", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));
    const requestId = requestedId();
    plane.enqueue(stopExecution());
    await waitFor("the execution to end", () => terminals().length > 0);

    const late = {
      ...command("respond_approval", {
        approvalId: "apr_testapproval00002",
        harnessRequestId: requestId,
        decision: "approve",
        reason: null
      }),
      executionId: EXECUTION_ID
    };
    plane.enqueue(late);
    await waitFor("the late decision to settle", () => plane.stateOf(late.commandId) === "completed");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A late approval does not resume a stopped execution, and does not do the
    // work the participant refused to let happen.
    expect(terminals()).toEqual(["execution.stopped"]);
    expect(existsSync(writtenFile())).toBe(false);
  }, 40_000);

  it("declares a boundary while it is blocked, so a handoff can complete", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));
    const boundariesBefore = plane.payloadsOf("boundary.reached").length;

    // The control plane asks for a boundary because a transfer was accepted.
    // A turn blocked on a permission prompt is at one — PRODUCT.md says so —
    // and only this machine knows that, so only this machine can declare it.
    plane.enqueue(command("boundary_request", { offerId: "hof_test" }));

    await waitFor(
      "the boundary to be declared",
      () => plane.payloadsOf("boundary.reached").length > boundariesBefore
    );
    expect(plane.payloadsOf("boundary.reached").at(-1)?.reason).toBe("permission prompt pending");
    // Declaring a boundary is not answering the question: it is still open.
    expect(terminals()).toEqual([]);
    expect(existsSync(writtenFile())).toBe(false);

    plane.enqueue(decide("approve"));
    await waitFor("the execution to end", () => terminals().length > 0);
    expect(terminals()).toEqual(["execution.completed"]);
  }, 40_000);

  it("cancels the open question when the execution is stopped", async () => {
    start({ fakeApproval: true }).discoverNow();
    plane.enqueue(startExecution());
    await waitFor("the approval to be reported", () => plane.kinds().includes("approval.requested"));

    plane.enqueue(stopExecution());
    await waitFor("the execution to end", () => terminals().length > 0);

    expect(terminals()).toEqual(["execution.stopped"]);
    // The question is settled by the machine that asked it, so nothing is left
    // pending on a turn that no longer exists.
    await waitFor("the question to be cancelled", () => plane.kinds().includes("approval.cancelled"));
    expect(plane.payloadsOf("approval.cancelled")[0]?.requestId).toBe(requestedId());
    // The scripted harness has no process, so the interrupt is the whole story.
    expect(plane.payloadsOf("execution.stopped")[0]?.via).toBe("protocol_interrupt");
  }, 40_000);
});
