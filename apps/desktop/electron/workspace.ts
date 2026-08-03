import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  PreparedFile,
  RunnerEvent,
  SettingsScope,
  TerminalChunk,
  TerminalKind,
  TerminalSession,
  WorkspaceProposal,
  WorkspaceSettings
} from "@novus/contracts";
import { ApiError } from "./api-client";
import { createSanitizer } from "./evidence";
import { loadWorkspaceSettings, WorkspaceConfigError, writeWorkspaceSettings } from "./workspace-config";
import { prepareLocalFiles as copyLocalFiles } from "./workspace-files";
import { gitExec, type GitExec } from "./workspace-git";
import { inspectProject } from "./workspace-inspect";
import { createPortAllocator, type PortAllocator, type PortRange } from "./workspace-ports";
import { emptySecretStore, fileSecretStore, type SecretStore } from "./workspace-secrets";
import { projectEnv, terminalEnv } from "./workspace-env";
import {
  reconcileRecordedProcesses,
  WorkspaceCommandError,
  WorkspaceProcesses
} from "./workspace-processes";
import { TerminalError, TerminalSessions } from "./workspace-terminal";

/**
 * OWNER: the workspace runtime's desktop half (D-040, D-041).
 *
 * Everything that reads a project, writes its configuration, supplies its
 * local files, builds its environments, allocates its ports, and supervises
 * its processes lives behind this module. `main.ts` resolves which workstream
 * is meant and calls in; it never touches a path, a command, or a secret
 * itself.
 *
 * Two rules bind every function here:
 *
 *  - Nothing a person did not confirm ever runs. `inspect` proposes; only an
 *    explicit `save` followed by an explicit command executes anything.
 *  - A secret value never leaves this process. Filenames and variable names
 *    cross the bridge; contents do not, and never reach the control plane.
 */

/** Where a workstream's work actually happens on this machine. */
export interface WorkspaceTarget {
  missionId: string;
  workstreamId: string;
  /** The registered local repository this workstream came from. */
  localId: string;
  missionBranch: string;
}

/** Server-allocated branch names only; nothing else is ever checked out. */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+$/;

/** What the runtime needs from the machine it runs on. Injectable so the whole
 *  composition is exercisable in a plain Node test. */
export interface WorkspaceHost {
  userDataPath: string;
  repositoryPath: (providerRepoId: string) => string | null;
  secretStore?: SecretStore;
  git?: GitExec;
}

interface ElectronAppShape {
  getPath: (name: string) => string;
}

/**
 * Loaded on demand rather than imported: a static `import ... from "electron"`
 * would drag the whole Electron runtime into every import of this module,
 * including the tests of everything that depends on it.
 */
function electronHost(): WorkspaceHost {
  const { app } = require("electron") as { app: ElectronAppShape };
  const { pathForLocalRepo } = require("./local-repos") as {
    pathForLocalRepo: (providerRepoId: string) => string | null;
  };
  return { userDataPath: app.getPath("userData"), repositoryPath: pathForLocalRepo };
}

// --- Paths this machine owns --------------------------------------------------

export function worktreeRootFor(userDataPath: string): string {
  return join(userDataPath, "worktrees");
}

/** One worktree per mission, the same one the harness turn uses. */
export function worktreeFor(userDataPath: string, missionId: string): string {
  return join(worktreeRootFor(userDataPath), missionId);
}

function secretStoreFor(host: WorkspaceHost): SecretStore {
  if (host.secretStore) return host.secretStore;
  try {
    return fileSecretStore(join(host.userDataPath, "workspace-secrets"));
  } catch {
    return emptySecretStore();
  }
}

/**
 * The worktree a workstream works in, created from the mission branch if it is
 * not there yet. The user's own checkout is never touched. Idempotent, and
 * identical to the guarantee the turn path makes: either may create it first,
 * and whichever gets there second finds it already correct.
 */
export async function ensureWorkspaceWorktree(
  git: GitExec,
  repositoryPath: string,
  userDataPath: string,
  missionId: string,
  missionBranch: string
): Promise<string> {
  if (!MISSION_BRANCH.test(missionBranch)) {
    throw new WorkspaceCommandError("Refusing to prepare a workspace on an unrecognized branch name.");
  }
  const root = worktreeRootFor(userDataPath);
  const worktree = worktreeFor(userDataPath, missionId);
  await git(repositoryPath, ["worktree", "prune"]);
  if (existsSync(join(worktree, ".git"))) return worktree;
  mkdirSync(root, { recursive: true });
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  const added = await git(repositoryPath, ["worktree", "add", "--", worktree, missionBranch]);
  if (added.code !== 0) {
    throw new WorkspaceCommandError(`This workspace could not be created: ${added.stderr.slice(0, 300)}`);
  }
  return worktree;
}

