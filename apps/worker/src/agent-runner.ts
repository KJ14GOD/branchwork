import {
  RunSchema,
  type ModelSelection,
  type SessionEvent,
} from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import type {
  ModelAdapter,
  ModelRouter,
  ModelToolExchange,
} from "./model.ts";
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

  constructor(
    eventStore: InMemorySessionEventStore,
    router: ModelRouter,
    adapters: readonly ModelAdapter[],
    tools: readonly AgentTool[],
  ) {
    this.eventStore = eventStore;
    this.router = router;
    this.adapters = adapters;
    this.tools = tools;
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

    const failRun = (reason: string): AgentRunResult => {
      this.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.failed",
        payload: { runId: run.id, reason },
      });

      return { runId: run.id, events: this.eventStore.list(input.sessionId) };
    };

    for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
      const response = await adapter.complete({
        goal: input.goal,
        toolExchanges,
      });

      if (response.type === "final") {
        this.eventStore.append({
          sessionId: input.sessionId,
          actorId: input.actorId,
          type: "run.completed",
          payload: {
            runId: run.id,
            summary: response.summary,
          },
        });

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
