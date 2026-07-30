import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime();

export const ModelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ReadFileToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("read_file"),
  input: z.object({
    path: z.string().min(1),
  }),
});

export const SearchRepositoryToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("search_repository"),
  input: z.object({
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
});

export const ProposePatchToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("propose_patch"),
  input: z.object({
    path: z.string().min(1),
    intent: z.string().min(1),
    edits: z
      .array(
        z.object({
          oldText: z.string().min(1),
          newText: z.string(),
        }),
      )
      .min(1)
      .max(20),
  }),
});

// Applying carries no edits of its own: it references a `patchId` returned by
// an earlier propose_patch call. Application is a separate, permissioned step,
// so a proposal can be reviewed (and denied) before it touches the working tree.
export const ApplyPatchToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("apply_patch"),
  input: z.object({
    patchId: IdSchema,
  }),
});

// Commands are described as a program plus an argument vector, never as a single
// string. A string would have to reach a shell to be useful, and a shell turns
// every argument the model writes into possible `;`, `&&`, `$()`, and
// redirection — an escape from the repository boundary through the one tool
// whose whole job is to run code.
export const RunCommandToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_command"),
  input: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).max(64).default([]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

export const RunTestsToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_tests"),
  input: z.object({
    args: z.array(z.string()).max(32).default([]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

export const ListDirectoryToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("list_directory"),
  input: z.object({
    path: z.string().min(1).optional(),
  }),
});

// Both Git tools are read-only reporting. They take no revision arguments and no
// pathspec beyond the repository itself, because every argument accepted here is
// an argument the model can use to ask Git about somewhere else.
export const GitStatusToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("git_status"),
  input: z.object({}),
});

export const GitDiffToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("git_diff"),
  input: z.object({
    // Unstaged by default, matching what `git diff` alone shows, because that is
    // what the agent just changed and most often wants to check.
    staged: z.boolean().optional(),
    path: z.string().min(1).optional(),
  }),
});

export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadFileToolCallSchema,
  SearchRepositoryToolCallSchema,
  ProposePatchToolCallSchema,
  ApplyPatchToolCallSchema,
  RunCommandToolCallSchema,
  RunTestsToolCallSchema,
  ListDirectoryToolCallSchema,
  GitStatusToolCallSchema,
  GitDiffToolCallSchema,
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ReadFileToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("read_file"),
  output: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
});

export const SearchRepositoryToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("search_repository"),
  output: z.object({
    query: z.string().min(1),
    matches: z.array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        text: z.string(),
      }),
    ),
  }),
});

// A proposal is a preview only. `status` stays "proposed" until a separate,
// permissioned application step writes it to the working tree.
export const ProposePatchToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("propose_patch"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    intent: z.string().min(1),
    status: z.literal("proposed"),
    diff: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export const ApplyPatchToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("apply_patch"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    status: z.literal("applied"),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

// Both execution tools report the same shape, because the model needs the same
// evidence either way: what ran, how it ended, and what it said. `exitCode` is
// null when a signal ended the process — a timeout kill is not exit 0, and
// collapsing the two would let a killed command read as a clean one.
const CommandOutcomeSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  // Output is capped so one runaway command cannot exhaust the model's context.
  truncated: z.boolean(),
});

export const RunCommandToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_command"),
  output: CommandOutcomeSchema,
});

export const RunTestsToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_tests"),
  output: CommandOutcomeSchema.extend({
    // Stated explicitly rather than left for the model to infer from exitCode,
    // because "did my change work" is the entire question this tool exists for.
    passed: z.boolean(),
  }),
});

export const ListDirectoryToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("list_directory"),
  output: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(["file", "directory", "symlink", "other"]),
      }),
    ),
    truncated: z.boolean(),
  }),
});

export const GitStatusToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("git_status"),
  output: z.object({
    branch: z.string().min(1).nullable(),
    // Null rather than false when the check could not run, so an unreadable
    // repository never reports as a clean one.
    clean: z.boolean().nullable(),
    files: z.array(
      z.object({
        path: z.string().min(1),
        status: z.string().min(1),
        staged: z.boolean(),
      }),
    ),
  }),
});

