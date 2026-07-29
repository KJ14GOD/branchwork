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
  ModelToolExchange,
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

const PROPOSE_PATCH_TOOL = {
  name: "propose_patch",
  description:
    "Propose an edit to one file in the selected repository. Novus computes and returns a unified diff preview. This does not modify the working tree — the change is only a proposal awaiting human review. Read the file first so every oldText is exact.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Repository-relative path to the file to edit.",
      },
      intent: {
        type: "string",
        description: "One sentence describing what this change accomplishes.",
      },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        description: "Exact-match replacements, applied in order.",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact existing text to replace. It must appear exactly once in the file; include surrounding lines when needed to make it unique.",
            },
            newText: {
              type: "string",
              description:
                "Replacement text. Use an empty string to delete the matched text.",
            },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "intent", "edits"],
    additionalProperties: false,
  },
};

const APPLY_PATCH_TOOL = {
  name: "apply_patch",
  description:
    "Apply a patch you previously proposed, writing it to the working tree. Takes the patchId returned by propose_patch. This requires human approval and may be denied. It fails if the file changed since the patch was proposed.",
  input_schema: {
    type: "object" as const,
    properties: {
      patchId: {
        type: "string",
        description: "The patchId returned by a previous propose_patch call.",
      },
    },
    required: ["patchId"],
    additionalProperties: false,
  },
};

const RUN_COMMAND_TOOL = {
  name: "run_command",
  description:
    "Run a program inside the selected repository and return its exit code, stdout, and stderr. The command runs without a shell, so pipes, redirection, globs, and operators like && are not interpreted — pass the program name and each argument separately. Requires human approval and may be denied.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description:
          "Program name resolved on PATH, such as 'node' or 'git'. Not a path and not a shell line.",
      },
      args: {
        type: "array",
        maxItems: 64,
        items: { type: "string" },
        description:
          "Arguments, one array element each. For example ['status', '--short'].",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 600000,
        description: "Kill the command after this long. Defaults to 120000.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const RUN_TESTS_TOOL = {
  name: "run_tests",
  description:
    "Run the repository's own test suite and report whether it passed. Use this to verify a change you applied actually works, before claiming it does. Requires human approval and may be denied.",
  input_schema: {
    type: "object" as const,
    properties: {
      args: {
        type: "array",
        maxItems: 32,
        items: { type: "string" },
        description:
          "Optional extra arguments passed to the test script, such as a filename to narrow the run.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 600000,
        description: "Kill the run after this long. Defaults to 120000.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const appendExchanges = (
  messages: MessageParam[],
  exchanges: readonly ModelToolExchange[],
): void => {
  for (const exchange of exchanges) {
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
        exchange.status === "ok"
          ? {
              type: "tool_result",
              tool_use_id: exchange.call.id,
              content: JSON.stringify(exchange.result.output),
            }
          : {
              type: "tool_result",
              tool_use_id: exchange.call.id,
              content: exchange.message,
              is_error: true,
            },
      ],
    });
  }
};

const buildMessages = (request: ModelRequest): MessageParam[] => {
  const messages: MessageParam[] = [];

  // Replay finished turns so a follow-up question keeps the earlier context.
  for (const turn of request.history) {
    messages.push({ role: "user", content: turn.goal });
    appendExchanges(messages, turn.exchanges);
    messages.push({ role: "assistant", content: turn.summary });
  }

  messages.push({ role: "user", content: request.goal });
  appendExchanges(messages, request.toolExchanges);

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
        "You are a coding agent working in a local repository. Search the repository to discover relevant files, then read files for exact evidence. Never invent file contents. When a change is needed, call propose_patch to produce a reviewable diff, then call apply_patch with the patchId it returns to write it. After applying a change, call run_tests to confirm it works, and report what the tests actually said rather than asserting success. apply_patch, run_command, and run_tests require human approval and may be denied — if one is, explain what you would have done rather than trying to work around the denial.",
      tools: [
        SEARCH_REPOSITORY_TOOL,
        READ_FILE_TOOL,
        PROPOSE_PATCH_TOOL,
        APPLY_PATCH_TOOL,
        RUN_COMMAND_TOOL,
        RUN_TESTS_TOOL,
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
      messages: buildMessages(request),
    });

    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };

    const toolUse = message.content.find((block) => block.type === "tool_use");

    if (toolUse?.type === "tool_use") {
      return {
        type: "tool_call",
        call: ToolCallSchema.parse({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }),
        usage,
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
      usage,
    };
  }
}
