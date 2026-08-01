import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { rgPath } from "@vscode/ripgrep";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

import { buildUnifiedDiff } from "./diff.ts";

const execFileAsync = promisify(execFile);

export interface AgentTool {
  readonly name: ToolCall["name"];
  execute(call: ToolCall): Promise<ToolResult>;
}

const isOutside = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);

  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
};

const isProtectedPath = (repositoryRoot: string, targetPath: string): boolean => {
  const pathFromRoot = relative(repositoryRoot, targetPath);
  const segments = pathFromRoot.split(sep);
  const fileName = basename(targetPath);
  const isEnvironmentFile =
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example");

  return segments.includes(".git") || isEnvironmentFile;
};

/**
 * `realpath` for a path that may no longer exist.
 *
 * Resolving the deepest ancestor that does exist and re-attaching the missing
 * tail keeps every symlink in the path resolved — which is the part that makes
 * the confinement check mean anything — while still producing an answer for a
 * file that was just deleted. Only a missing component is walked past; any
 * other filesystem error is the caller's to see.
 */
const realpathAllowingMissing = async (targetPath: string): Promise<string> => {
  let candidate = targetPath;

  for (;;) {
    try {
      return resolve(await realpath(candidate), relative(candidate, targetPath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(candidate);

      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) {
        throw error;
      }

      candidate = parent;
    }
  }
};

export const resolveInsideRepository = async (
  repositoryPath: string,
  requestedPath: string,
  // git_diff reports on what changed, and a deletion is a change. Every other
  // caller wants the path to exist, so this stays opt-in.
  options: { allowMissing?: boolean } = {},
): Promise<{ repositoryRoot: string; targetPath: string }> => {
  if (isAbsolute(requestedPath)) {
    throw new Error("Tools only accept repository-relative paths.");
  }

  const repositoryRoot = await realpath(repositoryPath);
  const unresolvedPath = resolve(repositoryRoot, requestedPath);

  if (isOutside(repositoryRoot, unresolvedPath)) {
    throw new Error("Tools cannot access paths outside the repository.");
  }

  const targetPath = options.allowMissing
    ? await realpathAllowingMissing(unresolvedPath)
    : await realpath(unresolvedPath);

  if (isOutside(repositoryRoot, targetPath)) {
    throw new Error("Tools cannot access paths outside the repository.");
  }

  if (isProtectedPath(repositoryRoot, targetPath)) {
    throw new Error("Tools cannot access protected repository paths.");
  }

  return { repositoryRoot, targetPath };
};

export class ReadFileTool implements AgentTool {
  readonly name = "read_file";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The read_file tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
    );
    const content = await readFile(targetPath, "utf8");

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        path: relative(repositoryRoot, targetPath),
        content,
      },
    });
  }
}

type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

type RipgrepMatch = {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
};

const runRepositorySearch = (
  repositoryRoot: string,
  targetPath: string,
  query: string,
  limit: number,
): Promise<SearchMatch[]> =>
  new Promise((resolveSearch, rejectSearch) => {
    const matches: SearchMatch[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let stoppedAtLimit = false;

    const child = spawn(
      rgPath,
      [
        "--json",
        "--smart-case",
        "--max-filesize",
        "1M",
        "--",
        query,
        relative(repositoryRoot, targetPath) || ".",
      ],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const consumeLine = (line: string): void => {
      if (!line || matches.length >= limit) {
        return;
      }

      const record = JSON.parse(line) as RipgrepMatch;

      if (record.type !== "match") {
        return;
      }

      const path = record.data?.path?.text;
      const lineNumber = record.data?.line_number;
      const text = record.data?.lines?.text;

      if (path && lineNumber && text !== undefined) {
        matches.push({
          path: relative(repositoryRoot, resolve(repositoryRoot, path)),
          line: lineNumber,
          text: text.trimEnd(),
        });
      }

      if (matches.length >= limit) {
        stoppedAtLimit = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        consumeLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      rejectSearch(
        new Error(`Unable to start repository search: ${error.message}`),
      );
    });

    child.on("close", (code) => {
      if (stdoutBuffer) {
        consumeLine(stdoutBuffer);
      }

      if (stoppedAtLimit || code === 0 || code === 1) {
        resolveSearch(matches);
        return;
      }

      rejectSearch(
        new Error(`Repository search failed: ${stderr.trim() || `exit ${code}`}`),
      );
    });
  });

export class SearchRepositoryTool implements AgentTool {
  readonly name = "search_repository";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(
        `The search_repository tool cannot execute ${call.name}.`,
      );
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path ?? ".",
    );

    // No directory check. A file is a perfectly reasonable thing to search, and
    // refusing one cost a wasted round trip every time the agent narrowed to a
    // file it had already located — ripgrep takes either, and only this caller
    // was fussy. The path still goes through resolveInsideRepository, so
    // confinement is unchanged.
    const matches = await runRepositorySearch(
      repositoryRoot,
      targetPath,
      call.input.query,
      call.input.limit ?? 30,
    );

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        query: call.input.query,
        matches,
      },
    });
  }
}

