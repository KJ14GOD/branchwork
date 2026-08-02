import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, SequencedRunnerEvent } from "@novus/contracts";
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
    getMission: async () => ({ workstream: { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH } }),
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

function start(): RunnerAgent {
  agent = startRunnerAgent({
    api: fakeApi(),
    controlPlaneUrl: "http://control-plane.test",
    getToken: () => "a-session",
    host: host(),
    fetch: plane.fetch,
    fakeHarness: true
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
    plane.enqueue(command("run_setup"));
    start().discoverNow();

    await waitFor("readiness to be reported", () =>
      plane.payloadsOf("workspace.readiness").some((payload) => payload.readiness === "ready")
    );

    const readiness = plane.payloadsOf("workspace.readiness");
    expect(readiness.map((payload) => payload.readiness)).toEqual(["configuring", "ready"]);
    expect(readiness[1]?.portRangeStart).toBeGreaterThan(3000);
    expect(existsSync(join(userData, "worktrees", MISSION_ID, "setup-ran.txt"))).toBe(true);
    // The command ran in the worktree, never in the user's own checkout.
    expect(existsSync(join(repo, "setup-ran.txt"))).toBe(false);

    // A workspace report belongs to the workstream: no execution, its own
    // sequence, starting at one.
    for (const report of plane.reported) expect(report.executionId).toBeNull();
    const sequences = plane.events().map((item) => item.originSeq);
    expect(sequences[0]).toBe(1);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);

    await waitFor("the command to settle", () => plane.stateOf("cmd_ws0000000000000001") === "completed");
  }, 40_000);

  it("starts a run command, keeps it alive, and stops it on request", async () => {
    plane.enqueue(command("run_command"));
    start().discoverNow();

    await waitFor("the run command to start", () => plane.kinds().includes("process.started"));
    const started = plane.payloadsOf("process.started")[0];
    expect(started?.kind).toBe("run");
    expect(started?.name).toBe("dev");
    expect(String(started?.processId)).toMatch(/^prc_/);
    await waitFor("the run command to write", () =>
      existsSync(join(userData, "worktrees", MISSION_ID, "dev-ran.txt"))
    );
    // The command is acknowledged while the process carries on: a run command
    // does not hold its acknowledgement for the life of the server.
    await waitFor("the start to settle", () => plane.stateOf("cmd_ws0000000000000001") === "completed");
    expect(plane.kinds()).not.toContain("process.exited");

    plane.enqueue(command("stop_command", { name: "dev" }));
    await waitFor("the process to exit", () => plane.kinds().includes("process.exited"));
    expect(plane.payloadsOf("process.exited")[0]?.state).toBe("stopped");
    expect(plane.payloadsOf("process.exited")[0]?.processId).toBe(started?.processId);
  }, 40_000);

  it("runs a declared check and reports the revision it proves", async () => {
    plane.enqueue(command("run_verification", { name: "test" }));
    start().discoverNow();

    await waitFor("the check to complete", () => plane.kinds().includes("verification.completed"));
    const check = plane.payloadsOf("verification.completed")[0];
    expect(check?.name).toBe("test");
    expect(check?.outcome).toBe("passed");
    expect(check?.category).toBe("test");
    const head = (await git(join(userData, "worktrees", MISSION_ID), ["rev-parse", "HEAD"])).trim();
    expect(check?.checkpointSha).toBe(head);
  }, 40_000);

  it("fails the command by name when the project never declared it", async () => {
    plane.enqueue(command("run_command", { name: "not-declared" }));
    start().discoverNow();

    await waitFor("the command to fail", () => plane.stateOf("cmd_ws0000000000000001") === "failed");
    expect(plane.failures.get("cmd_ws0000000000000001")).toContain("no run command named");
    expect(plane.kinds()).not.toContain("process.started");
  }, 40_000);

  it("settles a command it already ran instead of running it twice", async () => {
    plane.enqueue(command("run_setup"));
    start().discoverNow();
    await waitFor("setup to finish", () =>
      plane.payloadsOf("workspace.readiness").some((payload) => payload.readiness === "ready")
    );
    await waitFor("the command to settle", () => plane.stateOf("cmd_ws0000000000000001") === "completed");
    await agent?.shutdown("relaunching");
    agent = null;

    // The control plane forgot the acknowledgement and offers it again.
    const stale = plane.commands[0];
    if (stale) stale.state = "acknowledged";
    const before = plane.payloadsOf("workspace.readiness").length;

    start().discoverNow();
    await waitFor("the replay to settle", () => plane.stateOf("cmd_ws0000000000000001") === "completed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plane.payloadsOf("workspace.readiness").length).toBe(before);
  }, 40_000);
});
