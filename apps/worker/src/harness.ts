import type {
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessKind,
  ModelSelection,
  SessionEvent,
} from "@novus/contracts";

export type { HarnessCapabilities, HarnessDescriptor, HarnessKind };

/**
 * What executes a run.
 *
 * Novus had one agent loop for its whole life, so nothing needed this: "the
 * runner" and "the way agents work" were the same object. They are not the
 * same idea. Claude Code and Codex are complete harnesses — their own loop,
 * their own tools, their own context handling, their own permissions — and a
 * team that already uses one is not going to abandon it to use Novus.
 *
 * So the loop stops being the product. What Novus owns is the layer above it:
 * which people and which agents are on one mission, who holds control, where
 * direction goes, what changed, what was actually verified, and what gets
 * merged. This interface is the seam between the two.
 *
 * Three members, because that is exactly what `SessionRegistry` consumes
 * today — `run`, `resume`, and `AgentRunFailure` for attribution — plus the
 * two facts a caller cannot derive: which harness this is, and what it can be
 * asked to do.
 *
 * Everything a run *is* — its identity, its single terminal event, its
 * receipt, its budget — stays session-level and deliberately off this
 * interface. Those are Novus's promises, and they must hold identically no
 * matter whose loop did the work.
 */
export interface Harness {
  readonly kind: HarnessKind;
  readonly capabilities: HarnessCapabilities;

  /**
   * Identity of the thing that will run, resolved once and cached.
   *
   * Separate from `capabilities` because they are different kinds of claim: a
   * version is *discovered* by asking the binary, while capabilities are
   * *declared* by whoever wrote the adapter. A version that could not be read
   * comes back null rather than guessed.
   */
  describe(): Promise<HarnessDescriptor>;

  run(request: HarnessRunRequest): Promise<HarnessRunResult>;
  resume(request: HarnessResumeRequest): Promise<HarnessRunResult>;
}

/**
 * A request to do one unit of work under one goal.
 *
 * Field-for-field what `AgentRunner.run` already took. Deliberately: putting
 * the existing loop behind this interface has to be a type-level change with
 * no call-site edits, or the refactor is carrying a behaviour change it cannot
 * prove it did not make.
 */
export type HarnessRunRequest = {
  sessionId: string;
  actorId: string;
  goal: string;
  /** Preassigned by `fork.created`. The harness must come up under this id. */
  runId?: string | undefined;
  /**
   * A human's explicit pick for this turn. A harness that cannot honour it
   * declares `reportsModel: false` and ignores it rather than pretending.
   */
  model?: ModelSelection | undefined;
};

export type HarnessResumeRequest = {
  sessionId: string;
  actorId: string;
  runId: string;
};

/** The whole session log, re-read. Unchanged from `AgentRunResult`. */
export type HarnessRunResult = {
  runId: string;
  events: SessionEvent[];
};

/**
 * The built-in loop's declaration.
 *
 * Every field sits at its most capable value and every one of them is true
 * today. This is the row an external adapter's honesty is read against — when
 * `claude-code` declares `approvals: "harness-internal"`, the difference from
 * this line is exactly what the person using it is giving up.
 */
export const NOVUS_BUILTIN_CAPABILITIES: HarnessCapabilities = {
  pause: "boundary",
  steer: "mid-turn",
  toolVisibility: "typed",
  fileChanges: "proposed",
  approvals: "novus-mediated",
  usage: "per-call",
  cost: "reported",
  cancel: "graceful",
  reportsModel: true,
};