export type CommandOutcome = {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 120_000;

// Enough to read a stack trace or a failing test report, small enough that one
// runaway command cannot fill the model's context. Each stream is capped
// separately so a chatty stdout cannot hide the stderr that explains the failure.
const MAX_STREAM_CHARS = 32_000;

// Secrets are removed from the child's environment rather than trusted not to be
// printed. The model sees this command's stdout, so `run_command env` would
// otherwise hand it the provider key that the harness itself is authenticating
// with.
//
// This narrows the blast radius; it does not close it. A command can still read
// any file the user can, including .env — the path confinement that protects
// read_file cannot protect a program Novus does not interpret. That is the
// reason run_command is classified dangerous and denied by default: for this
// tool the approval gate *is* the boundary, not a formality in front of one.
const SECRET_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

// Names that read as secrets but are not. SSH_AUTH_SOCK is a socket path, and
// removing it breaks every `git fetch` and `git push` over SSH with an auth
// error that says nothing about the cause.
const ENVIRONMENT_EXCEPTIONS = new Set(["SSH_AUTH_SOCK"]);

export const scrubbedEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (ENVIRONMENT_EXCEPTIONS.has(name) || !SECRET_PATTERN.test(name)) {
      environment[name] = value;
    }
  }

  return environment;
};

// V1_README: Novus must never use `git reset --hard`, overwrite uncommitted user
// work, or silently modify the host's primary branch.
//
// Read this for what it is. It stops the destructive git command an agent
// reaches for by habit, where an operator approving "run a command" would have
// no realistic chance of catching it. It is *not* a security boundary and must
// never be treated as one: `run_command bash -c '...'` reaches a shell as a
// program and walks straight past every rule here. The approval gate is the
// control. If that gate is ever widened to allow commands without review, this
// list is not what makes it safe.
//
// Subcommands are matched anywhere in the vector rather than at args[0], since
// `git -c key=value reset --hard` is the same command with a prefix.
const REFUSED_GIT_SUBCOMMANDS: ReadonlyArray<{
  match: (args: readonly string[]) => boolean;
  reason: string;
}> = [
  {
    match: (args) => args.includes("reset") && args.includes("--hard"),
    reason: "git reset --hard discards uncommitted work irreversibly",
  },
  {
    match: (args) =>
      args.includes("clean") &&
      args.some((argument) => /^-[a-z]*f/i.test(argument)),
    reason: "git clean -f deletes untracked files irreversibly",
  },
  {
    match: (args) =>
      args.includes("checkout") &&
      (args.includes("--force") || args.includes("-f")),
    reason: "git checkout --force overwrites uncommitted work",
  },
  {
    match: (args) =>
      args.includes("push") &&
      (args.includes("--force") ||
        args.includes("-f") ||
        args.includes("--force-with-lease")),
    reason: "git push --force rewrites published history",
  },
];

const refuseDestructiveCommand = (
  command: string,
  args: readonly string[],
): void => {
  if (basename(command) !== "git") {
    return;
  }

  for (const rule of REFUSED_GIT_SUBCOMMANDS) {
    if (rule.match(args)) {
      throw new Error(
        `Refused: ${rule.reason}. Novus does not run this even with approval.`,
      );
    }
  }
};

// Detached children outlive a Ctrl-C on the worker, because they are no longer
// in its process group. Tracking them lets the worker take them down on the way
// out instead of leaving a test suite running invisibly.
const runningGroups = new Set<number>();

