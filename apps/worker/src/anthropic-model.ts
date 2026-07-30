import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  ModelSelectionSchema,
  ToolCallSchema,
  type ModelSelection,
} from "@novus/contracts";

import {
  TransientModelError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ModelToolExchange,
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
 *
 * The number has to fit a real task's working set, or the window rotates: at
 * 100k, tracing this repository's own tool-call flow needed ~150k characters
 * of sources held at once, so every re-read of an elided file evicted a file
 * still in use, which invited the next re-read — 44 calls and 1.7M tokens of
 * bounded thrash without reaching an answer. 200k holds that working set
 * whole with headroom, and costs input tokens only when a run has actually
 * read that much.
 */
const VERBATIM_BUDGET_CHARS = 200_000;
const ELIDE_OVER_CHARS = 2_000;

/**
 * How much of a result too large for the whole budget is still shown.
 *
 * A result bigger than VERBATIM_BUDGET_CHARS can never be kept whole, and the
 * ordinary elision stub would be a trap for it: the stub advises calling the
 * tool again for the verbatim text, but no re-read of this result can ever
 * come back under the budget, so the model re-reads forever — the same
 * livelock as the fixed-count window, produced by one huge file instead of
 * many small ones. Real repositories have such files: lessong's
 * .cache/all.json is 567k characters, and any lockfile or bundle qualifies.
 *
 * Showing the head with an honest note lets the model act on what it can see
 * or narrow in with search_repository, instead of retrying a read that cannot
 * work.
 */
const OVERSIZE_HEAD_CHARS = 20_000;

const describeElided = (name: string, payload: string): string =>
  `[${name} result elided to save context: ${payload.length} characters. Call the tool again if you need it verbatim.]`;

const describeElidedOversize = (name: string, payload: string): string =>
  `[${name} result elided to save context: ${payload.length} characters, too large to ever show whole. Calling the tool again returns only its first ${OVERSIZE_HEAD_CHARS} characters.]`;

const oversizeHead = (name: string, payload: string): string =>
  `[${name} result is ${payload.length} characters, too large to show whole. This is its beginning; re-reading returns this same head, so to reach the rest use search_repository with this file as the path.]\n${payload.slice(0, OVERSIZE_HEAD_CHARS)}`;

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

  if (payload.length > VERBATIM_BUDGET_CHARS) {
    return elide
      ? describeElidedOversize(exchange.result.name, payload)
      : oversizeHead(exchange.result.name, payload);
  }

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

    const payloadSize = JSON.stringify(exchange.result.output).length;
    // An oversized result is shown as its head, so its head is what it costs.
    // Charging the full size would mark it non-verbatim forever — which is the
    // livelock again, since the newest exchange is the one the model just
    // asked for and must be able to see.
    const size =
      payloadSize > VERBATIM_BUDGET_CHARS ? OVERSIZE_HEAD_CHARS : payloadSize;

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
  options: { finished?: boolean } = {},
): void => {
  // A finished turn keeps nothing verbatim. The budget walk runs per call, so
  // history turns each spent their own 100k — eight finished turns resent
  // ~770k characters of results the model had already turned into a summary,
  // on every call of turn nine. The summary is what a finished turn
  // contributes; its reads stay readable again, which is what the stub says.
  // Errors are still never elided, exactly as within the live turn.
  const verbatim = options.finished ? [] : verbatimExchanges(exchanges);

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
    appendExchanges(messages, turn.exchanges, { finished: true });
    messages.push({ role: "assistant", content: turn.summary });
  }

  messages.push({ role: "user", content: request.goal });
  appendExchanges(messages, request.toolExchanges);

  return messages;
};

/**
 * What the adapter makes of a provider message.
 *
 * Exported for the same reason buildMessages is: the edge cases live here —
 * a malformed tool call, a reply cut off at the output limit — and a live
 * provider cannot be pinned to producing them on demand.
 */
