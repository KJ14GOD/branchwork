import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { uptime } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  type CommandEnding,
  type DeclaredCommand,
  type ProcessKind,
  type ProcessLog,
  type ProcessLogChunk,
  type ProcessReadiness,
  type ResolvedReadiness,
  type RunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import { redact } from "./secret-policy";
export { redact };
import { headSha, type GitExec } from "./workspace-git";

/**
 * Process supervision for a workspace (D-041 … D-045; the rules are in
 * ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 *
 * Setup commands are finite, run commands are long-lived, verification
 * commands are finite and cancellable, and every one of them:
 *
 *  - runs the **snapshot** a participant authorized, never a command line read
 *    back out of a file that may have changed since (D-043);
 *  - runs in the workstream's worktree and never in the user's own checkout.
 *    That is asserted on every spawn rather than assumed from how the caller
 *    was written;
 *  - gets its own process group, so a stop, a deadline, or the application
 *    quitting reaches the whole tree instead of orphaning whatever the command
 *    started;
 *  - has its output bounded and redacted before it can become evidence — both
 *    the machine-local paths the room must never learn and any secret value
 *    this machine holds — and kept locally afterwards, so a process that ended
 *    is still inspectable;
 *  - reports how it ended, by name: an exit code, a signal, a deadline, or a
 *    cancellation are four different endings and the room says which;
 *  - reports through named events, including the one nobody enjoys: after a
 *    relaunch a process that is not actually alive is reported as gone, never
 *    presented as still running.
 *
 * No shell channel exists here, and none is added: a remote controller may
 * invoke the commands the project declared and nothing else (D-042).
 */

/** How long a stopped process gets to unwind before it is killed outright. */
const SIGKILL_AFTER_MS = 5_000;
/** The contract's ceiling for reported check output. */
const MAX_OUTPUT = 4_000;
/** What the runtime dock keeps per process on this machine. Larger than the
 *  reported bound, because reading a build log is the dock's whole job. */
const MAX_LOG = 200 * 1024;
/** How many finished processes stay inspectable before the oldest is dropped. */
const MAX_RETAINED_LOGS = 40;
/** Output is coalesced on this interval so a chatty command cannot turn into an
 *  IPC storm. */
const FLUSH_MS = 32;
const MAX_REASON = 400;
/** How often a declared readiness signal is asked. */
const PROBE_EVERY_MS = 400;
/** One probe's own patience, so a hung socket cannot outlast the deadline. */
const PROBE_TIMEOUT_MS = 2_000;

export interface Invocation {
  /** Exactly what was authorized. Nothing here is re-read from the repository. */
  command: DeclaredCommand;
  /** Built by `projectEnv()`; this module never adds to it. */
  env: Record<string, string>;
  /** The port a run command was actually given — declared, or allocated for
   *  this workstream. */
  port?: number | null;
}

export interface SupervisorOptions {
  workstreamId: string;
  /** Where every command runs. */
  worktree: string;
  /** The user's own checkout. Nothing ever runs here. */
  sourceRepo: string;
  git: GitExec;
  /** Replaces machine-local absolute paths with neutral labels. */
  sanitize: (text: string) => string;
  /** The secret values held for this repository, read at report time so a
   *  value supplied mid-session is still redacted. */
  secretValues: () => readonly string[];
  /** Workspace observations belong to the workstream, not to any turn: a run
   *  command outlives an execution and a setup can precede the first one. */
  emit: (event: RunnerEvent) => void;
  /** Where running processes are recorded, so a relaunch can be honest. */
  recordPath: string;
  /** Asks a declared readiness signal whether the application is up.
   *  Injectable so readiness is testable without a real server. */
  probe?: ReadinessProbe;
}

/** True when the declared signal answered. Never throws: an unreachable
 *  application is an answer, not an exception. */
export type ReadinessProbe = (target: ReadinessTarget) => Promise<boolean>;

export interface ReadinessTarget {
  kind: "http" | "port";
  url: string | null;
  port: number | null;
}

interface Supervised {
  processId: string;
  kind: ProcessKind;
  name: string;
  child: ChildProcess;
  escalation: NodeJS.Timeout | null;
  /** Set the moment an ending is decided, so whichever of the exit paths
   *  arrives first cannot be overwritten by a later guess. */
  ending: CommandEnding | null;
  stopReason: string | null;
  finished: Promise<CommandOutcome>;
}

