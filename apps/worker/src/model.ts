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

/**
 * What a router may consider when choosing a model for a turn.
 *
 * Every field here is something the harness can actually compute at the moment
 * of selection, from data it already holds. README.md lists more signals
 * routing should eventually weigh — historical success on similar work,
 * measured latency, repository and organization policy, independent evaluation
 * results — and they are deliberately NOT fields yet, because the data behind
 * them does not exist: there is no outcome store keyed by model and task, no
 * latency distribution per model (per-call model time only started being
 * recorded alongside this router), no policy store, no eval corpus. A router
 * that accepted a `historicalSuccessRate` nobody measures would be a stub
 * dressed as intelligence. When one of those stores exists, its signal is
 * added here, and this type is the seam it plugs into.
 */
export type ModelRoutingRequest = {
  goal: string;
  /**
   * Roughly how many characters of prior conversation the next model call
   * will carry: earlier goals and summaries, plus the current goal. A coarse
   * under-count — elided tool-result stubs are not included — used to
   * estimate what a call costs, never to pick a context window (the routed
   * models all share one). 0 or absent means "nothing yet".
   */
  contextChars?: number;
  /**
   * Whether this session's most recent finished run ended in run.failed.
   *
   * The one shard of "historical success" that needs no corpus: the history
   * is this session's own log. A goal submitted right after a failure is
   * usually the same problem coming back, and repeating the tier that just
   * failed is how a run fails twice at the same price.
   */
  lastRunFailed?: boolean;
  /**
   * The run's configured cost ceiling in USD, when the operator set one.
   * Null or absent means unbounded.
   */
  costBudgetUsd?: number | null;
};

/**
 * A selection plus its provenance. The reason is recorded in the session log
 * (run.progress today, and the run's own modelChoice once the contract
 * carries it), because a run whose model choice cannot be explained from the
 * log is exactly the black box this product exists to open.
 */
export type RoutedSelection = {
  selection: ModelSelection;
  /**
   * Who decided. "host" — the operator pinned a model in the environment (or
   * a fixed test/benchmark configuration did). "router" — a routing policy
   * chose. The third source, "human" (an explicit per-turn choice in the
   * composer), never comes from a router: the runner honors it before any
   * router is consulted, which is what makes "a human's choice always wins"
   * structural rather than a convention each router must remember.
   */
  source: "host" | "router";
  reason: string;
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
      /**
       * Text the provider sent alongside this tool call, if any — the
       * model narrating why before acting. Optional: most calls arrive with
       * no accompanying text, and an adapter that never populates it (the
       * scripted test adapter, say) is still a complete ModelResponse.
       */
      text?: string;
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
  /**
   * Pure and synchronous on purpose: this runs at the top of every turn, so
   * it must cost nothing and must return the same answer for the same
   * request — a selection that cannot be reproduced from its inputs cannot
   * be explained from the log either.
   */
  select(request: ModelRoutingRequest): RoutedSelection;
}

/**
 * The single-model case: NOVUS_MODEL / NOVUS_MODEL_PROVIDER pinned one model,
 * or a test or benchmark wants a known configuration. Ignores every signal by
 * design and says so in its reason.
 */
export class FixedModelRouter implements ModelRouter {
  private readonly selection: ModelSelection;
  private readonly reason: string;

  constructor(selection: ModelSelection, reason = "the host fixed this model") {
    this.selection = ModelSelectionSchema.parse(selection);
    this.reason = reason;
  }

  select(): RoutedSelection {
    return { selection: this.selection, source: "host", reason: this.reason };
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
