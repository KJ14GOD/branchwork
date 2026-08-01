import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime();

export const ModelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/* ============================================================
   Harnesses
   ============================================================
 *
 * A *model* is the intelligence. A *harness* is the whole program around it —
 * its own loop, its own tools, its own context handling, its own permissions.
 * Claude Code is a harness that runs Claude models. Novus has one of its own,
 * and for most of this repository's life it was the only way an agent ran, so
 * "a run" and "the harness" were the same thing and neither needed a name.
 *
 * They are not the same thing. Novus's job is the layer above: which people
 * and which agents are on one mission, who holds control, what changed, and
 * what was actually verified. The loop inside any one agent belongs to
 * whoever wrote it.
 */

/**
 * Which harness executed a run.
 *
 * A closed enum rather than a free string, so adding one is a compile error at
 * every exhaustive switch instead of a row nobody renders. `external` is the
 * operator-configured escape hatch; the descriptor's `id` says what actually
 * ran.
 */
export const HarnessKindSchema = z.enum([
  "novus-builtin",
  "claude-code",
  "codex",
  "external",
]);

export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/**
 * What a harness declares it can do — never what Novus wishes it could.
 *
 * Every field defaults to its LEAST capable value. An adapter whose author
 * forgets one gets a harness Novus will not try to pause, will not offer
 * steering for, and will not credit with having reported anything. That
 * direction is deliberate: the failure mode of a forgotten field has to be a
 * disabled button, never a Pause that silently does nothing. To the person
 * pressing it, silence and success look identical, and that is the whole
 * reason these are declared rather than assumed.
 */
export const HarnessCapabilitiesSchema = z.object({
  /**
   * `boundary` suspends and resumes carrying state. `immediate` stops now and
   * loses it. `none` cannot be paused at all — killing is not pausing.
   */
  pause: z.enum(["none", "boundary", "immediate"]).default("none"),
  /**
   * Where a human's direction can land. `mid-turn` is the built-in loop's
   * promise: folded into a live run at its next safe boundary. `next-run`
   * means the words are kept and become the next thing asked — a weaker
   * promise, and one that must never be dressed as the stronger one.
   */
  steer: z
    .enum(["none", "next-run", "between-turns", "mid-turn"])
    .default("none"),
  /**
   * Only `typed` may emit `tool.requested` / `tool.completed`. Those carry
   * Novus's own tool union, whose `apply_patch` arm means "this crossed the
   * approval gate". A harness whose tool names are its own gets the
   * `harness.activity` family instead, which promises nothing about review.
   */
  toolVisibility: z.enum(["none", "named", "typed"]).default("none"),
  /**
   * `proposed` means writes cross a review gate before they land. `reported`
   * means the harness says what it touched. `observed` means Novus finds out
   * by diffing afterwards. Only `proposed` supports propose-then-approve, and
   * only Novus's own loop offers it.
   */
  fileChanges: z
    .enum(["none", "observed", "reported", "proposed"])
    .default("none"),
  approvals: z
    .enum(["none", "harness-internal", "novus-mediated"])
    .default("none"),
  usage: z.enum(["none", "totals", "per-call"]).default("none"),
  cost: z.enum(["none", "reported"]).default("none"),
  /** `graceful` stops at a turn boundary. `kill` sends a signal. */
  cancel: z.enum(["kill", "graceful"]).default("kill"),
  reportsModel: z.boolean().default(false),
});

export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;

/**
 * Which harness ran, and what it could do while it did.
 *
 * `version` is discovered by asking the binary; `capabilities` are declared by
 * the adapter's author. Separate fields because they are different kinds of
 * claim — and a version that could not be read is null rather than guessed.
 */
export const HarnessDescriptorSchema = z.object({
  kind: HarnessKindSchema,
  /** The adapter's stable id, distinct from the version that ran. */
  id: z.string().min(1),
  version: z.string().min(1).nullable(),
  /** The program, never a shell line. Null for the in-process loop. */
  command: z.string().min(1).nullable(),
  capabilities: HarnessCapabilitiesSchema,
});

export type HarnessDescriptor = z.infer<typeof HarnessDescriptorSchema>;

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