export const killRunningCommands = (): void => {
  for (const pid of runningGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  runningGroups.clear();
};

export const runProcess = (
  repositoryRoot: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandOutcome> =>
  new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    // shell: false is the load-bearing argument. With a shell, every string the
    // model produced would be re-parsed for operators and substitutions.
    //
    // detached gives the child its own process group so a timeout can kill the
    // whole tree. `npm test` and `pnpm test` are launchers, so killing only the
    // direct child leaves the real test runner alive — and a survivor holding
    // the stdout pipe means `close` never fires and the tool call never
    // settles. That hangs the session queue permanently, which is a worse
    // failure than the timeout it was supposed to handle.
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: scrubbedEnvironment(),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");

      if (stream === "stdout") {
        if (stdout.length >= MAX_STREAM_CHARS) {
          truncated = true;
          return;
        }
        stdout += text.slice(0, MAX_STREAM_CHARS - stdout.length);
        truncated = truncated || stdout.length >= MAX_STREAM_CHARS;
        return;
      }

      if (stderr.length >= MAX_STREAM_CHARS) {
        truncated = true;
        return;
      }
      stderr += text.slice(0, MAX_STREAM_CHARS - stderr.length);
      truncated = truncated || stderr.length >= MAX_STREAM_CHARS;
    };

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));

    if (child.pid !== undefined) {
      runningGroups.add(child.pid);
    }

    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const settle = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);

      if (child.pid !== undefined) {
        runningGroups.delete(child.pid);
      }

      resolveRun({
        command: [command, ...args].join(" "),
        // A signalled process reports a null code. Reporting 0 for a process
        // the timeout killed would read as success.
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        truncated,
      });
    };

    const killTree = (): void => {
      // Negating the pid targets the process group, taking descendants with it.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // The group is already gone, or was never created; fall through.
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      settled = true;
      if (child.pid !== undefined) {
        runningGroups.delete(child.pid);
      }
      rejectRun(
        new Error(
          `Unable to run ${command}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? `${command} was not found on PATH` : error.message}`,
        ),
      );
    });

    // `exit` fires when the process ends; `close` waits for its stdio to reach
    // EOF, which a surviving descendant can hold open indefinitely. Settling on
    // close alone is what hung. Prefer close when it arrives — it means every
    // byte was collected — but never wait for it longer than a short drain.
    child.on("exit", (code) => {
      // Disarm the timeout here, not only in settle. Leaving it armed through
      // the drain lets a command that exited cleanly just before the deadline
      // be reported as timed out — and run_tests turns that into a passing
      // suite reported as failed.
      clearTimeout(timer);
      drainTimer = setTimeout(() => settle(code), 200);
    });

    child.on("close", (code) => settle(code));
  });

export class RunCommandTool implements AgentTool {
  readonly name = "run_command";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The run_command tool cannot execute ${call.name}.`);
    }

    if (call.input.command.includes("/") || call.input.command.includes("\\")) {
      throw new Error(
        "run_command takes a program name resolved on PATH, not a path. Pass arguments in args.",
      );
    }

    refuseDestructiveCommand(call.input.command, call.input.args);

    const repositoryRoot = await realpath(this.repositoryPath);
    const outcome = await runProcess(
      repositoryRoot,
      call.input.command,
      call.input.args,
      call.input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: outcome,
    });
  }
}

type PackageManager = { command: string; args: readonly string[] };

const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lockb", "bun"],
];

export const readPackageManifest = async (
  repositoryRoot: string,
  toolName: string,
): Promise<{ scripts?: Record<string, string> }> => {
  try {
    return JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    );
  } catch {
    throw new Error(
      `${toolName} found no package.json in the repository root, so it cannot tell how this project declares that.`,
    );
  }
};

/** The package manager the lockfile says this project uses, npm when none says. */
export const detectPackageManager = async (
  repositoryRoot: string,
): Promise<string> => {
  for (const [lockfile, manager] of LOCKFILE_PACKAGE_MANAGERS) {
    try {
      await stat(resolve(repositoryRoot, lockfile));
      return manager;
    } catch {
      continue;
    }
  }

  return "npm";
};

const detectScriptCommand = async (
  repositoryRoot: string,
  toolName: string,
  script: string,
): Promise<PackageManager> => {
  const manifest = await readPackageManifest(repositoryRoot, toolName);

  if (!manifest.scripts?.[script]) {
    throw new Error(
      `${toolName} requires a "${script}" script in package.json. Add one, or use run_command to invoke it directly.`,
    );
  }

  const manager = await detectPackageManager(repositoryRoot);

  // `run` spelled out for every manager. Bare `npm build` is not `npm run
  // build` — npm silently treats unknown bare subcommands as nothing — and
  // while `pnpm build` happens to work, relying on each manager's shorthand
  // is how the same tool runs different code under different lockfiles. The
  // one exception is `test`, which every manager treats as a first-class
  // subcommand; `run test` is equivalent, so uniformity wins there too.
  return { command: manager, args: ["run", script] };
};

/**
 * Runs the repository's own test script.
 *
 * This is the tool that lets a run answer "did my change work" with evidence
 * instead of assertion. It deliberately does not accept a command: the project
 * declares how its tests run, and a model choosing that for itself could report
 * a green suite it selected for being green.
 */
export class RunTestsTool implements AgentTool {
  readonly name = "run_tests";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The run_tests tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    const runner = await detectScriptCommand(repositoryRoot, this.name, "test");
    const outcome = await runProcess(
      repositoryRoot,
      runner.command,
      [...runner.args, ...call.input.args],
      call.input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        ...outcome,
        passed: outcome.exitCode === 0 && !outcome.timedOut,
      },
    });
  }
}

