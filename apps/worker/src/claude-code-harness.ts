import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import type { SessionEvent, SessionEventDraft } from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunFailure } from "./agent-runner.ts";
import {
  LineReader,
  mapStreamLine,
  type StreamContext,
} from "./claude-code-stream.ts";
import { claudeCodeArgs, type ClaudeCodePermissions } from "./claude-code-args.ts";
import type {
  Harness,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessKind,
  HarnessRunRequest,
  HarnessResumeRequest,
  HarnessRunResult,
} from "./harness.ts";

const run = promisify(execFile);

/**
 * Real Claude Code, as one Novus workstream.
 *
 * This is the whole point of the harness boundary. Claude Code is a complete
 * coding harness — its own loop, its own tools, its own context handling, its
 * own permissions, and, critically, its own authentication: driving the
 * installed CLI runs on whatever account that CLI is signed in to. A probe on
 * a subscription machine reports `apiKeySource: "none"`, which is the whole
 * answer to "can I use my Claude plan instead of API credit".
 *
 * What Novus gives up by doing this is stated in `CLAUDE_CODE_CAPABILITIES`
 * rather than hidden: Novus's approval gate is not in the path, tool calls
 * arrive named rather than typed, file changes are observed after the fact
 * instead of proposed for review, and a run can be killed but not paused.
 * Every one of those is a declared `false`, and every surface reads the
 * declaration rather than assuming the built-in loop's promises.
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  // Kill is not pause. There is no suspend-and-resume-with-state.
  pause: "none",
  // Direction is kept and becomes the next run's goal. Not folded into a live
  // turn — that is the built-in loop's promise and this must not borrow it.
  steer: "next-run",
  // "Bash" and "Edit" are Claude Code's names, not Novus's union.
  toolVisibility: "named",
  // Writes land, then Novus diffs. Nothing was proposed for review first.
  fileChanges: "observed",
  approvals: "harness-internal",
  usage: "totals",
  cost: "reported",
  cancel: "kill",
  reportsModel: true,
};

/** How long to wait for the handshake before giving up on the process. */
const INIT_TIMEOUT_MS = 30_000;

export type ClaudeCodeHarnessOptions = {
  eventStore: SessionEventStore;
  /** Where the agent works. Its confinement is this directory. */
  cwd: string;
  permissions: ClaudeCodePermissions;
  /** The binary. Injectable so tests can drive a fake without a real install. */
  command?: string;
};

/**
 * Whether the CLI is installed, and what version.
 *
 * Null rather than a thrown error: a harness that is not installed is a normal
 * fact about a machine, and the setup screen needs to say so calmly rather
 * than treat it as a failure.
 */
export const detectClaudeCode = async (
  command = "claude",
): Promise<{ version: string; command: string } | null> => {
  try {
    const { stdout } = await run(command, ["--version"], { timeout: 10_000 });
    const version = stdout.trim().split(/\s+/)[0];

    return version ? { version, command } : null;
  } catch {
    return null;
  }
};

export class ClaudeCodeHarness implements Harness {
  readonly kind: HarnessKind = "claude-code";
  readonly capabilities: HarnessCapabilities = CLAUDE_CODE_CAPABILITIES;

  private readonly eventStore: SessionEventStore;
  private readonly cwd: string;
  private readonly permissions: ClaudeCodePermissions;
  private readonly command: string;
  private cachedDescriptor: HarnessDescriptor | null = null;
  private child: ChildProcess | null = null;

  constructor(options: ClaudeCodeHarnessOptions) {
    this.eventStore = options.eventStore;
    this.cwd = options.cwd;
    this.permissions = options.permissions;
    this.command = options.command ?? "claude";
  }

  async describe(): Promise<HarnessDescriptor> {
    if (this.cachedDescriptor) {
      return this.cachedDescriptor;
    }

    const found = await detectClaudeCode(this.command);

    this.cachedDescriptor = {
      kind: "claude-code",
      id: "claude-code",
      version: found?.version ?? null,
      command: this.command,
      capabilities: this.capabilities,
    };

    return this.cachedDescriptor;
  }

  /**
   * Claude Code has no resume-by-id that Novus has verified, so this refuses
   * rather than silently starting fresh work under an old run's identity.
   */
  async resume(request: HarnessResumeRequest): Promise<HarnessRunResult> {
    this.eventStore.append({
      sessionId: request.sessionId,
      actorId: request.actorId,
      type: "harness.unsupported",
      payload: {
        runId: request.runId,
        requested: "resume",
        reason:
          "Claude Code runs are not resumable through Novus. Start a new run; the mission keeps the history of this one.",
      },
    });

    throw new AgentRunFailure(
      request.runId,
      new Error("claude-code cannot resume a run"),
    );
  }

