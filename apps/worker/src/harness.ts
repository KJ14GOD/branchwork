import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessKind,
  ModelSelection,
  SessionEvent,
} from "@novus/contracts";
import type { SessionEventStore } from "@novus/session-service";

import { buildReceipt, type ReceiptUsage, type RepositoryBase } from "./receipt.ts";
import { GIT_CONFIG_OVERRIDES, gitEnvironment } from "./tools.ts";

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

  /**
   * Stops whatever this harness has in flight, now.
   *
   * Optional, because the built-in loop does not have one and must not grow
   * one: it cancels by reading `run.cancel_requested` back off the log at its
   * next turn boundary, which is what lets a tool call already running finish.
   * An external harness has no such boundary — Novus is outside its loop — so
   * for those this is the *only* way a cancellation can reach anything, and a
   * harness declaring `cancel: "kill"` without implementing it is a button
   * that does nothing.
   *
   * Synchronous and safe to call twice. The run's own promise is what
   * eventually appends `run.cancelled`; this only asks.
   */
  stop?(): void;
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

/* ============================================================
   Evidence for a run Novus did not execute
   ============================================================
 *
 * The built-in loop produces its own evidence as it goes: every write is an
 * `apply_patch` result, every check is a `run_tests` result, and the receipt
 * reads those back. An external harness produces none of it — nothing crosses
 * Novus, so a run that rewrote nine files ended with a summary string and an
 * empty file list.
 *
 * What Novus can still do from the outside is diff, so that is what this does,
 * and it is careful about what a diff is allowed to claim. A diff of the
 * session's own tree against the run's base commit is *what differs*, not
 * *what the agent did* — see `attributable` below and on the contract.
 */

const execFileAsync = promisify(execFile);

/**
 * Git, run the way every other git call in the worker is run.
 *
 * The same `GIT_CONFIG_OVERRIDES` and `gitEnvironment()` the native git tools
 * use, and for the same reasons `tools.ts` gives: a repository's own config can
 * name an external diff or a textconv filter and git will happily run it, and
 * an inherited `GIT_DIR` silently points the call at another checkout
 * entirely. The environment scrub matters here too — reporting on a run must
 * not be the one git invocation in the worker that still carries the provider
 * key.
 */
const git = (cwd: string, args: readonly string[], timeoutMs: number) =>
  execFileAsync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
    cwd,
    env: gitEnvironment(),
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  }).then(({ stdout }) => stdout);

/** The contract's own ceiling on one observation. */
const MAX_OBSERVED_FILES = 500;

/**
 * An untracked file bigger than this is not read to be counted.
 *
 * Counting a new file's lines means reading it, and a run that dropped a
 * 400 MB artifact in the tree must not turn reporting into the slowest part
 * of the mission. Reported as zero additions, which is the same answer a
 * binary file gets, and neither is a claim that nothing was written.
 */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

export type ObservedFileChange = {
  path: string;
  additions: number;
  deletions: number;
};

export type ObservedChanges = {
  files: ObservedFileChange[];
  truncated: boolean;
};

/**
 * Whether a path git named is one Novus will put on a shared timeline.
 *
 * The repository invariant, applied to output rather than input: no absolute
 * paths, no `..`, nothing under `.git`, and no `.env`. `.env` in particular is
 * refused rather than merely uncounted — counting an untracked one means
 * reading it, and the one file Novus never reads is the one holding the
 * secrets.
 */
const isReportablePath = (path: string): boolean => {
  if (path.length === 0 || path.startsWith("/") || isAbsolute(path)) {
    return false;
  }

  const segments = path.split("/");

  if (segments.some((segment) => segment === ".." || segment === ".git")) {
    return false;
  }

  const name = segments.at(-1) ?? "";

  return name !== ".env" && !name.startsWith(".env.");
};

/**
 * How many lines an untracked file adds.
 *
 * Zero for anything that cannot be counted honestly — a symlink (following one
 * is the escape the repository boundary exists to refuse), something that is
 * not a regular file, a file over the cap, or a file with a NUL byte in it,
 * which is what git itself calls binary and reports as `-`.
 */
const countAddedLines = async (cwd: string, path: string): Promise<number> => {
  const full = resolve(cwd, path);
  const within = relative(cwd, full);

  if (within.length === 0 || within.startsWith("..") || isAbsolute(within)) {
    return 0;
  }

  try {
    const stats = await lstat(full);

    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_COUNTED_BYTES) {
      return 0;
    }

    const buffer = await readFile(full);

    if (buffer.includes(0)) {
      return 0;
    }

    const text = buffer.toString("utf8");

    if (text.length === 0) {
      return 0;
    }

    return text.endsWith("\n")
      ? text.split("\n").length - 1
      : text.split("\n").length;
  } catch {
    return 0;
  }
};

