import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ToolCall } from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunFailure, AgentRunner } from "./agent-runner.ts";
import {
  WorktreeManager,
  type ForkHandle,
} from "./worktree-manager.ts";
import type { ModelAdapter, ModelRouter } from "./model.ts";
import {
  AllowListApprovalGate,
  DenyAllApprovalGate,
  type ApprovalGate,
} from "./policy.ts";
import {
  ApplyPatchTool,
  GitDiffTool,
  GitStatusTool,
  ListDirectoryTool,
  ProposePatchTool,
  ReadFileTool,
  RunCommandTool,
  RunTestsTool,
  SearchRepositoryTool,
} from "./tools.ts";

const run = promisify(execFile);

/**
 * The commit a run starts from, and whether the tree already differs from it.
 *
 * Read per run rather than per session, because a second turn opens on top of
 * the first turn's writes. Null revision when the directory is not a Git
 * checkout, which is allowed — the repository still works, the receipt just
 * cannot cite a base. A dirty tree is reported rather than hidden: the base is
 * then that commit *plus* changes nobody recorded, and a reviewer has to be
 * able to tell those apart.
 */
const readRepositoryBase = async (
  repositoryPath: string,
): Promise<{ revision: string | null; dirty: boolean | null }> => {
  // Bounded and separately caught. This runs after run.started is emitted, in
  // the critical path of every run, so a git call that stalls on a large repo
  // or a network filesystem would leave the UI showing a run that never
  // continues — and a rejection here would end a run that had already begun.
  const git = (args: string[]) =>
    run("git", args, {
      cwd: repositoryPath,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });

  const revision = await git(["rev-parse", "HEAD"])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);

  // Null, not false. A failed check reported as clean would make the maximally
  // dirty repository — the one whose status output was too large to read — look
  // like the tidiest one.
  const dirty = await git(["status", "--porcelain"])
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch(() => null);

  return { revision, dirty };
};

export type HostDefaults = {
  allowWrites: boolean;
  allowCommands: boolean;
};

export type SessionOptions = {
  repositoryPath: string;
  allowWrites?: boolean | undefined;
  allowCommands?: boolean | undefined;
};

export type Session = {
  id: string;
  repositoryPath: string;
  /**
   * Cuts checkpoints and forks for this session's repository.
   *
   * One per session rather than one per worker, because a fork's isolation is
   * defined against the repository it came from and each session has its own.
   */
  worktrees: WorktreeManager;
  /** Forks made from this session, by their run id. */
  forks: Map<string, ForkHandle>;
  allowWrites: boolean;
  allowCommands: boolean;
  runner: AgentRunner;
  createdAt: string;
  /** Serialises turns so a second submission cannot interleave with a run. */
  queue: Promise<unknown>;
};

/**
 * Command execution is opted into separately from writing.
 *
 * Approving `apply_patch` means approving a diff that was reviewable before it
 * was applied. Approving `run_command` means approving arbitrary code, which
 * can read any file the host user can — including the `.env` that path
 * confinement keeps away from `read_file`. Those are different decisions, so
 * folding commands into NOVUS_ALLOW_WRITES would silently widen a permission
 * someone already granted for a much narrower reason.
 */
const buildApprovalGate = (
  allowWrites: boolean,
  allowCommands: boolean,
): ApprovalGate => {
  const allowed: ToolCall["name"][] = [];

  if (allowWrites) {
    allowed.push("apply_patch");
  }

  if (allowCommands) {
    allowed.push("run_command", "run_tests");
  }

  return allowed.length > 0
    ? new AllowListApprovalGate(allowed, "host")
    : new DenyAllApprovalGate();
};

