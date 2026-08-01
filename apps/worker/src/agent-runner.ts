import {
  ModelSelectionSchema,
  RunSchema,
  type ModelSelection,
  type Run,
  type SessionEvent,
  type ToolCall,
} from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import {
  TransientModelError,
  type CompletedTurn,
  type ModelAdapter,
  type ModelRouter,
  type ModelToolExchange,
  type RoutedSelection,
} from "./model.ts";
import {
  callCostUsd,
  DEFAULT_MODEL_PRICING,
  ratesFor,
  type PricingTable,
} from "./pricing.ts";
import {
  budgetExhausted,
  DEFAULT_RUN_BUDGET,
  type RunBudget,
} from "./budget.ts";
import {
  classifyTool,
  DenyAllApprovalGate,
  type ApprovalGate,
} from "./policy.ts";
import {
  buildReceipt,
  type ReceiptUsage,
  type RepositoryBase,
} from "./receipt.ts";
import {
  NOVUS_BUILTIN_CAPABILITIES,
  type Harness,
  type HarnessCapabilities,
  type HarnessDescriptor,
  type HarnessKind,
} from "./harness.ts";
import type { AgentTool } from "./tools.ts";

export type AgentRunInput = {
  sessionId: string;
  actorId: string;
  goal: string;
  /**
   * Reuse an id the log already knows instead of minting one.
   *
   * A forked attempt's run id is assigned when the fork is created — it is in
   * the log (`fork.created`) and on disk (the worktree's directory name)
   * before any run exists — so the run that executes the attempt has to come
   * up under that id, or the attempt's own events would belong to a run
   * nothing else has ever heard of and the compare screen would keep waiting
   * for events that landed somewhere else.
   */
  runId?: string | undefined;
  /**
   * An explicit human model choice for this turn — the composer's picker, as
   * opposed to its "Auto". When present the router is not consulted at all:
   * precedence is enforced here structurally, not by convention inside each
   * router implementation, so no future router can break it. Absent means
   * route.
   */
  model?: ModelSelection;
};

export type AgentRunResult = {
  runId: string;
  events: SessionEvent[];
};

/**
 * How this run's model came to be chosen. The same shape a router returns,
 * widened with the one source no router may produce: an explicit human
 * choice, which the runner constructs itself before any router is asked.
 */
type ModelChoice = {
  selection: ModelSelection;
  source: "human" | RoutedSelection["source"];
  reason: string;
};

const selectionsMatch = (
  first: ModelSelection,
  second: ModelSelection,
): boolean =>
  first.provider === second.provider && first.model === second.model;

/**
 * How long to wait out a provider that is refusing everyone, not just us.
 *
 * The SDK retries twice on its own before a transient error ever reaches the
 * runner, so these begin where sub-ten-second blips end. A live trace lost
 * twenty-one tool calls of gathered context to a 529 that lasted a little
 * longer than that; every exchange it needed to continue was still in memory.
 * Three waits totalling about a minute cover an overload burst without holding
 * a genuinely dead provider all the way to the wall clock — after the last
 * wait, the error is allowed to end the run and the log says why.
 */
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rebuilds a run's tool exchanges from its own events, for resuming a paused
 * run. The same read-the-log-not-memory principle `cancelRequested` and
 * `drainDirection` already use: the accumulated exchanges of a paused turn
 * live nowhere but the events those exchanges themselves produced.
 *
 * An exchange whose `tool.requested` is missing a matching outcome is not
 * possible to reconstruct and is silently dropped — the loop that produced
 * these events always pairs a request with exactly one of
 * completed/failed/denied before moving on, so this only happens for a call
 * still in flight, which by construction cannot be true of a paused run: the
 * pause boundary is the same one cancel uses, and it only fires once the
 * in-flight call has finished.
 */
