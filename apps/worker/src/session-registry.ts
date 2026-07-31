import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { Fork, ToolCall } from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import { AgentRunFailure, AgentRunner } from "./agent-runner.ts";
import {
  WorktreeManager,
  collectableForks,
  type ForkDisposition,
  type ForkHandle,
} from "./worktree-manager.ts";
import { DEFAULT_RUN_BUDGET, type RunBudget } from "./budget.ts";
import type { ModelSelection } from "@novus/contracts";
import type { ModelAdapter, ModelRouter } from "./model.ts";
import { DEFAULT_MODEL_PRICING, type PricingTable } from "./pricing.ts";
import { projectSession } from "./projection.ts";
import {
  AllowListApprovalGate,
  DenyAllApprovalGate,
  type ApprovalGate,
} from "./policy.ts";
import {
  ApplyPatchTool,
  GitBranchesTool,
  GitDiffTool,
  GitStatusTool,
  ListDirectoryTool,
  ListProviderModelsTool,
  ProposeDeletionTool,
  ProposeNewFileTool,
  ProposePatchTool,
  ReadFileTool,
  RunBuildTool,
  RunCommandTool,
  RunTestsTool,
  SearchRepositoryTool,
  type AgentTool,
} from "./tools.ts";
import { RunDiagnosticsTool } from "./diagnostics.ts";
import { DevServerTool } from "./dev-server.ts";

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

/**
 * Which of Novus's features this directory supports.
 *
 * Asked once when a session opens. Distinguishing "not a repository" from
 * "a repository with nothing committed" matters because the remedies differ and
 * neither is something Novus should quietly do on somebody's behalf.
 */
