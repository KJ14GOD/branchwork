import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { TerminalChunk, TerminalKind, TerminalSession } from "@novus/contracts";

/**
 * The interactive terminal (D-042; ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 *
 * A local workspace lives on one person's laptop, so an interactive shell there
 * belongs to that person and to nobody else. It is not lease-granted and not
 * role-granted. The enforcement is structural rather than presentational:
 * nothing in this file is reachable from the runner protocol, no shell command
 * kind exists in `RunnerCommandKindSchema`, and a session can only be created
 * by the machine that already holds the repository. There is therefore nothing
 * here to authorize incorrectly and nothing a crafted request can reach.
 *
 * The rules every session keeps:
 *
 *  - it starts in the workstream's worktree, never the user's own checkout —
 *    asserted on every spawn rather than assumed from how the caller was
 *    written;
 *  - its environment is `terminalEnv()` and nothing else (D-041);
 *  - it owns its own session and process group, and closing it — or the
 *    application quitting — reaches the whole tree: a hang-up first, because
 *    that is what makes a shell release the jobs job control put in process
 *    groups of their own, then SIGKILL if any of it is still there (see
 *    `hangUp`);
 *  - its scrollback is bounded and stays on this machine. Raw output is never
 *    written into an event, never reported to the control plane, and never
 *    becomes evidence;
 *  - it is never recorded anywhere. A PTY does not outlive the process that
 *    owned it, so after a relaunch there are no sessions at all — which is the
 *    honest answer, and better than a dead tab presented as live.
 */

/** Per session, oldest dropped. Enough to read back a build; small enough that
 *  a runaway command cannot eat the machine. */
const MAX_SCROLLBACK = 200 * 1024;
/** How long a closing session gets to unwind before it is killed outright. */
const SIGKILL_AFTER_MS = 5_000;
/** Output is coalesced on this interval so a command printing continuously
 *  cannot turn into an IPC storm. */
const FLUSH_MS = 16;
/** The most output one flush may carry; beyond it the oldest is dropped, the
 *  same way the scrollback is bounded. */
const MAX_PENDING = 64 * 1024;
/** A drawer is a handful of named tabs, not a session farm. */
const MAX_SESSIONS_PER_WORKSTREAM = 8;
const MAX_NAME = 60;
/** What a reader sees where output was dropped. Written as its own line so a
 *  gap is visible rather than spliced into the middle of a word. */
const GAP_MARKER = "\r\n[Novus dropped output that arrived faster than it could be shown]\r\n";
/** What a login shell is allowed to hand back, so a pathological profile
 *  cannot become the environment of every terminal afterwards. */
/** A close signals this many descendants at most; beyond it something is
 *  wrong that a terminal close is not going to fix. */
const MAX_DESCENDANTS = 200;
const MAX_PROFILE_VARS = 300;
const MAX_PROFILE_VALUE = 8_000;
const PROFILE_TIMEOUT_MS = 3_000;

// --- The native module, behind an interface -----------------------------------
// `@homebridge/node-pty-prebuilt-multiarch` is a Node-API addon, so one prebuilt
// binary loads under both Node and Electron without a rebuild. It is required
// lazily and behind this interface for two reasons: importing this module must
// not drag a native addon into every test that touches the workspace runtime,
// and a machine whose binary did not install should get a named refusal rather
// than a crash on startup.

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyHost {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

let cachedHost: PtyHost | null = null;

/** The real PTY module. Loaded once, and only when a session is actually
 *  opened. */
export function nodePtyHost(): PtyHost {
  if (cachedHost) return cachedHost;
  try {
    cachedHost = require("@homebridge/node-pty-prebuilt-multiarch") as PtyHost;
  } catch (error) {
    throw new TerminalError(
      `The terminal needs a native module this machine could not load: ${messageOf(error)}`
    );
  }
  return cachedHost;
}

// --- The user's own shell profile ---------------------------------------------

export type ProfileReader = () => Promise<Record<string, string>>;

/** Shell bookkeeping, not configuration. `PWD` in particular would be the
 *  probe's directory rather than the worktree the session opens in. */
const PROFILE_SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM"]);

/**
 * What the user's login shell exports, read once and layered *under* the
 * project's declared values (D-041). Reading it explicitly, rather than
 * spawning the session as a login shell, is what keeps that ordering true: a
 * login shell would run its profile after Novus had built the environment and
 * quietly win every conflict.
 *
 * Best effort by design. A machine with an unusual shell, a slow profile, or no
 * profile at all gets an empty result and a working terminal.
 */
export function loginShellProfile(
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, string>> {
  if (platform === "win32") return Promise.resolve({});
  const shell = source.SHELL ?? "/bin/sh";
  // A deliberately small environment: whatever comes back that is not in here
  // is something the profile itself exported, which is precisely what D-041
  // means by "the user's own shell profile".
  const probeEnv: Record<string, string> = { TERM: "dumb" };
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "SHELL"]) {
    const value = source[name];
    if (typeof value === "string" && value !== "") probeEnv[name] = value;
  }
  return new Promise((settle) => {
    try {
      execFile(
        shell,
        ["-l", "-c", "env"],
        { timeout: PROFILE_TIMEOUT_MS, maxBuffer: 512 * 1024, env: probeEnv, encoding: "utf8" },
        (error, stdout) => settle(error ? {} : parseProfile(stdout))
      );
    } catch {
      settle({});
    }
  });
}