export const GitDiffToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("git_diff"),
  output: z.object({
    staged: z.boolean(),
    diff: z.string(),
    filesChanged: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

export const ToolResultSchema = z.discriminatedUnion("name", [
  ReadFileToolResultSchema,
  SearchRepositoryToolResultSchema,
  ProposePatchToolResultSchema,
  ApplyPatchToolResultSchema,
  RunCommandToolResultSchema,
  RunTestsToolResultSchema,
  ListDirectoryToolResultSchema,
  GitStatusToolResultSchema,
  GitDiffToolResultSchema,
]);

export type ToolResult = z.infer<typeof ToolResultSchema>;

// session
export const SessionSchema = z.object({
  id: IdSchema,
  repositoryPath: z.string().min(1),
  /**
   * Null until a run gives it one.
   *
   * This was a required string, which quietly asserted that a session is
   * created *for* a goal. It is not: a session is a repository somebody opened,
   * and goals arrive per run — several of them, over a session that outlives
   * each. Requiring one here is why `session.created` was never emitted at all,
   * and why nothing could be restored from the log afterwards.
   */
  goal: z.string().min(1).nullable(),
  status: z.enum(["active", "paused", "completed"]),
  createdAt: TimestampSchema,
});

export type Session = z.infer<typeof SessionSchema>;

// a human or agent
export const ParticipantSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  name: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  role: z.enum(["owner", "editor", "reviewer", "viewer"]),
  joinedAt: TimestampSchema,
});

export type Participant = z.infer<typeof ParticipantSchema>;

// one agent execution
export const RunSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  goal: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "waiting_for_human",
    "completed",
    "failed",
    "cancelled",
  ]),
  startedBy: IdSchema,
  model: ModelSelectionSchema,
  createdAt: TimestampSchema,
});

export type Run = z.infer<typeof RunSchema>;

/**
 * Everything a fork needs to start where its parent stood.
 *
 * A checkpoint is not a snapshot of the working directory — copying a tree is
 * slow, unreviewable, and says nothing about what the agent was doing. It is
 * the smaller set of facts from which the starting state can be reconstructed
 * in a fresh worktree: a commit to check out, the uncommitted work as a patch,
 * and the intent the run was carrying at that moment.
 *
 * It is deliberately a value, not a handle. Two forks from one checkpoint must
 * start from the same thing, and that is only guaranteed if the checkpoint
 * cannot change under them after it was taken.
 */
