import {
  RunSchema,
  type ModelSelection,
  type Run,
  type SessionEvent,
} from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import type {
  CompletedTurn,
  ModelAdapter,
  ModelRouter,
  ModelToolExchange,
} from "./model.ts";
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
import type { AgentTool } from "./tools.ts";

export type AgentRunInput = {
  sessionId: string;
  actorId: string;
  goal: string;
};

export type AgentRunResult = {
  runId: string;
  events: SessionEvent[];
};

const selectionsMatch = (
  first: ModelSelection,
  second: ModelSelection,
): boolean =>
  first.provider === second.provider && first.model === second.model;

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

export class AgentRunner {
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
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.tools = tools;
    this.approvals = approvals;
    this.readBase = readBase;
    this.budget = budget;
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
   * Which model this runner would use, for a checkpoint to record.
   *
   * A checkpoint carries the model configuration so a fork runs the same way its
   * parent did — comparing two attempts made by different models would be
   * comparing the models, not the attempts.
   */
  modelSelection(): ModelSelection {
    return this.router.select({ goal: "" });
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const modelSelection = this.router.select({ goal: input.goal });
    const adapter = this.adapters.find((candidate) =>
      selectionsMatch(candidate.selection, modelSelection),
    );

    if (!adapter) {
      throw new Error(
        `No model adapter is configured for ${modelSelection.provider}/${modelSelection.model}.`,
      );
    }

    const run = RunSchema.parse({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      goal: input.goal,
      status: "running",
      startedBy: input.actorId,
      model: modelSelection,
      createdAt: new Date().toISOString(),
    });

    // From here the run exists in the log, so anything that throws has to be
    // attributable to it. Above this line there is no run yet — no adapter for
    // the selection, a draft the schema refused — and nothing has claimed to
    // the session that work began.
    try {
      return await this.execute(input, run, adapter);
    } catch (error) {
      throw new AgentRunFailure(run.id, error);
    }
  }

  private async execute(
    input: AgentRunInput,
    run: Run,
    adapter: ModelAdapter,
  ): Promise<AgentRunResult> {
    this.eventStore.append({
      sessionId: input.sessionId,
      actorId: input.actorId,
      type: "run.started",
      payload: { run },
    });

    this.eventStore.append({
      sessionId: input.sessionId,
      actorId: input.actorId,
      type: "run.progress",
      payload: {
        runId: run.id,
        message: `Selected ${run.model.provider}/${run.model.model}`,
      },
    });

    const toolExchanges: ModelToolExchange[] = [];
    const startedAt = Date.now();
    let consecutiveFailures = 0;
    const usage: ReceiptUsage = {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      callsMissingUsage: 0,
    };
    // Reading the base is reporting, not execution: a run that has already
    // emitted run.started must not die because git was unavailable.
    const base = await this.readBase().catch(() => ({
      revision: null,
      dirty: null,
    }));

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

    // Not a step loop. The run continues until the model says it is finished or
    // a budget it can be held to runs out, which is the difference between a
    // harness that does the work and one that stops at a number.
    for (;;) {
      const stopped = budgetExhausted(
        this.budget,
        {
          modelCalls: usage.modelCalls,
          totalTokens: usage.inputTokens + usage.outputTokens,
          consecutiveFailures,
          startedAt,
        },
        Date.now(),
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
      const pending = this.drainDirection(input.sessionId, run.id, input.actorId);
      const steered = pending.length === 0
        ? input.goal
        : `${input.goal}\n\nDirection from the session, applied at this turn:\n${pending.map((line) => `- ${line}`).join("\n")}`;

      const response = await adapter.complete({
        history: this.history,
        goal: steered,
        toolExchanges,
      });

      usage.modelCalls += 1;

      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
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