/**
 * What differs between this directory and the commit the run started from.
 *
 * Null — never an empty list — when the question could not be answered: no
 * base revision, not a Git checkout, a `git diff` that failed. "The diff could
 * not be read" and "nothing changed" are opposite answers, and reporting the
 * first as the second is how a run that rewrote the repository comes to say it
 * touched nothing.
 *
 * `--no-renames` on purpose: a rename reported as one moved file has no line
 * counts to speak of, and the delete-plus-add form is the one that adds up.
 */
export const observeRepositoryChanges = async (
  cwd: string,
  baseRevision: string | null,
): Promise<ObservedChanges | null> => {
  if (baseRevision === null) {
    return null;
  }

  const inRepo = (args: readonly string[]) => git(cwd, args, 15_000);

  // The boundary, and it has to be asked before anything is diffed.
  //
  // Git walks *up* from the working directory to find its top level, and a
  // subdirectory of a checkout is a session Novus supports — opening one only
  // requires `rev-parse --is-inside-work-tree`. So a diff run from
  // `outer/sub` reports on `outer`, and paths git prints are relative to
  // `outer`: they are inside no `..`, they escape nothing that
  // `isReportablePath` can see, and they name files above the selected root.
  // `assertRepositoryRoot` in tools.ts is the same rule for the native git
  // tools, written against the same failure.
  const topLevel = await inRepo(["rev-parse", "--show-toplevel"])
    .then((stdout) => stdout.trim())
    .catch(() => "");

  if (topLevel.length === 0) {
    return null;
  }

  // Resolved on both sides: macOS symlinks /var to /private/var, and a
  // comparison of unresolved paths would refuse every session under a temp
  // directory while letting a genuinely nested one through.
  const [resolvedTop, resolvedCwd] = await Promise.all([
    realpath(topLevel).catch(() => topLevel),
    realpath(cwd).catch(() => cwd),
  ]);

  if (resolvedTop !== resolvedCwd) {
    throw new Error(
      "The selected directory is inside a larger Git repository, so a diff of it would describe files outside the session. Open the repository's root instead.",
    );
  }

  let numstat: string;

  try {
    numstat = await inRepo([
      "diff",
      "--numstat",
      "--no-renames",
      "-z",
      baseRevision,
      "--",
    ]);
  } catch {
    return null;
  }

  const byPath = new Map<string, ObservedFileChange>();

  // `-z` because a path is whatever bytes the filesystem allows, and the
  // quoted form git prints otherwise would land mangled paths on the timeline.
  for (const record of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);

    if (!match) {
      continue;
    }

    const path = match[3]!;

    if (!isReportablePath(path)) {
      continue;
    }

    byPath.set(path, {
      path,
      // git writes `-` for a binary file. Zero, not a guess: the file changed
      // and the line counts beside it are honestly nothing.
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }

  // A brand-new file is invisible to `git diff` until it is staged, and an
  // external harness stages nothing — so without this, the files a run
  // *created* were exactly the ones it appeared not to have touched.
  try {
    const stdout = await inRepo([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);

    for (const path of stdout.split("\0")) {
      if (!isReportablePath(path) || byPath.has(path)) {
        continue;
      }

      byPath.set(path, {
        path,
        additions: await countAddedLines(cwd, path),
        deletions: 0,
      });
    }
  } catch {
    // The tracked half is still worth reporting. Untracked enumeration failing
    // is a smaller loss than dropping the whole observation.
  }

  const all = [...byPath.values()].sort((first, second) =>
    first.path.localeCompare(second.path),
  );

  return {
    files: all.slice(0, MAX_OBSERVED_FILES),
    truncated: all.length > MAX_OBSERVED_FILES,
  };
};

/**
 * The commit a run starts from, and whether the tree already differs from it.
 *
 * Read per run rather than per session, because a second turn opens on top of
 * the first turn's writes. Null revision when the directory is not a Git
 * checkout, which is allowed — the repository still works, the receipt just
 * cannot cite a base. A dirty tree is reported rather than hidden: the base is
 * then that commit *plus* changes nobody recorded, and a reviewer has to be
 * able to tell those apart.
 */
export const readRepositoryBase = async (
  repositoryPath: string,
): Promise<RepositoryBase> => {
  // Bounded and separately caught. This runs in the critical path of every
  // run, so a git call that stalls on a large repo or a network filesystem
  // would leave the UI showing a run that never continues — and a rejection
  // here would end a run that had already begun.
  const inRepo = (args: readonly string[]) => git(repositoryPath, args, 5_000);

  const revision = await inRepo(["rev-parse", "HEAD"])
    .then((stdout) => stdout.trim() || null)
    .catch(() => null);

  // Null, not false. A failed check reported as clean would make the maximally
  // dirty repository — the one whose status output was too large to read — look
  // like the tidiest one.
  const dirty = await inRepo(["status", "--porcelain"])
    .then((stdout) => stdout.trim().length > 0)
    .catch(() => null);

  return { revision, dirty };
};

/**
 * Records what changed in the tree an external harness worked in.
 *
 * `attributable` is a required argument for the same reason it is required on
 * the contract: it is the difference between evidence and a fabricated
 * citation, and a default would let a caller inherit an answer it never
 * thought about. A harness sharing the session's own tree passes false — the
 * diff then contains everything that differs from the base commit, a human's
 * own uncommitted edits included, and crediting an agent with those would be
 * the same failure as inventing a line number.
 *
 * Never throws. Observation is reporting, and reporting must not be able to
 * end a run that has otherwise finished.
 */
export const appendObservedChanges = async (input: {
  eventStore: SessionEventStore;
  sessionId: string;
  actorId: string;
  runId: string;
  cwd: string;
  baseRevision: string | null;
  attributable: boolean;
}): Promise<void> => {
  try {
    const observed = await observeRepositoryChanges(input.cwd, input.baseRevision);

    if (!observed) {
      return;
    }

    input.eventStore.append({
      sessionId: input.sessionId,
      actorId: input.actorId,
      type: "harness.changes_observed",
      payload: {
        runId: input.runId,
        files: observed.files,
        truncated: observed.truncated,
        attributable: input.attributable,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    console.warn(`run ${input.runId}: the repository could not be diffed — ${reason}`);

    // On the timeline too, not only on the host's console. A refused boundary
    // is the one case where the run produced no file evidence *for a reason a
    // person can act on* — open the repository's root — and a mission that
    // silently shows no changes is exactly the silence this slice exists to
    // remove. `observeRepositoryChanges` returning null is the other case and
    // says nothing here: "not a Git checkout" is a fact about the directory,
    // not something the team needs told twice.
    try {
      input.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.progress",
        payload: {
          runId: input.runId,
          message: `No file changes were recorded: ${reason}`,
        },
      });
    } catch {
      // The console line above already said it. A report about a report must
      // not be able to end a run.
    }
  }
};

/**
 * The usage an external harness has not told Novus about.
 *
 * Every unknown is null or a flag, never a zero that reads as a measurement.
 * `callsMissingUsage` is 1 rather than 0 because that field is the contract's
 * "these totals are a floor, not a count" flag, and a harness that reports one
 * lump sum per turn has told Novus nothing about the calls inside it — Novus
 * knows at least one happened and cannot say how many. An adapter whose stream
 * does report token totals overwrites the token fields and leaves the flag
 * standing, because `modelCalls: 0` is still a floor.
 */
export const unknownExternalUsage = (): ReceiptUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 0,
  callsMissingUsage: 1,
  modelTimeMs: 0,
  // Unpriced, not free. A harness declaring `cost: "none"` must reach the
  // receipt as null: a run reported as costing nothing because nobody counted
  // is a worse answer than one that says it does not know.
  costUsd: null,
  rates: null,
});

/**
 * Writes the run receipt for a run Novus did not execute.
 *
 * `buildReceipt` rather than a second receipt path, deliberately: the receipt
 * is the artifact people trust when they were not watching, and two builders
 * would eventually disagree about what counts as verified — with the external
 * one, which nobody exercises daily, being the one that drifts. Reading the
 * same log through the same function means an external harness cannot claim
 * anything the built-in loop could not.
 *
 * That is also why nothing here infers verification from what the harness said
 * it did. A `harness.activity` row named "Bash" whose summary is `pnpm test`
 * is the harness's own word for what it ran, unverified and unparsed, and no
 * check crossed Novus — so `buildReceipt` finds no checks and reports
 * `unverified`. Completion is not verification.
 */
export const appendExternalReceipt = (input: {
  eventStore: SessionEventStore;
  sessionId: string;
  actorId: string;
  runId: string;
  base: RepositoryBase;
  usage: ReceiptUsage;
}): void => {
  try {
    const receipt = buildReceipt(
      input.eventStore.list(input.sessionId),
      input.runId,
      { base: input.base, usage: input.usage },
    );

    if (receipt) {
      input.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "receipt.created",
        payload: { runId: input.runId, receipt },
      });
    }
  } catch (error) {
    // Said where the run is, exactly as the built-in loop does it. A receipt
    // that silently stops being produced is indistinguishable from one that
    // was never wanted.
    try {
      input.eventStore.append({
        sessionId: input.sessionId,
        actorId: input.actorId,
        type: "run.progress",
        payload: {
          runId: input.runId,
          message: `No receipt was produced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      console.error(
        `run ${input.runId}: no receipt, and the log could not be told either.`,
      );
    }
  }
};
