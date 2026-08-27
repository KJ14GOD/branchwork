import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { RunnerCommand, SequencedRunnerEvent } from "@novus/contracts";
import type { ControlPlaneClient } from "../electron/api-client";
import { startRunnerAgent, type RunnerAgent, type RunnerHost } from "../electron/runner-agent";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clonedRepositoryRoot,
  ensureRepositoryClone,
  isClonePresent,
  RepositoryCloneError,
  type CloneCredential
} from "../electron/workspace-clone";
import { ensureWorkspaceWorktree } from "../electron/workspace";
import { gitExec } from "../electron/workspace-git";

/**
 * Fetching a GitHub repository onto this machine, against a real git and a
 * real HTTP remote on loopback that demands a credential — no network, and no
 * stub standing in for the part that matters.
 *
 * The part that matters is the credential. ARCHITECTURE.md#the-supervisorharness-boundary
 * says it is injected per operation and never written to disk or exported into
 * an environment; a test that faked the transport would prove none of that. So
 * the remote here really does answer 401 until it is authenticated, and the
 * tests then go looking for the token everywhere it is not allowed to be.
 */

const TOKEN = "ghs_a_token_that_must_not_survive";
const OLD_BRANCH = "novus/m-old00001";
const NEW_BRANCH = "novus/m-new00002";
const LATER_BRANCH = "novus/m-later003";

let root: string;
let source: string;
let origin: string;
let userData: string;
let remote: Remote | null = null;
let agent: RunnerAgent | null = null;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** The commit a branch points at on the server — the fact a worktree has to
 *  match, because the server allocated that branch at that commit. */
const originSha = (branch: string): string => git(origin, ["rev-parse", branch]);

interface Remote {
  url: string;
  /** Every `user:password` the remote was actually presented with. */
  seen: string[];
  close(): Promise<void>;
}

/**
 * A git remote over HTTP that refuses anonymous access, so a clone only
 * succeeds if a credential really reached git. Serves the bare repository's
 * files (the dumb protocol) — enough for git to clone and fetch, and small
 * enough to be honest about what it is.
 */
async function startRemote(options: { accept: boolean }): Promise<Remote> {
  git(origin, ["update-server-info"]);
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Basic ")) {
      seen.push(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8"));
    }
    const authenticated = authorization.startsWith("Basic ") && options.accept;
    if (!authenticated) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="novus"' });
      response.end("authentication required");
      return;
    }
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://remote").pathname).replace(
      /^\/repo\.git/,
      ""
    );
    const file = join(origin, path);
    if (!file.startsWith(origin) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const credentialFor = (url: string): CloneCredential => ({
  remoteUrl: url,
  username: "x-access-token",
  token: TOKEN
});

/** Every byte under a directory, so "the token is nowhere" can be checked
 *  rather than asserted. */
function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function holdsToken(directory: string): string[] {
  return filesUnder(directory).filter((file) => readFileSync(file).includes(TOKEN));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "novus-clone-"));
  userData = mkdtempSync(join(tmpdir(), "novus-clone-userdata-"));
  source = join(root, "source");
  origin = join(root, "origin.git");

  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, ["config", "user.email", "test@local"]);
  git(source, ["config", "user.name", "Test"]);
  writeFileSync(join(source, "README.md"), "# fixture\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-qm", "initial"]);
  // The older mission branch: a workstream allocated before the next commit.
  git(source, ["branch", OLD_BRANCH]);
  writeFileSync(join(source, "CHANGELOG.md"), "# later\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-qm", "second"]);
  // The newer one, allocated at a different commit — so a worktree made from
  // the wrong branch is visibly the wrong tree.
  git(source, ["branch", NEW_BRANCH]);
  execFileSync("git", ["clone", "-q", "--bare", source, origin]);
});

/** Restores anything a test replaced globally (console, for one). */
let onCleanup: (() => void) | null = null;