export const CheckpointSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** The run being checkpointed, and how much of its history this covers. */
  parentRunId: IdSchema,
  // The parent's event sequence at the moment of capture. A fork's divergence
  // is only meaningful against a stated point in the parent's history, and
  // "the latest event" is not a point — it moves while the fork is being made.
  parentSequence: z.number().int().nonnegative(),
  base: z.object({
    // Not nullable, unlike a receipt's base. A receipt describes a run that
    // already happened and can honestly say the revision was unknown; a fork
    // has to check something out, so a repository with no commit cannot be
    // forked from at all and must be refused when the checkpoint is taken.
    // An object id, not a name. `z.string().min(1)` admitted "main", and a
    // checkpoint naming a branch is not a checkpoint: the parent commits once
    // and the fork checks out somewhere else entirely, while the event log
    // records the literal word "main" as the revision it started from. The
    // immutability this whole schema exists to provide was one string away
    // from being a lie.
    revision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, {
      message: "A checkpoint base must be a full commit object id, not a ref name.",
    }),
    // Uncommitted work at capture time, as a patch that applies to `revision`,
    // including files the agent created but never added — an agent writing a
    // new file is the ordinary case, and a fork that silently lacked it started
    // somewhere other than where the checkpoint said. Null when the tree was
    // genuinely clean. This is what makes the base
    // immutable: the parent may commit, amend, or discard afterwards and the
    // fork still starts from the state that was actually checkpointed.
    patch: z.string().min(1).nullable(),
  }),
  /** What the agent had established so far, in its own words. */
  agentState: z.string().min(1),
  // Repository-relative paths that were in front of the model. Carried so a
  // fork inherits the parent's attention rather than rediscovering it, and so
  // a reviewer can see what each attempt was looking at when they diverged.
  contextManifest: z.array(z.string().min(1)),
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  model: ModelSelectionSchema,
  // The parent's permissions, not the host's defaults. A fork is a continuation
  // of a run someone already authorised; re-deriving the policy from the host
  // would let a fork be more permissive than the run it came from.
  toolPolicy: z.object({
    allowWrites: z.boolean(),
    allowCommands: z.boolean(),
  }),
  // Null means unbounded, which is V1's actual behaviour. Zero would claim a
  // limit that is not enforced anywhere, and a budget that lies about being
  // exhausted is worse than one that admits it is not counting.
  budget: z.object({
    remainingModelCalls: z.number().int().nonnegative().nullable(),
    remainingTokens: z.number().int().nonnegative().nullable(),
  }),
  createdAt: TimestampSchema,
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * One isolated attempt started from a checkpoint.
 *
 * The fork is identified by its run id rather than carrying an id of its own.
 * V1 gives every fork a unique run id, and every other event in the log is
 * already keyed by `runId`, so a separate fork id would be a second name for
 * the same thing — and two names for one entity is how a log stops joining up.
 *
 * `sessionId` is the *parent* session. A fork gets its own event stream, not
 * its own session: the whole point is that both attempts are observable side
 * by side under the session the human is already watching.
 */
export const ForkSchema = z.object({
  runId: IdSchema,
  sessionId: IdSchema,
  checkpointId: IdSchema,
  parentRunId: IdSchema,
  /** How a human tells two attempts apart before there is any evidence. */
  label: z.string().min(1),
  // Absolute, and outside the selected repository. Forks never write to the
  // same working directory, so this is the field that has to be distinct for
  // the isolation claim to mean anything.
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  /** The commit the worktree was created at — the checkpoint's base. */
  revision: z.string().min(1),
  // Development ports are exclusive to this fork for as long as it lives. Two
  // attempts running the same project's dev server would otherwise collide on
  // a port and the second one would look like a failed attempt.
  devPorts: z.array(z.number().int().min(1).max(65_535)).min(1),
  createdAt: TimestampSchema,
});

export type Fork = z.infer<typeof ForkSchema>;

/**
 * What a finished run proves about itself.
 *
 * Assembled from the event log rather than accumulated alongside it, so the
 * receipt cannot claim anything the ordered history does not already contain.
 * If the two ever disagree, the events are right and the receipt is a bug.
 *
 * Cost in currency is deliberately absent. Token counts are exact and come from
 * the provider; a price per token is a table that goes stale, and a stale number
 * inside a document whose whole purpose is evidence is worse than no number.
 * Cost belongs with routing, which V1 defers.
 */
