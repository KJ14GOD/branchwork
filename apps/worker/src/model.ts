import {
  ModelSelectionSchema,
  type ModelSelection,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

/**
 * One completed tool turn as the model sees it.
 *
 * A rejected tool is still an exchange — the model receives the error and can
 * correct the call on the next turn instead of the run ending.
 */
export type ModelToolExchange =
  | { status: "ok"; call: ToolCall; result: ToolResult }
  | { status: "error"; call: ToolCall; message: string }
  /**
   * A tool call that never became one.
   *
   * The model asked for a real tool with arguments the contract rejects — an
   * `edits` that arrived as a string rather than an array, say. There is no
   * ToolCall to carry, so this holds the raw request instead. It still has to
   * reach the model as a result, because the provider requires one for every
   * tool_use and because a model that is not told what was wrong repeats it.
   */
  | {
      status: "invalid";
      id: string;
      name: string;
      input: unknown;
      message: string;
    };

/** A turn that already finished, replayed to the model as prior context. */
export type CompletedTurn = {
  goal: string;
  exchanges: readonly ModelToolExchange[];
  summary: string;
};

export type ModelRequest = {
  /** Earlier turns in this session, oldest first. */
  history: readonly CompletedTurn[];
  /** The goal being worked on right now. */
  goal: string;
  /** Tool exchanges within the current turn. */
  toolExchanges: readonly ModelToolExchange[];
};

export type ModelRoutingRequest = {
  goal: string;
};

/**
 * What one model call consumed.
 *
 * Reported by the adapter rather than estimated by the runner, because only the
 * provider knows what it actually billed — a locally counted approximation in a
 * receipt would be a guess wearing the costume of evidence.
 *
 * inputTokens is a full-price-equivalent count: an adapter that uses prompt
 * caching weighs cache reads and writes by what they bill relative to a
 * full-price token, so a token budget keeps meaning the same spend whether or
 * not the cache was warm.
 */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelResponse =
  | {
      type: "tool_call";
      call: ToolCall;
      usage?: ModelUsage;
    }
  /**
   * The model asked for a tool in a shape the contract refuses.
   *
   * Returned rather than thrown. A throw here escapes the run loop before any
   * terminal event, so the run ends with no run.failed and no receipt — the
   * agent simply stops, and nothing in the log says why. That is the one thing
   * the boundary is supposed to prevent: a malformed request is an observation
   * the model can correct, not a reason to lose the run.
   */
  | {
      type: "invalid_tool_call";
      id: string;
      name: string;
      input: unknown;
      message: string;
      usage?: ModelUsage;
    }
  | {
      type: "final";
      summary: string;
      usage?: ModelUsage;
    };

/**
 * A model call that failed for reasons that belong to the provider, not the run.
 *
 * A live trace lost twenty-one tool calls of gathered context to one 529 that
 * outlasted the SDK's own retries: the throw escaped the loop, the run failed,
 * and everything the run knew was discarded — even though every exchange it
 * needed to continue was still in memory. An overloaded provider is weather,
 * not a verdict on the run, so the adapter marks these and the runner waits
 * them out instead of dying. Anything else the adapter throws is still fatal.
 */
export class TransientModelError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "TransientModelError";
  }
}

export interface ModelAdapter {
  readonly selection: ModelSelection;
  complete(request: ModelRequest): Promise<ModelResponse>;
  /**
   * Which model ids this adapter's provider currently serves, if it can say.
   *
   * Optional because a scripted adapter has no provider to ask. When present,
   * the session gains the list_provider_models tool, which exists so the agent
   * can check a model id against the provider instead of judging it from
   * training data that may predate it.
   */
  listModels?(): Promise<string[]>;
}

export interface ModelRouter {
  select(request: ModelRoutingRequest): ModelSelection;
}

export class FixedModelRouter implements ModelRouter {
  private readonly selection: ModelSelection;

  constructor(selection: ModelSelection) {
    this.selection = ModelSelectionSchema.parse(selection);
  }

  select(): ModelSelection {
    return this.selection;
  }
}

export class ScriptedModelAdapter implements ModelAdapter {
  readonly selection: ModelSelection;
  private readonly requestedPath: string;

  constructor(selection: ModelSelection, requestedPath = "package.json") {
    this.selection = ModelSelectionSchema.parse(selection);
    this.requestedPath = requestedPath;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const exchange = request.toolExchanges[0];
    const toolResult =
      exchange?.status === "ok" ? exchange.result : undefined;

    if (!toolResult || toolResult.name !== "read_file") {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: {
            path: this.requestedPath,
          },
        },
      };
    }

    return {
      type: "final",
      summary: `Read ${toolResult.output.path} for "${request.goal}" (${toolResult.output.content.length} characters).`,
    };
  }
}
