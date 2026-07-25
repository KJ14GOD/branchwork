import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  ModelSelectionSchema,
  ToolCallSchema,
  type ModelSelection,
} from "@novus/contracts";

import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from "./model.ts";

const READ_FILE_TOOL = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the selected repository using a repository-relative path.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Repository-relative path to the file.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const SEARCH_REPOSITORY_TOOL = {
  name: "search_repository",
  description:
    "Search text across files in the selected repository. Returns repository-relative paths, line numbers, and matching lines. Use this to discover relevant files before reading them.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Text or regular expression to search for.",
      },
      path: {
        type: "string",
        description:
          "Optional repository-relative directory to search. Defaults to the entire repository.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum number of matching lines. Defaults to 30.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const buildMessages = (request: ModelRequest): MessageParam[] => {
  const messages: MessageParam[] = [
    {
      role: "user",
      content: request.goal,
    },
  ];

  for (const exchange of request.toolExchanges) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: exchange.call.id,
          name: exchange.call.name,
          input: exchange.call.input,
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: exchange.call.id,
          content: JSON.stringify(exchange.result.output),
        },
      ],
    });
  }

  return messages;
};

export class AnthropicModelAdapter implements ModelAdapter {
  readonly selection: ModelSelection;
  private readonly client: Anthropic;

  constructor(selection: ModelSelection, apiKey?: string) {
    this.selection = ModelSelectionSchema.parse(selection);

    if (this.selection.provider !== "anthropic") {
      throw new Error("AnthropicModelAdapter requires the anthropic provider.");
    }

    this.client = new Anthropic({ apiKey });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const message = await this.client.messages.create({
      model: this.selection.model,
      max_tokens: 4_096,
      system:
        "You are a coding agent investigating a local repository. Search the repository to discover relevant files, then read files for exact evidence. Never invent file contents.",
      tools: [SEARCH_REPOSITORY_TOOL, READ_FILE_TOOL],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
      messages: buildMessages(request),
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");

    if (toolUse?.type === "tool_use") {
      return {
        type: "tool_call",
        call: ToolCallSchema.parse({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }),
      };
    }

    const summary = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!summary) {
      throw new Error("Anthropic returned neither a tool call nor text.");
    }

    return {
      type: "final",
      summary,
    };
  }
}