// Creating a file goes through the same propose-then-apply flow as editing one,
// not through a separate unreviewed write path. Until this existed the agent
// literally could not create a file: propose_patch requires a path that is
// already a file, so "write a new module" was only reachable by contorting
// run_command — a dangerous-class tool producing an unreviewable write. The
// content arrives whole rather than as edits because there is nothing to edit
// yet; the reviewable diff is the entire file.
export const ProposeNewFileToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("propose_new_file"),
  input: z.object({
    path: z.string().min(1),
    intent: z.string().min(1),
    // Empty allowed: an empty marker file is a legitimate thing to create, and
    // refusing it would push exactly that case back out to run_command.
    content: z.string(),
    /**
     * Replace a file that already exists, rather than only creating one.
     *
     * Absent or false, an existing path is refused — creating a file is a
     * different intention from rewriting one, and a model that mistyped a
     * path should not silently flatten something. True is the model saying
     * it means to replace the whole file, which is an ordinary operation
     * that had no tool at all: `propose_patch` needs exact `oldText` to
     * match against, so a full rewrite meant reproducing the entire current
     * file byte-perfect just to say "replace all of this".
     *
     * The apply step still refuses if the file changed after the proposal
     * was made — an overwrite records what it was replacing, exactly like
     * an edit does.
     */
    overwrite: z.boolean().optional(),
  }),
});

// Deletion is proposed, not performed — the same two-step flow as every other
// write, because removing a file is as much a change to review as editing one.
// The proposal captures the file's content at proposal time so the apply step
// can refuse if the file changed in between, exactly like an edit's drift check.
export const ProposeDeletionToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("propose_deletion"),
  input: z.object({
    path: z.string().min(1),
    intent: z.string().min(1),
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

// Builds run the way tests do: the project's own script, selected by the
// project rather than composed by the model. run_command could reach the same
// script, but "did the project still build" deserves a structured yes/no the
// same way "did the tests pass" does.
export const RunBuildToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_build"),
  input: z.object({
    args: z.array(z.string()).max(32).default([]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

// Diagnostics take a kind, not a command. The project declares how its types
// and lint are checked; the model choosing the checker for itself could report
// a clean run it selected for being clean — the same reasoning run_tests
// already wrote down. No args at all: a diagnostic pass is over the whole
// project by definition, and every accepted argument would be an argument for
// steering the checker somewhere narrower than the claim being made.
export const RunDiagnosticsToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("run_diagnostics"),
  input: z.object({
    kind: z.enum(["typecheck", "lint"]),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }),
});

// A development server is the one process that is *supposed* to outlive the
// tool call — run_command's contract (start, watch, kill on timeout) is exactly
// wrong for it. The input is a discriminated union because the four actions
// share almost nothing: starting takes a program vector, the rest take at most
// a server id minted by a previous start.
export const DevServerToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("dev_server"),
  input: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("start"),
      // A program plus argv, never a shell line — same rule and same reasoning
      // as run_command.
      command: z.string().min(1),
      args: z.array(z.string()).max(64).default([]),
      // Optional: unset, Novus allocates a free port and hands it to the child
      // as PORT. Set, the tool refuses rather than fights if it is taken.
      port: z.number().int().min(1_024).max(65_535).optional(),
      // How long to wait for the port to answer before reporting the server as
      // still starting. Short by default: this holds up the agent loop.
      readyTimeoutMs: z.number().int().min(500).max(60_000).optional(),
    }),
    z.object({
      action: z.literal("stop"),
      serverId: IdSchema,
    }),
    z.object({
      action: z.literal("status"),
    }),
    z.object({
      action: z.literal("logs"),
      serverId: IdSchema,
    }),
  ]),
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

// Read-only like git_status and git_diff, and zero-argument for the same
// written-down reason those are: every revision or pathspec accepted here is a
// way to ask Git about somewhere other than the selected repository. It
// reports branches and worktrees — which exist, which is checked out — and
// changes nothing.
export const GitBranchesToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("git_branches"),
  input: z.object({}),
});

// The one tool that answers a question about the world outside the repository,
// and deliberately the narrowest possible one. A live run read a valid provider
// model id out of a repository and confidently called it a typo that "would
// 400" — a claim nothing in its tool set could check, because its training
// data predated the model. It takes no arguments at all: every argument
// accepted here would be an argument for asking the provider about something
// else.
export const ListProviderModelsToolCallSchema = z.object({
  id: IdSchema,
  name: z.literal("list_provider_models"),
  input: z.object({}),
});