/** The mask list every reported string passes through, so no path on this
 *  machine can reach the room. */
function sanitizerFor(worktree: string, repositoryPath: string, userDataPath: string): (text: string) => string {
  return createSanitizer([
    { path: worktree, label: "the mission worktree" },
    { path: repositoryPath, label: "the repository" },
    { path: worktreeRootFor(userDataPath), label: "the mission worktrees" }
  ]);
}

// --- The local half of the bridge --------------------------------------------
// Inspecting a project, writing its configuration, and supplying its local
// files are acts by the person sitting at this machine, so they are local.

interface Resolved {
  host: WorkspaceHost;
  git: GitExec;
  repositoryPath: string;
  worktree: string;
  secrets: SecretStore;
}

async function resolve(target: WorkspaceTarget, host?: WorkspaceHost): Promise<Resolved> {
  const resolvedHost = host ?? electronHost();
  const git = resolvedHost.git ?? gitExec;
  const repositoryPath = resolvedHost.repositoryPath(target.localId);
  if (repositoryPath === null) {
    throw new WorkspaceCommandError("This repository lives on another machine.");
  }
  const worktree = await ensureWorkspaceWorktree(
    git,
    repositoryPath,
    resolvedHost.userDataPath,
    target.missionId,
    target.missionBranch
  );
  return { host: resolvedHost, git, repositoryPath, worktree, secrets: secretStoreFor(resolvedHost) };
}

/**
 * A named refusal has to survive the bridge, or "actionable error" means a
 * dialog that says something went wrong. The IPC boundary reports an
 * `ApiError`, so the three local verbs translate their own named errors into
 * one before they leave.
 */
async function named<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkspaceConfigError) throw new ApiError("workspace_config", error.message, 409);
    if (error instanceof WorkspaceCommandError) throw new ApiError("workspace_command", error.message, 409);
    if (error instanceof TerminalError) throw new ApiError("terminal", error.message, 409);
    throw error;
  }
}

/** Reads the project and says what it would propose. Executes nothing. */
export async function inspectWorkspace(
  target: WorkspaceTarget,
  host?: WorkspaceHost
): Promise<WorkspaceProposal> {
  return named(async () => {
    const resolved = await resolve(target, host);
    return inspectProject({
      git: resolved.git,
      worktree: resolved.worktree,
      sourceRepo: resolved.repositoryPath,
      suppliedSecrets: resolved.secrets.suppliedNames(target.localId)
    });
  });
}

/** Writes `.novus/settings.toml` or `.novus/settings.local.toml`. */
export async function saveWorkspaceSettings(
  target: WorkspaceTarget,
  scope: SettingsScope,
  settings: WorkspaceSettings,
  host?: WorkspaceHost
): Promise<void> {
  await named(async () => {
    const resolved = await resolve(target, host);
    await writeWorkspaceSettings(resolved.git, resolved.worktree, scope, settings);
  });
}

/**
 * Copies confirmed Git-ignored files from the source repository into the
 * worktree. Refuses anything that is not ignored, any path escaping either
 * end, any symlink resolving outside the repository, and any directory.
 */
export async function prepareLocalFiles(
  target: WorkspaceTarget,
  paths: string[],
  host?: WorkspaceHost
): Promise<PreparedFile[]> {
  return named(async () => {
    const resolved = await resolve(target, host);
    return copyLocalFiles({
      git: resolved.git,
      sourceRepo: resolved.repositoryPath,
      worktree: resolved.worktree,
      paths
    });
  });
}

// --- The interactive terminal -------------------------------------------------
// Local IPC only, exactly like `inspectWorkspace` and `prepareLocalFiles` above:
// a session is opened by the person sitting at the machine that holds the
// repository. It is deliberately *not* part of the runner half below — there is
// no shell kind in the runner protocol and none is added, so an interactive
// shell is unreachable from the control plane by construction rather than by a
// check somebody could get wrong (D-042).

let sessions: TerminalSessions | null = null;

function terminals(): TerminalSessions {
  sessions ??= new TerminalSessions();
  return sessions;
}

/** Streamed output for every session on this machine. The listener is in this
 *  process; nothing here is reported anywhere. */
export function onTerminalOutput(listener: (chunk: TerminalChunk) => void): () => void {
  return terminals().onOutput(listener);
}

/**
 * Opens a session in the workstream's worktree, under the terminal environment
 * D-041 describes: the project's environment, plus the user's own login-shell
 * profile beneath it, plus the one variable only this environment gets —
 * `NOVUS_WORKSPACE_DIR`, because a terminal is the one place a person needs to
 * know where they are.
 */
