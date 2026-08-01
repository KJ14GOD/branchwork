import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import type { SessionEvent, SessionEventDraft } from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunFailure } from "./agent-runner.ts";
import { LineReader } from "./claude-code-stream.ts";
import {
  appendExternalReceipt,
  appendObservedChanges,
  readRepositoryBase,
  unknownExternalUsage,
  type Harness,
  type HarnessCapabilities,
  type HarnessDescriptor,
  type HarnessKind,
  type HarnessRunRequest,
  type HarnessResumeRequest,
  type HarnessRunResult,
} from "./harness.ts";

const run = promisify(execFile);

/**
 * Real Codex, as a second Novus workstream.
 *
 * This file is the test of whether the harness boundary is the right shape.
 * If adding a second, independently-designed harness had meant reworking the
 * Workroom, the rail, the event contract or the mission state, the abstraction
 * would have been wrong. It did not: this is one adapter, one stream mapper
 * and one permission translation, and everything above it already knew how to
 * render a harness whose tool detail Novus does not own.
 *
 * Codex differs from Claude Code in ways that matter and are declared rather
 * than smoothed over. `codex exec --json` is one-shot per turn — there is no
 * persistent stdin session to steer — and its stream reports whole completed
 * items rather than a call and its result separately. So this reports slightly
 * less than the Claude Code adapter does, and says so.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  pause: "none",
  // One-shot per invocation: direction becomes the next run's goal.
  steer: "next-run",
  toolVisibility: "named",
  fileChanges: "observed",
  approvals: "harness-internal",
  usage: "totals",
  // The stream reports tokens, not money.
  cost: "none",
  cancel: "kill",
  reportsModel: false,
};

/**
 * Novus's permissions, as a Codex sandbox mode.
 *
 * Pure and tested for the same reason the Claude Code translation is: this is
 * where a mistake widens what an agent may do. `danger-full-access` is never
 * produced by any input.
 */
export const codexSandbox = (permissions: {
  allowWrites: boolean;
  allowCommands: boolean;
}): string =>
  permissions.allowWrites || permissions.allowCommands
    ? "workspace-write"
    : "read-only";

export const codexArgs = (permissions: {
  allowWrites: boolean;
  allowCommands: boolean;
}): string[] => [
  "exec",
  "--json",
  "--sandbox",
  codexSandbox(permissions),
  // Codex refuses to run outside a trusted directory otherwise. Novus has
  // already confined the run to the selected repository, which is the check
  // that actually matters here.
  "--skip-git-repo-check",
];

/** Installed, and what version. Null is an ordinary fact about a machine. */
export const detectCodex = async (
  command = "codex",
): Promise<{ version: string } | null> => {
  try {
    const { stdout } = await run(command, ["--version"], { timeout: 10_000 });
    const found = /\b\d+\.\d+(?:\.\d+)?\b/.exec(stdout);

    return found ? { version: found[0] } : null;
  } catch {
    return null;
  }
};

/**
 * One parsed Codex line, as Novus events.
 *
 * Pure, so it can be pinned against recorded output. The shapes come from a
 * real `codex exec --json` run:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 *   {"type":"turn.completed","usage":{…}}
 */
/**
 * What a finished Codex turn says it spent.
 *
 * Tokens only — `cost: "none"` is the declaration, and the stream carries no
 * money. Null when the turn's `usage` was absent or unreadable, so an adapter
 * downstream can tell "not reported" from "reported as nothing".
 */
export type CodexTurnUsage = { inputTokens: number; outputTokens: number };

const readCodexUsage = (value: unknown): CodexTurnUsage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];

  return typeof input === "number" && typeof output === "number"
    ? {
        inputTokens: Math.max(0, Math.trunc(input)),
        outputTokens: Math.max(0, Math.trunc(output)),
      }
    : null;
};

