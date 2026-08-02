import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, SequencedRunnerEvent } from "@novus/contracts";
import type { ControlPlaneClient } from "../electron/api-client";
import { startRunnerAgent, type RunnerAgent, type RunnerHost } from "../electron/runner-agent";

/**
 * The agent itself, driven end to end against a stubbed control plane and the
 * scripted harness. The pure modules were all green while a real command
 * produced nothing at all — delivered, acknowledged, then silence — because a
 * binding inside the agent was never initialized. Only standing the agent up
 * and pushing one command through it can catch that class of fault, so that is
 * what these do.
 */

const MISSION_ID = "msn_agenttest";
const WORKSTREAM_ID = "wst_agenttest";
const EXECUTION_ID = "exe_agenttest";
const MISSION_BRANCH = "novus/m-ag3nt001";
const BASE_SHA = "a".repeat(40);
const CREDENTIAL = "runner-credential-for-the-agent-test";

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

/**
 * Just enough control plane to answer the three runner routes, with the same
 * rule the real one now follows: a command stops being offered only once it is
 * settled, so an acknowledged one survives a relaunch.
 */
class FakeControlPlane {
  readonly reported: { executionId: string; batch: SequencedRunnerEvent[] }[] = [];
  readonly commands: QueuedCommand[] = [];
  readonly registrations: string[] = [];
  turnsStarted = 0;

  enqueue(command: Omit<QueuedCommand, "state">): void {
    this.commands.push({ ...command, state: "pending" });
  }

  events(): SequencedRunnerEvent[] {
    return this.reported.flatMap((delivery) => delivery.batch);
  }

  kinds(): string[] {
    return this.events().map((item) => item.event.kind);
  }

  stateOf(commandId: string): string | undefined {
    return this.commands.find((command) => command.commandId === commandId)?.state;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const authorized = String((init?.headers as Record<string, string> | undefined)?.authorization);
    if (authorized !== `Runner ${CREDENTIAL}`) return json({ error: "no" }, 401);

    if (url.pathname === "/runner/commands") {
      const offered = this.commands.filter((command) => command.state !== "completed" && command.state !== "failed");
      for (const command of offered) if (command.state === "pending") command.state = "delivered";
      return json({
        commands: offered.map(({ state: _state, ...command }) => command),
        workstream: {
          workstreamId: WORKSTREAM_ID,
          missionId: MISSION_ID,
          missionBranch: MISSION_BRANCH,
          baseSha: BASE_SHA,
          provider: "local",
          providerRepoId: "local-1",
          harnessSessionId: null
        }
      });
    }

    if (url.pathname.startsWith("/runner/commands/")) {
      const commandId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { state: QueuedCommand["state"] };
      const command = this.commands.find((candidate) => candidate.commandId === commandId);
      if (command && command.state !== "completed" && command.state !== "failed") command.state = body.state;
      return json({ ok: true });
    }

    if (url.pathname === "/runner/events") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        executionId: string;
        events: SequencedRunnerEvent[];
      };
      this.reported.push({ executionId: body.executionId, batch: body.events });
      for (const item of body.events) if (item.event.kind === "execution.starting") this.turnsStarted += 1;
      return json({ ok: true, accepted: body.events.length, duplicates: 0 });
    }

    return json({ error: "not found" }, 404);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Only the three calls the agent actually makes on the client. */