export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadFileToolCallSchema,
  SearchRepositoryToolCallSchema,
  ProposePatchToolCallSchema,
  ProposeNewFileToolCallSchema,
  ProposeDeletionToolCallSchema,
  ApplyPatchToolCallSchema,
  RunCommandToolCallSchema,
  RunTestsToolCallSchema,
  RunBuildToolCallSchema,
  RunDiagnosticsToolCallSchema,
  DevServerToolCallSchema,
  ListDirectoryToolCallSchema,
  GitStatusToolCallSchema,
  GitDiffToolCallSchema,
  GitBranchesToolCallSchema,
  ListProviderModelsToolCallSchema,
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

// The same result shape as propose_patch on purpose: to a reviewer, "create
// this file" is a proposal with a diff whose every line is an addition, and
// the apply step that follows is the same apply_patch either way. The kind is
// not repeated in the payload because the result's own name already states it.
export const ProposeNewFileToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("propose_new_file"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    intent: z.string().min(1),
    status: z.literal("proposed"),
    // May be empty: creating an empty file is a change with no diff lines.
    diff: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export const ProposeDeletionToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("propose_deletion"),
  output: z.object({
    patchId: IdSchema,
    path: z.string().min(1),
    intent: z.string().min(1),
    status: z.literal("proposed"),
    // May be empty: deleting an already-empty file is a change with no lines.
    diff: z.string(),
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

export const RunBuildToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_build"),
  output: CommandOutcomeSchema.extend({
    // run_tests's `passed`, under the name a build earns. Same reason it is
    // explicit: "does it still build" is the entire question.
    succeeded: z.boolean(),
  }),
});

/**
 * One problem a checker reported, as data the model can act on.
 *
 * The alternative — handing back the checker's stdout — makes the model parse
 * a wall of text that every checker formats differently, and gives the UI
 * nothing to render but the wall. Path, line, and column are each nullable
 * because not every reported problem has a location (a tsconfig error names
 * no file at all), and inventing one would be a fabricated citation — the
 * exact failure the system prompt already forbids in the model's own words.
 */
const DiagnosticSchema = z.object({
  path: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  // "TS2322", an eslint rule id, or null when the checker named none.
  code: z.string().min(1).nullable(),
});

export const RunDiagnosticsToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("run_diagnostics"),
  output: z.object({
    kind: z.enum(["typecheck", "lint"]),
    command: z.string().min(1),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    // Exit 0 and not killed. Reported beside the diagnostics rather than
    // inferred from them, because a checker can fail with output the parser
    // did not recognise — zero parsed diagnostics must never read as clean.
    ok: z.boolean(),
    diagnostics: z.array(DiagnosticSchema),
    // Capped so one broken refactor cannot fill the model's context with ten
    // thousand identical errors.
    diagnosticsTruncated: z.boolean(),
    // The checker's own words, tail-capped. Kept because the parser is
    // best-effort over formats nobody standardised: when it recognises
    // nothing, this is the only evidence there is.
    raw: z.string(),
    rawTruncated: z.boolean(),
  }),
});

export const DevServerToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("dev_server"),
  output: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("start"),
      serverId: IdSchema,
      command: z.string().min(1),
      // Always present: allocated by Novus (and handed to the child as PORT)
      // or requested by the caller. `state` says whether anything answers on
      // it — a server is free to ignore PORT, and claiming it listened there
      // without checking would be an invented fact.
      port: z.number().int().min(1).max(65_535),
      pid: z.number().int().positive().nullable(),
      // listening: the port accepted a connection. starting: the process is
      // alive but the port has not answered yet — reported honestly rather
      // than waited on forever, because this holds up the agent loop.
      // exited: the process died before the wait ran out; a failed start.
      state: z.enum(["listening", "starting", "exited"]),
      exitCode: z.number().int().nullable(),
      // What the server printed while starting, tail-capped — the evidence
      // for *why* when state is "exited".
      logs: z.string(),
    }),
    z.object({
      action: z.literal("stop"),
      serverId: IdSchema,
      // False when the process was already gone: stopping a dead server is
      // not an error, but reporting it as a kill would claim an action that
      // never happened.
      stopped: z.boolean(),
    }),
    z.object({
      action: z.literal("status"),
      servers: z.array(
        z.object({
          serverId: IdSchema,
          command: z.string().min(1),
          port: z.number().int().min(1).max(65_535),
          pid: z.number().int().positive().nullable(),
          state: z.enum(["listening", "starting", "exited"]),
          uptimeMs: z.number().int().nonnegative(),
        }),
      ),
    }),
    z.object({
      action: z.literal("logs"),
      serverId: IdSchema,
      // Repeated here, not only on start, so anything deciding what these
      // logs are — redaction's dotenv rule, most concretely — can see the
      // command that produced them without holding state across events.
      command: z.string().min(1),
      logs: z.string(),
      truncated: z.boolean(),
    }),
  ]),
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