/**
 * Runs the repository's own build script, the way run_tests runs its tests.
 *
 * The same deliberate narrowness: the project declares how it builds, and the
 * model gets a structured verdict rather than choosing a compiler invocation
 * for itself. "Does it still build" is the question a change to a compiled
 * project has to answer before "do the tests pass" even means anything.
 */
export class RunBuildTool implements AgentTool {
  readonly name = "run_build";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The run_build tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    const runner = await detectScriptCommand(repositoryRoot, this.name, "build");
    const outcome = await runProcess(
      repositoryRoot,
      runner.command,
      [...runner.args, ...call.input.args],
      call.input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        ...outcome,
        succeeded: outcome.exitCode === 0 && !outcome.timedOut,
      },
    });
  }
}

export type PatchProposal = {
  patchId: string;
  path: string;
  intent: string;
  /**
   * What applying this proposal will do to the path. An edit rewrites an
   * existing file, a create writes a file that must not exist yet, a delete
   * removes one that must still match `baseContent`. One field rather than
   * three proposal types, because apply_patch is one tool and the write
   * class has exactly one member — the kind changes what the apply checks,
   * never which gate it crosses.
   */
  kind: "edit" | "create" | "delete";
  baseContent: string;
  proposedContent: string;
  additions: number;
  deletions: number;
  appliedAt: string | null;
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
};

/**
 * Turns model-proposed exact-match edits into a reviewable unified diff.
 *
 * The working tree is never written. Each accepted proposal is retained with
 * the content it was computed against so a later permissioned application step
 * can detect a file that changed after the proposal was made.
 */
export class ProposePatchTool implements AgentTool {
  readonly name = "propose_patch";
  private readonly repositoryPath: string;
  private readonly proposals = new Map<string, PatchProposal>();

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  getProposal(patchId: string): PatchProposal | undefined {
    return this.proposals.get(patchId);
  }

  markApplied(patchId: string): void {
    const proposal = this.proposals.get(patchId);

    if (proposal) {
      proposal.appliedAt = new Date().toISOString();
    }
  }

  /**
   * Accepts a proposal made by another propose-class tool.
   *
   * propose_new_file and propose_deletion register here rather than keeping
   * stores of their own, because apply_patch reads exactly one source — a
   * patchId that resolves differently depending on which tool minted it would
   * make "was this applied" unanswerable from one place.
   */
  register(proposal: PatchProposal): void {
    this.proposals.set(proposal.patchId, proposal);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The propose_patch tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
    );

    if (!(await stat(targetPath)).isFile()) {
      throw new Error("propose_patch requires a repository file path.");
    }

    const baseContent = await readFile(targetPath, "utf8");
    let proposedContent = baseContent;

    for (const [index, edit] of call.input.edits.entries()) {
      const occurrences = countOccurrences(proposedContent, edit.oldText);

      if (occurrences === 0) {
        throw new Error(
          `Edit ${index + 1} does not apply: oldText was not found in ${call.input.path}.`,
        );
      }

      if (occurrences > 1) {
        throw new Error(
          `Edit ${index + 1} is ambiguous: oldText matches ${occurrences} locations in ${call.input.path}. Include more surrounding context.`,
        );
      }

      // A replacer function keeps `$&` and friends in newText literal.
      proposedContent = proposedContent.replace(
        edit.oldText,
        () => edit.newText,
      );
    }

    if (proposedContent === baseContent) {
      throw new Error("propose_patch produced no change to the file.");
    }

    const path = relative(repositoryRoot, targetPath);
    const { diff, additions, deletions } = buildUnifiedDiff(
      path,
      baseContent,
      proposedContent,
    );
    const patchId = crypto.randomUUID();

    this.proposals.set(patchId, {
      patchId,
      path,
      intent: call.input.intent,
      kind: "edit",
      baseContent,
      proposedContent,
      additions,
      deletions,
      appliedAt: null,
    });

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        patchId,
        path,
        intent: call.input.intent,
        status: "proposed",
        diff,
        additions,
        deletions,
      },
    });
  }
}

export interface PatchProposalSource {
  getProposal(patchId: string): PatchProposal | undefined;
  markApplied(patchId: string): void;
}

/** A source that also accepts proposals minted by the other propose tools. */
export interface PatchProposalStore extends PatchProposalSource {
  register(proposal: PatchProposal): void;
}

/**
 * Proposes creating a file that does not exist yet.
 *
 * This closes a real hole rather than adding a convenience: propose_patch
 * requires an existing file, so before this the only way an agent could
 * create one was run_command — a dangerous-class tool whose write is not
 * reviewable before it happens. Creation belongs in the same
 * propose-then-apply flow as every other change, with the whole file as the
 * reviewable diff and apply_patch as the single permissioned writer.
 */
export class ProposeNewFileTool implements AgentTool {
  readonly name = "propose_new_file";
  private readonly repositoryPath: string;
  private readonly proposals: PatchProposalStore;

