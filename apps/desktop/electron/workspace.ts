import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_SECRET_LENGTH,
  type DeclaredCommand,
  type PreparedFile,
  type ProcessLog,
  type ProcessLogChunk,
  type RunnerEvent,
  type SecretState,
  type SettingsScope,
  type WorkspaceEntry,
  type WorkspaceFile,
  type TerminalChunk,
  type TerminalKind,
  type TerminalSession,
  type WorkspaceProposal,
  type WorkspaceSettings
} from "@novus/contracts";
import { ApiError } from "./api-client";
import { createSanitizer } from "./evidence";
import { declaredCommands, sameCommands } from "./workspace-commands";
import { loadWorkspaceSettings, WorkspaceConfigError, writeWorkspaceSettings } from "./workspace-config";
import { prepareLocalFiles as copyLocalFiles } from "./workspace-files";
import { gitExec, type GitExec } from "./workspace-git";
import { inspectProject } from "./workspace-inspect";
import { createPortAllocator, type PortAllocator, type PortRange } from "./workspace-ports";
import { emptySecretStore, fileSecretStore, type SecretStore } from "./workspace-secrets";
import { projectEnv, terminalEnv, proxyCredentials } from "./workspace-env";
import {
  parseLoopbackHttpUrl,
  reconcileRecordedProcesses,
  WorkspaceCommandError,
  WorkspaceProcesses,
  type Invocation
} from "./workspace-processes";
import { TerminalError, TerminalSessions } from "./workspace-terminal";
import { listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile } from "./workspace-tree";

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
  /** The repository's own short name, for anything this machine labels with
   *  the work rather than with itself — terminal tabs, so far. Optional
   *  because a caller may have a workstream and no repository record to hand. */
  repositoryLabel?: string | undefined;
}

/**
 * The repository's short name, from the one string both kinds of repository
 * carry: `KJ14GOD/branchwork` and `/Users/someone/code/robinhood-agentic` both
 * end in the name a person calls the project, so the last segment is it.
 *
 * The owner and the path in front of it are not dropped carelessly — they are
 * dropped because this labels a tab three characters from another tab, where
 * `KJ14GOD/branchwork 2` says nothing the room's own header does not already
 * say and costs the width the number needs.
 */
export function repositoryLabel(name: string): string {
  const last = name
    .split(/[/\\]/)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .pop();
  return (last ?? name).replace(/\.git$/, "").trim();
}

/** Server-allocated branch names only; nothing else is ever checked out. */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+$/;

/** How long a quitting application waits for its commands to unwind before it
 *  stops waiting. Long enough for a SIGKILL escalation, short enough that a
 *  wedged child cannot make Novus unquittable. */
const SHUTDOWN_GRACE_MS = 8_000;

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

/**
 * Custody of this machine's secret values. Availability is decided up front:
 * a machine whose operating system offers no encryption gets the store that
 * holds nothing and refuses by name, rather than one that quietly writes
 * nowhere (D-044).
 */
/**
 * Every value this machine holds for a project, for the redactor and for
 * nothing else.
 *
 * Deliberately a function returning strings rather than the store: the turn
 * path needs to *remove* these from text it is about to report, and giving it
 * the store would give it a way to put one somewhere instead. Nothing that
 * calls this may return its result across the bridge (D-041).
 */
export function secretValuesFor(host: WorkspaceHost, providerRepoId: string): readonly string[] {
  try {
    return [...secretStoreFor(host).allValues(providerRepoId), ...proxyCredentials()];
  } catch {
    // A store that cannot be read redacts nothing rather than failing the turn;
    // the store itself fails closed on *writes*, which is where it matters.
    return proxyCredentials();
  }
}

function secretStoreFor(host: WorkspaceHost): SecretStore {
  if (host.secretStore) return host.secretStore;
  const store = fileSecretStore(join(host.userDataPath, "workspace-secrets"));
  return store.available() ? store : emptySecretStore();
}