/**
 * Owns one agent session per selected repository.
 *
 * Tools are constructed per session rather than once at start-up, so the host
 * can point Novus at any repository without restarting the worker. Each
 * session's tools are bound to that repository and cannot reach another.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly created = new Set<(session: Session) => void>();
  private readonly eventStore: SessionEventStore;
  private readonly router: ModelRouter;
  private readonly adapters: readonly ModelAdapter[];
  /**
   * What this host permits when a request does not say.
   *
   * Both permissions work the same way on purpose. Before, writes came only
   * from the client's checkbox and commands came only from the environment,
   * so setting NOVUS_ALLOW_WRITES=1 and then seeing an unchecked box was a
   * reasonable thing to be confused by.
   */
  private readonly defaults: HostDefaults;

  constructor(
    eventStore: SessionEventStore,
    router: ModelRouter,
    adapters: readonly ModelAdapter[],
    defaults: HostDefaults = { allowWrites: false, allowCommands: false },
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.defaults = defaults;
  }

  hostDefaults(): HostDefaults {
    return this.defaults;
  }

  /** Called with each new session, so a publisher can attach to one it could not name. */
  onCreated(listener: (session: Session) => void): () => void {
    this.created.add(listener);

    return () => {
      this.created.delete(listener);
    };
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async create(options: SessionOptions): Promise<Session> {
    const requested = resolve(options.repositoryPath);

    let repositoryPath: string;

    try {
      repositoryPath = await realpath(requested);
    } catch {
      throw new Error(`No such directory: ${requested}`);
    }

    if (!(await stat(repositoryPath)).isDirectory()) {
      throw new Error(`Not a directory: ${repositoryPath}`);
    }

    const allowWrites = options.allowWrites ?? this.defaults.allowWrites;
    const allowCommands = options.allowCommands ?? this.defaults.allowCommands;
    const proposePatchTool = new ProposePatchTool(repositoryPath);
    const session: Session = {
      id: crypto.randomUUID(),
      repositoryPath,
      worktrees: new WorktreeManager(repositoryPath),
      forks: new Map(),
      allowWrites,
      allowCommands,
      createdAt: new Date().toISOString(),
      queue: Promise.resolve(),
      runner: new AgentRunner(
        this.eventStore,
        this.router,
        this.adapters,
        [
          new SearchRepositoryTool(repositoryPath),
          new ReadFileTool(repositoryPath),
          proposePatchTool,
          new ApplyPatchTool(repositoryPath, proposePatchTool),
          new RunCommandTool(repositoryPath),
          new RunTestsTool(repositoryPath),
          new ListDirectoryTool(repositoryPath),
          new GitStatusTool(repositoryPath),
          new GitDiffTool(repositoryPath),
        ],
        buildApprovalGate(allowWrites, allowCommands),
        () => readRepositoryBase(repositoryPath),
      ),
    };

    this.sessions.set(session.id, session);

    // Announced rather than returned only, because a session's id is a runtime
    // UUID: anything that has to be told which session exists — the relay
    // publisher, most obviously — cannot be configured with it in advance.
    for (const listener of this.created) {
      listener(session);
    }

    return session;
  }

  /**
   * Runs one turn. Turns within a session are serialised: a submission made
   * while a run is in flight waits rather than racing it.
   */
  submitTurn(session: Session, goal: string): Promise<void> {
    session.queue = session.queue
      .then(() =>
        session.runner.run({
          sessionId: session.id,
          actorId: "agent-1",
          goal,
        }),
      )
      .catch((error: unknown) => {
        this.reportTurnFailure(session, error);
      });

    return session.queue as Promise<void>;
  }

  /**
   * Tells the session about a turn that ended by throwing.
   *
   * The submitting client is answered the moment the turn is queued, so the
   * event log is the only channel a later failure has. Reporting it on stderr
   * alone left a run that had emitted `run.started` and then simply stopped —
   * from the timeline indistinguishable from one still thinking, and the host's
   * console is not somewhere a reviewer of the session will look.
   *
   * The append is attempted, not assumed. Persistence made a thrown `append`
   * possible for reasons that are about the machine rather than the draft — a
   * full disk, a write lock that outlasted the busy timeout — and those are
   * exactly the conditions under which the append recording the failure fails
   * too. When that happens there is nowhere left to say it but stderr, and it
   * gets said as its own line rather than swallowed a second time.
   */
  private reportTurnFailure(session: Session, error: unknown): void {
    const message =
      (error instanceof Error ? error.message : String(error)) ||
      "The turn ended without a message.";

    console.error(`turn failed: ${message}`);

    // Not an AgentRunFailure means the run never reached the log: no adapter
    // was configured for the selection, or the run draft itself was refused.
    // There is nothing in the session claiming to be in progress, so there is
    // nothing to correct — inventing a run id to fail would be worse.
    if (!(error instanceof AgentRunFailure)) {
      return;
    }

    try {
      this.eventStore.append({
        sessionId: session.id,
        actorId: "agent-1",
        type: "run.failed",
        payload: { runId: error.runId, reason: message },
      });
    } catch (reportError) {
      const reason =
        reportError instanceof Error
          ? reportError.message
          : String(reportError);

      console.error(
        `run ${error.runId} failed and the log could not be told: ${reason}`,
      );
    }
  }
}
