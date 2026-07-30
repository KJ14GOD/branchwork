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
import { SYSTEM_PROMPT, TOOL_DESCRIPTIONS } from "./tool-descriptions.ts";

// Anthropic's own envelope around the shared, provider-neutral descriptions —
// same name and description every provider gets, wrapped in the one field
// name this API expects instead of a second copy of the schema itself.
const ANTHROPIC_TOOLS = TOOL_DESCRIPTIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters as {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  },
}));

/**
 * How much tool output the most recent exchanges may carry in full.
 *
 * Every turn resends every earlier tool result, so a run that reads six files
 * pays for all six on every subsequent call — cost grows with the square of the
 * run's length, and a fifteen-call feature spent 605k tokens mostly on files it
 * had already finished with.
 *
 * A fixed count of recent exchanges was the first version of this, and it
 * livelocked on anything broader than a handful of files. "Explain this repo"
 * needs to hold ten-plus reads in view at once to write one coherent answer;
 * a cutoff of the last four elided everything else within a few calls, and
 * every elision explicitly invites the model to call the tool again — which it
 * did, correctly, because whatever it re-read scrolled back out of the window
 * before it had gathered enough to answer. A live run burned 79 tool calls this
 * way and never produced a summary.
 *
 * The budget is a size now, not a count: walk backward from the newest
 * exchange and keep results whole until their combined size would cross this
 * many characters, then elide older ones. A broad, shallow run — many small
 * reads — mostly fits inside the budget and stays whole; a narrow run that
 * keeps re-reading one huge file is still capped.
 */
const VERBATIM_BUDGET_CHARS = 100_000;
const ELIDE_OVER_CHARS = 2_000;

const describeElided = (name: string, payload: string): string =>
  `[${name} result elided to save context: ${payload.length} characters. Call the tool again if you need it verbatim.]`;

/**
 * The result text for one exchange, full or shortened.
 *
 * Errors are never elided regardless of age. They are short, and they are the
 * thing a model most needs to keep in view — a truncated explanation of what it
 * did wrong is how a model repeats the mistake.
 */
const resultContent = (
  exchange: ModelToolExchange,
  elide: boolean,
): string => {
  if (exchange.status === "invalid") {
    return exchange.message;
  }

  if (exchange.status === "error") {
    return exchange.message;
  }

  const payload = JSON.stringify(exchange.result.output);

  return elide && payload.length > ELIDE_OVER_CHARS
    ? describeElided(exchange.result.name, payload)
    : payload;
};

/**
 * Which exchanges stay verbatim, walking backward from the newest until the
 * size budget runs out. Errors and invalid calls are excluded from the walk —
 * `resultContent` never elides them regardless — so they neither cost budget
 * nor block older successful results from spending it.
 */
const verbatimExchanges = (
  exchanges: readonly ModelToolExchange[],
): boolean[] => {
  const verbatim = new Array<boolean>(exchanges.length).fill(false);
  let remaining = VERBATIM_BUDGET_CHARS;

  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index]!;

    if (exchange.status !== "ok") {
      continue;
    }

    const size = JSON.stringify(exchange.result.output).length;

    if (size > remaining) {
      continue;
    }

    verbatim[index] = true;
    remaining -= size;
  }

  return verbatim;
};

const appendExchanges = (
  messages: MessageParam[],
  exchanges: readonly ModelToolExchange[],
): void => {
  const verbatim = verbatimExchanges(exchanges);

  for (const [index, exchange] of exchanges.entries()) {
    messages.push({
      role: "assistant",
      content: [
        exchange.status === "invalid"
          ? {
              type: "tool_use",
              id: exchange.id,
              name: exchange.name,
              input: exchange.input,
            }
          : {
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
              content: resultContent(exchange, !verbatim[index]),
            }
          : {
              type: "tool_result",
              // An invalid call has no ToolCall to read an id from; the raw
              // tool_use id is what the provider needs to pair the result with.
              tool_use_id:
                exchange.status === "invalid" ? exchange.id : exchange.call.id,
              content: exchange.message,
              is_error: true,
            },
      ],
    });
  }
};

/**
 * Exported so the size of what gets sent can be asserted directly.
 *
 * The alternative was measuring the runner's own exchange list, which grows
 * whether or not elision works — a test that would have passed with the feature
 * removed.
 */
export const buildMessages = (request: ModelRequest): MessageParam[] => {
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
      system: SYSTEM_PROMPT,
      tools: ANTHROPIC_TOOLS,
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
      const call = ToolCallSchema.safeParse({
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      });

      if (!call.success) {
        // Not thrown. The contract is still the boundary — this call does not
        // become a ToolCall and no tool will run — but the model is told what
        // it got wrong and given the turn back.
        return {
          type: "invalid_tool_call",
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
          message: call.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; "),
          usage,
        };
      }

      return { type: "tool_call", call: call.data, usage };
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