  constructor(repositoryPath: string, proposals: PatchProposalStore) {
    this.repositoryPath = resolve(repositoryPath);
    this.proposals = proposals;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The propose_new_file tool cannot execute ${call.name}.`);
    }

    // allowMissing because the file not existing is the entire point — but
    // the resolution is otherwise the same guard as everywhere else, so an
    // absolute path, a `..` escape, a symlinked parent, a .env and anything
    // under .git are all still refused before existence is even considered.
    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
      { allowMissing: true },
    );

    const existing = await stat(targetPath).catch(() => null);

    if (existing !== null && !existing.isFile()) {
      throw new Error(`${call.input.path} already exists and is not a file.`);
    }

    const overwriting = existing !== null;

    if (overwriting && call.input.overwrite !== true) {
      // Actionable on purpose. This message used to say "use propose_patch to
      // edit an existing file", which is advice that cannot be followed when
      // what you hold is the file's full new text: propose_patch matches on
      // exact oldText, so a whole-file rewrite meant reproducing the current
      // file byte-perfect first. A live run hit exactly that, tried
      // propose_patch without edits twice, and died on consecutive failures.
      throw new Error(
        `${call.input.path} already exists. Call propose_new_file again with overwrite: true to replace its whole contents, or propose_patch with exact edits to change part of it.`,
      );
    }

    const path = relative(repositoryRoot, targetPath);
    // What is being replaced, so the apply step can refuse a file that moved
    // under the proposal — an overwrite is reviewed against a specific
    // version of the file, same as an edit.
    const baseContent = overwriting ? await readFile(targetPath, "utf8") : "";
    const { diff, additions, deletions } = buildUnifiedDiff(
      path,
      baseContent,
      call.input.content,
    );
    const patchId = crypto.randomUUID();

    this.proposals.register({
      patchId,
      path,
      intent: call.input.intent,
      kind: overwriting ? "edit" : "create",
      baseContent,
      proposedContent: call.input.content,
      additions,
      deletions,
      appliedAt: null,
    });

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        patchId,
        path,
        intent: call.input.intent,
        status: "proposed",
        diff,
        additions,
        deletions,
      },
    });
  }
}

/**
 * Proposes deleting an existing file.
 *
 * The proposal captures the file's content so the apply step can refuse a
 * file that changed after the deletion was reviewed — deleting what someone
 * saw is not the same decision as deleting what is there now. The diff shown
 * for review is the entire file removed, which is exactly what approving it
 * means.
 */
export class ProposeDeletionTool implements AgentTool {
  readonly name = "propose_deletion";
  private readonly repositoryPath: string;
  private readonly proposals: PatchProposalStore;

  constructor(repositoryPath: string, proposals: PatchProposalStore) {
    this.repositoryPath = resolve(repositoryPath);
    this.proposals = proposals;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The propose_deletion tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path,
    );

    if (!(await stat(targetPath)).isFile()) {
      throw new Error(
        "propose_deletion removes one file. Directories are refused: delete their files individually, so each removal is reviewed.",
      );
    }

    const baseContent = await readFile(targetPath, "utf8");
    const path = relative(repositoryRoot, targetPath);
    const { diff, additions, deletions } = buildUnifiedDiff(path, baseContent, "");
    const patchId = crypto.randomUUID();

    this.proposals.register({
      patchId,
      path,
      intent: call.input.intent,
      kind: "delete",
      baseContent,
      proposedContent: "",
      additions,
      deletions,
      appliedAt: null,
    });

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        patchId,
        path,
        intent: call.input.intent,
        status: "proposed",
        diff,
        additions,
        deletions,
      },
    });
  }
}

/**
 * Writes a previously proposed patch to the working tree.
 *
 * This is the only tool that mutates the repository, so it refuses anything it
 * cannot account for: an unknown proposal, a proposal already applied, or a
 * file whose contents drifted from what the diff was computed against. The
 * approval boundary lives in the runner — by the time this executes, the call
 * has already been authorised.
 */
export class ApplyPatchTool implements AgentTool {
  readonly name = "apply_patch";
  private readonly repositoryPath: string;
  private readonly proposals: PatchProposalSource;

  constructor(repositoryPath: string, proposals: PatchProposalSource) {
    this.repositoryPath = resolve(repositoryPath);
    this.proposals = proposals;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The apply_patch tool cannot execute ${call.name}.`);
    }

    const proposal = this.proposals.getProposal(call.input.patchId);

    if (!proposal) {
      throw new Error(
        `No patch proposal exists for ${call.input.patchId}. Call propose_patch first and apply the id it returns.`,
      );
    }

    if (proposal.appliedAt) {
      throw new Error(
        `Patch ${proposal.patchId} was already applied at ${proposal.appliedAt}.`,
      );
    }

    // allowMissing serves both non-edit kinds — a creation's file does not
    // exist yet, and a deletion has to be able to *report* one that is
    // already gone — while the confinement itself is identical for all
    // three: the missing tail is re-attached to the resolved ancestor, so
    // nothing outside the repository and nothing protected is reachable.
    const { targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      proposal.path,
      { allowMissing: proposal.kind !== "edit" },
    );

    if (proposal.kind === "create") {
      // The drift check, restated for a file that should not exist: what was
      // reviewed was "this path is new". A file that appeared since — the
      // human's own editor, another run — makes the proposal stale the same
      // way an edited base does.
      if ((await stat(targetPath).catch(() => null)) !== null) {
        throw new Error(
          `${proposal.path} was created after this proposal was made, so applying it would overwrite a file nobody reviewed. Read the file and propose an edit instead.`,
        );
      }

      // Parents are created inside the already-confined target path only.
      // dirname of a confined path is confined: the resolver refused any
      // escape before the tail was re-attached.
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, proposal.proposedContent, "utf8");
    } else if (proposal.kind === "delete") {
      const currentContent = await readFile(targetPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          throw error.code === "ENOENT"
            ? new Error(
                `${proposal.path} is already gone, so there is nothing to delete. The proposal was not applied.`,
              )
            : error;
        },
      );

      if (currentContent !== proposal.baseContent) {
        throw new Error(
          `${proposal.path} changed after its deletion was proposed. Deleting what was reviewed is not deleting what is there now — re-read the file and propose again.`,
        );
      }

      await unlink(targetPath);
    } else {
      const currentContent = await readFile(targetPath, "utf8");

      if (currentContent !== proposal.baseContent) {
        throw new Error(
          `${proposal.path} changed after this patch was proposed, so the diff no longer applies. Re-read the file and propose the change again.`,
        );
      }

      await writeFile(targetPath, proposal.proposedContent, "utf8");
    }

    this.proposals.markApplied(proposal.patchId);

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        patchId: proposal.patchId,
        path: proposal.path,
        status: "applied",
        additions: proposal.additions,
        deletions: proposal.deletions,
      },
    });
  }
}