const rebuildToolExchanges = (
  events: readonly SessionEvent[],
  runId: string,
): ModelToolExchange[] => {
  const forRun = [...events]
    .filter((event) => "runId" in event.payload && event.payload.runId === runId)
    .sort((first, second) => first.sequence - second.sequence);

  const calls = new Map<string, ToolCall>();
  const exchanges: ModelToolExchange[] = [];

  for (const event of forRun) {
    if (event.type === "tool.requested") {
      calls.set(event.payload.call.id, event.payload.call);
    } else if (event.type === "tool.completed") {
      const call = calls.get(event.payload.result.toolCallId);

      if (call) {
        exchanges.push({ status: "ok", call, result: event.payload.result });
      }
    } else if (event.type === "tool.failed") {
      const call = calls.get(event.payload.toolCallId);

      if (call) {
        exchanges.push({ status: "error", call, message: event.payload.message });
      } else {
        // No matching tool.requested means this was an invalid_tool_call,
        // which never became a real ToolCall to begin with — see model.ts.
        // The raw (invalid) input the model sent is not itself recorded, only
        // the message explaining what was wrong with it; that message is what
        // the model needs back to correct itself, so nothing is lost that
        // the original run would have used either.
        exchanges.push({
          status: "invalid",
          id: event.payload.toolCallId,
          name: event.payload.name,
          input: null,
          message: event.payload.message,
        });
      }
    } else if (event.type === "tool.denied") {
      const call = calls.get(event.payload.toolCallId);

      if (call) {
        exchanges.push({
          status: "error",
          call,
          message: `Denied: ${event.payload.reason}`,
        });
      }
    }
  }

  return exchanges;
};

// The step ceiling used to live here. It is in budget.ts now, as one bound
// among several and the least important of them — see the reasoning there.

// A tool error returns to the model as an observation, but a model that cannot
// recover after this many consecutive failures is looping, not correcting.
// Kept as a name so the two call sites below read the same as before; the value
// comes from the budget, which is where every bound now lives.

/**
 * A run that ended by throwing, carrying the run it ended.
 *
 * Every failure the runner judges for itself ends through `failRun`, which
 * appends `run.failed` and returns. What escapes as a throw is the other kind:
 * the model call rejecting, or the store refusing an append for a reason that
 * has nothing to do with the run — a full disk, a write lock this process
 * waited out. `run.started` is already in the log by then, so a caller that
 * catches the throw has to be able to say which run stopped, and the run id
 * exists nowhere else once the stack has unwound.
 */
export class AgentRunFailure extends Error {
  readonly runId: string;

  constructor(runId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentRunFailure";
    this.runId = runId;
  }
}

export class AgentRunner implements Harness {
  /**
   * The built-in loop, now named as one harness among several.
   *
   * Nothing below this line moved. Novus's own loop is still the reference
   * implementation — it is the only one where Novus mediates approvals, sees
   * typed tool calls, and can fold direction into a live turn — but it is no
   * longer the only way an agent can run, and the three members added here are
   * what let a subprocess-driven harness sit beside it.
   */
  readonly kind: HarnessKind = "novus-builtin";
  readonly capabilities: HarnessCapabilities = NOVUS_BUILTIN_CAPABILITIES;

  async describe(): Promise<HarnessDescriptor> {
    return {
      kind: "novus-builtin",
      id: "novus-builtin",
      // No binary to ask. Null rather than this package's version, which would
      // answer a different question than the one being asked.
      version: null,
      // In-process: there is no subprocess to name.
      command: null,
      capabilities: this.capabilities,
    };
  }

  private readonly eventStore: SessionEventStore;
  private readonly router: ModelRouter;
  private readonly adapters: readonly ModelAdapter[];
  private readonly tools: readonly AgentTool[];
  private readonly approvals: ApprovalGate;
  /**
   * Reads the repository base for a run, at the moment that run starts.
   *
   * Asked per run rather than once per session: a second turn opens on top of
   * whatever the first turn wrote, so a session-wide revision would name a base
   * that no longer describes what the run began from.
   */
  private readonly readBase: () => Promise<RepositoryBase>;
  /** Every bound on this run, and the reason it will give for stopping. */
  private readonly budget: RunBudget;
  /** Overridable so a test of the retry path does not actually wait a minute. */
  private readonly transientRetryDelaysMs: readonly number[];
  /** What each model bills, for the per-call cost the receipt and budget use. */
  private readonly pricing: PricingTable;
  /**
   * The runner's clock. Injectable so latency and wall-clock tests are
   * deterministic instead of sleeping and hoping; everything time-shaped in
   * the loop reads this one clock.
   */
  private readonly now: () => number;
  // One runner is one session. Finished turns stay here so a follow-up
  // question carries the earlier conversation.
  private readonly history: CompletedTurn[] = [];