afterEach(async () => {
  onCleanup?.();
  onCleanup = null;
  await agent?.shutdown("test over");
  agent = null;
  await remote?.close();
  remote = null;
  rmSync(root, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

describe("fetching a repository this machine does not have", () => {
  it("clones it with a credential injected for that operation", async () => {
    remote = await startRemote({ accept: true });

    const checkout = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      missionBranch: OLD_BRANCH,
      credential: credentialFor(remote.url)
    });

    expect(checkout.cloned).toBe(true);
    expect(isClonePresent(checkout.path)).toBe(true);
    // The remote refuses anonymous access, so this is proof the credential
    // reached git — through the helper, not through the URL.
    expect(remote.seen).toContain(`x-access-token:${TOKEN}`);
    // The mission branch the server allocated, at the commit the server has.
    expect(git(checkout.path, ["rev-parse", OLD_BRANCH])).toBe(originSha(OLD_BRANCH));
    // In Novus's own area, not a folder anybody added by hand.
    expect(checkout.path.startsWith(clonedRepositoryRoot(userData))).toBe(true);
  });

  it("keeps the token out of .git/config and off the disk entirely", async () => {
    remote = await startRemote({ accept: true });
    const checkout = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      missionBranch: OLD_BRANCH,
      credential: credentialFor(remote.url)
    });

    const config = readFileSync(join(checkout.path, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain("x-access-token");
    expect(config).not.toContain("credential");
    // The remote that persists is the plain one it was given.
    expect(config).toContain(remote.url);

    // Not in a helper script, a log, a FETCH_HEAD, or anywhere else.
    expect(holdsToken(checkout.path)).toEqual([]);
    expect(holdsToken(userData)).toEqual([]);
  });

  it("never lets the machine's own credential helper answer for Novus", async () => {
    // Identity is not repository authorization (D-031): a personal token in
    // someone's keychain must not quietly do Novus's fetching.
    const home = mkdtempSync(join(tmpdir(), "novus-clone-home-"));
    writeFileSync(
      join(home, ".gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=someone-else; echo password=a-personal-token; }; f"\n'
    );
    const realHome = process.env.HOME;
    process.env.HOME = home;
    remote = await startRemote({ accept: true });
    try {
      await ensureRepositoryClone({
        root: clonedRepositoryRoot(userData),
        providerRepoId: "9001",
        missionBranch: OLD_BRANCH,
        credential: credentialFor(remote.url)
      });
    } finally {
      process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(remote.seen).toContain(`x-access-token:${TOKEN}`);
    expect(remote.seen.join("|")).not.toContain("a-personal-token");
  });
});

describe("a second workstream on the same repository", () => {
  it("shares the checkout and takes its own worktree from its own branch", async () => {
    remote = await startRemote({ accept: true });
    const request = {
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      credential: credentialFor(remote.url)
    };

    const first = await ensureRepositoryClone({ ...request, missionBranch: OLD_BRANCH });
    const second = await ensureRepositoryClone({ ...request, missionBranch: NEW_BRANCH });

    expect(first.cloned).toBe(true);
    // Cloned once, reused afterwards — exactly as two missions on one local
    // folder already work.
    expect(second.cloned).toBe(false);
    expect(second.path).toBe(first.path);

    // The ordinary worktree path, unchanged, on a repository it did not fetch.
    const older = await ensureWorkspaceWorktree(gitExec, first.path, userData, "wst_older", OLD_BRANCH);
    const newer = await ensureWorkspaceWorktree(gitExec, second.path, userData, "wst_newer", NEW_BRANCH);

    expect(git(older, ["rev-parse", "HEAD"])).toBe(originSha(OLD_BRANCH));
    expect(git(newer, ["rev-parse", "HEAD"])).toBe(originSha(NEW_BRANCH));
    // Different revisions, so a worktree made from the wrong branch would show.
    expect(existsSync(join(older, "CHANGELOG.md"))).toBe(false);
    expect(existsSync(join(newer, "CHANGELOG.md"))).toBe(true);
    expect(git(first.path, ["worktree", "list"]).split("\n")).toHaveLength(3);
  });

  it("fetches a branch the server allocated after this machine cloned", async () => {
    remote = await startRemote({ accept: true });
    const request = {
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      credential: credentialFor(remote.url)
    };
    const first = await ensureRepositoryClone({ ...request, missionBranch: OLD_BRANCH });
    expect(git(first.path, ["branch", "--list", LATER_BRANCH])).toBe("");

    // The control plane allocates the next workstream's branch on the remote.
    git(origin, ["branch", LATER_BRANCH, NEW_BRANCH]);
    git(origin, ["update-server-info"]);

    const later = await ensureRepositoryClone({ ...request, missionBranch: LATER_BRANCH });
    const worktree = await ensureWorkspaceWorktree(gitExec, later.path, userData, "wst_later", LATER_BRANCH);

    expect(later.cloned).toBe(false);
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(originSha(LATER_BRANCH));
  });

  it("prepares one worktree when two callers ask for it at the same moment", async () => {
    // The runner's turn path and whatever the person just did — open a
    // terminal, list files — ask for the same worktree routinely. Unserialised
    // they interleave destructively: preparation reads "is it already there"
    // and then deletes what it found, so the loser removes the directory the
    // winner has just created and returned (D-058).
    remote = await startRemote({ accept: true });
    const request = {
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      credential: credentialFor(remote.url)
    };
    const checkout = await ensureRepositoryClone({ ...request, missionBranch: OLD_BRANCH });
    const asked = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureWorkspaceWorktree(gitExec, checkout.path, userData, "wst_contended0000000", OLD_BRANCH)
      )
    );

    // Every caller gets the same path, and that path is a real worktree on the
    // right branch *after all of them have returned* — which is the assertion
    // that fails when one caller has deleted another's.
    expect(new Set(asked).size).toBe(1);
    const worktree = asked[0] as string;
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(OLD_BRANCH);
  }, 90_000);

  it("never moves a mission branch that already has work on it", async () => {
    remote = await startRemote({ accept: true });
    const request = {
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      credential: credentialFor(remote.url)
    };
    const checkout = await ensureRepositoryClone({ ...request, missionBranch: OLD_BRANCH });

    // A checkpoint commit that has not been published yet.
    const worktree = await ensureWorkspaceWorktree(gitExec, checkout.path, userData, "wst_work", OLD_BRANCH);
    writeFileSync(join(worktree, "WORK.md"), "# a turn happened\n");
    git(worktree, ["-c", "user.email=t@l", "-c", "user.name=T", "add", "-A"]);
    git(worktree, ["-c", "user.email=t@l", "-c", "user.name=T", "commit", "-qm", "checkpoint"]);
    const checkpoint = git(worktree, ["rev-parse", "HEAD"]);

    await ensureRepositoryClone({ ...request, missionBranch: OLD_BRANCH });

    // Fetched, never merged, rebased, or reset (D-025).
    expect(git(checkout.path, ["rev-parse", OLD_BRANCH])).toBe(checkpoint);
  });
});

describe("when the repository cannot be fetched", () => {
  it("fails with a named error and leaves no half-built checkout", async () => {
    remote = await startRemote({ accept: false });
    const root = clonedRepositoryRoot(userData);

    const failure = await ensureRepositoryClone({
      root,
      providerRepoId: "9001",
      missionBranch: OLD_BRANCH,
      credential: credentialFor(remote.url)
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RepositoryCloneError);
    const error = failure as RepositoryCloneError;
    expect(error.code).toBe("clone_failed");
    expect(error.message).toContain("could not clone");
    // Nothing the runtime could mistake for a repository, and nothing
    // half-written beside it.
    expect(isClonePresent(join(root, "9001"))).toBe(false);
    expect(existsSync(join(root, "9001"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.includes("incoming"))).toEqual([]);
    // A refusal is allowed to explain itself; it is not allowed to quote the
    // token or name a folder on this machine.
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(root);
  });

  it("names a mission branch the remote does not have", async () => {
    remote = await startRemote({ accept: true });
    const failure = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      missionBranch: "novus/m-neverm4de",
      credential: credentialFor(remote.url)
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RepositoryCloneError);
    expect((failure as RepositoryCloneError).code).toBe("fetch_failed");
  });

  it("refuses anything but a server-allocated mission branch", async () => {
    const failure = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      missionBranch: "main",
      credential: credentialFor("https://github.com/novus/demo.git")
    }).catch((error: unknown) => error);

    expect((failure as RepositoryCloneError).code).toBe("bad_branch");
  });

  it("refuses a remote with a credential baked into it", async () => {
    const failure = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "9001",
      missionBranch: OLD_BRANCH,
      credential: credentialFor(`https://x-access-token:${TOKEN}@github.com/novus/demo.git`)
    }).catch((error: unknown) => error);

    expect((failure as RepositoryCloneError).code).toBe("bad_remote");
  });

  it("refuses a repository id that would climb out of its own folder", async () => {
    const failure = await ensureRepositoryClone({
      root: clonedRepositoryRoot(userData),
      providerRepoId: "../../elsewhere",
      missionBranch: OLD_BRANCH,
      credential: credentialFor("https://github.com/novus/demo.git")
    }).catch((error: unknown) => error);

    expect((failure as RepositoryCloneError).code).toBe("bad_repository");
  });
});

