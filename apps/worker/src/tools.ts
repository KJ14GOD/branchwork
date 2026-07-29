import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

import { buildUnifiedDiff } from "./diff.ts";

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

const resolveInsideRepository = async (
  repositoryPath: string,
  requestedPath: string,
): Promise<{ repositoryRoot: string; targetPath: string }> => {
  if (isAbsolute(requestedPath)) {
    throw new Error("Tools only accept repository-relative paths.");
  }

  const repositoryRoot = await realpath(repositoryPath);
  const unresolvedPath = resolve(repositoryRoot, requestedPath);

  if (isOutside(repositoryRoot, unresolvedPath)) {
    throw new Error("Tools cannot access paths outside the repository.");
  }

  const targetPath = await realpath(unresolvedPath);

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

    if (!(await stat(targetPath)).isDirectory()) {
      throw new Error("search_repository path must be a directory.");
    }

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

type CommandOutcome = {
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

const scrubbedEnvironment = (): NodeJS.ProcessEnv => {
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

const runProcess = (
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

const detectTestCommand = async (
  repositoryRoot: string,
): Promise<PackageManager> => {
  let manifest: { scripts?: Record<string, string> };

  try {
    manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "run_tests found no package.json in the repository root, so it cannot tell how this project runs its tests.",
    );
  }

  if (!manifest.scripts?.test) {
    throw new Error(
      'run_tests requires a "test" script in package.json. Add one, or use run_command to invoke the test runner directly.',
    );
  }

  for (const [lockfile, manager] of LOCKFILE_PACKAGE_MANAGERS) {
    try {
      await stat(resolve(repositoryRoot, lockfile));
      return { command: manager, args: ["test"] };
    } catch {
      continue;
    }
  }

  return { command: "npm", args: ["test"] };
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
    const runner = await detectTestCommand(repositoryRoot);
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

export type PatchProposal = {
  patchId: string;
  path: string;
  intent: string;
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

    const { targetPath } = await resolveInsideRepository(
      this.repositoryPath,
      proposal.path,
    );
    const currentContent = await readFile(targetPath, "utf8");

    if (currentContent !== proposal.baseContent) {
      throw new Error(
        `${proposal.path} changed after this patch was proposed, so the diff no longer applies. Re-read the file and propose the change again.`,
      );
    }

    await writeFile(targetPath, proposal.proposedContent, "utf8");
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