export interface CommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  spawnError: string | null;
  ending: CommandEnding;
}

export class WorkspaceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

/** One process's local record: what it is, how it ended, and what it printed. */
interface LogEntry {
  log: ProcessLog;
  pending: string;
  flush: NodeJS.Timeout | null;
}

export class WorkspaceProcesses {
  private readonly options: SupervisorOptions;
  /** Keyed by kind and name: a project may reasonably call both a run command
   *  and a check `test`, and one must never displace the other. */
  private readonly live = new Map<string, Supervised>();
  /** Insertion-ordered, so dropping the oldest is dropping the first. */
  private readonly logs = new Map<string, LogEntry>();
  private readonly listeners = new Set<(chunk: ProcessLogChunk) => void>();
  /** Every preview URL a process of this workstream actually reported. The
   *  preview bridge opens one of these and nothing else (D-045). */
  private readonly previews = new Set<string>();

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  isRunning(name: string): boolean {
    return [...this.live.values()].some((supervised) => supervised.name === name);
  }

  get runningNames(): string[] {
    return [...this.live.values()].map((supervised) => supervised.name);
  }

  /** Everything this workstream has run, still readable after it ended. */
  processLogs(): ProcessLog[] {
    return [...this.logs.values()].map((entry) => ({ ...entry.log }));
  }

  /** What this workstream reported as openable. */
  previewUrls(): string[] {
    return [...this.previews];
  }

