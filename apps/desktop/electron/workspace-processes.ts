import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ProcessKind, RunnerEvent, VerificationCheck } from "@novus/contracts";
import { z } from "zod";
import { headSha, type GitExec } from "./workspace-git";

/**
 * Process supervision for a workspace (D-041, D-042; the rules are in
 * ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 *
 * Setup commands are finite, run commands are long-lived, verification
 * commands are finite and cancellable, and every one of them:
 *
 *  - runs in the workstream's worktree and never in the user's own checkout.
 *    That is asserted on every spawn rather than assumed from how the caller
 *    was written;
 *  - gets its own process group, so a stop, a restart, or the application
 *    quitting reaches the whole tree instead of orphaning whatever the command
 *    started;
 *  - has its output bounded and redacted before it can become evidence — both
 *    the machine-local paths the room must never learn and any secret value
 *    this machine holds;
 *  - reports through named events, including the one nobody enjoys: after a
 *    relaunch a process that is not actually alive is reported as gone, never
 *    presented as still running.
 *
 * No shell channel exists here, and none is added: a remote controller may
 * invoke the commands the project declared and nothing else (D-042).
 */

/** How long a stopped process gets to unwind before it is killed outright. */
const SIGKILL_AFTER_MS = 5_000;
/** A finite command that has not ended by now is not going to. */
const FINITE_TIMEOUT_MS = 30 * 60_000;
/** The contract's ceiling for reported check output. */
const MAX_OUTPUT = 4_000;
/** Below this length a "secret" is a word, and redacting it would shred every
 *  line of output that happens to contain it. */
const MIN_REDACTABLE = 6;
const MAX_REASON = 400;

export interface CommandSpec {
  name: string;
  /** As the project declared it; never an expanded secret. */
  command: string;
  /** Relative to the worktree. */
  cwd?: string | undefined;
  env: Record<string, string>;
}

export interface LongRunSpec extends CommandSpec {
  port: number | null;
  /** What the project says its preview looks like; `{port}` is substituted. */
  previewUrl?: string | undefined;
  /** Whether the project allows a second run command to be alive at once. */
  allowConcurrent: boolean;
}

export interface VerificationSpec extends CommandSpec {
  category: VerificationCheck["category"];
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
}

interface Supervised {
  processId: string;
  kind: ProcessKind;
  name: string;
  child: ChildProcess;
  escalation: NodeJS.Timeout | null;
  stopReason: string | null;
  finished: Promise<CommandOutcome>;
}

export interface CommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  spawnError: string | null;
  timedOut: boolean;
  stopped: boolean;
}

export class WorkspaceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

export class WorkspaceProcesses {
  private readonly options: SupervisorOptions;
  /** Keyed by kind and name: a project may reasonably call both a run command
   *  and a check `test`, and one must never displace the other. */
  private readonly live = new Map<string, Supervised>();

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  isRunning(name: string): boolean {
    return [...this.live.values()].some((supervised) => supervised.name === name);
  }

  get runningNames(): string[] {
    return [...this.live.values()].map((supervised) => supervised.name);
  }