/** `KEY=value` lines only. A value spanning lines is dropped rather than
 *  guessed at — losing an exotic variable is safer than inventing one. */
export function parseProfile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const line of text.split("\n")) {
    if (count >= MAX_PROFILE_VARS) break;
    const split = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    const name = split?.[1];
    const value = split?.[2];
    if (name === undefined || value === undefined) continue;
    if (PROFILE_SKIP.has(name) || value.length > MAX_PROFILE_VALUE) continue;
    out[name] = value;
    count += 1;
  }
  return out;
}

// --- Sessions -----------------------------------------------------------------

export interface OpenSessionRequest {
  workstreamId: string;
  /** Where the session opens. The worktree, and nothing else. */
  worktree: string;
  /** The user's own checkout. Refused by name, never by convention. */
  sourceRepo: string;
  /** Built by `terminalEnv()`; this module never adds to it. */
  env: Record<string, string>;
  name?: string | undefined;
  kind?: TerminalKind | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
}

interface Live {
  sessionId: string;
  workstreamId: string;
  name: string;
  kind: TerminalKind;
  state: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  pty: PtyProcess | null;
  pid: number | null;
  scrollback: string;
  pending: string;
  flush: NodeJS.Timeout | null;
  escalation: NodeJS.Timeout | null;
  ended: Promise<void>;
  settle: () => void;
}

export interface TerminalSessionsOptions {
  pty?: PtyHost | (() => PtyHost);
  /** Injectable so the environment layering is testable without spawning
   *  somebody's login shell. */
  profile?: ProfileReader;
  platform?: NodeJS.Platform;
  /** The parent environment the shell is chosen from. */
  source?: Readonly<Record<string, string | undefined>>;
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Live>();
  private readonly listeners = new Set<(chunk: TerminalChunk) => void>();
  private readonly options: TerminalSessionsOptions;
  private profileOnce: Promise<Record<string, string>> | null = null;

  constructor(options: TerminalSessionsOptions = {}) {
    this.options = options;
  }

  /** The user's login-shell profile, read at most once per application run. */
  profile(): Promise<Record<string, string>> {
    this.profileOnce ??= (this.options.profile ?? (() => loginShellProfile(this.options.source, this.options.platform)))();
    return this.profileOnce;
  }

  onOutput(listener: (chunk: TerminalChunk) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(workstreamId?: string): TerminalSession[] {
    return [...this.sessions.values()]
      .filter((live) => workstreamId === undefined || live.workstreamId === workstreamId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId))
      .map(view);
  }

  get(sessionId: string): TerminalSession | null {
    const live = this.sessions.get(sessionId);
    return live ? view(live) : null;
  }

  /** What a session has printed so far. Fetched once when a pane opens rather
   *  than riding on every list and rename: 200KB per reply, for a call that
   *  changes eight characters, is a cost nobody asked for. */
  scrollback(sessionId: string): string {
    return this.sessions.get(sessionId)?.scrollback ?? "";
  }

