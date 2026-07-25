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
  | { status: "error"; call: ToolCall; message: string };

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

export type ModelResponse =
  | {
      type: "tool_call";
      call: ToolCall;
    }
  | {
      type: "final";
      summary: string;
    };

export interface ModelAdapter {
  readonly selection: ModelSelection;
  complete(request: ModelRequest): Promise<ModelResponse>;
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