export const responseFromMessage = (
  message: Pick<Anthropic.Message, "content" | "stop_reason" | "usage">,
): ModelResponse => {
  // The budget and the receipt treat tokens as what a run costs, and with
  // caching not every token costs the same: a cache read bills at a tenth of
  // a full-price token, a cache write at 1.25x. inputTokens is therefore a
  // full-price-equivalent count — the number that keeps a token ceiling
  // meaning the same spend whether or not the cache was warm, instead of
  // ending a cheap cached run at the price of an uncached one.
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
  const usage = {
    inputTokens:
      message.usage.input_tokens +
      Math.round(cacheRead / 10 + cacheWrite * 1.25),
    outputTokens: message.usage.output_tokens,
  };

  const toolUse = message.content.find((block) => block.type === "tool_use");

  // Computed once, ahead of the branch — a text block can sit alongside a
  // tool_use in the same message (the model narrating before acting) just as
  // easily as it can be the whole message (the final answer below), and both
  // branches read it the same way.
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

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

    // Spread rather than assigned: ModelResponse's text is optional under
    // exactOptionalPropertyTypes, so `text: undefined` on a silent call is
    // not the same thing as the key being absent.
    return { type: "tool_call", call: call.data, usage, ...(text ? { text } : {}) };
  }

  const summary = text;

  if (!summary) {
    throw new Error("Anthropic returned neither a tool call nor text.");
  }

  // A reply that hit the output ceiling stops mid-sentence, and without this
  // it would be recorded in run.completed as though it were the whole answer
  // — a summary that is wrong by omission, presented with full confidence.
  // The run still completes; the marker keeps the record honest about what
  // kind of answer it holds.
  if (message.stop_reason === "max_tokens") {
    return {
      type: "final",
      summary: `${summary}\n\n[This reply hit the model's output limit and is cut off here.]`,
      usage,
    };
  }

  return {
    type: "final",
    summary,
    usage,
  };
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
    let message;

    try {
      message = await this.createMessage(request);
    } catch (error) {
      // Rate limits, overload, server errors, and connection failures are the
      // provider's weather, not the run's fault. The SDK has already retried
      // these twice by the time they surface here; marking them lets the
      // runner wait longer and continue with everything it has gathered,
      // instead of losing the run. A 4xx that is not a rate limit stays fatal
      // — retrying a malformed request would loop on it.
      if (
        error instanceof Anthropic.APIConnectionError ||
        (error instanceof Anthropic.APIError &&
          typeof error.status === "number" &&
          (error.status === 429 || error.status >= 500))
      ) {
        throw new TransientModelError((error as Error).message, error);
      }

      throw error;
    }

    return responseFromMessage(message);
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];

    // Bounded twice over: a short timeout because this runs inside a tool call
    // where the wall clock is only checked between model calls, and an id cap
    // because the answer is for a model's context, not a catalogue. A failure
    // here is an ordinary tool failure — the run continues.
    // The page size matters as much as the timeout: the endpoint defaults to
    // twenty per page and the timeout is per request, so small pages could
    // stall a tool call through ten sequential fetches. Two pages at most.
    for await (const model of this.client.models.list(
      { limit: 100 },
      { timeout: 15_000 },
    )) {
      models.push(model.id);

      if (models.length >= 200) {
        break;
      }
    }

    return models;
  }

  private createMessage(request: ModelRequest) {
    return this.client.messages.create({
      // Each call's prompt is very nearly the previous call's prompt with one
      // exchange appended, so the provider can serve the shared prefix from
      // cache at a tenth of the price instead of re-reading it at full price
      // every turn. Without this, a deep trace of this repository ingested two
      // million full-price tokens in 34 calls and died on the token ceiling —
      // not stuck, just paying for the same context over and over. Elision
      // still bounds what a single call can carry; caching bounds what a run
      // pays to keep carrying it.
      cache_control: { type: "ephemeral" },
      model: this.selection.model,
      // 4k was too small for a real answer: a live summary of one cache file
      // hit it mid-sentence, ended recorded as complete, and never reached
      // the part that answered the question asked. Tool-call turns never get
      // near this; it only bounds the final explanation.
      max_tokens: 8_192,
      // Shared with every other provider adapter — see tool-descriptions.ts
      // for why, and for the citation rules this text carries.
      system: SYSTEM_PROMPT,
      tools: ANTHROPIC_TOOLS,
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
      messages: buildMessages(request),
    });
  }
}