export const GitBranchesToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("git_branches"),
  output: z.object({
    // Null on a detached HEAD, which is a real state the agent needs to see —
    // inventing a branch name for it would misreport where commits will land.
    current: z.string().min(1).nullable(),
    branches: z.array(
      z.object({
        name: z.string().min(1),
        isCurrent: z.boolean(),
        revision: z.string().min(1),
        // The tip commit's subject line, so two similarly named branches can
        // be told apart without another tool call. May be empty: an empty
        // commit message is unusual but not invalid.
        subject: z.string(),
        // "origin/main" when the branch tracks one, null when it tracks
        // nothing — most local work branches do not.
        upstream: z.string().min(1).nullable(),
      }),
    ),
    worktrees: z.array(
      z.object({
        path: z.string().min(1),
        // Null for a detached worktree.
        branch: z.string().min(1).nullable(),
        revision: z.string().min(1),
        // Whether this entry is the selected repository itself, so the model
        // can tell "the checkout I am in" from a sibling attempt.
        isCurrent: z.boolean(),
      }),
    ),
    truncated: z.boolean(),
  }),
});

export const ListProviderModelsToolResultSchema = z.object({
  toolCallId: IdSchema,
  name: z.literal("list_provider_models"),
  output: z.object({
    provider: z.string().min(1),
    models: z.array(z.string().min(1)),
  }),
});

