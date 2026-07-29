import {
  RunSchema,
  type ModelSelection,
  type SessionEvent,
} from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import type {
  CompletedTurn,
  ModelAdapter,
  ModelRouter,
  ModelToolExchange,
} from "./model.ts";
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

const MAX_MODEL_STEPS = 16;

// A tool error returns to the model as an observation, but a model that cannot
// recover after this many consecutive failures is looping, not correcting.
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

export class AgentRunner {
  private readonly eventStore: InMemorySessionEventStore;
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
  // One runner is one session. Finished turns stay here so a follow-up
  // question carries the earlier conversation.
  private readonly history: CompletedTurn[] = [];

  constructor(
    eventStore: InMemorySessionEventStore,
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
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.tools = tools;
    this.approvals = approvals;
    this.readBase = readBase;
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
        message: `Selected ${modelSelection.provider}/${modelSelection.model}`,
      },
    });

    const toolExchanges: ModelToolExchange[] = [];
    let consecutiveFailures = 0;
    const usage: ReceiptUsage = {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      callsMissingUsage: 0,
    };
    const base = await this.readBase();

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
        console.error(`receipt not produced: ${(error as Error).message}`);
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

    for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
      const response = await adapter.complete({
        history: this.history,
        goal: input.goal,
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

        if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
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

    return failRun(
      `The agent exceeded the ${MAX_MODEL_STEPS}-step ceiling without finishing.`,
    );
  }
}