/**
 * One preparation per worktree at a time, in this process (D-058).
 *
 * Two callers ask for the same worktree routinely and by design: the runner's
 * turn path, and whatever the person at the machine just did — open a terminal,
 * list files, run setup, each of which resolves a worktree first. Unserialised
 * they interleave destructively, because preparation reads "is it already
 * there" and then *deletes* what it found. The loser removes the directory the
 * winner has just created and returned, and the winner's next git command
 * fails with `No such file or directory`.
 *
 * That is not theoretical: it is the intermittent `workspace-clone` failure
 * that survived two sessions undiagnosed, and its user-visible form is the
 * error string below — "This workspace could not be created" — which is what a
 * person sees when they direct a mission and open its terminal a moment later.
 */
const worktreePreparations = new Map<string, Promise<string>>();

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
  // Keyed by where the worktree would live, which is what two callers actually
  // contend over — the same mission under a different user-data directory is a
  // different worktree and must not queue behind this one.
  const key = worktreeFor(userDataPath, missionId);
  const previous = worktreePreparations.get(key);
  const next = (previous ?? Promise.resolve("")).catch(() => "").then(() =>
    prepareWorktree(git, repositoryPath, userDataPath, missionId, missionBranch)
  );
  worktreePreparations.set(key, next);
  try {
    return await next;
  } finally {
    // Only when nothing else has queued behind it; otherwise the chain stands.
    if (worktreePreparations.get(key) === next) worktreePreparations.delete(key);
  }
}