export const ToolResultSchema = z.discriminatedUnion("name", [
  ReadFileToolResultSchema,
  SearchRepositoryToolResultSchema,
  ProposePatchToolResultSchema,
  ProposeNewFileToolResultSchema,
  ProposeDeletionToolResultSchema,
  ApplyPatchToolResultSchema,
  RunCommandToolResultSchema,
  RunTestsToolResultSchema,
  RunBuildToolResultSchema,
  RunDiagnosticsToolResultSchema,
  DevServerToolResultSchema,
  ListDirectoryToolResultSchema,
  GitStatusToolResultSchema,
  GitDiffToolResultSchema,
  GitBranchesToolResultSchema,
  ListProviderModelsToolResultSchema,
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
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  startedBy: IdSchema,
  model: ModelSelectionSchema,
  /**
   * Which harness ran this.
   *
   * Optional because absent is not a missing value — it is the fact about
   * every run recorded before harnesses had names: they all went through the
   * built-in loop. A required field would have rewritten history.
   */
  harness: HarnessDescriptorSchema.optional(),
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
/**
 * What a run has consumed so far.
 *
 * Named rather than written inline in the receipt because `run.paused` carries
 * it too. A budget accumulates in memory and that memory dies with the
 * process, so a paused run that resumed came back believing it had spent
 * nothing — and could spend its whole ceiling again on every resume. The
 * receipt is written when a run *ends*, which is exactly the case a paused run
 * is not, so the pause event is the only place this survives.
 */
export const RunUsageSchema = z.object({
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
  /**
   * What this run cost, in US dollars, when every model it called had a
   * published rate.
   *
   * Null rather than zero when any call's model was unpriced — a run
   * reported as costing $0.00 because nobody had a rate for its model is
   * a worse answer than one that says it does not know. README asks a run
   * to record cost per call; this is the total those calls add up to.
   */
  costUsd: z
    .number()
    .nonnegative()
    .nullable()
    // Null on receipts written before cost was recorded, which is the same
    // value it takes for an unpriced model: "not counted". Never zero — a run
    // reported as free because nobody counted is a worse answer than one that
    // says it does not know.
    .default(null),
  /**
   * Time spent inside model calls, as distinct from the run's wall clock.
   * The gap between the two is what the harness itself spent — tools,
   * approvals, waiting on a human.
   */
  modelTimeMs: z
    .number()
    .int()
    .nonnegative()
    // Zero on receipts written before this was measured. Unlike cost, this is
    // a secondary figure nothing is decided on, so a missing measurement
    // reading as none is acceptable where a missing *price* would not be.
    .default(0),
});

export type RunUsage = z.infer<typeof RunUsageSchema>;

export const RunReceiptSchema = z.object({
  runId: IdSchema,
  sessionId: IdSchema,
  goal: z.string().min(1),
  model: ModelSelectionSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
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
  usage: RunUsageSchema,
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
  testsFollowedFinalChange: z
    .boolean()
    .nullable()
    // Null on receipts written before this existed, which is the same value
    // it takes when the question does not arise — no tests, or no changes.
    // A receipt that never recorded the ordering cannot answer it either.
    .default(null),
  /**
   * Every check the run actually ran, of every kind, in the order it ran them.
   *
   * `tests` above is the same data for `run_tests` alone, and it stays because
   * things already read it. It was also the receipt's *only* verification
   * signal, which meant a run that typechecked clean and built green produced
   * a receipt indistinguishable from one that never checked anything — the
   * evidence was in the log and thrown away on the way to the artifact people
   * trust when they were not watching.
   *
   * `problems` is the count of structured diagnostics a checker reported, or
   * null for a check that does not report any. It never substitutes for
   * `passed`: a checker can fail with output the parser did not recognise, so
   * zero problems must never be read as clean.
   */
  checks: z.array(
    z.object({
      kind: z.enum(["tests", "build", "typecheck", "lint"]),
      command: z.string().min(1),
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      problems: z.number().int().nonnegative().nullable(),
      sequence: z.number().int().nonnegative(),
    }),
  )
    // Defaulted, because the log is durable and this field is not as old as
    // it is. Every receipt written before checks existed has none, and a
    // required field made those sessions unreadable — the error surfaced as a
    // Zod failure when simply opening one. An empty list is the honest
    // reading: that run recorded no structured checks.
    .default([]),
  /**
   * What the checks say about the changes — never what the agent says about
   * itself.
   *
   * A run's `status` answers "did the loop finish". This answers "is there
   * evidence it worked", and the two are independent: the most dangerous
   * receipt in the system is a completed run with no checks, because every
   * surface that renders completion as green is then reporting an unverified
   * diff as a good one.
   *
   * - `verified` — at least one check ran, all of them passed, and the last
   *   one ran after the last change.
   * - `failing` — a check ran and did not pass. Beats `unverified`, because a
   *   known failure is a stronger fact than a missing one.
   * - `unverified` — nothing ran, or everything that ran did so *before* the
   *   final change. Stale-and-green is not verified: a suite that passed
   *   before the last edit says nothing about the diff this receipt is
   *   attached to.
   *
   * There is deliberately no fourth value meaning "probably fine".
   */
  verification: z
    .enum(["verified", "failing", "unverified"])
    // Defaults to `unverified`, and the direction matters more than the
    // default. A receipt from before this field existed carries no evidence
    // that anything was checked, so the only safe reading is the one that
    // claims nothing. Defaulting to `verified` would have retroactively
    // marked every historical run as proven.
    .default("unverified"),
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

/**
 * A handoff is a lifecycle, not a write: offer → accept or decline → transfer
 * at a safe boundary. Each step is its own event because each step is a fact
 * someone acted on — an offer somebody never answered must be visible as
 * exactly that, not silently promoted into a transfer. The offer's own eventId
 * is the offer's identity; every later step points back at it.
 */
export const ControlOfferedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.offered"),
  payload: z.object({
    fromParticipantId: IdSchema,
    toParticipantId: IdSchema,
  }),
});

/**
 * The recipient said yes. Not the transfer itself: if a run is executing,
 * control moves at the next safe boundary, and the gap between these two
 * events is that wait, made visible.
 */
export const ControlAcceptedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.accepted"),
  payload: z.object({
    offerEventId: IdSchema,
    participantId: IdSchema,
  }),
});

export const ControlDeclinedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.declined"),
  payload: z.object({
    offerEventId: IdSchema,
    participantId: IdSchema,
    reason: z.string().min(1).optional(),
  }),
});