function fakeApi(plane: FakeControlPlane): ControlPlaneClient {
  return {
    listMissions: async () => [
      {
        missionId: MISSION_ID,
        repository: { provider: "local", providerRepoId: "local-1" }
      }
    ],
    getMission: async () => ({ workstream: { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH } }),
    registerRunner: async (workstreamId: string) => {
      plane.registrations.push(workstreamId);
      return {
        runnerId: "rnr_agenttest",
        credential: CREDENTIAL,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      };
    }
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
    api: fakeApi(plane),
    controlPlaneUrl: "http://control-plane.test",
    getToken: () => "a-session",
    host: host(),
    fetch: plane.fetch,
    fakeHarness: true
  });
  return agent;
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const command = (overrides: Partial<RunnerCommand> = {}): RunnerCommand => ({
  commandId: "cmd_first00000000000000",
  kind: "start_execution",
  workstreamId: WORKSTREAM_ID,
  missionId: MISSION_ID,
  executionId: EXECUTION_ID,
  seq: 1,
  payload: {
    directionId: "dir_first0000000000000",
    body: "Add a session-expiry guard",
    model: "claude-fable-5",
    effort: "high",
    resumeSessionId: null
  },
  createdAt: new Date().toISOString(),
  ...overrides
});

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-agent-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-agent-userdata-"));
  plane = new FakeControlPlane();
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
});

afterEach(async () => {
  await agent?.shutdown("test over");
  agent = null;
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe("the agent driving one command", () => {
  it("enrols, runs the turn, and reports it — the whole way through", async () => {
    plane.enqueue(command());
    const running = start();
    running.discoverNow();

    await waitFor("the turn to be reported complete", () => plane.kinds().includes("execution.completed"));

    // The bug this test exists for produced exactly none of these.
    const kinds = plane.kinds();
    expect(kinds).toContain("execution.starting");
    expect(kinds).toContain("execution.running");
    expect(kinds).toContain("harness.session");
    expect(kinds).toContain("direction.applied");
    expect(kinds).toContain("boundary.reached");
    expect(kinds).toContain("workspace.checkpoint");
    expect(kinds).toContain("execution.completed");

    // Reported in order, once, for the execution the command named.
    const sequences = plane.events().map((item) => item.originSeq);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
    for (const delivery of plane.reported) expect(delivery.executionId).toBe(EXECUTION_ID);

    await waitFor("the command to settle", () => plane.stateOf("cmd_first00000000000000") === "completed");
    expect(plane.registrations).toEqual([WORKSTREAM_ID]);

    // Applied is claimed only once the harness took the turn.
    const applied = plane.events().findIndex((item) => item.event.kind === "direction.applied");
    const session = plane.events().findIndex((item) => item.event.kind === "harness.session");
    expect(applied).toBeGreaterThan(session);
  }, 30_000);

  it("keeps the credential out of everything it reports", async () => {
    plane.enqueue(command());
    start().discoverNow();
    await waitFor("the turn to finish", () => plane.kinds().includes("execution.completed"));
    expect(JSON.stringify(plane.reported)).not.toContain(CREDENTIAL);
  }, 30_000);

  it("ends the execution even when the command was an apply against a live run", async () => {
    plane.enqueue(command({ commandId: "cmd_apply000000000000", kind: "apply_direction" }));
    start().discoverNow();

    // The command is `acknowledged` while its own turn runs, and the control
    // plane still offers acknowledged rows: the turn must not count itself as
    // more work and hang the execution open forever.
    await waitFor("the applied turn to terminate", () => plane.kinds().includes("execution.completed"));
    expect(plane.kinds()).toContain("direction.applied");
    await waitFor("the command to settle", () => plane.stateOf("cmd_apply000000000000") === "completed");
  }, 30_000);
});

describe("replay after a relaunch", () => {
  it("settles a command it already ran instead of running it twice", async () => {
    plane.enqueue(command());
    start().discoverNow();
    await waitFor("the first turn", () => plane.kinds().includes("execution.completed"));
    await waitFor("the command to settle", () => plane.stateOf("cmd_first00000000000000") === "completed");
    await agent?.shutdown("relaunching");
    agent = null;
    expect(plane.turnsStarted).toBe(1);

    // The control plane forgot the acknowledgement — the command is offered
    // again to a fresh agent on the same machine.
    const stale = plane.commands.find((candidate) => candidate.commandId === "cmd_first00000000000000");
    if (stale) stale.state = "acknowledged";

    start().discoverNow();
    await waitFor("the replay to settle", () => plane.stateOf("cmd_first00000000000000") === "completed");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(plane.turnsStarted).toBe(1);
  }, 30_000);
});