export const mapCodexLine = (
  line: unknown,
  context: { sessionId: string; actorId: string; runId: string },
): {
  events: SessionEventDraft[];
  ended: { ok: boolean; usage: CodexTurnUsage | null } | null;
} => {
  const none = { events: [], ended: null };

  if (typeof line !== "object" || line === null || !("type" in line)) {
    return none;
  }

  const event = line as Record<string, unknown>;
  const base = { sessionId: context.sessionId, actorId: context.actorId } as const;

  switch (event["type"]) {
    case "item.completed": {
      const item = event["item"] as Record<string, unknown> | undefined;

      if (!item) {
        return none;
      }

      const kind = String(item["type"] ?? "");
      const text = typeof item["text"] === "string" ? item["text"].trim() : "";

      // The agent talking. The one item type that is prose rather than an act.
      if (kind === "agent_message") {
        return text.length > 0
          ? {
              events: [
                {
                  ...base,
                  type: "harness.output",
                  payload: {
                    runId: context.runId,
                    text: text.slice(0, 2_000),
                    truncated: text.length > 2_000,
                  },
                },
              ],
              ended: null,
            }
          : none;
      }

      // Reasoning is the harness's private thinking. Novus does not record it:
      // it is not an act, it is not evidence, and putting it on a shared
      // timeline would publish something the person did not choose to share.
      if (kind === "reasoning") {
        return none;
      }

      return {
        events: [
          {
            ...base,
            type: "harness.activity",
            payload: {
              runId: context.runId,
              callId: String(item["id"] ?? `${context.runId}-item`),
              name: kind.length > 0 ? kind : "action",
              class:
                kind === "command_execution"
                  ? "execute"
                  : kind === "file_change"
                    ? "edit"
                    : "unknown",
              summary: text.length > 0 ? text.slice(0, 2_000) : null,
              // Codex reports items as already finished, so there is no
              // started/completed pair to join. Saying "completed" is the
              // honest reading of an item the stream calls completed.
              status: "completed",
              claimedPaths: [],
            },
          },
        ],
        ended: null,
      };
    }

    case "turn.completed":
      return {
        events: [],
        ended: { ok: true, usage: readCodexUsage(event["usage"]) },
      };

    case "turn.failed":
    case "error":
      return {
        events: [],
        ended: { ok: false, usage: readCodexUsage(event["usage"]) },
      };

    default:
      return none;
  }
};

export class CodexHarness implements Harness {
  readonly kind: HarnessKind = "codex";
  readonly capabilities: HarnessCapabilities = CODEX_CAPABILITIES;

  private readonly eventStore: SessionEventStore;
  private readonly cwd: string;
  private readonly permissions: { allowWrites: boolean; allowCommands: boolean };
  private readonly command: string;
  private cached: HarnessDescriptor | null = null;
  private child: ChildProcess | null = null;
  /** Whether a human asked for this run to stop. See the Claude Code adapter. */
  private cancelled = false;

  constructor(options: {
    eventStore: SessionEventStore;
    cwd: string;
    permissions: { allowWrites: boolean; allowCommands: boolean };
    command?: string;
  }) {
    this.eventStore = options.eventStore;
    this.cwd = options.cwd;
    this.permissions = options.permissions;
    this.command = options.command ?? "codex";
  }

  async describe(): Promise<HarnessDescriptor> {
    if (this.cached) {
      return this.cached;
    }

    const found = await detectCodex(this.command);

    this.cached = {
      kind: "codex",
      id: "codex",
      version: found?.version ?? null,
      command: this.command,
      capabilities: this.capabilities,
    };

    return this.cached;
  }

  async resume(request: HarnessResumeRequest): Promise<HarnessRunResult> {
    this.eventStore.append({
      sessionId: request.sessionId,
      actorId: request.actorId,
      type: "harness.unsupported",
      payload: {
        runId: request.runId,
        requested: "resume",
        reason:
          "Codex runs one turn per invocation and cannot be resumed. Start a new run; the mission keeps this one's history.",
      },
    });

    throw new AgentRunFailure(request.runId, new Error("codex cannot resume"));
  }