/** The offerer took an unanswered offer back — the recipient may be offline. */
export const ControlWithdrawnEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("control.withdrawn"),
  payload: z.object({
    offerEventId: IdSchema,
    participantId: IdSchema,
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
    // The offer this transfer settles. Optional because logs recorded before
    // the handoff lifecycle existed carry transfers with no offer behind them.
    offerEventId: IdSchema.optional(),
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

/**
 * A submitted direction a live execution has committed to fold in at its next
 * safe boundary. Submitted alone means recorded — it will wait for the next
 * execution if nothing is running. Queued means a specific run is about to
 * follow it, which is the difference between "heard" and "happening next",
 * and a participant needs to see which of the two their words are in.
 */
export const DirectionQueuedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("direction.queued"),
  payload: z.object({
    runId: IdSchema,
    directionEventId: IdSchema,
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
    // The model's own words leading up to this call, when the provider sent
    // any — Anthropic and OpenAI both allow a text block alongside a tool
    // call in the same response, and until this field existed the harness
    // read only the call out of it and threw the rest away. Optional and
    // absent on most calls: a model frequently acts without narrating, and
    // every event recorded before this field existed has none.
    text: z.string().min(1).optional(),
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

/* ============================================================
   What an external harness did
   ============================================================
 *
 * Deliberately NOT new arms on `ToolCallSchema`. That union discriminates on a
 * literal `name`, and every renderer switches on it exhaustively — a
 * passthrough arm would let an unreviewed external write inherit
 * `apply_patch`'s propose-then-approve guarantee at every one of those
 * switches. These events promise nothing about review, which is the honest
 * thing to promise about a program whose permissions are its own.
 */

/**
 * One action a harness took, at the only granularity it gives.
 *
 * An action appears twice under the same `callId`: once `started`, once with
 * its outcome. Last status wins. That is cheaper than a second event family
 * and it survives a stream that never reports the second half — which is
 * exactly what a killed subprocess produces.
 */
export const HarnessActivityEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("harness.activity"),
  payload: z.object({
    runId: IdSchema,
    callId: z.string().min(1),
    /**
     * The harness's own word — "Bash", "Edit", "shell". Never mapped onto a
     * Novus tool name: a mapping would be a claim about review that did not
     * happen.
     */
    name: z.string().min(1),
    /** For an icon and a filter. Nothing may gate a write on this. */
    class: z
      .enum(["unknown", "read", "search", "edit", "execute", "network", "other"])
      .default("unknown"),
    summary: z.string().min(1).nullable().default(null),
    status: z
      .enum(["started", "completed", "failed", "denied", "unknown"])
      .default("unknown"),
    /** Paths the harness SAYS it touched. Claimed, never verified. */
    claimedPaths: z.array(z.string().min(1)).max(64).default([]),
  }),
});

/** Prose from a harness whose tool detail Novus does not own. */
export const HarnessOutputEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("harness.output"),
  payload: z.object({
    runId: IdSchema,
    text: z.string().min(1),
    truncated: z.boolean().default(false),
  }),
});

/**
 * What a diff actually shows — the observed counterpart to a receipt's
 * patch-derived file list, which is empty for every external harness because
 * no patch ever crossed Novus.
 */
export const HarnessChangesObservedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("harness.changes_observed"),
  payload: z.object({
    runId: IdSchema,
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
        }),
      )
      .max(500),
    truncated: z.boolean().default(false),
    /**
     * False when the run shared the session's own tree. Then these paths are
     * everything that differs, a human's own edits included, and attributing
     * them to the harness would be a fabricated citation. Required, with no
     * default: a wrong guess here credits an agent with somebody's work.
     */
    attributable: z.boolean(),
  }),
});

/**
 * A control Novus asked for that this harness cannot perform.
 *
 * Without this, pressing Pause on a harness that cannot pause is silence — and
 * silence is indistinguishable from a pause that worked.
 */
export const HarnessUnsupportedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("harness.unsupported"),
  payload: z.object({
    runId: IdSchema,
    requested: z.enum(["pause", "resume", "steer", "approve", "fork"]),
    reason: z.string().min(1),
  }),
});

export const RunFailedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.failed"),
  payload: z.object({
    runId: IdSchema,
    reason: z.string().min(1),
  }),
});

/**
 * A request to stop a run, entered on the log the same way direction is.
 *
 * Two events, not one, for the reason `direction.submitted` /
 * `direction.applied` already is: a human needs to see the request was
 * received before it takes effect, and only the run loop itself can say when
 * it actually stopped. `run.cancelled` below is that acknowledgement — there
 * is no third "confirmed" concept needed on top of it.
 */
export const RunCancelRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.cancel_requested"),
  payload: z.object({
    runId: IdSchema,
  }),
});

// Appended by the run loop itself, at the next turn boundary after a
// cancellation was requested — the same boundary direction is folded in at.
// A tool call already in flight when the request arrives is allowed to
// finish; only the *next* model call is refused.
export const RunCancelledEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.cancelled"),
  payload: z.object({
    runId: IdSchema,
  }),
});

/**
 * A request to pause a run, entered on the log the same way a cancellation
 * is — see `RunCancelRequestedEventSchema`. Distinct from cancel: the run
 * this stops is not over, only suspended, so there is no receipt yet and
 * nothing here says the work is done.
 */
export const RunPauseRequestedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.pause_requested"),
  payload: z.object({
    runId: IdSchema,
  }),
});