  constructor(
    eventStore: SessionEventStore,
    router: ModelRouter,
    adapters: readonly ModelAdapter[],
    tools: readonly AgentTool[],
    // Absent a configured gate, write and dangerous tools are denied rather
    // than silently allowed.
    approvals: ApprovalGate = new DenyAllApprovalGate(),
    readBase: () => Promise<RepositoryBase> = async () => ({
      revision: null,
      dirty: false,
    }),
    budget: RunBudget = DEFAULT_RUN_BUDGET,
    transientRetryDelaysMs: readonly number[] = TRANSIENT_RETRY_DELAYS_MS,
    pricing: PricingTable = DEFAULT_MODEL_PRICING,
    now: () => number = Date.now,
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.tools = tools;
    this.approvals = approvals;
    this.readBase = readBase;
    this.budget = budget;
    this.transientRetryDelaysMs = transientRetryDelaysMs;
    this.pricing = pricing;
    this.now = now;
  }

  /**
   * Direction submitted but not yet applied, marked applied as it is returned.
   *
   * Read from the event log rather than a queue, because the log already has to
   * be the record of what happened — a second structure holding the same facts
   * is how a direction gets applied twice, or dropped and never explained.
   */
  private drainDirection(
    sessionId: string,
    runId: string,
    actorId: string,
  ): string[] {
    const events = this.eventStore.list(sessionId);
    const applied = new Set(
      events
        .filter((event) => event.type === "direction.applied")
        .map((event) =>
          event.type === "direction.applied" ? event.payload.directionEventId : "",
        ),
    );

    const pending = events.filter(
      (event) =>
        event.type === "direction.submitted" && !applied.has(event.eventId),
    );

    for (const event of pending) {
      if (event.type !== "direction.submitted") {
        continue;
      }

      this.eventStore.append({
        sessionId,
        actorId,
        type: "direction.applied",
        payload: {
          runId,
          directionEventId: event.eventId,
          direction: event.payload.direction,
        },
      });
    }

    return pending.flatMap((event) =>
      event.type === "direction.submitted" ? [event.payload.direction] : [],
    );
  }

  /**
   * Whether a cancellation has been requested for this run.
   *
   * Read from the log rather than an in-memory flag, for the same reason
   * direction is: the log already has to be the record of what happened, and
   * a second place tracking the same fact is how a request gets missed or
   * acted on twice.
   */
  private cancelRequested(sessionId: string, runId: string): boolean {
    return this.eventStore
      .list(sessionId)
      .some(
        (event) =>
          event.type === "run.cancel_requested" && event.payload.runId === runId,
      );
  }

  /**
   * Whether a pause is currently outstanding for this run.
   *
   * Unlike cancellation, pause is not one-shot: a run can be paused and
   * resumed more than once, so "some event exists" is not enough — what
   * matters is only the *most recent* of the three pause-related events. If
   * that is a request, a pause is pending; if it is `run.paused` or
   * `run.resumed`, it has already been acted on and nothing is outstanding.
   */
  private pauseRequested(sessionId: string, runId: string): boolean {
    const latest = this.eventStore
      .list(sessionId)
      .filter(
        (event) =>
          (event.type === "run.pause_requested" ||
            event.type === "run.paused" ||
            event.type === "run.resumed") &&
          event.payload.runId === runId,
      )
      .sort((first, second) => first.sequence - second.sequence)
      .at(-1);

    return latest?.type === "run.pause_requested";
  }

  /**
   * Which model this runner would use for an unsignaled turn, for a
   * checkpoint to record.
   *
   * A checkpoint carries the model configuration so a fork runs the same way its
   * parent did — comparing two attempts made by different models would be
   * comparing the models, not the attempts. Under a routing router this is
   * the empty-goal default (no signals, no override), which is deterministic
   * — the property forks actually need.
   */
  modelSelection(): ModelSelection {
    return this.router.select({ goal: "" }).selection;
  }

  /**
   * Roughly how many characters of prior conversation the next turn carries:
   * earlier goals and summaries plus the new goal. Deliberately not the tool
   * exchanges — finished turns' results are elided to stubs by the adapter,
   * so counting their full payloads would overstate what a call resends. An
   * estimate feeding an estimate; see ModelRoutingRequest.
   */
  private contextChars(goal: string): number {
    return (
      this.history.reduce(
        (total, turn) => total + turn.goal.length + turn.summary.length,
        0,
      ) + goal.length
    );
  }

  /**
   * Whether this session's most recent finished run failed, from the log —
   * the same read-the-log-not-memory rule direction and cancellation follow.
   * Cancelled is not failed: a human stopping a run says nothing about
   * whether the model was up to it.
   */
  private lastRunFailed(sessionId: string): boolean {
    const events = this.eventStore.list(sessionId);

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;

      if (event.type === "run.failed") {
        return true;
      }

      if (event.type === "run.completed" || event.type === "run.cancelled") {
        return false;
      }
    }