export async function openTerminal(
  target: WorkspaceTarget,
  input: { name?: string | undefined; kind?: TerminalKind | undefined; cols?: number | undefined; rows?: number | undefined },
  host?: WorkspaceHost
): Promise<TerminalSession> {
  return named(async () => {
    const resolved = await resolve(target, host);
    const settings = loadWorkspaceSettings(resolved.worktree).effective;
    const ports = createPortAllocator({
      filePath: join(resolved.host.userDataPath, "workspace-ports.json")
    });
    const range = await ports.rangeFor(target.workstreamId);
    const env = terminalEnv({
      workspace: {
        workspaceId: target.workstreamId,
        missionBranch: target.missionBranch,
        port: range.start,
        portRangeStart: range.start,
        portRangeEnd: range.end
      },
      settings,
      secrets: resolved.secrets.values(target.localId, settings.secretNames),
      profile: await terminals().profile(),
      workspaceDir: resolved.worktree
    });
    return terminals().open({
      workstreamId: target.workstreamId,
      worktree: resolved.worktree,
      sourceRepo: resolved.repositoryPath,
      env,
      name: input.name,
      kind: input.kind,
      cols: input.cols,
      rows: input.rows
    });
  });
}

/** This workstream's sessions on this machine. Empty after a relaunch: nothing
 *  about a session is written down, because a PTY cannot survive the process
 *  that owned it and a dead tab shown as live would be a lie. */
export function listTerminals(workstreamId: string): TerminalSession[] {
  return terminals().list(workstreamId);
}

export function writeTerminal(sessionId: string, data: string): void {
  try {
    terminals().write(sessionId, data);
  } catch (error) {
    throw terminalApiError(error);
  }
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): void {
  try {
    terminals().resize(sessionId, cols, rows);
  } catch (error) {
    throw terminalApiError(error);
  }
}

export function renameTerminal(sessionId: string, name: string): TerminalSession {
  try {
    return terminals().rename(sessionId, name);
  } catch (error) {
    throw terminalApiError(error);
  }
}

export async function closeTerminal(sessionId: string): Promise<void> {
  await terminals().close(sessionId);
}

/** Called when the application quits: every session is killed and nothing is
 *  left behind (D-034). */
export async function shutdownTerminals(): Promise<void> {
  const current = sessions;
  sessions = null;
  if (current) await current.shutdown();
}

function terminalApiError(error: unknown): unknown {
  return error instanceof TerminalError ? new ApiError("terminal", error.message, 409) : error;
}

// --- The runner half ----------------------------------------------------------
// Running a declared command is remotely invokable, so it arrives as a runner
// command the control plane already authorized (D-042). What arrives is a
// *name*; which command that name means is the repository's business, read
// from the repository, here.

/** Everything a workspace command needs to know about where it is running. */
export interface WorkspaceCommandContext {
  missionId: string;
  workstreamId: string;
  providerRepoId: string;
  missionBranch: string;
  /** The control plane's workspace identity, when it sent one. */
  workspaceId?: string | null;
}

export interface WorkspaceRuntime {
  runSetup(context: WorkspaceCommandContext): Promise<void>;
  runCommand(context: WorkspaceCommandContext, name: string | null): Promise<void>;
  stopCommand(context: WorkspaceCommandContext, name: string | null): Promise<void>;
  runVerification(context: WorkspaceCommandContext, name: string | null): Promise<void>;
  /** Says what is true about processes the last run recorded. */
  reconcile(): void;
  shutdown(reason: string): Promise<void>;
}

export interface WorkspaceRuntimeDeps {
  host: WorkspaceHost;
  /** Workspace observations belong to the workstream: a setup command can
   *  precede the first turn and a run command outlives one, so they are
   *  reported with no execution at all. */
  emit: (workstreamId: string, event: RunnerEvent) => void;
}