  onLog(listener: (chunk: ProcessLogChunk) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The project's setup command. Readiness moves to `configuring` while it
   * runs and to `ready` or `failed` when it ends — never to `ready` on a
   * non-zero exit, whatever the command printed on its way out.
   */
  async runSetup(invocation: Invocation, ports: { start: number | null; end: number | null }): Promise<void> {
    this.report({
      kind: "workspace.readiness",
      payload: {
        readiness: "configuring",
        portRangeStart: ports.start,
        portRangeEnd: ports.end,
        setupError: null
      }
    });

    let outcome: CommandOutcome;
    try {
      outcome = await this.run(invocation, { finite: true });
    } catch (error) {
      const reason = this.clean(messageOf(error)).slice(0, MAX_REASON);
      this.report({
        kind: "workspace.readiness",
        payload: {
          readiness: "failed",
          portRangeStart: ports.start,
          portRangeEnd: ports.end,
          setupError: reason
        }
      });
      throw error;
    }

    const failure = describeFailure(outcome);
    this.report({
      kind: "workspace.readiness",
      payload: {
        readiness: failure === null ? "ready" : "failed",
        portRangeStart: ports.start,
        portRangeEnd: ports.end,
        setupError: failure === null ? null : this.clean(failure).slice(0, MAX_REASON)
      }
    });
  }

  /**
   * A long-lived run command. It is not tied to any harness turn: an agent
   * finishing does not stop the app, and the app running does not block
   * direction (PRODUCT.md, *App running*). It has no deadline of any kind —
   * the whole point of a run command is that it keeps going.
   */
  async startRun(invocation: Invocation, allowConcurrent: boolean): Promise<void> {
    const name = invocation.command.name;
    if (this.live.has(key("run", name))) return; // already alive: starting it again is a no-op
    if (!allowConcurrent) {
      const other = [...this.live.values()].find((supervised) => supervised.kind === "run");
      if (other) {
        throw new WorkspaceCommandError(
          `${other.name} is already running, and this project has not allowed two run commands at once.`
        );
      }
    }
    // Awaiting the spawn, not the server: a long-lived command resolves as soon
    // as it is running, so the command that asked for it is acknowledged while
    // the process carries on independently of any harness turn.
    await this.run(invocation, { finite: false });
  }

  /**
   * One verification check. The revision it proves is read *before* the command
   * starts: a check that began while the agent was still writing must not claim
   * a revision that did not exist when it ran (D-037). The origin is decided by
   * the caller — a participant's Run control, or Novus itself after a
   * checkpoint — and travels with the report, because the room must never read
   * "somebody ran this" about a check nobody pressed.
   */
  async runVerification(
    invocation: Invocation,
    origin: "participant" | "automatic" = "participant"
  ): Promise<void> {
    const spec = invocation.command;
    const checkpointSha = await headSha(this.options.git, this.options.worktree);
    const startedAt = new Date();
    let outcome: CommandOutcome;
    try {
      outcome = await this.run(invocation, { finite: true });
    } catch (error) {
      const completedAt = new Date();
      this.report({
        kind: "verification.completed",
        payload: {
          name: spec.name,
          category: spec.category ?? "test",
          outcome: "errored",
          command: this.clean(spec.command).slice(0, MAX_REASON),
          exitCode: null,
          output: this.clean(messageOf(error)).slice(0, MAX_OUTPUT),
          truncated: false,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
          origin,
          checkpointSha,
          ending: "spawn_failed"
        }
      });
      throw error;
    }

    const completedAt = new Date();
    this.report({
      kind: "verification.completed",
      payload: {
        name: spec.name,
        category: spec.category ?? "test",
        outcome: verdict(outcome),
        command: this.clean(spec.command).slice(0, MAX_REASON),
        exitCode: outcome.exitCode,
        output: outcome.output === "" ? null : outcome.output.slice(-MAX_OUTPUT),
        truncated: outcome.truncated,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        origin,
        checkpointSha,
        ending: outcome.ending
      }
    });
  }

  /** Stops the named process and everything it started. */
  async stop(name: string, reason: string): Promise<void> {
    const matching = [...this.live.values()].filter((supervised) => supervised.name === name);
    for (const supervised of matching) this.signal(supervised, "cancelled", reason);
    await Promise.allSettled(matching.map((supervised) => supervised.finished));
  }

  /** Stops everything. Called when the application is quitting, so no run
   *  command outlives the app that started it (D-034). */
  async stopAll(reason: string): Promise<void> {
    const all = [...this.live.values()];
    for (const supervised of all) this.signal(supervised, "cancelled", reason);
    await Promise.allSettled(all.map((supervised) => supervised.finished));
    for (const entry of this.logs.values()) {
      if (entry.flush) clearTimeout(entry.flush);
      entry.flush = null;
    }
  }

  // --- Spawning --------------------------------------------------------------

  private async run(invocation: Invocation, shape: { finite: boolean }): Promise<CommandOutcome> {
    const spec = invocation.command;
    const cwd = this.resolveCwd(spec.cwd ?? undefined);
    const processId = `prc_${randomBytes(9).toString("hex")}`;
    const port = invocation.port ?? spec.port ?? null;
    const declaredReadiness = shape.finite ? null : spec.readiness;
    const awaiting = declaredReadiness !== null && declaredReadiness.kind !== "process";

    let child: ChildProcess;
    try {
      child = spawnShell(spec.command, cwd, invocation.env);
    } catch (error) {
      const reason = this.clean(messageOf(error)).slice(0, MAX_REASON);
      this.openLog(processId, spec, port, "not_required");
      this.report({
        kind: "process.started",
        payload: {
          processId,
          kind: spec.kind,
          name: spec.name,
          command: this.clean(spec.command).slice(0, MAX_REASON),
          port,
          previewUrl: null,
          readiness: "not_required"
        }
      });
      this.closeLog(processId, "failed", null, "spawn_failed", reason);
      this.report({
        kind: "process.exited",
        payload: { processId, state: "failed", ending: "spawn_failed", exitCode: null, failureReason: reason }
      });
      return {
        exitCode: null,
        signal: null,
        output: "",
        truncated: false,
        spawnError: reason,
        ending: "spawn_failed"
      };
    }

    const preview = previewFor(spec.previewUrl ?? undefined, port);
    this.openLog(processId, spec, port, awaiting ? "pending" : "not_required");
    if (!shape.finite) this.setLogPreview(processId, preview.url);
    this.report({
      kind: "process.started",
      payload: {
        processId,
        kind: spec.kind,
        name: spec.name,
        command: this.clean(spec.command).slice(0, MAX_REASON),
        port,
        previewUrl: preview.url,
        readiness: awaiting ? "pending" : "not_required"
      }
    });

    const supervised: Supervised = {
      processId,
      kind: spec.kind,
      name: spec.name,
      child,
      escalation: null,
      ending: null,
      stopReason: null,
      finished: Promise.resolve(emptyOutcome())
    };
    supervised.finished = this.watch(supervised, invocation, shape, preview, port);
    this.live.set(key(spec.kind, spec.name), supervised);
    this.recordStart(processId, spec, child.pid ?? null);

    if (shape.finite) return supervised.finished;
    // A long-lived command is reported when it starts; the caller does not wait
    // for it to end. Its declared readiness signal is asked in the background —
    // a process existing is not a claim that an application is serving.
    if (awaiting && declaredReadiness !== null) {
      void this.awaitReadiness(supervised, declaredReadiness, port, preview.url);
    }
    return emptyOutcome();
  }

  private watch(
    supervised: Supervised,
    invocation: Invocation,
    shape: { finite: boolean },
    preview: Preview,
    port: number | null
  ): Promise<CommandOutcome> {
    const spec = invocation.command;
    return new Promise<CommandOutcome>((settle) => {
      const child = supervised.child;
      let output = "";
      let truncated = false;
      let spawnError: string | null = null;
      // A URL the project *declared* is the project's own statement and stands.
      // A URL Novus derived from the port it handed out is a guess, and the
      // server's own "Local: …" line is better evidence than a guess. A finite
      // command has no preview to offer whatever it prints.
      let previewSettled = preview.declared || shape.finite;
      let done = false;

      // The deadline the participant authorized, and nothing else. A run
      // command's `timeoutMs` is null by construction, so it never gets one.
      const deadline = spec.timeoutMs;
      const timeout =
        shape.finite && deadline !== null
          ? setTimeout(() => {
              this.signal(
                supervised,
                "timeout",
                `It ran past the ${describeMinutes(deadline)} this project allows for ${spec.name}.`
              );
            }, deadline)
          : null;
      // Deliberately not unref'd: a deadline that the event loop is allowed to
      // skip is not a deadline. It is cleared on every exit path below.

      const absorb = (chunk: Buffer): void => {
        const text = this.clean(chunk.toString());
        this.appendLog(supervised.processId, text);
        output += text;
        if (output.length > MAX_OUTPUT * 2) {
          // The tail is what says how a command ended, so that is what is kept.
          output = output.slice(output.length - MAX_OUTPUT * 2);
          truncated = true;
        }
        if (!previewSettled) {
          const discovered = detectPreviewUrl(text);
          if (discovered !== null && discovered !== preview.url) {
            previewSettled = true;
            // The only in-contract way to deliver a URL a server printed after
            // it started: the same process, now with one more true fact about
            // it.
            this.setLogPreview(supervised.processId, discovered);
            this.report({
              kind: "process.started",
              payload: {
                processId: supervised.processId,
                kind: spec.kind,
                name: spec.name,
                command: this.clean(spec.command).slice(0, MAX_REASON),
                port,
                previewUrl: discovered,
                readiness: this.logs.get(supervised.processId)?.log.readiness === "pending"
                  ? "pending"
                  : "not_required"
              }
            });
          }
        }
      };

      child.stdout?.on("data", absorb);
      child.stderr?.on("data", absorb);

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        if (supervised.escalation) clearTimeout(supervised.escalation);
        this.live.delete(key(spec.kind, spec.name));
        this.recordEnd(supervised.processId);

        const ending =
          supervised.ending ??
          (spawnError !== null
            ? "spawn_failed"
            : signal !== null
              ? "signal"
              : "exit");
        const outcome: CommandOutcome = { exitCode, signal, output, truncated, spawnError, ending };
        const failure = describeFailure(outcome, supervised.stopReason);
        const state = ending === "cancelled" ? "stopped" : failure === null ? "exited" : "failed";
        // A cancelled process is not a failure, but it still owes the room the
        // reason it stopped — "stopped" with no explanation is a room that
        // cannot say who did what.
        const said = ending === "cancelled" ? supervised.stopReason : failure;
        const reason = said === null ? null : this.clean(said).slice(0, MAX_REASON);
        this.closeLog(supervised.processId, state, exitCode, ending, reason);
        this.report({
          kind: "process.exited",
          payload: { processId: supervised.processId, state, ending, exitCode, failureReason: reason }
        });
        settle(outcome);
      };

      // Without this a missing binary is an unhandled error event and the
      // promise never settles: the command would hang forever.
      child.on("error", (error) => {
        spawnError = this.clean(messageOf(error)).slice(0, MAX_REASON);
        finish(null, null);
      });
      // Both, first one wins. `close` waits for the stdio streams, and a
      // grandchild that inherited the pipe holds them open after the shell
      // itself is gone — waiting only for `close` is how a quit hangs forever.
      child.on("exit", (code, signal) => finish(code, signal));
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  /**
   * Asks the declared readiness signal until it answers or its own deadline
   * passes. Either way the process keeps running: a health check that never
   * answered is a fact about the application, and killing somebody's server
   * over it is a decision only the project may make (`stopOnFailure`).
   */
  private async awaitReadiness(
    supervised: Supervised,
    readiness: ResolvedReadiness,
    port: number | null,
    fallbackPreview: string | null
  ): Promise<void> {
    const probe = this.options.probe ?? defaultProbe;
    const target = readinessTarget(readiness, port);
    if (target === null) {
      this.settleReadiness(supervised, "unreachable", null, "This readiness signal named nothing to check.");
      return;
    }
    const deadline = Date.now() + readiness.timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      if (!this.live.has(key(supervised.kind, supervised.name))) return; // it ended first
      let answered = false;
      try {
        answered = await probe(target);
      } catch {
        answered = false;
      }
      if (answered) {
        this.settleReadiness(supervised, "ready", target.kind === "http" ? target.url : fallbackPreview, null);
        return;
      }
      await pause(PROBE_EVERY_MS);
    }
    if (!this.live.has(key(supervised.kind, supervised.name))) return;
    this.settleReadiness(
      supervised,
      "unreachable",
      null,
      `It did not answer ${target.kind === "http" ? target.url ?? "its health URL" : `port ${target.port ?? "?"}`} within ${readiness.timeoutSeconds}s.`
    );
    if (readiness.stopOnFailure) {
      this.signal(supervised, "cancelled", "This project asks Novus to stop a run command that never became ready.");
    }
  }

  private settleReadiness(
    supervised: Supervised,
    readiness: "ready" | "unreachable",
    previewUrl: string | null,
    detail: string | null
  ): void {
    if (previewUrl !== null) this.setLogPreview(supervised.processId, previewUrl);
    const entry = this.logs.get(supervised.processId);
    if (entry) {
      entry.log.readiness = readiness;
      this.emitChunk(entry, "");
    }
    this.report({
      kind: "process.readiness",
      payload: {
        processId: supervised.processId,
        readiness,
        previewUrl,
        detail: detail === null ? null : this.clean(detail).slice(0, MAX_REASON)
      }
    });
  }

  /** SIGTERM to the whole group, then SIGKILL if it is still there. The ending
   *  is fixed here, before the exit arrives, so the reason a process stopped is
   *  the reason Novus decided and not one inferred from a signal afterwards. */
  private signal(supervised: Supervised, ending: CommandEnding, reason: string): void {
    supervised.ending ??= ending;
    supervised.stopReason ??= reason;
    killTree(supervised.child, "SIGTERM");
    if (supervised.escalation) clearTimeout(supervised.escalation);
    supervised.escalation = setTimeout(() => killTree(supervised.child, "SIGKILL"), SIGKILL_AFTER_MS);
    supervised.escalation.unref?.();
  }

  /**
   * Where a command may run. The worktree is the only answer, and the user's
   * own checkout is refused by name rather than by convention — this is the
   * assertion that stands between a project's build script and somebody's
   * actual work.
   */
  private resolveCwd(relative: string | undefined): string {
    const worktree = realOrSelf(this.options.worktree);
    const source = realOrSelf(this.options.sourceRepo);
    if (worktree === source) {
      throw new WorkspaceCommandError("Novus will not run a project command in your own checkout.");
    }
    if (relative === undefined || relative === "") return worktree;
    if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new WorkspaceCommandError("That working directory is not inside the workspace.");
    }
    const target = resolve(worktree, relative);
    if (target !== worktree && !target.startsWith(`${worktree}${sep}`)) {
      throw new WorkspaceCommandError("That working directory is not inside the workspace.");
    }
    if (!existsSync(target)) {
      throw new WorkspaceCommandError("That working directory does not exist in the workspace yet.");
    }
    return target;
  }

  // --- The local log --------------------------------------------------------

  private openLog(
    processId: string,
    spec: DeclaredCommand,
    port: number | null,
    readiness: ProcessReadiness
  ): void {
    void port;
    if (this.logs.size >= MAX_RETAINED_LOGS) {
      for (const [id, entry] of this.logs) {
        if (entry.log.state === "starting" || entry.log.state === "running") continue;
        if (entry.flush) clearTimeout(entry.flush);
        this.logs.delete(id);
        break;
      }
    }
    this.logs.set(processId, {
      log: {
        processId,
        workstreamId: this.options.workstreamId,
        kind: spec.kind,
        name: spec.name,
        command: this.clean(spec.command).slice(0, MAX_REASON),
        state: readiness === "pending" ? "starting" : "running",
        readiness,
        exitCode: null,
        ending: null,
        failureReason: null,
        previewUrl: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        output: "",
        truncated: false
      },
      pending: "",
      flush: null
    });
  }

  private appendLog(processId: string, text: string): void {
    const entry = this.logs.get(processId);
    if (!entry || text === "") return;
    const grown = entry.log.output + text;
    if (grown.length > MAX_LOG) {
      entry.log.output = grown.slice(grown.length - MAX_LOG);
      entry.log.truncated = true;
    } else {
      entry.log.output = grown;
    }
    entry.pending += text;
    if (entry.flush !== null) return;
    entry.flush = setTimeout(() => {
      entry.flush = null;
      const chunk = entry.pending;
      entry.pending = "";
      if (chunk !== "") this.emitChunk(entry, chunk);
    }, FLUSH_MS);
    entry.flush.unref?.();
  }

  private setLogPreview(processId: string, url: string | null): void {
    if (url !== null) this.previews.add(url);
    const entry = this.logs.get(processId);
    if (entry) entry.log.previewUrl = url;
  }

  private closeLog(
    processId: string,
    state: ProcessLog["state"],
    exitCode: number | null,
    ending: CommandEnding,
    failureReason: string | null
  ): void {
    const entry = this.logs.get(processId);
    if (!entry) return;
    if (entry.flush) {
      clearTimeout(entry.flush);
      entry.flush = null;
    }
    entry.log.state = state;
    entry.log.exitCode = exitCode;
    entry.log.ending = ending;
    entry.log.failureReason = failureReason;
    entry.log.endedAt = new Date().toISOString();
    if (entry.log.readiness === "pending") entry.log.readiness = "not_required";
    const tail = entry.pending;
    entry.pending = "";
    this.emitChunk(entry, tail);
  }

  private emitChunk(entry: LogEntry, data: string): void {
    const chunk: ProcessLogChunk = {
      processId: entry.log.processId,
      workstreamId: entry.log.workstreamId,
      data,
      state: entry.log.state,
      readiness: entry.log.readiness,
      exitCode: entry.log.exitCode,
      ending: entry.log.ending
    };
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        /* a broken listener must not take the process down with it */
      }
    }
  }

  // --- Reporting -------------------------------------------------------------

  /** Every reported string passes through here: machine-local paths become
   *  labels and any secret value becomes a marker. */
  private clean(text: string): string {
    return redact(this.options.sanitize(text), this.options.secretValues());
  }

  private report(event: RunnerEvent): void {
    this.options.emit(redactEvent(event, (text) => this.clean(text)));
  }

  // --- The record a relaunch reads ------------------------------------------

  private recordStart(processId: string, spec: DeclaredCommand, pid: number | null): void {
    if (pid === null) return;
    const records = readRecords(this.options.recordPath);
    records[processId] = {
      processId,
      workstreamId: this.options.workstreamId,
      kind: spec.kind,
      name: spec.name,
      pid,
      startedAt: new Date().toISOString()
    };
    writeRecords(this.options.recordPath, records);
  }

  private recordEnd(processId: string): void {
    const records = readRecords(this.options.recordPath);
    if (records[processId] === undefined) return;
    delete records[processId];
    writeRecords(this.options.recordPath, records);
  }
}