    return false;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // A human's explicit choice always wins over the router — enforced here,
    // structurally: when the turn names a model, no router runs at all. The
    // router is Auto, not a veto.
    const choice: ModelChoice = input.model
      ? {
          selection: ModelSelectionSchema.parse(input.model),
          source: "human",
          reason: "chosen explicitly for this turn",
        }
      : this.router.select({
          goal: input.goal,
          contextChars: this.contextChars(input.goal),
          lastRunFailed: this.lastRunFailed(input.sessionId),
          costBudgetUsd: this.budget.costUsd,
        });
    const adapter = this.adapters.find((candidate) =>
      selectionsMatch(candidate.selection, choice.selection),
    );

    if (!adapter) {
      throw new Error(
        `No model adapter is configured for ${choice.selection.provider}/${choice.selection.model}. This worker can run: ${this.adapters.map((candidate) => `${candidate.selection.provider}/${candidate.selection.model}`).join(", ")}.`,
      );
    }

    // A preassigned id must be genuinely new. A second run.started under an
    // id the log already carries would reset that run's entire projection —
    // exactly what resume()'s `continuing` flag exists to prevent — so a
    // duplicate is refused here, before anything claims work began.
    if (input.runId !== undefined) {
      const already = this.eventStore
        .list(input.sessionId)
        .some(
          (event) =>
            event.type === "run.started" &&
            event.payload.run.id === input.runId,
        );

      if (already) {
        throw new Error(
          `Run ${input.runId} already exists in this session's log and cannot be started again.`,
        );
      }
    }

    const run = RunSchema.parse({
      id: input.runId ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      goal: input.goal,
      status: "running",
      startedBy: input.actorId,
      model: choice.selection,
      createdAt: new Date().toISOString(),
    });