// Appended by the run loop at the same turn boundary a cancellation would be
// honoured at. Not terminal: the run can still be resumed, so this carries no
// receipt and `RunReceiptSchema.status` deliberately does not include it.
export const RunPausedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.paused"),
  payload: z.object({
    runId: IdSchema,
    /**
     * What the run had spent when it stopped, so resuming continues the
     * count instead of restarting it.
     *
     * A run's budget lives in memory and dies with the process. Pause is the
     * only way a run comes back — a crashed one is reconciled to failed and a
     * cancelled one does not resume — so this is the single place the figure
     * has to survive, and without it a ceiling could be spent again in full on
     * every resume.
     *
     * Optional because pauses recorded before this existed have none. A
     * resumed run that finds none starts from zero, which is the old
     * behaviour and the honest reading of a log that never wrote it down.
     */
    usage: RunUsageSchema.optional(),
  }),
});

// Appended once, when a paused run is asked to continue — before the run
// loop has necessarily produced anything new. `run.started` is not repeated:
// this is the same run picking back up, not a new one.
export const RunResumedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("run.resumed"),
  payload: z.object({
    runId: IdSchema,
  }),
});

/**
 * What happened when a chosen attempt's changes were written to the parent.
 *
 * `applied: true` lists the paths that were actually written or removed — not
 * a line count, because the point of this record is "did it land," not a
 * second diffstat next to the one the compare screen already shows.
 *
 * `applied: false` is not a failure of the decision — a host can choose an
 * attempt whose patch no longer applies and still want that choice on the
 * record. `conflicts` names the files it refused and why, mirroring
 * `apply_patch`'s own refusal when a file drifted after a proposal was made.
 */