// --- Readiness ----------------------------------------------------------------

/**
 * The only hostnames a preview may carry. Literal strings, matched after
 * `new URL` has normalised the authority — a name that merely *resolves* to
 * loopback (`localtest.me`, `*.nip.io`, an attacker's own A record) is somebody
 * else's host with a friendly spelling, and resolving it here would introduce a
 * second moment for the answer to change.
 *
 * `0.0.0.0` is deliberately absent: it is what a server binds to, not somewhere
 * a browser goes. `detectPreviewUrl` already rewrites it to `localhost`, so
 * nothing legitimate needs it.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What a declared signal actually asks, with `{port}` filled in. Null when the
 *  project named a signal but nothing to check. */
export function readinessTarget(readiness: ResolvedReadiness, port: number | null): ReadinessTarget | null {
  if (readiness.kind === "process") return null;
  if (readiness.kind === "port") {
    const chosen = readiness.port ?? port;
    return chosen === null ? null : { kind: "port", url: null, port: chosen };
  }
  const template = readiness.url;
  if (template === null || template === "") return null;
  const filled = port === null ? template : template.split("{port}").join(String(port));
  if (filled.includes("{port}")) return null;
  return { kind: "http", url: filled, port };
}

/** The probe that actually runs on this machine. Loopback only: this is a
 *  readiness check for a local application, never a general-purpose fetcher. */
