import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EffortSchema,
  ModelIdSchema,
  type RunnerEvent
} from "@novus/contracts";
import { captureCheckpoint, createSanitizer, type GitRunner } from "./evidence";
import { HarnessStream } from "./harness-stream";

/**
 * The Claude Code adapter (D-017, D-032): one direction becomes one supervised
 * headless turn in a dedicated worktree of the mission branch — never the
 * user's own checkout — and everything observed is reported upward as a claim.
 *
 * The rules this module exists to keep:
 *
 *  - No absolute local path may appear in any reported payload. Every event
 *    leaves through one sanitizing gate, so this is structural rather than a
 *    discipline each call site has to remember.
 *  - A turn always ends. A spawn that fails, a harness that dies, a checkpoint
 *    that throws, a stop that the process ignores — each has a named outcome.
 *  - A failed checkpoint is never reported as a completed execution.
 *  - A fresh harness session is never presented as a continuous one.
 *
 * No Electron import: the app supplies the worktree root, the repository path,
 * and whether it is packaged, which keeps the whole turn testable.
 */

/** Where a harness CLI installed outside the login shell's PATH usually lives. */
const PROBE_PATH = [
  process.env.PATH ?? "",
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin"
].join(":");

/** Server-allocated branch names only; a direction never names a branch. */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+$/;

/** How long a stopped harness gets to exit on its own before it is killed. */
const SIGKILL_AFTER_MS = 5_000;

const MAX_STDERR = 4_000;
const MAX_REASON = 400;

export type TerminalEvent = Extract<
  RunnerEvent,
  {
    kind:
      | "execution.completed"
      | "execution.stopped"
      | "execution.failed"
      | "execution.interrupted";
  }
>;

export interface TurnRequest {
  executionId: string;
  missionId: string;
  /** The user's repository, from which the mission worktree is created. */
  repositoryPath: string;
  /** The app-owned directory that holds one worktree per mission. */
  worktreeRoot: string;
  missionBranch: string;
  direction: string;
  model: string;
  effort: string;
  /** The session this workstream continues, or null for a fresh one. */
  resumeSessionId: string | null;
  /** Announce the execution's start; a follow-up turn inside the same
   *  execution does not repeat it. */
  announceStart: boolean;
  /** Deterministic scripted harness for tests; the caller gates it. */
  fakeHarness: boolean;
  emit: (event: RunnerEvent) => void;
}

export interface TurnResult {
  /** What the execution's terminal event should be. The caller emits it when
   *  the execution actually ends, so a follow-up direction can extend the run. */
  terminal: TerminalEvent;
  /** The session the harness used, for the next turn to continue. */
  sessionId: string | null;
}

export interface RunningTurn {
  stop(reason: string): void;
  readonly finished: Promise<TurnResult>;
}

const gitExec: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))
    );
  });

/** Every string in every reported payload passes through here. */
function sanitizeEvent(event: RunnerEvent, sanitize: (text: string) => string): RunnerEvent {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return sanitize(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { kind: event.kind, payload: walk(event.payload) } as RunnerEvent;
}

/**
 * One worktree per mission, created from the mission branch and reused across
 * turns. Stale metadata from a worktree the user deleted by hand is pruned
 * first, and a directory left behind without its git link is rebuilt, so
 * recovery never needs manual git surgery.
 */
async function ensureWorktree(
  git: GitRunner,
  repositoryPath: string,
  worktreeRoot: string,
  missionId: string,
  missionBranch: string
): Promise<string> {
  const worktree = join(worktreeRoot, missionId);
  await git(repositoryPath, ["worktree", "prune"]).catch(() => undefined);
  if (existsSync(join(worktree, ".git"))) return worktree;
  mkdirSync(worktreeRoot, { recursive: true });
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  await git(repositoryPath, ["worktree", "add", "--", worktree, missionBranch]);
  return worktree;
}

/** Claude Code's own signals that the machine is not signed in. */
const AUTH_HINTS =
  /(invalid api key|authentication|unauthori[sz]ed|not logged in|please run\s+\/?login|credit balance|no api key)/i;

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError: string | null;
}

