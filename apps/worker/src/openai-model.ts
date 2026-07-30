import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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

/**
 * The second concrete `ModelAdapter` — proof that the provider-neutral
 * interface in `model.ts` was actually neutral, not Anthropic's shape with
 * the serial numbers filed off. README says "Novus must never make a single
 * model provider its architectural foundation"; until this file existed that
 * was an aspiration nothing tested.
 *
 * Deliberately not sharing message-building or context-elision code with
 * `anthropic-model.ts`. The two providers' conversation shapes are genuinely
 * different — content blocks with typed parts versus a flat role-tagged
 * message array — and forcing one abstraction over both before there is a
 * third provider to prove it generalises would be exactly the mistake
 * `novus-build-harness` warns against in the other direction. Only the tool
 * *descriptions* moved to a shared module, because those are identical
 * content wrapped differently, not different logic.
 */

const openaiTools: ChatCompletionTool[] = TOOL_DESCRIPTIONS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

// Same idea as the Anthropic adapter's budget — walk backward from the newest
// exchange and keep results whole until this many characters are spent, then
// elide older ones rather than resending every prior read on every turn — but
// implemented independently, against this provider's own message shape,
// rather than shared code. See anthropic-model.ts for the full account of the
// livelock this exists to prevent (a fixed count of recent exchanges, rather
// than a size budget, stopped a broad "explain this repo" from ever finishing).
const VERBATIM_BUDGET_CHARS = 100_000;
const ELIDE_OVER_CHARS = 2_000;

const describeElided = (name: string, payload: string): string =>
  `[${name} result elided to save context: ${payload.length} characters. Call the tool again if you need it verbatim.]`;

const resultContent = (exchange: ModelToolExchange, elide: boolean): string => {
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

const verbatimExchanges = (exchanges: readonly ModelToolExchange[]): boolean[] => {
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
  messages: ChatCompletionMessageParam[],
  exchanges: readonly ModelToolExchange[],
): void => {
  const verbatim = verbatimExchanges(exchanges);

  for (const [index, exchange] of exchanges.entries()) {
    const toolCallId = exchange.status === "invalid" ? exchange.id : exchange.call.id;
    const name = exchange.status === "invalid" ? exchange.name : exchange.call.name;
    const input = exchange.status === "invalid" ? exchange.input : exchange.call.input;

    messages.push({
      role: "assistant",
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    });

    messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: resultContent(exchange, !verbatim[index]),
    });
  }
};

/**
 * Exported for the same reason `buildMessages` in `anthropic-model.ts` is:
 * so the size of what gets sent — and, here, the round-trip of a tool call
 * through the message shape — can be asserted directly rather than through
 * the runner's own growing exchange list.
 */
export const buildMessages = (request: ModelRequest): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];

  for (const turn of request.history) {
    messages.push({ role: "user", content: turn.goal });
    appendExchanges(messages, turn.exchanges);
    messages.push({ role: "assistant", content: turn.summary });
  }

  messages.push({ role: "user", content: request.goal });
  appendExchanges(messages, request.toolExchanges);

  return messages;
};

/**
 * Turns one raw OpenAI tool call into the shape `ModelResponse` requires, or
 * an `invalid_tool_call` observation if it cannot.
 *
 * Pulled out of `complete` so this — the actual trust boundary, where a
 * provider's untyped string arguments become something the rest of the
 * harness trusts — can be tested without a network call. `usage` is threaded
 * through rather than attached by the caller so every return path here stays
 * a single object literal, matching `ModelResponse`'s exact shape.
 */
export const interpretToolCall = (
  toolCall: ChatCompletionMessageToolCall,
  usage: { usage: { inputTokens: number; outputTokens: number } } | Record<string, never>,
  // The message's own content, when OpenAI sent a tool call and text
  // together — the same thing Anthropic calls a text block beside a
  // tool_use. Trimmed and dropped if empty by the caller, not here, so this
  // function's every return path stays the single object literal the rest
  // of the file already relies on to match ModelResponse's exact shape.
  text?: string,
): ModelResponse => {
  if (toolCall.type !== "function") {
    return {
      type: "invalid_tool_call",
      id: toolCall.id,
      name: toolCall.custom.name,
      input: null,
      message: `Novus only supports function tool calls, not "${toolCall.type}".`,
      ...usage,
    };
  }

  let input: unknown;

  try {
    // The provider does not guarantee valid JSON here — its own types say so
    // explicitly. A throw at this point would escape the run loop before any
    // terminal event is recorded, which is exactly the failure model.ts warns
    // callers against: "the run ends with no run.failed and no receipt."
    // Returned as an observation instead, so the model sees what it produced
    // and can correct it.
    input = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    return {
      type: "invalid_tool_call",
      id: toolCall.id,
      name: toolCall.function.name,
      input: toolCall.function.arguments,
      message: `Arguments were not valid JSON: ${(error as Error).message}`,
      ...usage,
    };
  }

  const call = ToolCallSchema.safeParse({
    id: toolCall.id,
    name: toolCall.function.name,
    input,
  });

  if (!call.success) {
    return {
      type: "invalid_tool_call",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
      message: call.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
      ...usage,
    };
  }

  return {
    type: "tool_call",
    call: call.data,
    ...usage,
    ...(text ? { text } : {}),
  };
};

export class OpenAIModelAdapter implements ModelAdapter {
  readonly selection: ModelSelection;
  private readonly client: OpenAI;

  constructor(selection: ModelSelection, apiKey?: string) {
    this.selection = ModelSelectionSchema.parse(selection);

    if (this.selection.provider !== "openai") {
      throw new Error("OpenAIModelAdapter requires the openai provider.");
    }

    this.client = new OpenAI({ apiKey });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create({
      model: this.selection.model,
      messages: buildMessages(request),
      tools: openaiTools,
      tool_choice: "auto",
      // The runner executes one tool call per turn — mirrors the Anthropic
      // adapter's disable_parallel_tool_use. Without this, a response with
      // more than one tool call leaves the extra ones' ids unanswered, and
      // the *next* request is rejected by the provider for it — a failure
      // that reads as a mystery 400 far from the translation bug that caused it.
      parallel_tool_calls: false,
    });

    const message = response.choices[0]?.message;

    if (!message) {
      throw new Error("OpenAI returned no choice to read a response from.");
    }

    // Spread in rather than assigned, because ModelResponse's usage is an
    // optional field under exactOptionalPropertyTypes — `usage: undefined`
    // is not the same thing as the key being absent, and the difference is
    // exactly what tells agent-runner.ts whether to count a call as missing
    // usage or as genuinely having none to report.
    const usage = response.usage
      ? {
          usage: {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          },
        }
      : {};

    const toolCall = message.tool_calls?.[0];

    if (toolCall) {
      return interpretToolCall(toolCall, usage, (message.content ?? "").trim());
    }

    const summary = (message.content ?? "").trim();

    if (!summary) {
      throw new Error("OpenAI returned neither a tool call nor text.");
    }

    return { type: "final", summary, ...usage };
  }
}