  async run(request: HarnessRunRequest): Promise<HarnessRunResult> {
    // Before the first await, so the reset cannot wipe a `stop()` that arrived
    // during the version probe or the base read. See the Claude Code adapter.
    this.cancelled = false;

    const descriptor = await this.describe();

    if (descriptor.version === null) {
      throw new Error(
        `Codex is not installed, or \`${this.command}\` is not on the PATH.`,
      );
    }

    const runId = request.runId ?? crypto.randomUUID();
    // Before the run exists in the log, so it describes the tree this turn
    // opened on rather than the one it leaves behind.
    const base = await readRepositoryBase(this.cwd);

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
          // Codex chooses its own model and the stream does not name it, which
          // is exactly what `reportsModel: false` declares. Recorded as the
          // harness rather than invented as a model id.
          model: { provider: "codex", model: "codex" },
          harness: descriptor,
          createdAt: new Date().toISOString(),
        },
      },
    });

    const child = spawn(
      this.command,
      [...codexArgs(this.permissions), request.goal],
      { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    this.child = child;

    // A cancellation that landed between `run.started` and the spawn above
    // has nothing to signal yet. Re-asking here is what stops it arriving as
    // a request against a process that did not exist when it was made.
    if (this.cancelled) {
      this.closeChild();
    }

    const reader = new LineReader();
    const state: { ended: { ok: boolean; usage: CodexTurnUsage | null } | null } = {
      ended: null,
    };
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of reader.push(chunk.toString())) {
        const { events, ended } = mapCodexLine(line, {
          sessionId: request.sessionId,
          actorId: request.actorId,
          runId,
        });

        for (const event of events) {
          this.eventStore.append(event);
        }

        if (ended) {
          state.ended = ended;
        }
      }
    });

    const code = await new Promise<number | null>((settle) => {
      child.on("close", settle);
    });

    this.child = null;

    // Codex proposed nothing and Novus approved nothing, so the tree is the
    // only witness to what this turn did. Same ordering as the Claude Code
    // adapter: observation, then the terminal event, then the receipt that
    // reads both back.
    await appendObservedChanges({
      eventStore: this.eventStore,
      sessionId: request.sessionId,
      actorId: request.actorId,
      runId,
      cwd: this.cwd,
      baseRevision: base.revision,
      // False. Codex runs in the session's own tree, so this diff is what
      // differs — not what the agent did. See the Claude Code adapter.
      attributable: false,
    });

    if (state.ended?.ok) {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.completed",
        payload: { runId, summary: "Codex finished the turn." },
      });
    } else if (state.ended === null && this.cancelled) {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.cancelled",
        payload: { runId },
      });
    } else {
      this.eventStore.append({
        sessionId: request.sessionId,
        actorId: request.actorId,
        type: "run.failed",
        payload: {
          runId,
          reason:
            stderr.trim().length > 0
              ? stderr.trim().slice(-1_000)
              : `Codex exited with code ${code ?? "unknown"} without completing the turn.`,
        },
      });
    }

    appendExternalReceipt({
      eventStore: this.eventStore,
      sessionId: request.sessionId,
      actorId: request.actorId,
      runId,
      base,
      usage: {
        ...unknownExternalUsage(),
        // Tokens, and only tokens. `cost: "none"` means costUsd stays null
        // however many tokens the turn reports — Novus has no rate card for a
        // model Codex never names, and a dollar figure invented from one it
        // guessed at would be worse than admitting it does not know.
        inputTokens: state.ended?.usage?.inputTokens ?? 0,
        outputTokens: state.ended?.usage?.outputTokens ?? 0,
      },
    });

    return {
      runId,
      events: this.eventStore.list(request.sessionId) as SessionEvent[],
    };
  }

  /** Asks this turn to stop. See `ClaudeCodeHarness.stop`. */
  stop(): void {
    this.cancelled = true;
    this.closeChild();
  }

  /**
   * Closes the child down, in escalating order. Safe to call twice.
   *
   * `codex exec` reads nothing from stdin — it is one-shot per invocation and
   * was spawned with stdin ignored — so unlike the Claude Code adapter there
   * is no stream to end first, only a signal to send.
   */
  private closeChild(): void {
    const child = this.child;

    if (!child) {
      return;
    }

    this.child = null;

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