    // From here the run exists in the log, so anything that throws has to be
    // attributable to it. Above this line there is no run yet — no adapter for
    // the selection, a draft the schema refused — and nothing has claimed to
    // the session that work began.
    try {
      return await this.execute(input, run, adapter, [], false, choice);
    } catch (error) {
      throw new AgentRunFailure(run.id, error);
    }
  }

  /**
   * Continues a run that was previously paused, under the same run id.
   *
   * `run.started` is not appended again — this is the same run picking back
   * up, not a new one, which is why the receipt and projection key off
   * `run.id` rather than a fresh one. Two things are deliberately not carried
   * forward across the resume: token usage, because it is only ever reported
   * per model call and never logged, so there is nothing to rebuild it from;
   * and the run's start time for budget purposes, which resets so neither a
   * long pause nor the turns before it count against the continuation's own
   * budget. Both are read straight from the log otherwise — the tool
   * exchanges the model had already built up are rebuilt from the events
   * they produced, same as direction and cancellation already are.
   */
  async resume(input: {
    sessionId: string;
    actorId: string;
    runId: string;
  }): Promise<AgentRunResult> {
    const events = this.eventStore.list(input.sessionId);
    const started = events.find(
      (event) =>
        event.type === "run.started" && event.payload.run.id === input.runId,
    );

    if (started?.type !== "run.started") {
      throw new Error(`No run ${input.runId} exists to resume.`);
    }

    const terminated = events.some(
      (event) =>
        (event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled") &&
        event.payload.runId === input.runId,
    );

    if (terminated) {
      throw new Error(`Run ${input.runId} already ended and cannot be resumed.`);
    }

    const pauseState = events
      .filter(
        (event) =>
          (event.type === "run.pause_requested" ||
            event.type === "run.paused" ||
            event.type === "run.resumed") &&
          event.payload.runId === input.runId,
      )
      .sort((first, second) => first.sequence - second.sequence)
      .at(-1);

    if (pauseState?.type !== "run.paused") {
      throw new Error(`Run ${input.runId} is not paused.`);
    }

    // Not the caller's to supply: the goal a resumed run continues with is
    // the one it already started with, on the log, not whatever a caller
    // happens to pass. Only `run()` mints a fresh one.
    const run = started.payload.run;
    const adapter = this.adapters.find((candidate) =>
      selectionsMatch(candidate.selection, run.model),
    );

    if (!adapter) {
      throw new Error(
        `No model adapter is configured for ${run.model.provider}/${run.model.model}.`,
      );
    }

    this.eventStore.append({
      sessionId: input.sessionId,
      actorId: input.actorId,
      type: "run.resumed",
      payload: { runId: run.id },
    });

    try {
      return await this.execute(
        { sessionId: input.sessionId, actorId: input.actorId, goal: run.goal },
        run,
        adapter,
        rebuildToolExchanges(events, run.id),
        // continuing = true. The docstring above already said run.started is
        // not appended again; execute() did it anyway, unconditionally, for
        // every caller. projection.ts resets a run's entire state on
        // run.started, so a second one silently wiped every tool call and
        // file change a paused run had made before resume ever ran.
        true,
      );
    } catch (error) {
      throw new AgentRunFailure(run.id, error);
    }
  }

  private async execute(
    input: AgentRunInput,
    run: Run,
    adapter: ModelAdapter,
    // Non-empty only when this is a resumed run: the exchanges a paused turn
    // had already accumulated, rebuilt from the log so the model does not
    // lose the context it built up before the pause.
    initialToolExchanges: readonly ModelToolExchange[] = [],
    // A resume, continuing an id the log already knows, not a fresh start.
    // Kept as its own flag rather than inferred from initialToolExchanges
    // being non-empty: a run can genuinely pause before its first tool call,
    // and inferring from an empty array would misclassify that resume as new.
    continuing = false,
    // Who picked this run's model and why. Absent on a resume, where the
    // model is the one the log already recorded, not a fresh decision.
    choice?: ModelChoice,
  ): Promise<AgentRunResult> {
    if (!continuing) {
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.started",
        payload: { run },
      });

      // The reason is part of the record, not decoration: a run whose model
      // choice cannot be explained from the log is the black box this
      // product exists to open. Every timeline renders run.progress already,
      // so the explanation is visible everywhere today.
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.progress",
        payload: {
          runId: run.id,
          message: `Selected ${run.model.provider}/${run.model.model}${
            choice ? ` (${choice.source}: ${choice.reason})` : ""
          }`,
        },
      });
    }

    const toolExchanges: ModelToolExchange[] = [...initialToolExchanges];
    const startedAt = this.now();
    // Priced once for the whole run — the model is fixed at run start, so
    // these rates are the run's rates. Null means the model has no configured
    // price, and every cost figure downstream honestly says "unknown" rather
    // than zero.
    const rates = ratesFor(this.pricing, run.model);
    let consecutiveFailures = 0;
    // How many times each read-class call has run with byte-identical input
    // since the repository could last have changed. A read is a pure function
    // of the repository, so until a write or a command runs, an identical read
    // returns identical bytes and the repeat gains nothing. The map is cleared
    // whenever a non-read tool executes, because after that the same read is a
    // genuine question again.
    const readRepeats = new Map<string, number>();
    let identicalReads = 0;
    // A resume continues the count rather than restarting it. Read from the
    // log rather than carried in memory, because the process that held that
    // memory is exactly what may have gone away — and a run that resumed
    // believing it had spent nothing could spend its whole ceiling again on
    // every resume, which is the guard failing in the one direction that
    // costs money.
    //
    // Absent on pauses recorded before the snapshot existed, and on a fresh
    // run. Both start from zero, which is the honest reading of a log that
    // never wrote it down.
    const resumedFrom = continuing
      ? this.eventStore
          .list(input.sessionId)
          .filter(
            (event) =>
              event.type === "run.paused" && event.payload.runId === run.id,
          )
          .sort((first, second) => first.sequence - second.sequence)
          .at(-1)
      : undefined;
    const priorUsage =
      resumedFrom?.type === "run.paused" ? resumedFrom.payload.usage : undefined;

    const usage: ReceiptUsage = {
      inputTokens: priorUsage?.inputTokens ?? 0,
      outputTokens: priorUsage?.outputTokens ?? 0,
      modelCalls: priorUsage?.modelCalls ?? 0,
      callsMissingUsage: priorUsage?.callsMissingUsage ?? 0,
      modelTimeMs: priorUsage?.modelTimeMs ?? 0,
      // Null is sticky in the right direction: a prior leg that could not be
      // priced makes the whole run unpriced, rather than resuming at zero and
      // reporting only what the second leg happened to cost.
      costUsd:
        rates === null
          ? null
          : priorUsage === undefined
            ? 0
            : priorUsage.costUsd,
      rates,
    };
    // Reading the base is reporting, not execution: a run that has already
    // emitted run.started must not die because git was unavailable.
    const base = await this.readBase().catch(() => ({
      revision: null,
      dirty: null,
    }));

    // Whether this run is a forked attempt. An attempt's goal is frozen at
    // its checkpoint — V1's fork carries "goal and constraints" as a value —
    // and direction submitted to the session steers the session's own run.
    // Mechanically it has to be this way too: drainDirection marks a
    // direction applied the moment any one run folds it in, so concurrent
    // attempts draining the same queue would race one another (and the
    // parent) for who swallows it, with the losers never seeing it and the
    // parent losing it nondeterministically. Read from the log rather than
    // passed as a flag, because fork.created precedes the attempt's
    // run.started by construction and the log is what survives a restart —
    // a resumed fork keeps this property without anyone re-telling it.
    const forkAttempt = this.eventStore
      .list(input.sessionId)
      .some(
        (event) =>
          event.type === "fork.created" &&
          event.payload.fork.runId === run.id,
      );

    // Emitted after the terminal event, so the receipt can read it back and
    // report how the run actually ended rather than how it was expected to.
    const emitReceipt = (): void => {
      // A receipt is a report about a run, so it must never be able to end one.
      // Validation here, or any subscriber the append notifies, would otherwise
      // turn a finished run into a rejected promise — losing the very result
      // the receipt exists to describe.
      try {
        const receipt = buildReceipt(
          this.eventStore.list(input.sessionId),
          run.id,
          { base, usage },
        );

        if (receipt) {
          this.eventStore.append({
            sessionId: input.sessionId,
            actorId: input.actorId,
            type: "receipt.created",
            payload: { runId: run.id, receipt },
          });
        }
      } catch (error) {
        // Say so where the run is. A receipt that silently stops being produced
        // is indistinguishable from one that was never wanted, and stderr on
        // the host is not somewhere a reviewer of the session will look.
        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "run.progress",
          payload: {
            runId: run.id,
            message: `No receipt was produced: ${(error as Error).message}`,
          },
        });
      }
    };

    const failRun = (reason: string): AgentRunResult => {
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.failed",
        payload: { runId: run.id, reason },
      });

      emitReceipt();

      return { runId: run.id, events: this.eventStore.list(input.sessionId) };
    };

    // Distinct from failRun: a cancelled run is not a failure, and reporting
    // it as one would tell a reviewer the agent broke when a human simply
    // asked it to stop.
    const cancelRun = (): AgentRunResult => {
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.cancelled",
        payload: { runId: run.id },
      });

      emitReceipt();

      return { runId: run.id, events: this.eventStore.list(input.sessionId) };
    };

    // Distinct from both: a paused run is not done and gets no receipt —
    // there is nothing terminal yet for one to describe, and `resume` is what
    // picks this same run back up.
    const pauseRun = (): AgentRunResult => {
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.paused",
        // The spend goes with it. Budgets accumulate in memory and that
        // memory dies with the process, so a resumed run used to come back
        // believing it had spent nothing — and a cost ceiling could be spent
        // again in full on every resume. No receipt is written here on
        // purpose (a paused run is not over), so this event is the only place
        // the figure can survive.
        payload: {
          runId: run.id,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            modelCalls: usage.modelCalls,
            callsMissingUsage: usage.callsMissingUsage,
            costUsd: usage.costUsd,
            modelTimeMs: usage.modelTimeMs,
          },
        },
      });

      return { runId: run.id, events: this.eventStore.list(input.sessionId) };
    };

    // Not a step loop. The run continues until the model says it is finished or
    // a budget it can be held to runs out, which is the difference between a
    // harness that does the work and one that stops at a number.
    for (;;) {
      // Checked first, ahead of the budget and ahead of direction: a run
      // being stopped should not spend one more model call finding that out,
      // and a direction still pending when the cancel arrives is left
      // unapplied rather than folded into a call that will never happen.
      // This is the same turn boundary direction is folded in at — a tool
      // call already in flight when the request lands is allowed to finish;
      // only the *next* model call is refused.
      if (this.cancelRequested(input.sessionId, run.id)) {
        return cancelRun();
      }

      // Checked right after cancel, at the same boundary: a pause that is
      // still outstanding stops the run here rather than spending another
      // model call first. A pause never overrides a cancel — cancel already
      // returned above if both were requested — but the reverse can happen
      // legitimately (a paused run gets cancelled instead of resumed), which
      // is handled the ordinary way the next time this run's loop runs.
      if (this.pauseRequested(input.sessionId, run.id)) {
        return pauseRun();
      }

      const stopped = budgetExhausted(
        this.budget,
        {
          modelCalls: usage.modelCalls,
          totalTokens: usage.inputTokens + usage.outputTokens,
          costUsd: usage.costUsd,
          consecutiveFailures,
          identicalReads,
          startedAt,
        },
        this.now(),
      );

      if (stopped !== null) {
        return failRun(`The run ${stopped}.`);
      }

      // Direction is folded in here, between turns, and nowhere else. V1 is
      // explicit that a human does not mutate a prompt that is already
      // executing: the runtime finishes the current atomic tool action first,
      // and this is that boundary. Anything submitted mid-call waits for it.
      //
      // The log is what says which direction is outstanding, rather than a
      // queue held beside it. Two places tracking the same thing is how a
      // direction gets applied twice or silently dropped.
      //
      // A forked attempt does not drain it at all — see forkAttempt above.
      const pending = forkAttempt
        ? []
        : this.drainDirection(input.sessionId, run.id, input.actorId);
      const steered = pending.length === 0
        ? input.goal
        : `${input.goal}\n\nDirection from the session, applied at this turn:\n${pending.map((line) => `- ${line}`).join("\n")}`;

      // A transient provider error — overload, a rate limit, a dropped
      // connection — is waited out rather than allowed to end the run, because
      // everything the run has gathered is right here in toolExchanges and
      // dying discards it all. Only marked-transient errors are retried, and
      // only this many times: a provider that stays down through every wait
      // ends the run through the ordinary throw path, with the cause intact.
      let response;
      // The successful attempt's own duration. Failed transient attempts and
      // the waits between them are excluded on purpose: they are already in
      // the log as run.progress lines, and the run's elapsedMs carries the
      // whole wall clock — this number answers "how long does the model
      // itself take", which is the latency a future router would weigh.
      let modelCallMs = 0;

      for (let attempt = 0; ; attempt += 1) {
        const attemptStartedAt = this.now();

        try {
          response = await adapter.complete({
            history: this.history,
            goal: steered,
            toolExchanges,
          });
          modelCallMs = this.now() - attemptStartedAt;
          break;
        } catch (error) {
          const delay = this.transientRetryDelaysMs[attempt];

          if (!(error instanceof TransientModelError) || delay === undefined) {
            throw error;
          }

          // Said in the log, because from the timeline a silent wait is
          // indistinguishable from a run that hung.
          this.eventStore.append({
            sessionId: input.sessionId,
            actorId: input.actorId,
            type: "run.progress",
            payload: {
              runId: run.id,
              message: `The model provider is unavailable (${error.message}); retrying in ${Math.round(delay / 1000)}s (${attempt + 1} of ${this.transientRetryDelaysMs.length}).`,
            },
          });

          await sleep(delay);
        }
      }

      usage.modelCalls += 1;
      // Latency is the runner's own measurement, unlike tokens. Tokens are
      // reported by the adapter because only the provider knows what it
      // billed; latency is knowable from the caller's seat with the caller's
      // clock, and measuring it here means no adapter can silently forget to.
      usage.modelTimeMs += modelCallMs;

      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;

        if (rates !== null) {
          // Cost accrues per call, not once at the end, so the budget check
          // at the top of the loop sees money already spent — a $5 ceiling
          // stops the run at the first call that crosses it, not at the
          // receipt. When some calls report no usage this is a floor, and
          // callsMissingUsage says so.
          usage.costUsd =
            (usage.costUsd ?? 0) + callCostUsd(rates, response.usage);
        }
      } else {
        // Counted, not ignored: the totals become a floor and anything showing
        // them has to say so rather than print a number that is quietly short.
        usage.callsMissingUsage += 1;
      }

      if (response.type === "final") {
        this.history.push({
          goal: input.goal,
          exchanges: [...toolExchanges],
          summary: response.summary,
        });

        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "run.completed",
          payload: {
            runId: run.id,
            summary: response.summary,
          },
        });

        emitReceipt();

        return {
          runId: run.id,
          events: this.eventStore.list(input.sessionId),
        };
      }

      if (response.type === "invalid_tool_call") {
        // The model asked for a real tool with arguments the contract refuses.
        // Nothing runs, and the run does not end: the model is told what was
        // wrong and takes the next turn. Before this, the adapter threw and the
        // throw escaped the loop — no run.failed, no receipt, an agent that
        // simply stopped with nothing in the log saying why.
        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "tool.failed",
          payload: {
            runId: run.id,
            toolCallId: response.id,
            name: response.name,
            message: response.message,
          },
        });

        toolExchanges.push({
          status: "invalid",
          id: response.id,
          name: response.name,
          input: response.input,
          message: `The arguments did not match the tool's contract — ${response.message}. Read the tool's schema and call it again.`,
        });

        // Counted like any other failure. A model that cannot produce a
        // well-formed call after several tries is looping, not correcting.
        consecutiveFailures += 1;

        if (consecutiveFailures >= this.budget.consecutiveFailures) {
          return failRun(
            `The agent produced ${consecutiveFailures} malformed tool calls in a row. Last error: ${response.message}`,
          );
        }

        continue;
      }

      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "tool.requested",
        payload: {
          runId: run.id,
          call: response.call,
          // Carried straight through from the adapter — see ModelResponse's
          // own doc comment for why this is optional and usually absent.
          ...(response.text ? { text: response.text } : {}),
        },
      });

      const tool = this.tools.find(
        (candidate) => candidate.name === response.call.name,
      );

      if (!tool) {
        return failRun(`No tool is configured for ${response.call.name}.`);
      }

      const toolClass = classifyTool(response.call.name);

      if (toolClass !== "read") {
        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "tool.approval_requested",
          payload: { runId: run.id, call: response.call, toolClass },
        });

        const decision = await this.approvals.review({
          call: response.call,
          toolClass,
        });

        if (!decision.approved) {
          this.eventStore.append({
            sessionId: input.sessionId,
            actorId: input.actorId,
            type: "tool.denied",
            payload: {
              runId: run.id,
              toolCallId: response.call.id,
              deniedBy: decision.deniedBy,
              reason: decision.reason,
            },
          });

          // A denial is a decision, not a malfunction: tell the model why and
          // let it respond, without counting toward the failure budget.
          toolExchanges.push({
            status: "error",
            call: response.call,
            message: `Denied: ${decision.reason}`,
          });

          continue;
        }

        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "tool.approved",
          payload: {
            runId: run.id,
            toolCallId: response.call.id,
            approvedBy: decision.approvedBy,
          },
        });
      }

      if (toolClass !== "read") {
        // The repository may be about to change, so every identical-read count
        // starts over: re-reading a file after a patch or a command is the
        // correct thing to do, not a loop. Cleared on the execution attempt
        // rather than on success — a command that failed may still have
        // written — but not on a denial, which runs nothing and must not keep
        // resetting the very counter that would catch a deny-and-retry cycle.
        readRepeats.clear();
      }

      let result;

      try {
        result = await tool.execute(response.call);
      } catch (error) {
        const message = (error as Error).message;

        toolExchanges.push({
          status: "error",
          call: response.call,
          message,
        });

        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "tool.failed",
          payload: {
            runId: run.id,
            toolCallId: response.call.id,
            name: response.call.name,
            message,
          },
        });

        consecutiveFailures += 1;

        if (consecutiveFailures >= this.budget.consecutiveFailures) {
          return failRun(
            `The agent failed ${consecutiveFailures} tool calls in a row without recovering. Last error: ${message}`,
          );
        }

        continue;
      }

      consecutiveFailures = 0;

      if (toolClass === "read") {
        const key = `${response.call.name} ${JSON.stringify(response.call.input)}`;
        const repeats = (readRepeats.get(key) ?? 0) + 1;

        readRepeats.set(key, repeats);
        identicalReads = Math.max(identicalReads, repeats);

        if (repeats >= this.budget.identicalReads) {
          // Checked here as well as at the loop top so the reason can name the
          // call that looped — same shape as the failure counter above. The
          // result still enters the log first: the evidence of the loop is the
          // repetition itself, and hiding the final read would make the log
          // disagree with the reason.
          this.eventStore.append({
            sessionId: input.sessionId,
            actorId: input.actorId,
            type: "tool.completed",
            payload: { runId: run.id, result },
          });

          return failRun(
            `The agent called ${response.call.name} with ${JSON.stringify(response.call.input)} ${repeats} times without anything changing in between — it was re-reading what it already had rather than finishing.`,
          );
        }
      }

      toolExchanges.push({
        status: "ok",
        call: response.call,
        result,
      });

      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "tool.completed",
        payload: {
          runId: run.id,
          result,
        },
      });
    }

    // Unreachable: the loop returns through failRun or run.completed. Kept out
    // rather than left as a lie about how a run can end.
  }
}