/**
 * Asks the configured provider which model ids it currently serves.
 *
 * This exists because of a correctness failure, not a capability wish: a live
 * run read `claude-opus-4-8` out of a repository and confidently reported it
 * as a typo that would fail every request, because the id postdated the
 * model's training data and nothing in its tool set could check. The provider
 * itself is the only authority on this fact.
 *
 * The fetcher is injected by whoever owns the provider client, so the tool
 * layer stays provider-neutral. The call takes no model-controlled arguments
 * at all — the one question it can ask is fixed at construction.
 */
export class ListProviderModelsTool implements AgentTool {
  readonly name = "list_provider_models";
  private readonly provider: string;
  private readonly listModels: () => Promise<string[]>;

  constructor(provider: string, listModels: () => Promise<string[]>) {
    this.provider = provider;
    this.listModels = listModels;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The list_provider_models tool cannot execute ${call.name}.`);
    }

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        provider: this.provider,
        models: await this.listModels(),
      },
    });
  }
}

// Reporting tools. These read the repository and never change it, so they are
// classified read and run without approval — but they still reach the
// filesystem and still spawn Git, so every path goes through the same resolver
// as the rest and every argument vector is fixed by Novus rather than composed
// from model input.
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_DIFF_CHARS = 48_000;
const GIT_TIMEOUT_MS = 15_000;

// Configuration that turns reading a repository into running its code.
//
// `.git/config` belongs to whoever wrote the repository, and these tools were
// classified read — meaning they execute with no approval at all. Git will
// happily honour `diff.external`, a `textconv` filter, or `core.fsmonitor` from
// that file and run whatever it names. Classifying run_tests as dangerous to
// avoid trusting a repository to be benign, and then trusting it here, was the
// mistake; these overrides are what make the read classification true.
// Exported so the harness adapters' own git calls run under the same
// overrides. A second copy of this list would be a security-relevant list free
// to drift, and the one that drifted would be the one nobody exercises daily.
export const GIT_CONFIG_OVERRIDES = [
  "-c", "diff.external=",
  "-c", "diff.textconv=",
  "-c", "core.fsmonitor=",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.quotePath=false",
];

// Git reads more than the repository's own config. A GIT_DIR or GIT_WORK_TREE
// inherited from the worker silently points these tools somewhere else, and
// GIT_EXTERNAL_DIFF is the environment's version of the config above. The
// secret scrub is inherited too, so anything git does spawn cannot read the
// provider key out of its environment.
export const gitEnvironment = (): NodeJS.ProcessEnv => {
  const environment = scrubbedEnvironment();

  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) {
      delete environment[name];
    }
  }

  environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
  environment["GIT_CONFIG_SYSTEM"] = "/dev/null";
  environment["GIT_TERMINAL_PROMPT"] = "0";

  return environment;
};

const runGit = (
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> =>
  execFileAsync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
    cwd: repositoryRoot,
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  }).then(({ stdout }) => stdout);

/**
 * Refuses to report on a repository larger than the one that was selected.
 *
 * Git walks up from the working directory to find its top level, so pointing
 * Novus at a subdirectory of a checkout would let these tools describe — and
 * diff — files above the selected root. Every other tool is confined by
 * resolveInsideRepository; this is the same rule for the one that asks Git
 * instead of the filesystem.
 */
const assertRepositoryRoot = async (repositoryRoot: string): Promise<void> => {
  const topLevel = (await runGit(repositoryRoot, ["rev-parse", "--show-toplevel"]))
    .trim();

  if (!topLevel || (await realpath(topLevel)) !== repositoryRoot) {
    throw new Error(
      "The selected directory is inside a larger Git repository. Git tools report on the selected repository only, so open its root instead.",
    );
  }
};

// Never diff a file the other tools refuse to read. `git diff` has no notion of
// a protected path, so an unqualified diff of a tracked .env prints the secrets
// read_file exists to withhold.
const PROTECTED_PATHSPECS = [":(exclude).env", ":(exclude).env.*"];

export class ListDirectoryTool implements AgentTool {
  readonly name = "list_directory";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The list_directory tool cannot execute ${call.name}.`);
    }

    const { repositoryRoot, targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      call.input.path ?? ".",
    );

    if (!(await stat(targetPath)).isDirectory()) {
      throw new Error("list_directory requires a directory path.");
    }

    const found = await readdir(targetPath, { withFileTypes: true });
    // Count what the agent is allowed to see, not what the directory holds.
    // Truncation is measured after the protected entries are dropped, because
    // a directory of exactly the cap plus a .env loses nothing and reporting
    // otherwise sends the agent looking for entries that were never withheld.
    const visible = found.filter(
      (entry) => !isProtectedPath(repositoryRoot, resolve(targetPath, entry.name)),
    );
    const entries = visible
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? ("directory" as const)
          : entry.isSymbolicLink()
            ? ("symlink" as const)
            : entry.isFile()
              ? ("file" as const)
              : ("other" as const),
      }));

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        path: relative(repositoryRoot, targetPath),
        entries,
        truncated: visible.length > MAX_DIRECTORY_ENTRIES,
      },
    });
  }
}