export function startTurn(request: TurnRequest): RunningTurn {
  const worktree = join(request.worktreeRoot, request.missionId);
  // The mask list is built before anything can be emitted, so the very first
  // event is already free of machine-local paths.
  const sanitize = createSanitizer([
    { path: worktree, label: "the mission worktree" },
    { path: request.repositoryPath, label: "the repository" },
    { path: request.worktreeRoot, label: "the mission worktrees" }
  ]);
  const emit = (event: RunnerEvent): void => request.emit(sanitizeEvent(event, sanitize));

  let stopReason: string | null = null;
  let child: ChildProcess | null = null;
  let escalation: NodeJS.Timeout | null = null;

  const stop = (reason: string): void => {
    stopReason = reason;
    const running = child;
    if (!running?.pid) return;
    // The harness spawns its own children; signalling the group is the only
    // way an interrupted turn does not leave orphans behind.
    killTree(running, "SIGTERM");
    if (escalation) clearTimeout(escalation);
    escalation = setTimeout(() => killTree(running, "SIGKILL"), SIGKILL_AFTER_MS);
    escalation.unref?.();
  };

  const finished = (async (): Promise<TurnResult> => {
    try {
      return await run();
    } finally {
      if (escalation) clearTimeout(escalation);
    }
  })();

  return { stop, finished };

  async function run(): Promise<TurnResult> {
    if (request.announceStart) emit({ kind: "execution.starting", payload: {} });

    if (!MISSION_BRANCH.test(request.missionBranch)) {
      return terminate({
        kind: "execution.failed",
        payload: { classification: "internal", reason: "Refusing to run against an unrecognized branch name." }
      });
    }

    let worktreePath: string;
    try {
      worktreePath = await ensureWorktree(
        gitExec,
        request.repositoryPath,
        request.worktreeRoot,
        request.missionId,
        request.missionBranch
      );
    } catch (error) {
      return terminate({
        kind: "execution.failed",
        payload: { classification: "internal", reason: bounded(sanitize(messageOf(error)), MAX_REASON) }
      });
    }

    // The allowlist in the contracts package is the only list of models and
    // efforts; anything else falls back rather than reaching the CLI.
    const chosenModel = ModelIdSchema.safeParse(request.model);
    const chosenEffort = EffortSchema.safeParse(request.effort);
    const model: string = chosenModel.success ? chosenModel.data : DEFAULT_MODEL;
    const effort: string = chosenEffort.success ? chosenEffort.data : DEFAULT_EFFORT;
    emit({ kind: "execution.running", payload: { harness: "claude-code", model, effort } });

    let resumeSessionId = request.resumeSessionId;
    let stream = new HarnessStream({ resumeSessionId, sanitize });
    let outcome = await attempt(worktreePath, model, effort, stream, resumeSessionId);

    // A session the CLI no longer holds must not silently become a fresh
    // conversation presented as continuous: retry once, openly fresh.
    if (
      resumeSessionId !== null &&
      stopReason === null &&
      stream.sessionId === null &&
      (outcome.spawnError !== null || outcome.code !== 0)
    ) {
      resumeSessionId = null;
      stream = new HarnessStream({ resumeSessionId: null, sanitize });
      outcome = await attempt(worktreePath, model, effort, stream, null);
    }

    for (const event of stream.end()) emit(event);

    // The harness has actually stopped working: this is the safe boundary a
    // pending control transfer waits for (PRODUCT.md#control).
    emit({ kind: "boundary.reached", payload: { reason: "turn complete" } });

    // "Nothing changed" is evidence too, so a clean turn still checkpoints.
    let checkpointFailed: string | null = null;
    try {
      const checkpoint = await captureCheckpoint(gitExec, worktreePath, {
        branch: request.missionBranch,
        summary: bounded(request.direction.replace(/\s+/g, " ").trim(), 72),
        sanitize
      });
      emit({ kind: "workspace.checkpoint", payload: checkpoint });
      if (checkpoint.outcome === "failed") checkpointFailed = checkpoint.error ?? "The checkpoint failed.";
    } catch (error) {
      const reason = bounded(sanitize(messageOf(error)), MAX_REASON);
      checkpointFailed = reason;
      emit({
        kind: "workspace.checkpoint",
        payload: {
          outcome: "failed",
          sha: null,
          parentSha: null,
          branch: request.missionBranch,
          withheldSecrets: 0,
          uncommitted: true,
          error: reason,
          files: []
        }
      });
    }

    return {
      terminal: classify(outcome, stream, checkpointFailed),
      sessionId: stream.sessionId
    };
  }

  /** One harness process, from spawn to exit. Never rejects. */
  function attempt(
    worktreePath: string,
    model: string,
    effort: string,
    stream: HarnessStream,
    resumeSessionId: string | null
  ): Promise<ProcessOutcome> {
    if (request.fakeHarness) return fakeAttempt(worktreePath, stream);

    return new Promise<ProcessOutcome>((resolve) => {
      const args = [
        "-p",
        request.direction,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--model",
        model,
        "--effort",
        effort,
        ...(resumeSessionId === null ? ["--session-id", randomUUID()] : ["--resume", resumeSessionId])
      ];
      let settled = false;
      const settle = (outcome: ProcessOutcome): void => {
        if (settled) return;
        settled = true;
        child = null;
        resolve(outcome);
      };

      let spawned: ChildProcess;
      try {
        spawned = spawn("claude", args, {
          cwd: worktreePath,
          env: { ...process.env, PATH: PROBE_PATH },
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so a stop reaches the tools it started.
          detached: true
        });
      } catch (error) {
        settle({ code: null, signal: null, stderr: "", spawnError: messageOf(error) });
        return;
      }
      child = spawned;
      if (stopReason !== null) stop(stopReason); // stopped between the decision and the spawn

      // Without this listener a missing binary is an unhandled error event and
      // the promise never settles: the turn would hang forever.
      spawned.on("error", (error) => {
        settle({ code: null, signal: null, stderr: "", spawnError: messageOf(error) });
      });

      spawned.stdout?.on("data", (chunk: Buffer) => {
        // Defensive by construction: the parser drops anything it cannot read
        // rather than throwing into the data handler.
        for (const event of stream.push(chunk.toString())) emit(event);
      });

      // stderr is Novus/system diagnostics. It is never the harness speaking,
      // so it never becomes harness.text.
      let stderr = "";
      spawned.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
      });

      spawned.on("close", (code, signal) => {
        settle({ code, signal, stderr, spawnError: null });
      });
    });
  }

  /** The scripted harness: the identical pipeline, real git, no model call. */
  async function fakeAttempt(worktreePath: string, stream: HarnessStream): Promise<ProcessOutcome> {
    try {
      const sessionId = request.resumeSessionId ?? randomUUID();
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-harness" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `Working on: ${request.direction}` }] }
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_fake_write",
                name: "Write",
                // Deliberately absolute: the sanitizing gate has to earn its keep.
                input: { file_path: join(worktreePath, "NOVUS_FAKE_TURN.md") }
              }
            ]
          }
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Done. The change is in the worktree." }] }
        })
      ];
      for (const line of lines) {
        if (stopReason !== null) return { code: null, signal: "SIGTERM", stderr: "", spawnError: null };
        for (const event of stream.push(`${line}\n`)) emit(event);
        await delay(20);
      }
      writeFileSync(join(worktreePath, "NOVUS_FAKE_TURN.md"), `# Fake turn\n\n${request.direction}\n`);
      // No trailing newline: the flush path is part of what is being exercised.
      stream.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
      return { code: 0, signal: null, stderr: "", spawnError: null };
    } catch (error) {
      // An exception in the double must still end the turn, or a test run
      // hangs on an execution that never terminates.
      return { code: null, signal: null, stderr: "", spawnError: messageOf(error) };
    }
  }

  function classify(
    outcome: ProcessOutcome,
    stream: HarnessStream,
    checkpointFailed: string | null
  ): TerminalEvent {
    if (stopReason !== null) {
      return { kind: "execution.stopped", payload: { reason: bounded(sanitize(stopReason), MAX_REASON) } };
    }
    if (outcome.spawnError !== null) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "spawn_failed",
          reason: bounded(sanitize(`Claude Code could not start: ${outcome.spawnError}`), MAX_REASON)
        }
      };
    }
    const result = stream.result;
    const diagnostics = `${result?.message ?? ""}\n${outcome.stderr}`;
    if ((result?.isError === true || outcome.code !== 0) && AUTH_HINTS.test(diagnostics)) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "authentication",
          reason: "Claude Code isn't signed in on this machine. Sign in to the CLI and direct again."
        }
      };
    }
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim() || result?.message || `exit ${outcome.code ?? "unknown"}`;
      return {
        kind: "execution.failed",
        payload: {
          classification: "nonzero_exit",
          reason: bounded(sanitize(`Claude Code exited unsuccessfully: ${detail}`), MAX_REASON)
        }
      };
    }
    if (result?.isError === true) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "harness_error",
          reason: bounded(sanitize(result.message ?? "The harness reported an error."), MAX_REASON)
        }
      };
    }
    // Reached last on purpose: an unreconciled checkpoint failure can never be
    // dressed up as a completed execution.
    if (checkpointFailed !== null) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "checkpoint_failed",
          reason: bounded(sanitize(`The work could not be checkpointed: ${checkpointFailed}`), MAX_REASON)
        }
      };
    }
    return { kind: "execution.completed", payload: {} };
  }

  /** A turn that ends before the harness ran still reports a boundary, so a
   *  pending control transfer is never left waiting on a dead execution. */
  function terminate(terminal: TerminalEvent): TurnResult {
    emit({ kind: "boundary.reached", payload: { reason: "turn ended before the harness started" } });
    return { terminal, sessionId: null };
  }
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown failure.";
}