export const defaultProbe: ReadinessProbe = async (target) => {
  if (target.kind === "port") {
    return target.port === null ? false : await portAnswers(target.port);
  }
  const url = target.url === null ? null : parseLoopbackHttpUrl(target.url);
  if (url === null) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Any answer is an answer: a 404 from a server that is listening still
    // proves the server is listening, which is the question being asked.
    await fetch(url.toString(), { signal: controller.signal, redirect: "manual" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

function portAnswers(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (answer: boolean): void => {
      socket.destroy();
      settle(answer);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(settle, ms);
    timer.unref?.();
  });
}

// --- Relaunch reconciliation --------------------------------------------------

const RecordSchema = z.object({
  processId: z.string(),
  workstreamId: z.string(),
  kind: z.enum(["setup", "run", "verification"]),
  name: z.string(),
  pid: z.number().int(),
  startedAt: z.string()
});
const RecordFileSchema = z.record(RecordSchema);
export type ProcessRecord = z.infer<typeof RecordSchema>;

function readRecords(path: string): Record<string, ProcessRecord> {
  try {
    if (!existsSync(path)) return {};
    const parsed = RecordFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeRecords(path: string, records: Record<string, ProcessRecord>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records), { mode: 0o600 });
  } catch (error) {
    console.warn("[workspace] could not record a running process:", messageOf(error));
  }
}

/**
 * What a relaunch says about the processes the last run recorded.
 *
 * Nothing recorded is presented as still running. A process that died with the
 * app is reported gone; one that somehow survived is killed first, because
 * Novus can no longer read its output, no longer knows what it is doing, and
 * would otherwise leave a stranger holding the workstream's port. Either way
 * the room hears the truth rather than a stale "running".
 *
 * Only the *group* is signalled, and only when the recorded pid still leads one
 * of its own: a bare pid after a reboot may belong to somebody else's process,
 * and Novus does not kill a stranger to tidy its own bookkeeping.
 */
export function reconcileRecordedProcesses(
  recordPath: string,
  emit: (workstreamId: string, event: RunnerEvent) => void,
  isAlive: (pid: number) => boolean = processIsAlive
): ProcessRecord[] {
  const records = Object.values(readRecords(recordPath));
  if (records.length === 0) return [];
  const bootedAt = Date.now() - uptime() * 1000;
  for (const record of records) {
    // A pid recorded before this machine booted is not this process any more —
    // pids restart low, and Novus does not signal a stranger to tidy its own
    // bookkeeping. It is still reported as gone, because it is.
    const sameBoot = Date.parse(record.startedAt) >= bootedAt;
    const alive = sameBoot && isAlive(record.pid);
    if (alive) {
      try {
        // The negative pid is the whole safety property: it only signals when
        // this pid is still a process-group leader, which is what Novus made it.
        process.kill(-record.pid, "SIGTERM");
      } catch {
        /* the group is gone, or this pid is no longer a leader — leave it alone */
      }
    }
    emit(record.workstreamId, {
      kind: "process.exited",
      payload: {
        processId: record.processId,
        state: "stopped",
        ending: "cancelled",
        exitCode: null,
        failureReason: alive
          ? "Novus restarted and could no longer supervise this process, so it was stopped."
          : "Novus closed while this was running, so it is no longer running."
      }
    });
  }
  writeRecords(recordPath, {});
  return records;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means something is there and it is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- Output handling ----------------------------------------------------------


/** Every string in a reported payload, cleaned in one place, so this is
 *  structural rather than something each call site has to remember. */
function redactEvent(event: RunnerEvent, clean: (text: string) => string): RunnerEvent {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { kind: event.kind, payload: walk(event.payload) } as RunnerEvent;
}

export interface Preview {
  url: string | null;
  /** True when the project said so, rather than Novus deriving it from the
   *  port it allocated. A derivation yields to what the server actually
   *  prints; a declaration does not. */
  declared: boolean;
}

/** Where a person can open this run command, before it has printed anything. */
export function previewFor(template: string | undefined, port: number | null): Preview {
  if (template === undefined || template === "") {
    // Novus told the command which port to use, so this is the reasonable
    // guess — and it is marked as one.
    return { url: port === null ? null : `http://localhost:${port}`, declared: false };
  }
  const filled = port === null ? template : template.split("{port}").join(String(port));
  return filled.includes("{port}")
    ? { url: null, declared: false }
    : { url: filled.slice(0, 300), declared: true };
}

const LOCAL_URL =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>)\]]*)?)/i;