const readRepositoryState = async (
  repositoryPath: string,
): Promise<"ready" | "no-commits" | "absent"> => {
  const git = (args: string[]) =>
    run("git", args, { cwd: repositoryPath, timeout: 5_000 });

  const inside = await git(["rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false);

  if (!inside) {
    return "absent";
  }

  // A repository with no HEAD has nothing to check out, so a fork has no base.
  return git(["rev-parse", "--verify", "--quiet", "HEAD"])
    .then(({ stdout }) => (stdout.trim() === "" ? "no-commits" : "ready"))
    .catch(() => "no-commits");
};

export type HostDefaults = {
  allowWrites: boolean;
  allowCommands: boolean;
};

export type SessionOptions = {
  repositoryPath: string;
  allowWrites?: boolean | undefined;
  allowCommands?: boolean | undefined;
  /**
   * Reuse an id the log already knows, so its timeline comes back.
   *
   * Permissions are not taken from the old session — a resumed one gets the
   * host's current defaults, because a session recorded with writes allowed
   * should not silently regain them a week later.
   */
  resume?: string | undefined;
};

export type Session = {
  id: string;
  repositoryPath: string;
  /** Read when the session opened, so the client can say what will not work. */
  repositoryState: "ready" | "no-commits" | "absent";
  /**
   * Cuts checkpoints and forks for this session's repository.
   *
   * One per session rather than one per worker, because a fork's isolation is
   * defined against the repository it came from and each session has its own.
   * Also the only holder of live fork handles: the log is where forks are
   * *remembered* (`fork.created`), the manager is where their checkouts are
   * *operable*, and a second map beside it held the same handles a second
   * time until it was removed.
   */
  worktrees: WorktreeManager;
  /**
   * One promise chain per forked attempt, by run id.
   *
   * Deliberately not the session's own `queue`: concurrent attempts are the
   * point of forking, so two forks must be able to run beside each other and
   * beside the parent. What still has to be serialised is one attempt with
   * itself — a resume racing another resume of the same fork would run two
   * loops under one run id — and that is all this map does.
   */
  forkTurns: Map<string, Promise<unknown>>;
  /**
   * One runner per attempt, kept for the attempt's life, by run id.
   *
   * The parent session holds a single `runner` for its whole life; a fork
   * used to get a freshly built one on every call, which quietly meant a
   * fresh `ProposePatchTool` too. Proposals live in that tool's memory, so
   * an attempt that proposed a patch, paused, and resumed came back to a
   * runner that had never heard of its own proposal: `apply_patch` failed
   * with "call propose_patch first", the run completed, and the attempt
   * showed zero files changed. Caching here is what makes an attempt's
   * pause/resume behave the same way the parent's already does.
   */
  forkRunners: Map<string, AgentRunner>;
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
    // Every dangerous-class tool this flag stands for, by name. This list and
    // TOOL_CLASSES in policy.ts have to move together: a tool classified
    // dangerous but missing here is not denied loudly — it is denied on every
    // call of every session with commands enabled, which reads as a broken
    // tool rather than a policy decision.
    allowed.push(
      "run_command",
      "run_tests",
      "run_build",
      "run_diagnostics",
      "dev_server",
    );
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
  /** Rates and bounds handed to every runner this registry builds. */
  private readonly pricing: PricingTable;
  private readonly budget: RunBudget;

  constructor(
    eventStore: SessionEventStore,
    router: ModelRouter,
    adapters: readonly ModelAdapter[],
    defaults: HostDefaults = { allowWrites: false, allowCommands: false },
    economics: { pricing?: PricingTable; budget?: RunBudget } = {},
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.defaults = defaults;
    this.pricing = economics.pricing ?? DEFAULT_MODEL_PRICING;
    this.budget = economics.budget ?? DEFAULT_RUN_BUDGET;
  }

  hostDefaults(): HostDefaults {
    return this.defaults;
  }

  /**
   * Every model this worker can actually run — the adapters that exist, not
   * the models that exist. What the turns route validates an explicit choice
   * against, and what /health reports so a picker can grey out the rest
   * instead of offering a model that would 400.
   */
  models(): ModelSelection[] {
    return this.adapters.map((adapter) => adapter.selection);
  }

  /**
   * Every session the log remembers, newest activity first.
   *
   * Read from the durable log rather than from this registry, which only holds
   * what the current process opened. The point is to reach a session from
   * *before* the restart.
   */
  remembered(): {
    id: string;
    repositoryPath: string;
    createdAt: string;
    events: number;
    lastActivityAt: string;
  }[] {
    const remembered = [];

    for (const sessionId of this.eventStore.sessions()) {
      const events = this.eventStore.readable(sessionId).events;
      const created = events.find((event) => event.type === "session.created");

      if (created?.type !== "session.created") {
        // A session with no creation event predates this being recorded. Its
        // runs are still in the log; there is no repository path to reopen it
        // with, so it is not offered rather than offered broken.
        continue;
      }

      remembered.push({
        id: sessionId,
        repositoryPath: created.payload.session.repositoryPath,
        createdAt: created.payload.session.createdAt,
        events: events.length,
        lastActivityAt: events.at(-1)?.occurredAt ?? created.occurredAt,
      });
    }

    return remembered.sort((first, second) =>
      second.lastActivityAt.localeCompare(first.lastActivityAt),
    );
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

  /**
   * The full tool set, bound to one directory.
   *
   * Used by the session's own runner against the selected repository, and by
   * every forked attempt against its worktree. That the list is identical is
   * the point: nothing about a fork's capabilities differs from its parent's
   * except which tree the tools are confined to — isolation comes from the
   * binding, not from a different tool set.
   */
  private buildTools(repositoryPath: string): AgentTool[] {
    const proposePatchTool = new ProposePatchTool(repositoryPath);

    // Registered whether or not the adapter can answer, because the tool is
    // *described* to the model unconditionally — TOOL_DESCRIPTIONS is one
    // static list every adapter shares. A described tool the runner cannot
    // find does not fail the call, it fails the run ("No tool is configured
    // for..."), so an adapter without listModels used to turn this one
    // request into a dead session. Now it is an ordinary tool error the
    // model reads and moves on from.
    const selection = this.router.select({ goal: "" }).selection;
    const adapter = this.adapters.find(
      (candidate) =>
        candidate.selection.provider === selection.provider &&
        candidate.selection.model === selection.model,
    );
    const listModels =
      adapter?.listModels !== undefined
        ? () => adapter.listModels!()
        : async (): Promise<string[]> => {
            throw new Error(
              `The ${selection.provider} adapter does not expose a model list, so this question cannot be answered from here.`,
            );
          };

    return [
      new SearchRepositoryTool(repositoryPath),
      new ReadFileTool(repositoryPath),
      proposePatchTool,
      // All three propose tools feed one store — proposePatchTool — so
      // apply_patch resolves any patchId from one place regardless of
      // which kind of change it names.
      new ProposeNewFileTool(repositoryPath, proposePatchTool),
      new ProposeDeletionTool(repositoryPath, proposePatchTool),
      new ApplyPatchTool(repositoryPath, proposePatchTool),
      new RunCommandTool(repositoryPath),
      new RunTestsTool(repositoryPath),
      new RunBuildTool(repositoryPath),
      new RunDiagnosticsTool(repositoryPath),
      new DevServerTool(repositoryPath),
      new ListDirectoryTool(repositoryPath),
      new GitStatusTool(repositoryPath),
      new GitDiffTool(repositoryPath),
      new GitBranchesTool(repositoryPath),
      new ListProviderModelsTool(selection.provider, listModels),
    ];
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
    const repositoryState = await readRepositoryState(repositoryPath);

    // Captured before the map is written, because reconciliation below depends
    // on the answer: a session this process already has open may have loops
    // live under its run ids right now, and those must never be reconciled.
    const alreadyOpenHere =
      options.resume !== undefined && this.sessions.has(options.resume);

    const session: Session = {
      id: options.resume ?? crypto.randomUUID(),
      repositoryPath,
      repositoryState,
      worktrees: new WorktreeManager(repositoryPath),
      forkTurns: new Map(),
      forkRunners: new Map(),
      allowWrites,
      allowCommands,
      createdAt: new Date().toISOString(),
      queue: Promise.resolve(),
      runner: new AgentRunner(
        this.eventStore,
        this.router,
        this.adapters,
        this.buildTools(repositoryPath),
        buildApprovalGate(allowWrites, allowCommands),
        () => readRepositoryBase(repositoryPath),
        this.budget,
        undefined,
        this.pricing,
      ),
    };

    // Recorded, because until now nothing ever wrote this event: the contract
    // defined it, the renderers drew it, and no code appended one — so the log
    // held runs belonging to sessions it had no record of, and there was nothing
    // to restore a session *from*.
    this.eventStore.append({
      sessionId: session.id,
      actorId: "host",
      type: "session.created",
      payload: {
        session: {
          id: session.id,
          repositoryPath: session.repositoryPath,
          goal: null,
          status: "active",
          createdAt: session.createdAt,
        },
      },
    });

    this.sessions.set(session.id, session);

    // Forks the log remembers are re-attached to their checkouts on disk.
    // `fork.created` is durable; the worktree manager's handles are not — so
    // without this, a restarted worker could still list an attempt on the
    // compare screen (that reads the log) but never apply its decision or
    // resume its paused run, because the handle to its worktree lived only in
    // the process that forked it. A fresh session's log has nothing to adopt
    // and this loop is a no-op.
    // Attempts an earlier open already reclaimed. Their checkouts are meant to
    // be gone, so failing to re-attach one is the expected outcome rather than
    // something to warn a host about on every open for the rest of the
    // session's life. Everything else that fails to adopt still gets said.
    const alreadyReclaimed = new Set(
      this.collectableFor(session.id).map((entry) => entry.runId),
    );

    for (const event of this.eventStore.list(session.id)) {
      if (event.type !== "fork.created") {
        continue;
      }

      try {
        await session.worktrees.adopt(event.payload.fork);
      } catch (error) {
        // Not fatal to the resume: the attempt's evidence is still in the
        // log even when its checkout is gone, and a session must not become
        // unopenable because one fork's directory was deleted. Said on the
        // host, and again — with the same words — by whatever operation
        // actually needed the missing worktree.
        if (alreadyReclaimed.has(event.payload.fork.runId)) {
          continue;
        }

        console.warn(
          `fork ${event.payload.fork.runId} could not be re-attached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!alreadyOpenHere) {
      this.reconcileInterruptedRuns(session);
      await this.reclaimResolvedForks(session);
    }

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
   *
   * `model` is an explicit human choice for this turn; absent means the
   * router decides. Passed through untouched — precedence lives in the
   * runner, in one place.
   */
  submitTurn(
    session: Session,
    goal: string,
    model?: ModelSelection,
  ): Promise<void> {
    session.queue = session.queue
      .then(() =>
        session.runner.run({
          sessionId: session.id,
          actorId: "agent-1",
          goal,
          ...(model ? { model } : {}),
        }),
      )
      .catch((error: unknown) => {
        this.reportTurnFailure(session, error);
      });

    return session.queue as Promise<void>;
  }

  /**
   * Continues a run this session previously paused. Serialised through the
   * same queue as `submitTurn`, for the same reason: a resume racing a fresh
   * turn on the same session is exactly the interleaving that queue exists
   * to prevent.
   *
   * A forked attempt's run takes the fork path instead: `session.runner` is
   * bound to the parent's repository and the parent's approval gate, so
   * resuming a fork's run through it would execute the attempt's remaining
   * turns in the parent's working tree — the exact tree the fork exists to
   * keep it out of.
   */
  resumeTurn(session: Session, runId: string): Promise<void> {
    const fork = this.forkRecord(session.id, runId);

    if (fork) {
      return this.resumeForkRun(session, fork);
    }

    session.queue = session.queue
      .then(() =>
        session.runner.resume({
          sessionId: session.id,
          actorId: "agent-1",
          runId,
        }),
      )
      .catch((error: unknown) => {
        this.reportTurnFailure(session, error);
      });

    return session.queue as Promise<void>;
  }

  /**
   * Executes a forked attempt's goal inside its own worktree.
   *
   * This is the half of forking that did not exist: a fork was a checkout
   * with a label — created, recorded, and then nothing ever ran in it, so
   * the compare screen compared silence. The attempt gets its own runner,
   * with the same tool set as the parent bound to the fork's worktree, and
   * its run starts under the fork's preassigned run id so its events land in
   * the parent session's log where the timeline, /compare, and /files
   * already look.
   *
   * Accepted, not completed — same contract as a turn: the returned promise
   * settles when the attempt's run ends, and callers that answer a client
   * first are expected to drop it.
   */
  startForkRun(session: Session, handle: ForkHandle, goal: string): Promise<void> {
    return this.queueForkTurn(session, handle.fork.runId, () =>
      this.buildForkRunner(session, handle).run({
        sessionId: session.id,
        actorId: "agent-1",
        goal,
        runId: handle.fork.runId,
      }),
    );
  }

  /**
   * Continues a forked attempt's paused run, in the fork's own worktree.
   *
   * The handle is looked up rather than carried, because after a restart the
   * only thing that survives is the log: `create` re-adopts every recorded
   * fork at session open, and a fork it could not re-attach (its directory
   * was deleted) fails here with the reason — recorded as the run's failure,
   * since a paused run whose checkout is gone can never continue and leaving
   * it "paused" forever would be a lie the timeline repeats indefinitely.
   */
  private resumeForkRun(session: Session, fork: Fork): Promise<void> {
    return this.queueForkTurn(session, fork.runId, async () => {
      const handle =
        session.worktrees.get(fork.runId) ?? (await session.worktrees.adopt(fork));

      return this.buildForkRunner(session, handle).resume({
        sessionId: session.id,
        actorId: "agent-1",
        runId: fork.runId,
      });
    });
  }

  /**
   * One runner per attempt, bound to the attempt's worktree.
   *
   * The approval gate is the security boundary here, and it is derived from
   * two things intersected — the parent session's permissions as they stand
   * now, and the tool policy the checkpoint recorded when the fork was cut —
   * so an attempt can never hold an authority its parent session does not
   * currently hold, and never one the run it continued from was not granted.
   * Never `this.defaults`: a host whose environment permits writes does not
   * thereby permit them for a session that was opened with them off, and the
   * checkpoint schema itself says the same ("the parent's permissions, not
   * the host's defaults").
   */
  private buildForkRunner(session: Session, handle: ForkHandle): AgentRunner {
    // Built once per attempt and kept. Rebuilding on every call also rebuilt
    // the attempt's tools, and `ProposePatchTool` holds its proposals in
    // memory — so a fork that proposed, paused, and resumed lost the patch it
    // was about to apply. See `forkRunners` on Session for the full account.
    const existing = session.forkRunners.get(handle.fork.runId);

    if (existing) {
      return existing;
    }

    const recorded = this.checkpointToolPolicy(
      session.id,
      handle.fork.checkpointId,
    );

    const runner = new AgentRunner(
      this.eventStore,
      this.router,
      this.adapters,
      this.buildTools(handle.worktreePath),
      buildApprovalGate(
        session.allowWrites && recorded.allowWrites,
        session.allowCommands && recorded.allowCommands,
      ),
      () => readRepositoryBase(handle.worktreePath),
      // The host's budget and pricing, not the defaults. These two arguments
      // were simply absent, so every forked attempt fell back to
      // DEFAULT_RUN_BUDGET — whose costUsd is null, meaning uncapped — and a
      // host who set NOVUS_COST_BUDGET_USD had a ceiling that bound their own
      // runs and none of their attempts. Attempts are the thing you deliberately
      // start several of at once, so that was the ceiling failing exactly where
      // spend multiplies. Pricing goes with it: an unpriced model makes usage
      // costUsd null, and a null spend under a set ceiling is refused rather
      // than silently unenforced.
      this.budget,
      undefined,
      this.pricing,
    );

    session.forkRunners.set(handle.fork.runId, runner);

    return runner;
  }

  /**
   * The tool policy a checkpoint recorded, from the log.
   *
   * Missing — a log written before checkpoints carried policy, or a
   * checkpoint event that never landed — denies rather than allows, the same
   * convention as the missing approval gate it feeds.
   */
  private checkpointToolPolicy(
    sessionId: string,
    checkpointId: string,
  ): { allowWrites: boolean; allowCommands: boolean } {
    const event = this.eventStore
      .list(sessionId)
      .find(
        (candidate) =>
          candidate.type === "checkpoint.created" &&
          candidate.payload.checkpoint.id === checkpointId,
      );

    return event?.type === "checkpoint.created"
      ? event.payload.checkpoint.toolPolicy
      : { allowWrites: false, allowCommands: false };
  }

  /** The fork this run id belongs to, from the log, or null for a session's own run. */
  private forkRecord(sessionId: string, runId: string): Fork | null {
    const event = this.eventStore
      .list(sessionId)
      .find(
        (candidate) =>
          candidate.type === "fork.created" &&
          candidate.payload.fork.runId === runId,
      );

    return event?.type === "fork.created" ? event.payload.fork : null;
  }

  /**
   * Chains work onto one attempt's own queue.
   *
   * Parallel to `submitTurn`'s use of `session.queue`, per fork: attempts
   * run concurrently with each other and with the parent, but one attempt
   * is serialised with itself, so a resume racing another resume of the
   * same fork queues instead of running two loops under one run id.
   */
  private queueForkTurn(
    session: Session,
    runId: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    const next = (session.forkTurns.get(runId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        this.reportForkFailure(session, runId, error);
      });

    session.forkTurns.set(runId, next);

    return next as Promise<void>;
  }

  /**
   * The reclamation policy applied to one session's log. Reads only.
   *
   * Split out because two callers need the same answer for different reasons:
   * the sweep, to delete, and the adoption loop, to know that a checkout it
   * cannot find was supposed to be gone.
   */
  private collectableFor(sessionId: string): ForkDisposition[] {
    const events = this.eventStore.list(sessionId);

    if (events.length === 0) {
      return [];
    }

    const forks: { fork: Fork; sequence: number }[] = [];
    const decisions: { sequence: number; runId: string; applied: boolean }[] = [];

    for (const event of events) {
      if (event.type === "fork.created") {
        forks.push({ fork: event.payload.fork, sequence: event.sequence });
      }

      if (event.type === "decision.recorded") {
        decisions.push({
          sequence: event.sequence,
          runId: event.payload.runId,
          applied: event.payload.outcome.applied,
        });
      }
    }

    if (forks.length === 0 || decisions.length === 0) {
      return [];
    }

    const runs = new Map(
      projectSession(sessionId, events).runs.map((run) => [run.runId, run]),
    );

    return collectableForks({
      forks,
      statusOf: (runId) => runs.get(runId)?.status ?? null,
      decisions,
    });
  }

  /**
   * Gives back the disk that decided attempts are still holding.
   *
   * Nothing removed a fork's checkout, ever. Each one is a full second copy of
   * the working tree plus a branch plus a record under `.git/worktrees`, so a
   * team forking a few times a day for a week ends up with a repository whose
   * sibling directory is larger than the repository and a `git worktree list`
   * nobody can read.
   *
   * Run at session open — the same seam that adopts forks and reconciles runs
   * — because that is where the log has just been read and where the host is
   * deliberately picking up this repository. It is a sweep rather than an
   * event handler on purpose: a sweep also collects what an earlier crash,
   * an earlier version, or a decision recorded by some other process left
   * behind, and it converges no matter how many of those it missed.
   *
   * The policy is `collectableForks`, and it is conservative on purpose — an
   * attempt's work exists only in its worktree, so this deletes exactly the
   * attempts whose comparison was decided and applied, and nothing else.
   * Ordered after reconciliation so an attempt the worker died inside is
   * already settled rather than looking live to the sweep.
   */
  private async reclaimResolvedForks(session: Session): Promise<void> {
    // Only the ones this manager actually holds a handle for. A fork an
    // earlier open already reclaimed is still collectable *by the policy* —
    // the log does not forget that its comparison was decided — but there is
    // nothing left to delete, and asking would report a failure per attempt
    // per open forever.
    const dispositions = this.collectableFor(session.id).filter(
      (entry) => session.worktrees.get(entry.runId) !== undefined,
    );

    if (dispositions.length === 0) {
      // Still worth pruning: a checkout the human deleted by hand leaves a
      // registration behind whether or not any decision was ever recorded.
      await session.worktrees.pruneRecords().catch(() => undefined);

      return;
    }

    const { collected, failures } = await session.worktrees.collect(dispositions);

    if (collected.length > 0) {
      console.log(
        `reclaimed ${collected.length} decided attempt worktree(s): ${collected.join(", ")}`,
      );
    }

    for (const failure of failures) {
      // Said, not thrown. Housekeeping must never be why a session refuses to
      // open — and the next open will try this one again.
      console.warn(`an attempt's worktree could not be reclaimed — ${failure}`);
    }

    await session.worktrees.pruneRecords().catch(() => undefined);
  }

  /**
   * Ends the runs that a worker exit left claiming to be in flight.
   *
   * A run is driven by a live loop in this process and by nothing else. The
   * log records `run.started` and, later, a terminator; if the process dies
   * between the two, nothing is left to write the second one. The run then
   * projects as `running` forever — the compare screen shows an attempt still
   * working, the timeline shows a spinner, and both are describing a loop that
   * stopped existing when the worker did. That is the failure mode this closes:
   * not a cosmetic status, but a surface that reports work in flight that is
   * not.
   *
   * Reconciled to `run.failed` rather than to a new terminal status. Four
   * places keep their own copy of "how a run can end" — the projection, the
   * receipt, the compare screen, and the guest timeline — and only one of them
   * is compiler-enforced, so a new status is a cross-surface change with three
   * silent ways to be wrong. `run.failed` is also the honest answer: an
   * interrupted run did not finish, and the one thing it must never do is read
   * as a pass. The reason says what actually happened, so a reader is not left
   * inferring it from a generic failure.
   *
   * Paused runs are deliberately untouched. A pause is a durable, intentional
   * state that outlives the process — the host paused an attempt precisely so
   * they could come back to it — so failing one here would destroy the thing
   * the feature exists to preserve.
   *
   * What this cannot see is a loop in *another* process. Two workers sharing
   * one `NOVUS_DB` and one session id would let this end a run the other is
   * still driving. That configuration is already unsupported for other reasons
   * (two runners, two turn queues, one log), and it is recorded as a known gap
   * rather than papered over: proving liveness across processes needs a
   * heartbeat, which is a bigger change than this one.
   */
  private reconcileInterruptedRuns(session: Session): void {
    const events = this.eventStore.list(session.id);

    if (events.length === 0) {
      return;
    }

    // The projection is the authority on what "running" means, rather than a
    // second hand-rolled fold beside it. A run that is paused, cancelled,
    // completed, or failed is already settled and is not touched.
    const interrupted = projectSession(session.id, events).runs.filter(
      (candidate) => candidate.status === "running",
    );

    for (const orphan of interrupted) {
      try {
        this.eventStore.append({
          sessionId: session.id,
          actorId: "agent-1",
          type: "run.failed",
          payload: {
            runId: orphan.runId,
            reason:
              "interrupted — the worker exited while this run was in flight, so no loop was left to finish it. Nothing it had already done was lost: its tool calls and file changes are above. Fork a checkpoint to carry on from here.",
          },
        });
      } catch (error) {
        // A log that cannot be appended to is not a reason to refuse the
        // session: the host still needs to open it, and the stale `running`
        // is what they had before this ran at all.
        console.error(
          `run ${orphan.runId} was interrupted and the log could not be told: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Tells the log about a fork attempt that ended by throwing.
   *
   * Unlike `reportTurnFailure`, a fork's run id is known before any run
   * exists — it was minted at fork creation and recorded by `fork.created` —
   * so even a failure *before* `run.started` (no adapter configured, a
   * worktree that no longer exists) can be attributed instead of only said
   * on stderr. An attempt that never managed to start is an attempt that
   * failed, and a compare screen listing it as forever pending would be
   * hiding exactly the evidence it exists to show.
   *
   * What must never happen here is ending a run some live loop still owns:
   * a duplicate start is refused by the runner while the first loop keeps
   * going, and appending `run.failed` for that refusal would falsely
   * terminate the survivor. So the append happens only when the log says no
   * loop can be live — the run never started, it is currently paused (the
   * loop exits on pause), or the error is an AgentRunFailure thrown by the
   * loop itself as it died.
   */
  private reportForkFailure(
    session: Session,
    runId: string,
    error: unknown,
  ): void {
    const message =
      (error instanceof Error ? error.message : String(error)) ||
      "The fork's run ended without a message.";

    console.error(`fork attempt ${runId} failed: ${message}`);

    const events = this.eventStore.list(session.id);
    const started = events.some(
      (event) =>
        event.type === "run.started" && event.payload.run.id === runId,
    );
    const ended = events.some(
      (event) =>
        (event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled") &&
        event.payload.runId === runId,
    );
    const latestPause = events
      .filter(
        (event) =>
          (event.type === "run.pause_requested" ||
            event.type === "run.paused" ||
            event.type === "run.resumed") &&
          event.payload.runId === runId,
      )
      .sort((first, second) => first.sequence - second.sequence)
      .at(-1);
    const pausedNow = latestPause?.type === "run.paused";

    if (ended) {
      return;
    }

    if (!(error instanceof AgentRunFailure) && started && !pausedNow) {
      // A loop may still be live under this id; the refusal was the report.
      return;
    }

    try {
      this.eventStore.append({
        sessionId: session.id,
        actorId: "agent-1",
        type: "run.failed",
        payload: { runId, reason: message },
      });
    } catch (reportError) {
      const reason =
        reportError instanceof Error
          ? reportError.message
          : String(reportError);

      console.error(
        `fork attempt ${runId} failed and the log could not be told: ${reason}`,
      );
    }
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
