import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

  constructor(
    eventStore: InMemorySessionEventStore,
    router: ModelRouter,
    adapters: readonly ModelAdapter[],
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
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

    const allowWrites = options.allowWrites ?? false;
    const allowCommands = options.allowCommands ?? false;
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