export const RunReceiptSchema = z.object({
  runId: IdSchema,
  sessionId: IdSchema,
  goal: z.string().min(1),
  model: ModelSelectionSchema,
  status: z.enum(["completed", "failed"]),
  // Read at the start of *this run*, not once per session: a second turn opens
  // on top of the first turn's writes, so a session-wide revision would name a
  // base that no longer describes what the run started from.
  base: z.object({
    revision: z.string().min(1).nullable(),
    // A revision alone claims more reproducibility than it can deliver. An
    // uncommitted tree means the base is that commit *plus* changes nobody
    // recorded, and a reviewer has to know which of the two they are looking at.
    //
    // Null when it could not be determined. `false` has to mean "checked, and
    // clean" — reporting a failed check as clean would make the maximally dirty
    // repository, the one whose status output was too large to read, look like
    // the tidiest.
    dirty: z.boolean().nullable(),
  }),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  elapsedMs: z.number().int().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    // Calls whose adapter reported nothing. When this is above zero the totals
    // are a floor, not a count, and anything displaying them has to say so
    // rather than print a confident number that is quietly short.
    //
    // Provider-side retries are invisible here for the same reason: the SDK
    // reports usage for the response it finally returned, not for the attempts
    // it made, so a retried call under-reports against what was billed.
    callsMissingUsage: z.number().int().nonnegative(),
  }),
  toolCalls: z.array(
    z.object({
      toolCallId: IdSchema,
      name: z.string().min(1),
      outcome: z.enum(["completed", "failed", "denied"]),
    }),
  ),
  // One entry per file, not per patch. Two patches to the same file are one
  // changed file, and counting them twice inflates the headline number that is
  // the first thing anyone reads.
  //
  // Covers apply_patch only. A run that writes through run_command — codegen, a
  // formatter, `sed -i` — changed files that are not listed here, and the event
  // log records the command rather than its effect. Closing that gap needs a
  // diff against `base` at the end of the run, which is Milestone 4 work; until
  // then this is the set of *patched* files, not the set of changed ones.
  //
  // additions and deletions are summed across patches to the same file, so a
  // later patch rewriting lines an earlier one added is counted in both. The
  // `patches` count sits beside them so the numbers cannot be mistaken for a
  // net diff against base.
  filesChanged: z.array(
    z.object({
      path: z.string().min(1),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      patches: z.number().int().positive(),
      /** Sequence of the last patch to this file, so order stays recoverable. */
      sequence: z.number().int().nonnegative(),
    }),
  ),
  tests: z.array(
    z.object({
      command: z.string().min(1),
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Whether the last test run happened after the last file change.
   *
   * A green suite that ran *before* the final edit says nothing about the diff
   * this receipt is attached to, and the flat lists above cannot show that on
   * their own. Null when the run has no tests or no changes, where the question
   * does not arise.
   *
   * Inherits the limit above: it compares against the last *patch*, so a file
   * written by run_command after the tests ran will not make this false.
   */
  testsFollowedFinalChange: z.boolean().nullable(),
  approvals: z.array(
    z.object({
      toolCallId: IdSchema,
      decision: z.enum(["approved", "denied"]),
      actorId: IdSchema,
      reason: z.string().min(1).optional(),
    }),
  ),
  // Present on completion; absent when the run failed, where `failure` explains.
  summary: z.string().min(1).optional(),
  failure: z.string().min(1).optional(),
});

export type RunReceipt = z.infer<typeof RunReceiptSchema>;

const EventEnvelopeSchema = z.object({
  eventId: IdSchema,
  sessionId: IdSchema,
  sequence: z.number().int().nonnegative(),
  actorId: IdSchema,
  occurredAt: TimestampSchema,
});

export const SessionCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("session.created"),
  payload: z.object({
    session: SessionSchema,
  }),
});

export const RunStartedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.started"),
  payload: z.object({
    run: RunSchema,
  }),
});

export const RunProgressEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.progress"),
  payload: z.object({
    runId: IdSchema,
    message: z.string().min(1),
  }),
});

/**
 * Who is in the session, and what they may do.
 *
 * A role is carried on the participant rather than checked at the call site,
 * because "only the owner may hand over control" has to be answerable from the
 * event log after the fact. A decision nobody can reconstruct is not a decision
 * anyone can review.
 */
export const ParticipantJoinedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("participant.joined"),
  payload: z.object({
    participant: ParticipantSchema,
  }),
});

export const ParticipantLeftEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("participant.left"),
  payload: z.object({
    participantId: IdSchema,
    // Distinguishes a tab closing from someone deliberately leaving. Presence
    // that cannot tell those apart makes a flaky network look like a departure.
    reason: z.enum(["disconnected", "left", "removed"]),
  }),
});

/**
 * Control is requested and granted, never taken.
 *
 * V1: only one authority controls a run at a time, and other participants
 * submit direction rather than acting. Both halves are events so the timeline
 * shows who asked and who agreed, which is the part a reviewer needs later.
 */
export const ControlRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.requested"),
  payload: z.object({
    participantId: IdSchema,
    reason: z.string().min(1).optional(),
  }),
});

