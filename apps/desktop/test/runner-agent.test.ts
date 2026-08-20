import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, SequencedRunnerEvent } from "@novus/contracts";
import type { ControlPlaneClient } from "../electron/api-client";
import { startRunnerAgent, type RunnerAgent, type RunnerAgentDeps, type RunnerHost } from "../electron/runner-agent";

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
  /** The mission's lanes. A second one is what a competing approach is. */
  lanes: { workstreamId: string; missionBranch: string; branchStatus: string }[] = [
    { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" }
  ];
  /** Which lane's credential is which, so a runner cannot poll another's. */
  readonly credentials = new Map<string, string>([[CREDENTIAL, WORKSTREAM_ID]]);
  turnsStarted = 0;
  /** The mission's repository, as the commands response states it. */
  provider: "local" | "github" = "local";
  providerRepoId = "local-1";
  /** Where a minted clone credential points; null refuses the route. */
  remoteUrl: string | null = null;
  /** How many clone-credential mints refuse before succeeding — the seed for
   *  the first-turn race, where the fetch is not done when the turn arrives. */
  credentialFailures = 0;
  credentialMints = 0;

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
    const header = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    const lane = this.credentials.get(header.replace("Runner ", ""));
    if (!lane) return json({ error: "no" }, 401);

    if (url.pathname === "/runner/commands") {
      // A lane is offered its own commands and nobody else's, exactly as the
      // real control plane scopes them to the credential (D-035).
      const offered = this.commands.filter(
        (command) =>
          command.workstreamId === lane && command.state !== "completed" && command.state !== "failed"
      );
      for (const command of offered) if (command.state === "pending") command.state = "delivered";
      const branch = this.lanes.find((entry) => entry.workstreamId === lane)?.missionBranch ?? MISSION_BRANCH;
      return json({
        commands: offered.map(({ state: _state, ...command }) => command),
        workstream: {
          workstreamId: lane,
          missionId: MISSION_ID,
          missionBranch: branch,
          baseSha: BASE_SHA,
          provider: this.provider,
          providerRepoId: this.providerRepoId,
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

    if (url.pathname === "/runner/clone-credential") {
      this.credentialMints += 1;
      if (this.credentialFailures > 0) {
        this.credentialFailures -= 1;
        return json({ error: { code: "minting_refused", message: "the seeded mint refusal" } }, 503);
      }
      if (!this.remoteUrl) return json({ error: { code: "no_remote", message: "no remote here" } }, 404);
      return json({
        remoteUrl: this.remoteUrl,
        username: "x-access-token",
        token: "seeded-clone-token",
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      });
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
    // Every lane of the mission, which is how the agent discovers what to
    // enrol for: one here, and one more for every approach (D-074).
    getMission: async () => ({
      workstream: { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" },
      workstreams: plane.lanes
    }),
    registerRunner: async (workstreamId: string) => {
      plane.registrations.push(workstreamId);
      // One credential per lane, which is what makes two approaches on one
      // machine two runners rather than one with two jobs.
      const credential = workstreamId === WORKSTREAM_ID ? CREDENTIAL : `${CREDENTIAL}-${workstreamId}`;
      plane.credentials.set(credential, workstreamId);
      return {
        runnerId: `rnr_${workstreamId}`,
        credential,
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

function start(overrides: Partial<RunnerAgentDeps> = {}): RunnerAgent {
  agent = startRunnerAgent({
    api: fakeApi(plane),
    controlPlaneUrl: "http://control-plane.test",
    getToken: () => "a-session",
    host: host(),
    fetch: plane.fetch,
    fakeHarness: true,
    ...overrides
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

    // Reported in order and exactly once — **per stream**, which is what the
    // outbox actually guarantees: a sequence is monotonic within one
    // execution, and the workstream has a stream of its own for what happens
    // outside a turn (the workspace manifest publish, D-186/D-193). Asserting
    // one sorted run across both was only ever true while this fixture
    // happened to emit nothing on the workstream stream.
    // A delivery names the stream its batch belongs to; the events inside
    // carry only their sequence within it.
    const streams = new Map<string, number[]>();
    for (const delivery of plane.reported) {
      const key = delivery.executionId ?? "workstream";
      streams.set(key, [
        ...(streams.get(key) ?? []),
        ...delivery.batch.map((item) => item.originSeq)
      ]);
    }
    expect(streams.has(EXECUTION_ID)).toBe(true);
    for (const [, sequences] of streams) {
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences[0]).toBe(1);
    }
    // Every delivery that names an execution names the one the command did.
    for (const delivery of plane.reported) {
      if (delivery.executionId !== null) expect(delivery.executionId).toBe(EXECUTION_ID);
    }

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
  /**
   * A machine that died mid-turn, reconstructed the only way a test can: the
   * memory file a killed launch would have left behind. Killing the real
   * process is what happens in production; what matters here is the decision
   * the next launch makes about what it finds.
   */
  function abandonedCommand(commandId: string, executionId: string | null): void {
    writeFileSync(
      join(userData, "runner-commands.json"),
      JSON.stringify({ version: 2, commands: [{ id: commandId, state: "started", executionId }] })
    );
  }

  it("does not run a turn a killed launch had already started", async () => {
    plane.enqueue(command());
    // The control plane saw the acknowledgement and is offering it again,
    // which is exactly what a runner that crashed mid-turn comes back to.
    const offered = plane.commands.find((candidate) => candidate.commandId === "cmd_first00000000000000");
    if (offered) offered.state = "acknowledged";
    abandonedCommand("cmd_first00000000000000", EXECUTION_ID);

    start().discoverNow();

    await waitFor("the command to settle", () => plane.stateOf("cmd_first00000000000000") === "failed");
    // The whole point: no second harness process, no second checkpoint, no
    // second commit against a worktree the first attempt had already changed.
    expect(plane.turnsStarted).toBe(0);
    expect(plane.kinds()).not.toContain("workspace.checkpoint");
    // And the room is told the truth rather than left saying Running until the
    // liveness sweep gets to it ninety seconds later.
    expect(plane.kinds()).toContain("execution.interrupted");
    const interrupted = plane
      .events()
      .find((item) => item.event.kind === "execution.interrupted")?.event as
      | { payload: { reason: string } }
      | undefined;
    expect(interrupted?.payload.reason).toMatch(/restarted/i);
  }, 30_000);

  it("keeps its memory of an abandoned command across a second relaunch", async () => {
    abandonedCommand("cmd_first00000000000000", EXECUTION_ID);
    plane.enqueue(command());
    const offered = plane.commands.find((candidate) => candidate.commandId === "cmd_first00000000000000");
    if (offered) offered.state = "acknowledged";

    start().discoverNow();
    await waitFor("the first settlement", () => plane.stateOf("cmd_first00000000000000") === "failed");
    await agent?.shutdown("relaunching");
    agent = null;

    // The control plane forgets again and re-offers the same command. A
    // machine that answered "I began that and lost it" once must not later
    // answer "never seen it" and run the turn after all.
    if (offered) offered.state = "acknowledged";
    start().discoverNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(plane.turnsStarted).toBe(0);
  }, 30_000);

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

/**
 * A mission with a competing approach, on one machine (D-074).
 *
 * The claim being tested is isolation, and it is structural: two lanes get two
 * enrolments, two credentials, and two worktrees. There is no code path where
 * one approach's turn can see the other's files, because there is no directory
 * they share.
 */
describe("two approaches on one machine", () => {
  const APPROACH_ID = "wst_agentapproach";
  const APPROACH_BRANCH = "novus/m-ag3nt001-a2";

  it("enrols for both lanes and gives each its own worktree", async () => {
    await git(repo, ["branch", APPROACH_BRANCH]);
    plane.lanes = [
      { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" },
      { workstreamId: APPROACH_ID, missionBranch: APPROACH_BRANCH, branchStatus: "created" }
    ];
    // One command per lane, each naming its own execution.
    plane.enqueue(command());
    plane.enqueue(
      command({
        commandId: "cmd_approach0000000000",
        workstreamId: APPROACH_ID,
        executionId: "exe_agentapproach",
        payload: {
          directionId: "dir_approach00000000",
          body: "Try it the other way",
          model: "claude-fable-5",
          effort: "high",
          resumeSessionId: null
        }
      })
    );

    start().discoverNow();
    await waitFor(
      "both turns to finish",
      () =>
        plane.reported.filter((delivery) =>
          delivery.batch.some((item) => item.event.kind === "execution.completed")
        ).length === 2,
      30_000
    );

    // Two enrolments, one per lane — not one runner serving both.
    expect(new Set(plane.registrations)).toEqual(new Set([WORKSTREAM_ID, APPROACH_ID]));

    // Two worktrees, keyed by lane. The mission-keyed directory the old build
    // used does not exist at all, which is the point: there is nothing shared.
    const worktrees = join(userData, "worktrees");
    expect(existsSync(join(worktrees, WORKSTREAM_ID))).toBe(true);
    expect(existsSync(join(worktrees, APPROACH_ID))).toBe(true);
    expect(existsSync(join(worktrees, MISSION_ID))).toBe(false);

    // Each turn's file landed in its own lane, on its own branch.
    const baseline = (await git(join(worktrees, WORKSTREAM_ID), ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const approach = (await git(join(worktrees, APPROACH_ID), ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    expect(baseline).toBe(MISSION_BRANCH);
    expect(approach).toBe(APPROACH_BRANCH);
    expect(existsSync(join(worktrees, WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(true);
    expect(existsSync(join(worktrees, APPROACH_ID, "NOVUS_FAKE_TURN.md"))).toBe(true);
  }, 60_000);
});

/**
 * The first-turn race the live GitHub proof observed (2026-08-16): the
 * mission's first direction is dispatched the moment this machine takes the
 * lane, and taking the lane necessarily precedes the fetch — the clone
 * credential is minted over the runner credential. Before the guard, the turn
 * settled failed with `invalid reference` (checkout present, branch absent) or
 * the misdiagnosed "lives on another machine" (no checkout at all). Both
 * shapes are seeded here: the first credential mint refuses, so discovery's
 * own fetch deterministically has not happened when the command arrives.
 */
describe("a GitHub lane's turn waits for the fetch it raced", () => {
  const GH_REPO = "gh-race-1";
  let seed: string;
  let bare: string;
  let server: Server | null = null;
  let remoteUrl = "";
  let paths: Map<string, string>;

  /** A dumb-HTTP git remote on loopback: enough for clone and fetch, no auth
   *  — credential hygiene is workspace-clone.test.ts's subject, not this one's. */
  async function serveBare(): Promise<void> {
    await git(bare, ["update-server-info"]);
    server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://remote").pathname).replace(
        /^\/repo\.git/,
        ""
      );
      const file = join(bare, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        response.statusCode = 404;
        return response.end();
      }
      response.end(readFileSync(file));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server!.address() as { port: number }).port;
    remoteUrl = `http://127.0.0.1:${port}/repo.git`;
  }

  function githubApi(): ControlPlaneClient {
    return {
      listMissions: async () => [
        { missionId: MISSION_ID, repository: { provider: "github", providerRepoId: GH_REPO } }
      ],
      getMission: async () => ({
        workstream: { workstreamId: WORKSTREAM_ID, missionBranch: MISSION_BRANCH, branchStatus: "created" },
        workstreams: plane.lanes,
        runner: null
      }),
      registerRunner: async (workstreamId: string) => {
        plane.registrations.push(workstreamId);
        plane.credentials.set(CREDENTIAL, workstreamId);
        // The race itself: the control plane dispatches the controller's
        // queued first direction the moment the runner enrols, while the
        // fetch this enrolment makes possible has not begun.
        plane.enqueue(command());
        return {
          runnerId: `rnr_${workstreamId}`,
          credential: CREDENTIAL,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        };
      }
    } as unknown as ControlPlaneClient;
  }

  function githubHost(): RunnerHost {
    return {
      userDataPath: userData,
      isPackaged: false,
      label: "test-machine",
      repositoryPath: (providerRepoId) => paths.get(providerRepoId) ?? null,
      recordRepositoryPath: (providerRepoId, repoPath) => paths.set(providerRepoId, repoPath)
    };
  }

  beforeEach(async () => {
    paths = new Map();
    plane.provider = "github";
    plane.providerRepoId = GH_REPO;
    // Discovery's own mint eats this refusal inside the enrolment pass, so the
    // checkout deterministically does not exist when the command is delivered.
    plane.credentialFailures = 1;
    seed = mkdtempSync(join(tmpdir(), "novus-gh-seed-"));
    bare = mkdtempSync(join(tmpdir(), "novus-gh-bare-"));
    await git(seed, ["init", "-b", "main"]);
    await git(seed, ["config", "user.name", "Test"]);
    await git(seed, ["config", "user.email", "test@local"]);
    writeFileSync(join(seed, "README.md"), "# origin fixture\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "-m", "init"]);
    await git(seed, ["branch", MISSION_BRANCH]);
    rmSync(bare, { recursive: true, force: true });
    await git(seed, ["clone", "--bare", seed, bare]);
    await serveBare();
    plane.remoteUrl = remoteUrl;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(seed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it("with no checkout at all: fetches, then runs, instead of failing as another machine's", async () => {
    start({ api: githubApi(), host: githubHost() });

    await waitFor(
      "the raced first turn to complete",
      () => plane.stateOf("cmd_first00000000000000") === "completed",
      30_000
    );
    expect(plane.kinds()).toContain("execution.completed");
    expect(plane.kinds()).not.toContain("execution.failed");
    // Two mints: the seeded refusal discovery ate, then the turn's own.
    expect(plane.credentialMints).toBeGreaterThanOrEqual(2);
    // The turn ran in a real worktree of the fetched checkout, on the branch.
    const worktree = join(userData, "worktrees", WORKSTREAM_ID);
    expect((await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(MISSION_BRANCH);
  }, 60_000);

  it("with the checkout present but the branch unfetched: fetches the branch instead of `invalid reference`", async () => {
    // A previous mission's checkout: the repository is here, this mission's
    // branch is not — the exact shape behind `fatal: invalid reference`.
    const checkout = join(userData, "repositories", GH_REPO);
    await git(userData, ["clone", "--single-branch", "--branch", "main", bare, checkout]);
    paths.set(GH_REPO, checkout);

    start({ api: githubApi(), host: githubHost() });

    await waitFor(
      "the branch-fetching turn to complete",
      () => plane.stateOf("cmd_first00000000000000") === "completed",
      30_000
    );
    expect(plane.kinds()).toContain("execution.completed");
    expect(plane.kinds()).not.toContain("execution.failed");
    const worktree = join(userData, "worktrees", WORKSTREAM_ID);
    expect((await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(MISSION_BRANCH);
  }, 60_000);
});