  /**
   * The project's setup command. Readiness moves to `configuring` while it
   * runs and to `ready` or `failed` when it ends — never to `ready` on a
   * non-zero exit, whatever the command printed on its way out.
   */
  async runSetup(spec: CommandSpec, ports: { start: number | null; end: number | null }): Promise<void> {
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
      outcome = await this.run("setup", spec, { finite: true, port: null, previewUrl: undefined });
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
   * direction (PRODUCT.md, *Project running*).
   */
  async startRun(spec: LongRunSpec): Promise<void> {
    if (this.live.has(key("run", spec.name))) return; // already alive: starting it again is a no-op
    if (!spec.allowConcurrent) {
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
    await this.run("run", spec, { finite: false, port: spec.port, previewUrl: spec.previewUrl });
  }

  /**
   * One verification check. The revision it proves is read *before* the command
   * starts: a check that began while the agent was still writing must not claim
   * a revision that did not exist when it ran (D-037).
   */
  async runVerification(spec: VerificationSpec): Promise<void> {
    const checkpointSha = await headSha(this.options.git, this.options.worktree);
    const startedAt = new Date();
    let outcome: CommandOutcome;
    try {
      outcome = await this.run("verification", spec, { finite: true, port: null, previewUrl: undefined });
    } catch (error) {
      const completedAt = new Date();
      this.report({
        kind: "verification.completed",
        payload: {
          name: spec.name,
          category: spec.category,
          outcome: "errored",
          command: this.clean(spec.command).slice(0, MAX_REASON),
          exitCode: null,
          output: this.clean(messageOf(error)).slice(0, MAX_OUTPUT),
          truncated: false,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
          checkpointSha
        }
      });
      throw error;
    }

    const completedAt = new Date();
    this.report({
      kind: "verification.completed",
      payload: {
        name: spec.name,
        category: spec.category,
        outcome: verdict(outcome),
        command: this.clean(spec.command).slice(0, MAX_REASON),
        exitCode: outcome.exitCode,
        output: outcome.output === "" ? null : outcome.output,
        truncated: outcome.truncated,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        checkpointSha
      }
    });
  }

  /** Stops the named process and everything it started. */
  async stop(name: string, reason: string): Promise<void> {
    const matching = [...this.live.values()].filter((supervised) => supervised.name === name);
    for (const supervised of matching) this.signal(supervised, reason);
    await Promise.allSettled(matching.map((supervised) => supervised.finished));
  }

  /** Stops everything. Called when the application is quitting, so no run
   *  command outlives the app that started it (D-034). */
  async stopAll(reason: string): Promise<void> {
    const all = [...this.live.values()];
    for (const supervised of all) this.signal(supervised, reason);
    await Promise.allSettled(all.map((supervised) => supervised.finished));
  }

  // --- Spawning --------------------------------------------------------------

  private async run(
    kind: ProcessKind,
    spec: CommandSpec,
    shape: { finite: boolean; port: number | null; previewUrl: string | undefined }
  ): Promise<CommandOutcome> {
    const cwd = this.resolveCwd(spec.cwd);
    const processId = `prc_${randomBytes(9).toString("hex")}`;

    let child: ChildProcess;
    try {
      child = spawnShell(spec.command, cwd, spec.env);
    } catch (error) {
      const reason = this.clean(messageOf(error)).slice(0, MAX_REASON);
      this.report({
        kind: "process.started",
        payload: {
          processId,
          kind,
          name: spec.name,
          command: this.clean(spec.command).slice(0, MAX_REASON),
          port: shape.port,
          previewUrl: null
        }
      });
      this.report({
        kind: "process.exited",
        payload: { processId, state: "failed", exitCode: null, failureReason: reason }
      });
      return {
        exitCode: null,
        signal: null,
        output: "",
        truncated: false,
        spawnError: reason,
        timedOut: false,
        stopped: false
      };
    }

    const preview = previewFor(shape.previewUrl, shape.port);
    this.report({
      kind: "process.started",
      payload: {
        processId,
        kind,
        name: spec.name,
        command: this.clean(spec.command).slice(0, MAX_REASON),
        port: shape.port,
        previewUrl: preview.url
      }
    });

    const supervised: Supervised = {
      processId,
      kind,
      name: spec.name,
      child,
      escalation: null,
      stopReason: null,
      finished: Promise.resolve(emptyOutcome())
    };
    supervised.finished = this.watch(supervised, spec, shape, preview);
    this.live.set(key(kind, spec.name), supervised);
    this.recordStart(processId, spec, kind, child.pid ?? null);

    if (shape.finite) return supervised.finished;
    // A long-lived command is reported when it starts; the caller does not wait
    // for it to end, and the exit event arrives whenever it does.
    return emptyOutcome();
  }

  private watch(
    supervised: Supervised,
    spec: CommandSpec,
    shape: { finite: boolean; port: number | null; previewUrl: string | undefined },
    preview: Preview
  ): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((settle) => {
      const child = supervised.child;
      let output = "";
      let truncated = false;
      let spawnError: string | null = null;
      let timedOut = false;
      // A URL the project *declared* is the project's own statement and stands.
      // A URL Novus derived from the port it handed out is a guess, and the
      // server's own "Local: …" line is better evidence than a guess. A finite
      // command has no preview to offer whatever it prints.
      let previewSettled = preview.declared || shape.finite;
      let done = false;

      const timeout = shape.finite
        ? setTimeout(() => {
            timedOut = true;
            this.signal(supervised, "It ran past the time Novus waits for a finite command.");
          }, FINITE_TIMEOUT_MS)
        : null;
      timeout?.unref?.();

      const absorb = (chunk: Buffer): void => {
        const text = this.clean(chunk.toString());
        output += text;
        if (output.length > MAX_OUTPUT) {
          // The tail is what says how a command ended, so that is what is kept.
          output = output.slice(output.length - MAX_OUTPUT);
          truncated = true;
        }
        if (!previewSettled) {
          const discovered = detectPreviewUrl(text);
          if (discovered !== null && discovered !== preview.url) {
            previewSettled = true;
            // The only in-contract way to deliver a URL a server printed after
            // it started: the same process, now with one more true fact about
            // it.
            this.report({
              kind: "process.started",
              payload: {
                processId: supervised.processId,
                kind: supervised.kind,
                name: spec.name,
                command: this.clean(spec.command).slice(0, MAX_REASON),
                port: shape.port,
                previewUrl: discovered
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
        this.live.delete(key(supervised.kind, spec.name));
        this.recordEnd(supervised.processId);

        const outcome: CommandOutcome = {
          exitCode,
          signal,
          output,
          truncated,
          spawnError,
          timedOut,
          stopped: supervised.stopReason !== null
        };
        const failure = describeFailure(outcome);
        this.report({
          kind: "process.exited",
          payload: {
            processId: supervised.processId,
            state: outcome.stopped ? "stopped" : failure === null ? "exited" : "failed",
            exitCode,
            failureReason:
              outcome.stopped && supervised.stopReason !== null
                ? this.clean(supervised.stopReason).slice(0, MAX_REASON)
                : failure === null
                  ? null
                  : this.clean(failure).slice(0, MAX_REASON)
          }
        });
        settle(outcome);
      };

      // Without this a missing binary is an unhandled error event and the
      // promise never settles: the command would hang forever.
      child.on("error", (error) => {
        spawnError = this.clean(messageOf(error)).slice(0, MAX_REASON);
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  /** SIGTERM to the whole group, then SIGKILL if it is still there. */
  private signal(supervised: Supervised, reason: string): void {
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

  private recordStart(processId: string, spec: CommandSpec, kind: ProcessKind, pid: number | null): void {
    if (pid === null) return;
    const records = readRecords(this.options.recordPath);
    records[processId] = {
      processId,
      workstreamId: this.options.workstreamId,
      kind,
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
 */
export function reconcileRecordedProcesses(
  recordPath: string,
  emit: (workstreamId: string, event: RunnerEvent) => void,
  isAlive: (pid: number) => boolean = processIsAlive
): ProcessRecord[] {
  const records = Object.values(readRecords(recordPath));
  if (records.length === 0) return [];
  for (const record of records) {
    const alive = isAlive(record.pid);
    if (alive) {
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch {
        try {
          process.kill(record.pid, "SIGTERM");
        } catch {
          /* it went away between the check and the signal */
        }
      }
    }
    emit(record.workstreamId, {
      kind: "process.exited",
      payload: {
        processId: record.processId,
        state: "stopped",
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

/**
 * Removes any secret value from text before it can be reported. Short values
 * are left alone: below a handful of characters a "secret" is a common word,
 * and blanking every occurrence would destroy the output without protecting
 * anything.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

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

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, or the platform refused; fall back to the
    // process itself rather than leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

function describeFailure(outcome: CommandOutcome): string | null {
  if (outcome.spawnError !== null) return `It could not start: ${outcome.spawnError}`;
  if (outcome.timedOut) return "It ran past the time Novus waits for a finite command.";
  if (outcome.stopped) return null;
  if (outcome.signal !== null) return `It was killed by ${outcome.signal}.`;
  if (outcome.exitCode !== 0 && outcome.exitCode !== null) return `It exited with code ${outcome.exitCode}.`;
  return null;
}

function verdict(outcome: CommandOutcome): "passed" | "failed" | "errored" {
  if (outcome.spawnError !== null || outcome.timedOut) return "errored";
  // A cancelled check produced no verdict; calling it a pass or a fail would be
  // inventing evidence.
  if (outcome.stopped) return "errored";
  return outcome.exitCode === 0 ? "passed" : "failed";
}

function emptyOutcome(): CommandOutcome {
  return {
    exitCode: null,
    signal: null,
    output: "",
    truncated: false,
    spawnError: null,
    timedOut: false,
    stopped: false
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