  async run(request: HarnessRunRequest): Promise<HarnessRunResult> {
    const descriptor = await this.describe();

    if (descriptor.version === null) {
      // Before `run.started`, deliberately: a machine without the CLI has not
      // begun a run and must not leave a failed one on the log.
      throw new Error(
        `Claude Code is not installed, or \`${this.command}\` is not on the PATH.`,
      );
    }

    const args = claudeCodeArgs(this.permissions, request.model?.model ?? null);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;

    const reader = new LineReader();
    let stderr = "";
    let model: string | null = null;
    // A holder, not a bare `let`: TypeScript's control-flow analysis narrows a
    // variable that is only ever assigned inside a callback to `never` at
    // every read after the await, which is not a real fact about this code.
    const turn: {
      ended: { ok: boolean; message: string | null; costUsd: number | null } | null;
    } = { ended: null };
    let runId = request.runId ?? crypto.randomUUID();
    let started = false;
    const pending: SessionEventDraft[] = [];

    child.stderr?.on("data", (chunk: Buffer) => {
      // Capped: a failing child can produce a lot, and only the tail is ever
      // read by a person.
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });

    const context = (): StreamContext => ({
      sessionId: request.sessionId,
      actorId: request.actorId,
      runId,
    });

    const flush = () => {
      while (pending.length > 0) {
        const draft = pending.shift();

        if (draft) {
          this.eventStore.append(draft);
        }
      }
    };

    const handshake = new Promise<void>((settle, fail) => {
      const timer = setTimeout(() => {
        fail(
          new Error(
            `Claude Code did not report ready within ${INIT_TIMEOUT_MS / 1000}s.`,
          ),
        );
      }, INIT_TIMEOUT_MS);

      const finished = new Promise<void>((done) => {
        child.stdout?.on("data", (chunk: Buffer) => {
          for (const line of reader.push(chunk.toString())) {
            const { events, signals } = mapStreamLine(line, context());

            for (const signal of signals) {
              if (signal.kind === "init") {
                model = signal.model;
                clearTimeout(timer);
                settle();
              }

              if (signal.kind === "turn-ended") {
                turn.ended = signal;
                done();
              }
            }

            // Held until `run.started` exists. An event that names a run the
            // log has never seen is an orphan no projection can place.
            if (started) {
              for (const event of events) {
                this.eventStore.append(event);
              }
            } else {
              pending.push(...events);
            }
          }
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (!turn.ended) {
          fail(
            new Error(
              stderr.trim().length > 0
                ? stderr.trim().slice(-1_000)
                : `Claude Code exited with code ${code ?? "unknown"} before reporting a result.`,
            ),
          );
        }
      });

      void finished;
    });

    // The goal goes in BEFORE the handshake is awaited.
    //
    // Under `--input-format stream-json` the CLI emits `system/init` only once
    // it has had something to work on, so waiting for init before writing is a
    // deadlock: each side is waiting for the other. Found against the real
    // binary — the first fake for this adapter emitted init unprompted and
    // happily concealed it, which is why the fake now reads stdin first.
    child.stdin?.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: request.goal }] },
      })}\n`,
    );

    try {
      await handshake;
    } catch (cause) {
      child.kill("SIGKILL");
      this.child = null;
      // Still before `run.started`: nothing to attribute a failure to.
      throw cause;
    }

    // The handshake carried the real model, so `run.started` states what is
    // actually running rather than a placeholder the router guessed.
    this.eventStore.append({
      sessionId: request.sessionId,
      actorId: request.actorId,
      type: "run.started",
      payload: {
        run: {
          id: runId,
          sessionId: request.sessionId,
          goal: request.goal,
          status: "running",
          startedBy: request.actorId,
          model: { provider: "claude-code", model: model ?? "unknown" },
          harness: descriptor,
          createdAt: new Date().toISOString(),
        },
      },
    });

    started = true;
    flush();

    await new Promise<void>((settle) => {
      const check = setInterval(() => {
        if (turn.ended) {
          clearInterval(check);
          settle();
        }
      }, 50);

      child.on("close", () => {
        clearInterval(check);
        settle();
      });
    });

    this.stop();

    const outcome = turn.ended;

    if (outcome === null) {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.failed",
        payload: {
          runId,
          reason:
            stderr.trim().length > 0
              ? stderr.trim().slice(-1_000)
              : "Claude Code exited without reporting a result.",
        },
      });
    } else if (outcome.ok) {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.completed",
        payload: { runId, summary: outcome.message ?? "Finished." },
      });
    } else {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.failed",
        payload: {
          runId,
          reason: outcome.message ?? stderr.trim().slice(-1_000) ?? "Failed.",
        },
      });
    }

    return {
      runId,
      events: this.eventStore.list(request.sessionId) as SessionEvent[],
    };
  }

  /** Closes the child down, in escalating order. Safe to call twice. */
  stop(): void {
    const child = this.child;

    if (!child) {
      return;
    }

    this.child = null;
    child.stdin?.end();

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 3_000).unref();
    }
  }
}