async function prepareWorktree(
  git: GitExec,
  repositoryPath: string,
  userDataPath: string,
  missionId: string,
  missionBranch: string
): Promise<string> {
  const root = worktreeRootFor(userDataPath);
  const worktree = worktreeFor(userDataPath, missionId);
  await git(repositoryPath, ["worktree", "prune"]);
  if (existsSync(join(worktree, ".git"))) return worktree;
  mkdirSync(root, { recursive: true });
  // Whatever is here is not a worktree — it has no `.git` — so it is debris
  // from a preparation that did not finish, and `git worktree add` refuses a
  // path that exists. Removing it is safe *because* of the serialization
  // above: without that, this line is what deletes another caller's worktree.
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

// --- Secret values ------------------------------------------------------------
// The one direction a value travels: from the person at this machine into this
// machine's credential store. Nothing reads one back out, so `secretsFor` and
// `forgetSecret` answer with names and a supplied flag and nothing else
// (D-041, D-044).

/** What the project declares it needs, and what this machine has for it. */
export async function secretsFor(target: WorkspaceTarget, host?: WorkspaceHost): Promise<SecretState> {
  return named(async () => {
    const resolved = await resolve(target, host);
    return secretState(resolved.secrets, resolved.worktree, target.localId);
  });
}

export async function supplySecret(
  target: WorkspaceTarget,
  name: string,
  value: string,
  host?: WorkspaceHost
): Promise<SecretState> {
  return named(async () => {
    const resolved = await resolve(target, host);
    if (value.length < MIN_SECRET_LENGTH) {
      throw new WorkspaceCommandError(
        `Novus only holds a value it can reliably remove from command output, which means at least ${MIN_SECRET_LENGTH} characters.`
      );
    }
    resolved.secrets.put(target.localId, name, value);
    return secretState(resolved.secrets, resolved.worktree, target.localId);
  });
}

export async function forgetSecret(
  target: WorkspaceTarget,
  name: string,
  host?: WorkspaceHost
): Promise<SecretState> {
  return named(async () => {
    const resolved = await resolve(target, host);
    resolved.secrets.forget(target.localId, name);
    return secretState(resolved.secrets, resolved.worktree, target.localId);
  });
}

function secretState(secrets: SecretStore, worktree: string, localId: string): SecretState {
  const declared = loadWorkspaceSettings(worktree).effective.secretNames;
  const supplied = new Set(secrets.suppliedNames(localId));
  return {
    encryptionAvailable: secrets.available(),
    names: declared.map((name) => ({ name, supplied: supplied.has(name) })),
    // Held for a name the project no longer asks for. Shown so it can be
    // forgotten deliberately rather than lingering unnoticed on a laptop.
    orphaned: [...supplied].filter((name) => !declared.includes(name)).sort()
  };
}

// --- Opening a local preview --------------------------------------------------

/**
 * Hands a loopback preview to the operating system's browser (D-045).
 *
 * Two gates, and both matter. The URL must parse as loopback `http`/`https`
 * with no credentials in its authority — a string check would forward
 * `http://localhost@elsewhere.example`, whose host is `elsewhere.example`. And
 * it must be a URL a *live process of this workstream actually reported*, so
 * the renderer cannot ask for an arbitrary address: what opens is what this
 * machine observed, not what something typed.
 *
 * No shell command is involved at any point.
 */
export async function openPreview(
  workstreamId: string,
  url: string,
  open: (url: string) => Promise<void>
): Promise<void> {
  const parsed = parseLoopbackHttpUrl(url);
  if (parsed === null) {
    throw new ApiError(
      "preview_refused",
      "Novus opens a local preview only: a loopback http or https address, with no credentials in it.",
      409
    );
  }
  const supervisor = supervisorsByWorkstream.get(workstreamId);
  const known = supervisor?.previewUrls() ?? [];
  if (!known.includes(parsed.toString()) && !known.includes(url)) {
    throw new ApiError(
      "preview_unknown",
      "Nothing running in this workspace reported that address.",
      409
    );
  }
  // Rebuilt from validated components rather than passing the caller's string.
  await open(parsed.toString());
}

// --- The runtime dock ---------------------------------------------------------
// Setup, run, and verification output for the machine that ran it. Local, like
// the terminal: it is never reported, never an event, and never evidence.

const logListeners = new Set<(chunk: ProcessLogChunk) => void>();
/** Kept at module scope rather than on the runtime, so a listener registered
 *  once at start-up survives a runtime being torn down and rebuilt. */
const logForwarders = new Map<string, () => void>();
const supervisorsByWorkstream = new Map<string, WorkspaceProcesses>();

function emitLog(chunk: ProcessLogChunk): void {
  for (const listener of logListeners) {
    try {
      listener(chunk);
    } catch {
      /* a broken listener must not take the process down with it */
    }
  }
}

export function onProcessLog(listener: (chunk: ProcessLogChunk) => void): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

/** What this workstream has run on this machine, still readable after it
 *  ended. Empty after a relaunch: output is not written down. */
export function processLogsFor(workstreamId: string): ProcessLog[] {
  return supervisorsByWorkstream.get(workstreamId)?.processLogs() ?? [];
}

// --- The workspace's own files -------------------------------------------------
// Local, like the terminal: the worktree is on this machine, and browsing it is
// an act by the person sitting at it (D-048).

/**
 * Runs a file verb and masks this machine's paths out of whatever it throws.
 *
 * These three were the only reported strings in the product that did not pass
 * through the sanitizer: an `ENOTDIR` from the filesystem arrives carrying the
 * absolute path it failed on, and that message is rendered in the pane. Errors
 * are a reported string like any other.
 */
async function withMaskedPaths<T>(
  target: WorkspaceTarget,
  host: WorkspaceHost | undefined,
  work: (resolved: Resolved) => T | Promise<T>
): Promise<T> {
  return named(async () => {
    const resolved = await resolve(target, host);
    const mask = sanitizerFor(resolved.worktree, resolved.repositoryPath, resolved.host.userDataPath);
    try {
      return await work(resolved);
    } catch (error) {
      if (error instanceof WorkspaceCommandError) throw new WorkspaceCommandError(mask(error.message));
      throw error;
    }
  });
}

export async function listFiles(
  target: WorkspaceTarget,
  path: string | undefined,
  host?: WorkspaceHost
): Promise<WorkspaceEntry[]> {
  return withMaskedPaths(target, host, (resolved) => listWorkspaceTree(resolved.worktree, path ?? ""));
}

export async function readFile(
  target: WorkspaceTarget,
  path: string,
  host?: WorkspaceHost
): Promise<WorkspaceFile> {
  return withMaskedPaths(target, host, (resolved) => readWorkspaceFile(resolved.worktree, path));
}

export async function writeFile(
  target: WorkspaceTarget,
  path: string,
  text: string,
  host?: WorkspaceHost
): Promise<void> {
  await withMaskedPaths(target, host, (resolved) => {
    writeWorkspaceFile(resolved.worktree, path, text);
    return null;
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
const terminalListeners = new Set<(chunk: TerminalChunk) => void>();
let terminalForwarder: (() => void) | null = null;

/**
 * The session set for this machine, built on first use.
 *
 * Listeners live here rather than on the instance. `shutdownTerminals` clears
 * the instance, so a listener registered once at start-up would otherwise be
 * dropped by the first shutdown and every subsequent session would stream its
 * output into nothing — with the scrollback still holding it, so the pane and
 * the machine would quietly disagree.
 */
function terminals(): TerminalSessions {
  if (sessions === null) {
    sessions = new TerminalSessions();
    terminalForwarder = sessions.onOutput((chunk) => {
      for (const listener of terminalListeners) {
        try {
          listener(chunk);
        } catch {
          /* a broken listener must not take the session down with it */
        }
      }
    });
  }
  return sessions;
}

/** Streamed output for every session on this machine. The listener is in this
 *  process; nothing here is reported anywhere. */
export function onTerminalOutput(listener: (chunk: TerminalChunk) => void): () => void {
  terminals();
  terminalListeners.add(listener);
  return () => {
    terminalListeners.delete(listener);
  };
}

/** What a session has printed so far, for a pane that has just opened. */
export function terminalScrollback(sessionId: string): string {
  return terminals().scrollback(sessionId);
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
      label: target.repositoryLabel,
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
  terminalForwarder?.();
  terminalForwarder = null;
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

/**
 * What a runner command carries: the *name* the control plane authorized, and
 * the immutable snapshot it authorized it against (D-043). The snapshot is what
 * runs. `null` means the control plane had no published snapshot to pin, which
 * the runner refuses rather than guessing from a file that may have moved.
 */
export interface PinnedCommand {
  name: string | null;
  snapshot: DeclaredCommand | null;
}

export interface WorkspaceRuntime {
  runSetup(context: WorkspaceCommandContext, pinned: PinnedCommand): Promise<void>;
  runCommand(context: WorkspaceCommandContext, pinned: PinnedCommand): Promise<void>;
  stopCommand(context: WorkspaceCommandContext, name: string | null): Promise<void>;
  runVerification(context: WorkspaceCommandContext, pinned: PinnedCommand): Promise<void>;
  /** Reads the project's configuration and publishes what it declares, so every
   *  participant's Run control offers the same list and every authorization is
   *  pinned to a snapshot the server holds. */
  publishDeclared(context: WorkspaceCommandContext): Promise<void>;
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
  /** What was last published per workstream, so re-reading unchanged
   *  configuration does not become an event every fifteen seconds. */
  const published = new Map<string, DeclaredCommand[]>();

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
    // that changed it changes what the *next* command will be. What is already
    // authorized runs from its snapshot and is unaffected (D-043).
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
      supervisorsByWorkstream.set(context.workstreamId, supervisor);
      logForwarders.get(context.workstreamId)?.();
      logForwarders.set(context.workstreamId, supervisor.onLog(emitLog));
    }
    announce(context.workstreamId, settings);
    return { worktree, repositoryPath, settings, range, supervisor };
  }

  /**
   * Publishes the declared list when it differs from what was last said.
   *
   * A project that declares nothing publishes nothing: "this project has said
   * how to do nothing" is what *Workspace needs setup* already says, and an
   * empty list in the event log every time a machine looks at an unconfigured
   * repository is noise. Commands disappearing later is news, and does emit.
   */
  function announce(workstreamId: string, settings: WorkspaceSettings): void {
    const commands = declaredCommands(settings);
    const previous = published.get(workstreamId);
    if (previous === undefined && commands.length === 0) {
      published.set(workstreamId, commands);
      return;
    }
    if (previous !== undefined && sameCommands(previous, commands)) return;
    published.set(workstreamId, commands);
    deps.emit(workstreamId, { kind: "workspace.declared", payload: { commands } });
  }

  /**
   * The snapshot to run. A name with no snapshot is refused rather than
   * resolved from the file: the whole point of pinning is that the runner does
   * not decide what a participant authorized.
   */
  function pin(pinned: PinnedCommand, kind: DeclaredCommand["kind"]): DeclaredCommand {
    const snapshot = pinned.snapshot;
    if (snapshot === null) {
      throw new WorkspaceCommandError(
        "Novus has not read this project's configuration yet, so there is nothing it can honestly run."
      );
    }
    if (snapshot.kind !== kind) {
      throw new WorkspaceCommandError("That command was authorized as a different kind of command.");
    }
    return snapshot;
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

  const invocationFor = (
    context: WorkspaceCommandContext,
    snapshot: DeclaredCommand,
    settings: WorkspaceSettings,
    range: PortRange,
    port: number | null
  ): Invocation => ({
    command: snapshot,
    env: environmentFor(context, settings, range, port),
    port
  });

  return {
    reconcile: () => {
      reconcileRecordedProcesses(recordPath, (workstreamId, event) => deps.emit(workstreamId, event));
    },

    /**
     * Reads the project and publishes what it declares.
     *
     * Preparing is what reads it, and preparing creates the worktree if it is
     * not there — which is why the caller runs this **through the workstream's
     * own command chain** rather than on a timer beside it. Pruning and
     * recreating a worktree underneath a running turn is a race that ends with
     * the turn failing, and it was one.
     */
    publishDeclared: async (context) => {
      await prepare(context);
    },

    runSetup: async (context, pinned) => {
      const snapshot = pin(pinned, "setup");
      const { settings, range, supervisor } = await prepare(context);
      await supervisor.runSetup(
        // Setup does not listen on anything, but it is told the workspace's
        // port all the same: a setup step that seeds a database or boots a
        // service needs the same answer the run command will get.
        invocationFor(context, snapshot, settings, range, range.start),
        { start: range.start, end: range.end }
      );
    },

    runCommand: async (context, pinned) => {
      const snapshot = pin(pinned, "run");
      const { settings, range, supervisor } = await prepare(context);
      // The declared port wins, because a project that pins one has a reason;
      // otherwise the workstream's own range keeps two workstreams apart.
      const port = snapshot.port ?? range.start;
      await supervisor.startRun(
        invocationFor(context, snapshot, settings, range, port),
        settings.concurrentRuns
      );
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

    runVerification: async (context, pinned) => {
      const snapshot = pin(pinned, "verification");
      const { settings, range, supervisor } = await prepare(context);
      await supervisor.runVerification(invocationFor(context, snapshot, settings, range, range.start));
    },

    shutdown: async (reason) => {
      // Raced, not simply awaited: a command whose stdio a grandchild is still
      // holding must not keep the application from exiting (D-034).
      await Promise.race([
        Promise.allSettled([...supervisors.values()].map((supervisor) => supervisor.stopAll(reason))),
        new Promise((settle) => {
          const timer = setTimeout(settle, SHUTDOWN_GRACE_MS);
          timer.unref?.();
        })
      ]);
      for (const [workstreamId, forward] of logForwarders) {
        forward();
        supervisorsByWorkstream.delete(workstreamId);
      }
      logForwarders.clear();
      supervisors.clear();
      published.clear();
    }
  };
}

export { TerminalError, WorkspaceCommandError, WorkspaceConfigError };