  open(request: OpenSessionRequest): TerminalSession {
    const cwd = assertWorktree(request.worktree, request.sourceRepo);
    // Every session of this workstream, not only the running ones: an exited
    // tab is still on screen and still holds its scrollback, so counting only
    // the live ones both mints a duplicate name and walks past the cap.
    const existing = [...this.sessions.values()].filter(
      (live) => live.workstreamId === request.workstreamId
    );
    if (existing.length >= MAX_SESSIONS_PER_WORKSTREAM) {
      const spent = existing.find((live) => live.state === "exited");
      if (spent === undefined) {
        throw new TerminalError(
          `This workstream already has ${MAX_SESSIONS_PER_WORKSTREAM} terminals open. Close one first.`
        );
      }
      this.forget(spent);
    }

    const kind: TerminalKind = request.kind ?? "shell";
    const sessionId = `trm_${randomBytes(9).toString("hex")}`;
    const platform = this.options.platform ?? process.platform;
    const { file, args } = shellFor(request.env, platform);

    let pty: PtyProcess;
    try {
      pty = this.host().spawn(file, args, {
        name: "xterm-256color",
        cols: clamp(request.cols ?? 80, 2, 1000),
        rows: clamp(request.rows ?? 24, 1, 500),
        cwd,
        // Exactly what the caller built with `terminalEnv()`. Nothing is added
        // here, so the disclosure boundary has one owner (D-041).
        env: request.env
      });
    } catch (error) {
      throw new TerminalError(`This terminal could not start: ${messageOf(error)}`);
    }

    let settle: () => void = () => undefined;
    const ended = new Promise<void>((done) => {
      settle = done;
    });
    const live: Live = {
      sessionId,
      workstreamId: request.workstreamId,
      name: cleanName(request.name) ?? defaultName(kind, this.nextOrdinal(request.workstreamId, kind)),
      kind,
      state: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      pty,
      pid: typeof pty.pid === "number" ? pty.pid : null,
      scrollback: "",
      pending: "",
      flush: null,
      escalation: null,
      ended,
      settle
    };
    this.sessions.set(sessionId, live);

    pty.onData((data) => this.absorb(live, data));
    pty.onExit(({ exitCode }) => this.finish(live, exitCode));

    return view(live);
  }

  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);
    if (live.state !== "running" || live.pty === null) {
      throw new TerminalError("That terminal has exited.");
    }
    try {
      live.pty.write(data);
    } catch (error) {
      throw new TerminalError(`That terminal stopped accepting input: ${messageOf(error)}`);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.require(sessionId);
    if (live.state !== "running" || live.pty === null) return; // an exited pane keeps its last size
    try {
      live.pty.resize(clamp(cols, 2, 1000), clamp(rows, 1, 500));
    } catch {
      /* the process went away between the check and the call */
    }
  }

  rename(sessionId: string, name: string): TerminalSession {
    const live = this.require(sessionId);
    const cleaned = cleanName(name);
    if (cleaned === null) throw new TerminalError("A terminal needs a name.");
    live.name = cleaned;
    return view(live);
  }

  /**
   * Ends the session and everything it started. Resolves once it is gone, or
   * once Novus has stopped waiting for it.
   *
   * The wait is bounded on purpose. `ended` settles from the PTY's own exit,
   * and a child that ignores SIGKILL — an uninterruptible read, a wedged
   * kernel extension — would otherwise leave this promise pending forever, and
   * with it the End-session button, and with it `before-quit`. A terminal that
   * will not die is a fact to report, not a reason to hang the application.
   */
  async close(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.signal(live);
    await Promise.race([live.ended, deadline(SIGKILL_AFTER_MS * 2)]);
    this.forget(live);
  }

  /** Called when the application is quitting: no shell outlives the app that
   *  started it, and nothing is left behind (D-034). Bounded for the same
   *  reason `close` is. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const live of all) this.signal(live);
    await Promise.race([
      Promise.allSettled(all.map((live) => live.ended)),
      deadline(SIGKILL_AFTER_MS * 2)
    ]);
    for (const live of all) this.forget(live);
    this.sessions.clear();
    this.listeners.clear();
  }

  /** Drops a session and every timer it owns. */
  private forget(live: Live): void {
    if (live.flush) clearTimeout(live.flush);
    if (live.escalation) clearTimeout(live.escalation);
    live.flush = null;
    live.escalation = null;
    this.sessions.delete(live.sessionId);
  }

  // --- Internals ---------------------------------------------------------------

  private host(): PtyHost {
    const configured = this.options.pty;
    if (typeof configured === "function") return configured();
    return configured ?? nodePtyHost();
  }

  /** The next free number for this kind, counting every session still known —
   *  running or exited — so two tabs never carry the same label. */
  private nextOrdinal(workstreamId: string, kind: TerminalKind): number {
    const taken = new Set(
      [...this.sessions.values()]
        .filter((live) => live.workstreamId === workstreamId)
        .map((live) => live.name)
    );
    for (let ordinal = 1; ordinal <= MAX_SESSIONS_PER_WORKSTREAM * 2 + 1; ordinal += 1) {
      if (!taken.has(defaultName(kind, ordinal))) return ordinal;
    }
    return taken.size + 1;
  }

  private require(sessionId: string): Live {
    const live = this.sessions.get(sessionId);
    if (!live) throw new TerminalError("That terminal is not open on this machine.");
    return live;
  }

  private absorb(live: Live, data: string): void {
    live.scrollback = bound(live.scrollback + data, MAX_SCROLLBACK);
    const grown = live.pending + data;
    if (grown.length > MAX_PENDING) {
      // The stream is bounded like the scrollback, but unlike the scrollback a
      // reader cannot tell a truncated stream from a quiet one. So it says so:
      // a hole in a terminal that announces itself is honest, and a hole that
      // does not is the pane and the scrollback silently disagreeing.
      const kept = grown.slice(grown.length - MAX_PENDING);
      live.pending = `${GAP_MARKER}${kept}`;
    } else {
      live.pending = grown;
    }
    if (live.flush !== null) return;
    live.flush = setTimeout(() => {
      live.flush = null;
      const chunk = live.pending;
      live.pending = "";
      if (chunk !== "") this.emit({ sessionId: live.sessionId, data: chunk, state: live.state, exitCode: live.exitCode });
    }, FLUSH_MS);
    live.flush.unref?.();
  }

  private finish(live: Live, exitCode: number): void {
    if (live.state === "exited") return;
    live.state = "exited";
    live.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    live.endedAt = new Date().toISOString();
    live.pty = null;
    if (live.flush) {
      clearTimeout(live.flush);
      live.flush = null;
    }
    if (live.escalation) {
      clearTimeout(live.escalation);
      live.escalation = null;
    }
    // The tail, plus the news that this was the last of it.
    const tail = live.pending;
    live.pending = "";
    this.emit({ sessionId: live.sessionId, data: tail, state: "exited", exitCode: live.exitCode });
    live.settle();
  }

  /** Hang up, then SIGTERM the group, then SIGKILL if any of it is still
   *  there. See `hangUp` for why the first of those three is the one that
   *  actually reaches a background job. */
  private signal(live: Live): void {
    if (live.state === "exited") {
      live.settle();
      return;
    }
    hangUp(live);
    if (live.escalation) clearTimeout(live.escalation);
    live.escalation = setTimeout(() => killTree(live, "SIGKILL"), SIGKILL_AFTER_MS);
    live.escalation.unref?.();
  }

  private emit(chunk: TerminalChunk): void {
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        /* a broken listener must not take the session down with it */
      }
    }
  }
}