/** The "Local: http://…" line every dev server prints, in whatever dressing. */
export function detectPreviewUrl(text: string): string | null {
  const match = LOCAL_URL.exec(text);
  const found = match?.[1];
  if (found === undefined) return null;
  // 0.0.0.0 is what a server binds to, not somewhere a browser goes.
  return found.replace("0.0.0.0", "localhost").slice(0, 300);
}

/**
 * A loopback `http`/`https` URL, or null.
 *
 * This is the one gate between "a project printed a string" and "Novus asked
 * the operating system to open it", so it is deliberately narrow: only those
 * two schemes, only a loopback host, and never a URL carrying credentials —
 * `http://localhost@evil.example` has the authority `evil.example` and a
 * `startsWith("http://localhost")` check would wave it straight through.
 */
export function parseLoopbackHttpUrl(candidate: string): URL | null {
  // Refused before parsing rather than after: the URL parser silently strips
  // or percent-encodes whitespace and control characters, so a string carrying
  // one would come back looking well-formed instead of being rejected.
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return null;
  return url;
}

// --- Shared plumbing ----------------------------------------------------------

/**
 * A command line is a command line: it wants a shell to read it. Deliberately
 * not a *login* shell — the user's profile belongs to the interactive terminal
 * environment and nowhere else (D-041), which is why the constructed PATH
 * carries the places a tool is actually installed.
 */
