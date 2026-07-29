import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ToolCall } from "@novus/contracts";
import type { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import type { ModelAdapter, ModelRouter } from "./model.ts";
import {
  AllowListApprovalGate,
  DenyAllApprovalGate,
  type ApprovalGate,
} from "./policy.ts";
import {
  ApplyPatchTool,
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
): Promise<{ revision: string | null; dirty: boolean }> => {
  try {
    const [head, status] = await Promise.all([
      run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }),
      run("git", ["status", "--porcelain"], { cwd: repositoryPath }),
    ]);

    return {
      revision: head.stdout.trim() || null,
      dirty: status.stdout.trim().length > 0,
    };
  } catch {
    return { revision: null, dirty: false };
  }
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
  private readonly eventStore: InMemorySessionEventStore;
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
    eventStore: InMemorySessionEventStore,
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
        ],
        buildApprovalGate(allowWrites, allowCommands),
        () => readRepositoryBase(repositoryPath),
      ),
    };

    this.sessions.set(session.id, session);

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
        console.error(`turn failed: ${(error as Error).message}`);
      });

    return session.queue as Promise<void>;
  }
}