// --- Shared plumbing ------------------------------------------------------------

function view(live: Live): TerminalSession {
  return {
    sessionId: live.sessionId,
    workstreamId: live.workstreamId,
    name: live.name,
    kind: live.kind,
    state: live.state,
    exitCode: live.exitCode,
    startedAt: live.startedAt,
    endedAt: live.endedAt
  };
}

/**
 * Where a session may open. The worktree is the only answer, and the user's own
 * checkout is refused by name — this is the assertion that stands between an
 * interactive shell and somebody's actual work.
 */
export function assertWorktree(worktree: string, sourceRepo: string): string {
  const tree = realOrSelf(worktree);
  const source = realOrSelf(sourceRepo);
  if (tree === source) {
    throw new TerminalError("Novus will not open a terminal in your own checkout.");
  }
  if (!existsSync(tree)) {
    throw new TerminalError("This workspace does not exist on this machine yet.");
  }
  return tree;
}

/**
 * The user's own shell, interactive but deliberately *not* a login shell: the
 * login profile has already been read and layered under the project's declared
 * values, and running it again here would reverse that order (D-041).
 */
export function shellFor(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform === "win32") return { file: env.COMSPEC ?? "cmd.exe", args: [] };
  const shell = env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file: shell, args: [] };
}

/**
 * How a terminal session is ended, in the order that actually reaches
 * everything.
 *
 * node-pty gives the shell its own session and its own process group, but a
 * shell attached to a tty turns *job control* on — so `sleep 300 &` lands in a
 * process group of its own inside that session, and signalling the shell's
 * group alone reaches the shell and nothing it started. (Observed, not assumed:
 * a group SIGTERM left the background job running.) What does reach it is the
 * hang-up a closing terminal window delivers: a shell receiving SIGHUP hangs up
 * its jobs before it exits.
 *
 * That covers a job the shell still owns. It does not cover one that left —
 * `( sleep 300 & )` in a subshell, or anything `disown`ed or `nohup`ed — which
 * is in neither the shell's group nor its job table, and which a group signal
 * therefore misses entirely. (Also observed: it survived.) So the descendants
 * are enumerated and signalled by name as well.
 *
 * Three things go out, then: SIGHUP to the session leader, for the usual case
 * where the session is a shell with jobs; SIGTERM to the foreground group, for
 * the case where it is not a shell at all; and SIGTERM to every descendant this
 * machine can still see. SIGKILL follows the same three on the escalation.
 */