// --- The runner, end to end, on a repository it fetched -----------------------

const MISSION_ID = "msn_fetched";
const WORKSTREAM_ID = "wst_fetched";
const EXECUTION_ID = "exe_fetched";
const CREDENTIAL = "runner-credential-for-the-fetched-repository";

interface QueuedCommand extends RunnerCommand {
  state: "pending" | "delivered" | "acknowledged" | "completed" | "failed";
}

/** Just enough control plane to answer the runner routes this path uses,
 *  including the one that hands over repository access. */
class FakeControlPlane {
  readonly reported: { executionId: string | null; batch: SequencedRunnerEvent[] }[] = [];
  readonly commands: QueuedCommand[] = [];
  credentialRequests = 0;

  constructor(private readonly remoteUrl: string) {}

  enqueue(command: RunnerCommand): void {
    this.commands.push({ ...command, state: "pending" });
  }

  kinds(): string[] {
    return this.reported.flatMap((delivery) => delivery.batch).map((item) => item.event.kind);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization);
    if (authorization !== `Runner ${CREDENTIAL}`) return json({ error: { code: "no", message: "no" } }, 401);

    if (url.pathname === "/runner/clone-credential") {
      this.credentialRequests += 1;
      return json({
        remoteUrl: this.remoteUrl,
        username: "x-access-token",
        token: TOKEN,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      });
    }
    if (url.pathname === "/runner/commands") {
      const offered = this.commands.filter((command) => command.state !== "completed" && command.state !== "failed");
      for (const command of offered) if (command.state === "pending") command.state = "delivered";
      return json({
        commands: offered.map(({ state: _state, ...command }) => command),
        workstream: {
          workstreamId: WORKSTREAM_ID,
          missionId: MISSION_ID,
          missionBranch: OLD_BRANCH,
          baseSha: originSha(OLD_BRANCH),
          provider: "github",
          providerRepoId: "9001",
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
        executionId: string | null;
        events: SequencedRunnerEvent[];
      };
      this.reported.push({ executionId: body.executionId, batch: body.events });
      return json({ ok: true, accepted: body.events.length, duplicates: 0 });
    }
    return json({ error: { code: "not_found", message: "no" } }, 404);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Missions the fake control plane is currently serving, so a test can add a
 *  second workstream on the same repository the way the server would. */
interface FakeMission {
  missionId: string;
  workstreamId: string;
  missionBranch: string;
}

function fakeApi(registrations: string[], missions?: FakeMission[]): ControlPlaneClient {
  const served = missions ?? [
    { missionId: MISSION_ID, workstreamId: WORKSTREAM_ID, missionBranch: OLD_BRANCH }
  ];
  return {
    listMissions: async () =>
      served.map((mission) => ({
        missionId: mission.missionId,
        repository: { provider: "github", providerRepoId: "9001" }
      })),
    getMission: async (missionId: string) => {
      const found = served.find((mission) => mission.missionId === missionId) ?? served[0];
      return {
        workstream: {
          workstreamId: found?.workstreamId,
          missionBranch: found?.missionBranch,
          // The server allocated the branch; that is what makes it fetchable.
          branchStatus: "created"
        },
        runner: null
      };
    },
    registerRunner: async (workstreamId: string) => {
      registrations.push(workstreamId);
      return {
        runnerId: "rnr_fetched",
        credential: CREDENTIAL,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      };
    }
  } as unknown as ControlPlaneClient;
}

/** Generous by design: what these wait for is a real clone over a real HTTP
 *  remote, a real worktree, and a real turn, and the suite runs on whatever
 *  machine it runs on. A deterministic test that fails on a busy laptop is not
 *  evidence of anything. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the runner on a repository it fetched", () => {
  it("enrols, fetches, and then runs a turn with no case for GitHub anywhere", async () => {
    remote = await startRemote({ accept: true });
    const plane = new FakeControlPlane(remote.url);
    const registrations: string[] = [];
    // The machine-local map, exactly as `local-repos.ts` keeps it: a folder the
    // user picked and a checkout Novus fetched are the same entry.
    const machineMap = new Map<string, string>();
    const host: RunnerHost = {
      userDataPath: userData,
      isPackaged: false,
      label: "test-machine",
      repositoryPath: (providerRepoId) => machineMap.get(providerRepoId) ?? null,
      recordRepositoryPath: (providerRepoId, repoPath) => void machineMap.set(providerRepoId, repoPath)
    };

    agent = startRunnerAgent({
      api: fakeApi(registrations),
      controlPlaneUrl: "http://control-plane.test",
      getToken: () => "a-session",
      host,
      fetch: plane.fetch,
      fakeHarness: true
    });
    agent.discoverNow();

    await waitFor("the repository to be fetched", () => machineMap.has("9001"));
    expect(registrations).toEqual([WORKSTREAM_ID]);
    expect(plane.credentialRequests).toBe(1);
    const checkout = machineMap.get("9001") as string;
    expect(checkout).toBe(join(clonedRepositoryRoot(userData), "9001"));
    expect(git(checkout, ["rev-parse", OLD_BRANCH])).toBe(originSha(OLD_BRANCH));

    // From here nothing knows the repository came from GitHub: the same
    // command, the same worktree, the same harness, the same checkpoint.
    plane.enqueue({
      commandId: "cmd_onafetchedrepo000",
      kind: "start_execution",
      workstreamId: WORKSTREAM_ID,
      missionId: MISSION_ID,
      executionId: EXECUTION_ID,
      seq: 1,
      payload: {
        directionId: "dir_onafetchedrepo000",
        body: "Work the repository Novus fetched",
        model: "claude-fable-5",
        effort: "high",
        resumeSessionId: null
      },
      createdAt: new Date().toISOString()
    });
    agent.pollNow();

    await waitFor(
      "the turn to complete",
      () => plane.kinds().includes("execution.completed"),
      40_000
    ).catch(() => {
      throw new Error(
        `turn never completed; reported ${JSON.stringify(plane.kinds())}; ` +
          `credential requests ${plane.credentialRequests}; machineMap has ${machineMap.size}`
      );
    });
    expect(plane.kinds()).toContain("workspace.checkpoint");

    // The worktree is on the branch the server allocated, and the turn's
    // checkpoint sits directly on the commit that branch pointed at.
    const worktree = join(userData, "worktrees", WORKSTREAM_ID);
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(OLD_BRANCH);
    expect(existsSync(join(worktree, "NOVUS_FAKE_TURN.md"))).toBe(true);
    expect(git(worktree, ["rev-parse", "HEAD~1"])).toBe(originSha(OLD_BRANCH));

    // Nothing that was reported, and nothing left on disk, carries the token.
    expect(JSON.stringify(plane.reported)).not.toContain(TOKEN);
    expect(holdsToken(userData)).toEqual([]);
  }, 60_000);

  it("announces nothing for a mission whose branch this machine could not fetch", async () => {
    // The case that actually produces `fatal: invalid reference`: the
    // repository IS here — a first mission cloned it — and a later mission's
    // branch is not, because its fetch failed. A refusing remote is the
    // ordinary transient cause: an expired credential, a rate limit, a
    // branch the provider has not propagated yet. `ensureCheckout` then backs
    // off and returns silently, and discovery used to fall through to
    // announcing anyway — and publishing builds the worktree, so `git worktree
    // add` ran against a ref this machine does not have, on every fifteen
    // second pass of the backoff window (D-060).
    remote = await startRemote({ accept: true });
    const plane = new FakeControlPlane(remote.url);
    const machineMap = new Map<string, string>();
    const served: FakeMission[] = [
      { missionId: MISSION_ID, workstreamId: WORKSTREAM_ID, missionBranch: OLD_BRANCH }
    ];
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...parts: unknown[]) => void warnings.push(parts.map(String).join(" "));
    onCleanup = () => {
      console.warn = realWarn;
    };

    agent = startRunnerAgent({
      api: fakeApi([], served),
      controlPlaneUrl: "http://control-plane.test",
      getToken: () => "a-session",
      host: {
        userDataPath: userData,
        isPackaged: false,
        label: "test-machine",
        repositoryPath: (providerRepoId) => machineMap.get(providerRepoId) ?? null,
        recordRepositoryPath: (providerRepoId, repoPath) => void machineMap.set(providerRepoId, repoPath)
      },
      fetch: plane.fetch,
      fakeHarness: true
    });
    agent.discoverNow();
    await waitFor("the repository to be fetched", () => machineMap.has("9001"));

    // Now the remote goes away and a second mission appears. Its branch was
    // never fetched, and cannot be.
    await remote.close();
    remote = null;
    served.push({
      missionId: "msn_unfetchable00000",
      workstreamId: "wst_unfetchable00000",
      missionBranch: LATER_BRANCH
    });
    // The first pass *throws* out of the fetch and never reaches the announce.
    // The failure this guards is on every pass after it: `ensureCheckout`
    // records a retry time and then returns silently while it backs off, so
    // discovery falls straight through with no branch on the machine.
    agent.discoverNow();
    await new Promise((settle) => setTimeout(settle, 1_500));
    warnings.length = 0;
    agent.discoverNow();
    await new Promise((settle) => setTimeout(settle, 2_000));

    // `announceCommands` swallows what publishing throws and warns once, so the
    // console is where this is visible — the same place it was visible in
    // production, looking like a mission that can never have a workspace.
    const complaints = warnings.join("\n");
    expect(complaints).not.toContain("invalid reference");
    expect(complaints).not.toContain("could not be created");
    // And nothing built a worktree for it from a ref that is not here.
    expect(existsSync(join(userData, "worktrees", "msn_unfetchable00000"))).toBe(false);
  }, 60_000);

  it("fetches a second workstream's branch into a repository it already cloned", async () => {
    // The bug this exists for: `needsCheckout` asked whether the *repository*
    // was here, so the first mission cloned it and every mission after that was
    // skipped — its branch never fetched, and `git worktree add` failing with
    // `invalid reference: novus/m-…` the moment anything opened a terminal,
    // read a file, or ran a command in it (D-051).
    remote = await startRemote({ accept: true });
    const plane = new FakeControlPlane(remote.url);
    const machineMap = new Map<string, string>();
    const host: RunnerHost = {
      userDataPath: userData,
      isPackaged: false,
      label: "test-machine",
      repositoryPath: (providerRepoId) => machineMap.get(providerRepoId) ?? null,
      recordRepositoryPath: (providerRepoId, repoPath) => void machineMap.set(providerRepoId, repoPath)
    };

    // The server allocates a second workstream's branch on the remote.
    git(origin, ["branch", LATER_BRANCH, NEW_BRANCH]);
    git(origin, ["update-server-info"]);

    const served: FakeMission[] = [
      { missionId: MISSION_ID, workstreamId: WORKSTREAM_ID, missionBranch: OLD_BRANCH },
      { missionId: "msn_second00000000000", workstreamId: "wst_second00000000000", missionBranch: LATER_BRANCH }
    ];

    agent = startRunnerAgent({
      api: fakeApi([], served),
      controlPlaneUrl: "http://control-plane.test",
      getToken: () => "a-session",
      host,
      fetch: plane.fetch,
      fakeHarness: true
    });
    agent.discoverNow();

    await waitFor("the repository to be fetched", () => machineMap.has("9001"));
    const checkout = machineMap.get("9001") as string;

    // Both branches are here, not just the one that happened to be cloned
    // first — so a worktree can be made for either workstream.
    await waitFor("the second workstream's branch to arrive", () => {
      try {
        return git(checkout, ["rev-parse", "--verify", "--quiet", `refs/heads/${LATER_BRANCH}`]) !== "";
      } catch {
        return false;
      }
    });
    expect(git(checkout, ["rev-parse", OLD_BRANCH])).toBe(originSha(OLD_BRANCH));
    expect(git(checkout, ["rev-parse", LATER_BRANCH])).toBe(originSha(LATER_BRANCH));

    // The lane's own key: the agent has already made this worktree while
    // discovering the second workstream, and asking for the same lane finds it
    // rather than trying to check the branch out twice (D-074).
    const worktree = await ensureWorkspaceWorktree(
      gitExec,
      checkout,
      userData,
      "wst_second00000000000",
      LATER_BRANCH
    );
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(LATER_BRANCH);
  }, 90_000);
});