export const DecisionOutcomeSchema = z.discriminatedUnion("applied", [
  z.object({
    applied: z.literal(true),
    files: z.array(z.string().min(1)),
  }),
  z.object({
    applied: z.literal(false),
    reason: z.string().min(1),
    conflicts: z.array(
      z.object({
        path: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
  }),
  /**
   * Nothing was written and nothing needed to be.
   *
   * Choosing the baseline — the work already in the parent's tree — is a real
   * decision whose application is a no-op. Both of the shapes above were wrong
   * for it: `applied: true` with an empty file list claims a write that never
   * happened, and `applied: false` is rendered as a refusal everywhere it
   * appears ("not applied — …", in red), which would tell a reader the
   * mechanics failed when there were no mechanics to fail.
   *
   * A third arm of the discriminated union rather than a flag beside
   * `applied: false`, deliberately: every consumer narrows on `applied`, so
   * this one does not typecheck until each of them has been made to say what
   * it means. A flag would have compiled everywhere and been read as a failure
   * in four places.
   */
  z.object({
    applied: z.literal("unnecessary"),
    reason: z.string().min(1),
  }),
]);

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/**
 * What the human actually decided, as opposed to what the mechanics then did.
 *
 * Choosing was the only decision this log could record, so the two ways a
 * review genuinely ends — "go again with this feedback" and "neither of these
 * yet" — had nowhere to go and were taken outside the product, which is
 * exactly where a decision stops being reviewable. All three are decisions and
 * all three are recorded; only `adopt` implies anything should be written.
 */
export const DecisionKindSchema = z.enum(["adopt", "revision", "exploration"]);

export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/**
 * Why, in the decider's own words.
 *
 * Required, and deliberately one field rather than four. A form asking
 * separately for the reason, the evidence, the risk and the unresolved part
 * gets four boxes of filler from somebody who has already made up their mind;
 * one box that a person has to write a sentence in is the thing a teammate
 * reads three weeks later and actually learns from.
 *
 * Capped because this is a justification, not a design document — and floored
 * above nothing at all, because "ok" is the answer this field exists to stop.
 */
export const DecisionRationaleSchema = z.string().trim().min(12).max(2_000);

/**
 * Which approach a decision names.
 *
 * `attempt` is a fork: a run with a worktree of its own whose changes may still
 * have to be written into the parent. `baseline` is the work already in the
 * parent's tree — the execution the alternatives were alternatives *to*.
 *
 * The distinction is on the event because it cannot be recovered later. Which
 * run is the baseline is derived from the forks that exist *now*; fork again
 * tomorrow and the same log re-derives a different one, so a decision that only
 * stored a run id would silently change what it meant. Optional because every
 * decision recorded before baselines could be chosen named an attempt.
 */
export const DecisionTargetSchema = z.enum(["attempt", "baseline"]);

export type DecisionTarget = z.infer<typeof DecisionTargetSchema>;

// A human choosing between attempts, recorded whether or not the patch that
// followed actually landed. V1 says the merge is always a human decision —
// this is that decision's evidence, separate from the mechanics of applying
// it, the same way direction.submitted is recorded separately from whether
// the runtime could fold it in.
export const DecisionRecordedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal("decision.recorded"),
  payload: z
    .object({
      /** The run that was chosen — a fork's run id, or the baseline's. */
      runId: IdSchema,
      /**
       * Which kind of approach `runId` names. Absent means `attempt`, which is
       * the only thing a decision could name before the baseline was
       * selectable.
       */
      target: DecisionTargetSchema.optional(),
      /**
       * The checkpoint this decision was made across.
       *
       * For an attempt it is the checkpoint the fork was cut from. For the
       * baseline it is the checkpoint the alternatives were cut from — the
       * shared starting point that is the reason the comparison was fair, and
       * therefore the reason this run is the baseline at all. Absent only when
       * the baseline was chosen with no fork ever having been made, where
       * there is no shared checkpoint to name and saying so beats inventing
       * one; `requireCheckpointForAttempt` below keeps it mandatory everywhere
       * else, including on every event already in the log.
       */
      checkpointId: IdSchema.optional(),
      /**
       * The other approaches that were on the table, by run id.
       *
       * The comparison context, frozen. A rejected alternative stays in the
       * event history on its own `fork.created`, but *which* alternatives this
       * particular decision was made against is derived state that moves — the
       * next fork changes it. Recording it is what lets a receipt say what was
       * turned down rather than what happens to exist now. Optional: decisions
       * recorded before this field did not carry it, and an absent list means
       * "not recorded", never "there were none".
       */
      alternatives: z.array(IdSchema).optional(),
      /**
       * Which of the three ways a review ends. Optional so that decisions
       * recorded before this field existed still parse — the log is durable and
       * a schema that refused its own history would make every old session
       * unreadable. Absent means `adopt`, which is what those decisions were.
       */
      kind: DecisionKindSchema.optional(),
      /**
       * Optional here and required at the route.
       *
       * The two are not in tension: the route refuses a *new* decision without
       * one, and this schema has to keep reading the decisions recorded before
       * rationales were asked for. Tightening the stored shape instead would
       * make old sessions unreplayable, which this repository has already
       * shipped once.
       */
      rationale: DecisionRationaleSchema.optional(),
      outcome: DecisionOutcomeSchema,
    })
    .refine(
      (payload) =>
        payload.target === "baseline" || payload.checkpointId !== undefined,
      {
        message:
          "A decision on an attempt must name the checkpoint it was cut from.",
        path: ["checkpointId"],
      },
    ),
});

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionCreatedEventSchema,
  RunStartedEventSchema,
  RunProgressEventSchema,
  DirectionSubmittedEventSchema,
  DirectionQueuedEventSchema,
  DirectionAppliedEventSchema,
  ParticipantJoinedEventSchema,
  ParticipantLeftEventSchema,
  ControlRequestedEventSchema,
  ControlOfferedEventSchema,
  ControlAcceptedEventSchema,
  ControlDeclinedEventSchema,
  ControlWithdrawnEventSchema,
  ControlTransferredEventSchema,
  ToolRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovedEventSchema,
  ToolDeniedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  HarnessActivityEventSchema,
  HarnessOutputEventSchema,
  HarnessChangesObservedEventSchema,
  HarnessUnsupportedEventSchema,
  ReceiptCreatedEventSchema,
  CheckpointCreatedEventSchema,
  ForkCreatedEventSchema,
  DecisionRecordedEventSchema,
  RunCancelRequestedEventSchema,
  RunCancelledEventSchema,
  RunPauseRequestedEventSchema,
  RunPausedEventSchema,
  RunResumedEventSchema,
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
  DirectionQueuedEventSchema.omit({
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
  ControlOfferedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ControlAcceptedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ControlDeclinedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  ControlWithdrawnEventSchema.omit({
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
  HarnessActivityEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  HarnessOutputEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  HarnessChangesObservedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  HarnessUnsupportedEventSchema.omit({
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
  DecisionRecordedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunCancelRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunCancelledEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunPauseRequestedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunPausedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
  RunResumedEventSchema.omit({
    eventId: true,
    sequence: true,
    occurredAt: true,
  }),
]);

export type SessionEventDraft = z.infer<typeof SessionEventDraftSchema>;