function hangUp(live: Live): void {
  const descendants = live.pid === null ? [] : descendantsOf(live.pid);
  send(live, live.pid, "SIGHUP");
  send(live, live.pid === null ? null : -live.pid, "SIGTERM");
  for (const pid of descendants) bareKill(pid, "SIGTERM");
}

function killTree(live: Live, signal: NodeJS.Signals): void {
  const descendants = live.pid === null ? [] : descendantsOf(live.pid);
  send(live, live.pid === null ? null : -live.pid, signal);
  send(live, live.pid, signal);
  for (const pid of descendants) bareKill(pid, signal);
}

/**
 * Every process descended from this one, as the operating system currently
 * reports it. Best effort by design: on a machine where `ps` is unavailable or
 * slow the answer is an empty list and the group signals above still do their
 * ordinary work.
 */
export function descendantsOf(pid: number, table: string | null = processTable()): number[] {
  if (table === null) return [];
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const matched = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!matched) continue;
    const child = Number(matched[1]);
    const parent = Number(matched[2]);
    if (child === parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  // Bounded so a cycle in a malformed table cannot spin, and so a runaway
  // process farm cannot turn a close into a long operation.
  while (queue.length > 0 && found.length < MAX_DESCENDANTS) {
    const next = queue.shift();
    if (next === undefined) continue;
    for (const child of children.get(next) ?? []) {
      if (found.includes(child) || child === pid) continue;
      found.push(child);
      queue.push(child);
    }
  }
  // Deepest first: a parent that dies before its children can leave them
  // reparented and unreachable by this list.
  return found.reverse();
}

function processTable(): string | null {
  if (process.platform === "win32") return null;
  try {
    const listed = spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 });
    return listed.status === 0 ? listed.stdout : null;
  } catch {
    return null;
  }
}

function bareKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone, or not ours to signal */
  }
}

function send(live: Live, pid: number | null, signal: NodeJS.Signals): void {
  if (pid !== null) {
    try {
      process.kill(pid, signal);
      return;
    } catch {
      /* it is already gone, or the platform refused; fall through */
    }
  }
  try {
    live.pty?.kill(signal);
  } catch {
    /* already exited */
  }
}

/** Oldest dropped: what a person wants to read is the end. */
/** A wait that never becomes the reason an application will not quit. */
function deadline(ms: number): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(settle, ms);
    timer.unref?.();
  });
}

function bound(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function cleanName(name: string | undefined): string | null {
  if (name === undefined) return null;
  // Control characters in a tab label are a rendering trick, not a name.
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME);
  return cleaned === "" ? null : cleaned;
}

function defaultName(kind: TerminalKind, ordinal: number): string {
  return ordinal === 1 ? kind : `${kind} ${ordinal}`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong on this machine.";
}
