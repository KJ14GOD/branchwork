import {
  ModelSelectionSchema,
  type ModelSelection,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

export type ModelToolExchange = {
  call: ToolCall;
  result: ToolResult;
};

export type ModelRequest = {
  goal: string;
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
    const toolResult = request.toolExchanges[0]?.result;

    if (!toolResult) {
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