export const ControlTransferredEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.transferred"),
  payload: z.object({
    fromParticipantId: IdSchema,
    toParticipantId: IdSchema,
    // Accepted, because a handoff the recipient did not take is not a handoff —
    // it is a run nobody is holding.
    acceptedAt: TimestampSchema,
  }),
});

/**
 * Direction is queued, then applied at a boundary the runtime chooses.
 *
 * Submitted and applied are two events on purpose. A human needs to see that
 * their words were received *before* they take effect, and the gap between the
 * two is exactly the window V1 describes: the runtime finishes or cancels the
 * current atomic tool action first, so direction never lands mid-call.
 */
export const DirectionAppliedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("direction.applied"),
  payload: z.object({
    runId: IdSchema,
    directionEventId: IdSchema,
    direction: z.string().min(1),
  }),
});

export const DirectionSubmittedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("direction.submitted"),
  payload: z.object({
    runId: IdSchema,
    direction: z.string().min(1),
  }),
});

export const RunCompletedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.completed"),
  payload: z.object({
    runId: IdSchema,
    summary: z.string().min(1),
  }),
});

export const ToolRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.requested"),
  payload: z.object({
    runId: IdSchema,
    call: ToolCallSchema,
  }),
});

export const ToolCompletedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.completed"),
  payload: z.object({
    runId: IdSchema,
    result: ToolResultSchema,
  }),
});

// Write and dangerous tool calls cross an approval boundary before they run.
// The request and its resolution are both recorded, so a receipt can show who
// authorised every consequential action.
export const ToolApprovalRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.approval_requested"),
  payload: z.object({
    runId: IdSchema,
    call: ToolCallSchema,
    toolClass: z.enum(["write", "dangerous"]),
  }),
});

export const ToolApprovedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.approved"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    approvedBy: IdSchema,
  }),
});

export const ToolDeniedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.denied"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    deniedBy: IdSchema,
    reason: z.string().min(1),
  }),
});

// A tool that rejects is an observation, not the end of the run: the message
// is returned to the model so it can correct the call.
export const ToolFailedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("tool.failed"),
  payload: z.object({
    runId: IdSchema,
    toolCallId: IdSchema,
    name: z.string().min(1),
    message: z.string().min(1),
  }),
});

// Emitted once per run, after run.completed or run.failed, so the receipt can
// summarise the terminal event too.
export const ReceiptCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("receipt.created"),
  payload: z.object({
    runId: IdSchema,
    receipt: RunReceiptSchema,
  }),
});

// Recorded before any fork exists, and separately from it. A checkpoint that
// no fork was ever made from is still evidence — it is the point a human chose
// to mark — and folding it into fork.created would lose every checkpoint that
// was taken and not used.
export const CheckpointCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("checkpoint.created"),
  payload: z.object({
    checkpoint: CheckpointSchema,
  }),
});

// The fork's own run emits run.started under its own runId immediately after
// this. This event is the parent's record of having branched; that one is the
// child's record of having begun.
export const ForkCreatedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("fork.created"),
  payload: z.object({
    fork: ForkSchema,
  }),
});

export const RunFailedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.failed"),
  payload: z.object({
    runId: IdSchema,
    reason: z.string().min(1),
  }),
});

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  RunStartedEventSchema,
  RunProgressEventSchema,
  DirectionSubmittedEventSchema,
  DirectionAppliedEventSchema,
  ParticipantJoinedEventSchema,
  ParticipantLeftEventSchema,
  ControlRequestedEventSchema,
  ControlTransferredEventSchema,
  ToolRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovedEventSchema,
  ToolDeniedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  ReceiptCreatedEventSchema,
  CheckpointCreatedEventSchema,
  ForkCreatedEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const SessionEventDraftSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunStartedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunProgressEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  DirectionSubmittedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  DirectionAppliedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ParticipantJoinedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ParticipantLeftEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ControlRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ControlTransferredEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolApprovalRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolApprovedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolDeniedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolCompletedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ToolFailedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunCompletedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunFailedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ReceiptCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  CheckpointCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ForkCreatedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
]);

export type SessionEventDraft = z.infer<typeof SessionEventDraftSchema>;