export function createWorkspaceRuntime(deps: WorkspaceRuntimeDeps): WorkspaceRuntime {
  const git = deps.host.git ?? gitExec;
  const secrets = secretStoreFor(deps.host);
  const recordPath = join(deps.host.userDataPath, "workspace-processes.json");
  const ports: PortAllocator = createPortAllocator({
    filePath: join(deps.host.userDataPath, "workspace-ports.json")
  });
  const supervisors = new Map<string, WorkspaceProcesses>();

  interface Prepared {
    worktree: string;
    repositoryPath: string;
    settings: WorkspaceSettings;
    range: PortRange;
    supervisor: WorkspaceProcesses;
  }

  async function prepare(context: WorkspaceCommandContext): Promise<Prepared> {
    const repositoryPath = deps.host.repositoryPath(context.providerRepoId);
    if (repositoryPath === null) {
      throw new WorkspaceCommandError("This repository lives on another machine.");
    }
    const worktree = await ensureWorkspaceWorktree(
      git,
      repositoryPath,
      deps.host.userDataPath,
      context.missionId,
      context.missionBranch
    );
    // Configuration is read fresh every time: it lives in the branch, so a turn
    // that changed it changes what the next command runs.
    const settings = loadWorkspaceSettings(worktree).effective;
    const range = await ports.rangeFor(context.workstreamId);

    let supervisor = supervisors.get(context.workstreamId);
    if (!supervisor) {
      supervisor = new WorkspaceProcesses({
        workstreamId: context.workstreamId,
        worktree,
        sourceRepo: repositoryPath,
        git,
        sanitize: sanitizerFor(worktree, repositoryPath, deps.host.userDataPath),
        secretValues: () => secrets.allValues(context.providerRepoId),
        emit: (event) => deps.emit(context.workstreamId, event),
        recordPath
      });
      supervisors.set(context.workstreamId, supervisor);
    }
    return { worktree, repositoryPath, settings, range, supervisor };
  }

  /** The environment a project command runs in: never the parent's, never the
   *  harness's credential, and only the secrets the configuration selected. */
  function environmentFor(
    context: WorkspaceCommandContext,
    settings: WorkspaceSettings,
    range: PortRange,
    port: number | null
  ): Record<string, string> {
    return projectEnv(
      {
        // One active workspace per workstream, so until the control plane sends
        // a workspace id the workstream's is the same fact by another name.
        workspaceId: context.workspaceId ?? context.workstreamId,
        missionBranch: context.missionBranch,
        port,
        portRangeStart: range.start,
        portRangeEnd: range.end
      },
      settings,
      secrets.values(context.providerRepoId, settings.secretNames)
    );
  }

  return {
    reconcile: () => {
      reconcileRecordedProcesses(recordPath, (workstreamId, event) => deps.emit(workstreamId, event));
    },

    runSetup: async (context) => {
      const { settings, range, supervisor } = await prepare(context);
      const setup = settings.setup;
      if (setup === undefined) {
        throw new WorkspaceCommandError("This project has not said how to install itself.");
      }
      await supervisor.runSetup(
        {
          name: "setup",
          command: setup.command,
          cwd: setup.cwd,
          // Setup does not listen on anything, but it is told the workspace's
          // port all the same: a setup step that seeds a database or boots a
          // service needs the same answer the run command will get.
          env: environmentFor(context, settings, range, range.start)
        },
        { start: range.start, end: range.end }
      );
    },

    runCommand: async (context, name) => {
      const { settings, range, supervisor } = await prepare(context);
      const chosen = pickRun(settings, name);
      // The declared port wins, because a project that pins one has a reason;
      // otherwise the workstream's own range keeps two workstreams apart.
      const port = chosen.port ?? range.start;
      await supervisor.startRun({
        name: chosen.name,
        command: chosen.command,
        cwd: chosen.cwd,
        env: environmentFor(context, settings, range, port),
        port,
        previewUrl: chosen.previewUrl,
        allowConcurrent: settings.concurrentRuns
      });
    },

    stopCommand: async (context, name) => {
      const supervisor = supervisors.get(context.workstreamId);
      if (!supervisor) return; // nothing of ours is running
      if (name === null) {
        await supervisor.stopAll("Stopped by a participant.");
        return;
      }
      await supervisor.stop(name, "Stopped by a participant.");
    },

    runVerification: async (context, name) => {
      const { settings, range, supervisor } = await prepare(context);
      const checks =
        name === null ? settings.verify : settings.verify.filter((check) => check.name === name);
      if (checks.length === 0) {
        throw new WorkspaceCommandError(
          name === null
            ? "This project has not declared any checks to run."
            : `This project has no check named ${name}.`
        );
      }
      for (const check of checks) {
        await supervisor.runVerification({
          name: check.name,
          command: check.command,
          cwd: check.cwd,
          category: check.category,
          env: environmentFor(context, settings, range, range.start)
        });
      }
    },

    shutdown: async (reason) => {
      await Promise.allSettled([...supervisors.values()].map((supervisor) => supervisor.stopAll(reason)));
      supervisors.clear();
    }
  };
}

function pickRun(settings: WorkspaceSettings, name: string | null): WorkspaceSettings["run"][number] {
  if (settings.run.length === 0) {
    throw new WorkspaceCommandError("This project has not said how to run itself.");
  }
  if (name !== null) {
    const named = settings.run.find((entry) => entry.name === name);
    if (!named) throw new WorkspaceCommandError(`This project has no run command named ${name}.`);
    return named;
  }
  const preferred = settings.defaultRun;
  const chosen =
    (preferred === undefined ? undefined : settings.run.find((entry) => entry.name === preferred)) ??
    settings.run[0];
  if (!chosen) throw new WorkspaceCommandError("This project has not said how to run itself.");
  return chosen;
}

export { TerminalError, WorkspaceCommandError, WorkspaceConfigError };
