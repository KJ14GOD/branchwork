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

const LIST_DIRECTORY_TOOL = {
  name: "list_directory",
  description:
    "List the entries of a directory inside the selected repository. Use this to orient yourself before searching or reading.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description:
          "Repository-relative directory. Defaults to the repository root.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const GIT_STATUS_TOOL = {
  name: "git_status",
  description:
    "Show which files in the repository have been modified, staged, or left untracked. Use this to see what your own changes touched.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

const GIT_DIFF_TOOL = {
  name: "git_diff",
  description:
    "Show the current diff of the repository. Unstaged by default. Use this to read back exactly what your patches changed before you claim they are correct.",
  input_schema: {
    type: "object" as const,
    properties: {
      staged: {
        type: "boolean",
        description: "Diff staged changes instead of unstaged ones.",
      },
      path: {
        type: "string",
        description: "Optional repository-relative path to narrow the diff.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

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
      system:
        // The two citation rules exist because a live run fabricated both
        // kinds of claim, confidently: it cited server.mjs:274 for a line
        // that lives at 295 (read_file returns no line numbers, so every
        // :NNN it wrote was an estimate dressed as a citation), and it
        // declared a valid provider model id "not a real model id — would
        // 400" from stale outside knowledge. Nothing failed visibly either
        // time; the summary just said things the run had never verified.
        "You are a coding agent working in a local repository. Search the repository to discover relevant files, then read files for exact evidence. Never invent file contents. Cite line numbers only when a tool result actually showed them: search results carry line numbers, plain file reads do not, and an estimated line number presented as a citation is an invention. When a conclusion depends on knowledge from outside this repository — a provider's model names, a library's behavior, version facts — say it is unverified instead of stating it as fact. When a change is needed, call propose_patch to produce a reviewable diff, then call apply_patch with the patchId it returns to write it. After applying a change, call run_tests to confirm it works, and report what the tests actually said rather than asserting success. apply_patch, run_command, and run_tests require human approval and may be denied — if one is, explain what you would have done rather than trying to work around the denial.",
      tools: [
        SEARCH_REPOSITORY_TOOL,
        READ_FILE_TOOL,
        PROPOSE_PATCH_TOOL,
        APPLY_PATCH_TOOL,
        RUN_COMMAND_TOOL,
        RUN_TESTS_TOOL,
        LIST_DIRECTORY_TOOL,
        GIT_STATUS_TOOL,
        GIT_DIFF_TOOL,
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
      messages: buildMessages(request),
    });
  }
}