export class GitStatusTool implements AgentTool {
  readonly name = "git_status";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The git_status tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);

    let porcelain: string;

    try {
      await assertRepositoryRoot(repositoryRoot);
      porcelain = await runGit(repositoryRoot, [
        "status",
        "--porcelain=v1",
        "--branch",
        // -z is what makes this parseable. Without it a rename is printed as
        // `R  old -> new` on one line and a path containing a space or a
        // non-ASCII byte is C-quoted, so slicing the line yields either the
        // arrow sentence or a path with quotes in it — neither of which names
        // a file. With -z each record is NUL-terminated, nothing is quoted,
        // and a rename's original path is simply the record that follows.
        "-z",
      ]);
    } catch (error) {
      // Null clean, not false. A repository we could not read is unknown, and
      // reporting it as clean would let the agent conclude nothing changed.
      return ToolResultSchema.parse({
        toolCallId: call.id,
        name: this.name,
        output: { branch: null, clean: null, files: [] },
      });
    }

    const records = porcelain.split("\0").filter(Boolean);
    const branchRecord = records.find((record) => record.startsWith("##"));
    const branch =
      branchRecord?.replace(/^## /, "").split(/\.\.\.|\s/)[0] ?? null;

    const files: Array<{ status: string; path: string; staged: boolean }> = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;

      if (record.startsWith("##")) {
        continue;
      }

      // Porcelain v1 is a two-character status followed by a space.
      const status = record.slice(0, 2);
      // A rename or a copy spends a second record on the path it came from.
      // Skipping it matters twice over: it is not a file that changed, and
      // read as a status line its first two characters are part of a filename.
      // The path reported is the destination — the file that exists now, and
      // the one every other tool can be pointed at.
      if (/[RC]/.test(status)) {
        index += 1;
      }

      files.push({
        status: status.trim() || "?",
        path: record.slice(3),
        staged: status[0] !== " " && status[0] !== "?",
      });
    }

    // An untracked node_modules is tens of thousands of entries, and every one
    // of them would land in the model's context and the event log.
    const reported = files.slice(0, MAX_DIRECTORY_ENTRIES);

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        branch: branch || null,
        clean: reported.length === 0,
        files: reported,
      },
    });
  }
}