function spawnShell(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  const windows = process.platform === "win32";
  const shell = windows ? (env.COMSPEC ?? "cmd.exe") : "/bin/sh";
  const args = windows ? ["/d", "/s", "/c", command] : ["-c", command];
  return spawn(shell, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a stop reaches everything the command started.
    detached: !windows
  });
}

/** One live process per kind and name. */
function key(kind: ProcessKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * Both the group and the process itself, unconditionally.
 *
 * A group signal reaches only what is still in that group, and the direct child
 * is signalled separately rather than as a fallback: making the second call
 * conditional on the first throwing means a group that partly went away leaves
 * the shell running. Neither call is expected to succeed every time, so both
 * failures are absorbed.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* the group is gone, or this platform has none */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

function describeMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.max(1, Math.round(ms / 1000))} seconds`;
}

export function describeFailure(outcome: CommandOutcome, stopReason?: string | null): string | null {
  if (outcome.ending === "spawn_failed") return `It could not start: ${outcome.spawnError ?? "unknown"}`;
  if (outcome.ending === "timeout") return stopReason ?? "It ran past the time this project allows.";
  if (outcome.ending === "cancelled") return null;
  if (outcome.signal !== null) return `It was killed by ${outcome.signal}.`;
  if (outcome.exitCode !== 0 && outcome.exitCode !== null) return `It exited with code ${outcome.exitCode}.`;
  return null;
}

function verdict(outcome: CommandOutcome): "passed" | "failed" | "errored" {
  // A check that ran out of time, was cancelled, or never started produced no
  // verdict. Calling any of those a pass or a fail would be inventing evidence.
  if (outcome.ending !== "exit") return "errored";
  return outcome.exitCode === 0 ? "passed" : "failed";
}

function emptyOutcome(): CommandOutcome {
  return {
    exitCode: null,
    signal: null,
    output: "",
    truncated: false,
    spawnError: null,
    ending: "exit"
  };
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