export class GitDiffTool implements AgentTool {
  readonly name = "git_diff";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The git_diff tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    await assertRepositoryRoot(repositoryRoot);

    const staged = call.input.staged ?? false;
    // --no-ext-diff and --no-textconv restate the config overrides as flags.
    // Belt and braces on the one tool where being wrong runs a program.
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];

    if (staged) {
      args.push("--staged");
    }

    args.push("--");

    if (call.input.path) {
      // Resolved through the same guard as every other path, and passed after
      // `--` so a filename can never be read as an option.
      //
      // A deleted file is the one case where the guard has to answer about a
      // path that is not there. "Read back what my patch changed" is what this
      // tool is for, and a deletion is a change; resolving through realpath
      // meant the diff that proves the file is gone was the diff it refused to
      // produce. Nothing is relaxed: the missing tail is re-attached to the
      // resolved ancestor, so an absolute path, a `..` escape, a symlinked
      // parent and a .env are all still refused.
      const { targetPath } = await resolveInsideRepository(
        this.repositoryPath,
        call.input.path,
        { allowMissing: true },
      );
      const requested = relative(repositoryRoot, targetPath);

      // An empty relative path means the repository root, which Git rejects as
      // a pathspec. "." is what it wants.
      args.push(requested || ".");
    }

    args.push(...PROTECTED_PATHSPECS);

    const diff = await runGit(repositoryRoot, args);
    const filesChanged = (diff.match(/^diff --git /gm) ?? []).length;

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        staged,
        diff: diff.slice(0, MAX_DIFF_CHARS),
        filesChanged,
        truncated: diff.length > MAX_DIFF_CHARS,
      },
    });
  }
}

const MAX_BRANCHES = 200;

/**
 * Reports the repository's branches and worktrees. Strictly read-side:
 * creating, switching, or deleting a branch changes the checkout under the
 * human who selected it, and that is run_command-with-approval territory, not
 * something a read-class tool does quietly.
 *
 * The same hardening as the other git reporters — config overrides, scrubbed
 * environment, fixed argument vectors, and the repository-root assertion —
 * because "read-only" is only true when the repository cannot make Git run
 * code on the way to answering.
 */
export class GitBranchesTool implements AgentTool {
  readonly name = "git_branches";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The git_branches tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);

    await assertRepositoryRoot(repositoryRoot);

    // %(HEAD) marks the branch this worktree has checked out, which is also
    // how a detached HEAD shows itself: no branch carries the mark. Fields
    // are NUL-separated because a subject line can contain anything printable
    // — a subject with a tab in it must not become two fields.
    const refs = await runGit(repositoryRoot, [
      "for-each-ref",
      "refs/heads",
      "--format=%(HEAD)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(subject)",
    ]);

    const parsed = refs
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [head, name, revision, upstream, subject] = line.split("\0");

        if (!name || !revision) {
          return [];
        }

        return [
          {
            name,
            isCurrent: head === "*",
            revision,
            subject: subject ?? "",
            upstream: upstream ? upstream : null,
          },
        ];
      });

    const branches = parsed.slice(0, MAX_BRANCHES);
    const current = branches.find((branch) => branch.isCurrent)?.name ?? null;

    // --porcelain -z: records are NUL-terminated attribute lines, a blank
    // record between worktrees. Parsed rather than displayed because the
    // model needs "which checkout is mine" as a fact, not a listing.
    const worktreeRecords = await runGit(repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);

    const worktrees: Array<{
      path: string;
      branch: string | null;
      revision: string;
      isCurrent: boolean;
    }> = [];
    let entry: { path?: string; branch?: string | null; revision?: string } = {};

    const flush = async (): Promise<void> => {
      if (entry.path && entry.revision) {
        // realpath so the comparison with the (already-resolved) repository
        // root is between two resolved paths — /var vs /private/var on macOS
        // otherwise reports the selected checkout as somebody else's.
        const resolvedPath = await realpath(entry.path).catch(() => entry.path!);

        worktrees.push({
          path: resolvedPath,
          branch: entry.branch ?? null,
          revision: entry.revision,
          isCurrent: resolvedPath === repositoryRoot,
        });
      }
      entry = {};
    };

    for (const record of worktreeRecords.split("\0")) {
      if (record === "") {
        await flush();
        continue;
      }

      if (record.startsWith("worktree ")) {
        entry.path = record.slice("worktree ".length);
      } else if (record.startsWith("HEAD ")) {
        entry.revision = record.slice("HEAD ".length);
      } else if (record.startsWith("branch ")) {
        entry.branch = record
          .slice("branch ".length)
          .replace(/^refs\/heads\//, "");
      } else if (record === "detached") {
        entry.branch = null;
      }
    }

    await flush();

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        current,
        branches,
        worktrees,
        truncated: parsed.length > MAX_BRANCHES,
      },
    });
  }
}
