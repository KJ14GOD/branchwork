import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelSelection, RunReceipt } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { AnthropicModelAdapter } from "./anthropic-model.ts";
import { FixedModelRouter } from "./model.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { killRunningCommands } from "./tools.ts";

/**
 * The three benchmarks from V1_README's *Evaluation* section, and their scorer.
 *
 * Milestone 2's exit condition is "the agent completes the bug-fix benchmark
 * locally and produces a reproducible diff and test receipt". Every part of
 * that sentence existed before this file did, and none of it had been observed
 * happening at once. This runs it and says what actually occurred.
 *
 * The other two tasks the same section asks for — a feature spread across
 * several files, and a change whose obvious form is wrong until you have read
 * something the failing test does not mention — score identically, because the
 * thing being scored is the same thing: a diff, a receipt, and a suite re-run
 * by somebody other than the agent. Only the fixture and the goal differ.
 *
 * Two things are load-bearing about how it scores. It re-runs the fixture's own
 * suite itself rather than believing the run_tests result the agent saw, and it
 * runs a hidden test the agent could not read. Between them they close the two
 * ways a run can look successful without being it: reporting a green suite that
 * was green for the wrong reason, and passing the visible test by deleting or
 * special-casing it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BENCHMARKS_DIR = join(REPO_ROOT, "benchmarks");

export const BENCHMARK_NAMES = [
  "bug-fix",
  "small-feature",
  "repo-reasoning",
] as const;

export type BenchmarkName = (typeof BENCHMARK_NAMES)[number];

export const isBenchmarkName = (value: string): value is BenchmarkName =>
  (BENCHMARK_NAMES as readonly string[]).includes(value);

/**
 * What the scratch copy of each fixture is called on disk.
 *
 * Only cosmetic — it is the directory name a human sees in `--keep` output and
 * in a stack trace — but a fixture that arrives as `benchmark-run` in every
 * failure report is harder to talk about than one that arrives as `retention`.
 */
const SCRATCH_DIRECTORY: Record<BenchmarkName, string> = {
  "bug-fix": "throttle",
  "small-feature": "queryfilter",
  "repo-reasoning": "retention",
};

// Copied in only after the agent has stopped, so it is never on disk while the
// agent can search, read, or run it. The leading dot also keeps it out of the
// fixture's own `tests/*.test.js` glob if the ordering ever changed.
const HIDDEN_TEST_DIR = ".novus-hidden";

const scriptedSelection = (benchmark: BenchmarkName): ModelSelection => ({
  provider: "scripted",
  model: `${benchmark}-fixture`,
});

const LIVE_SELECTION: ModelSelection = {
  provider: "anthropic",
  model: "claude-opus-5",
};

export type BenchmarkVariant = "scripted" | "live";

export type ProcessOutcome = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type BenchmarkCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type BenchmarkResult = {
  benchmark: BenchmarkName;
  variant: BenchmarkVariant;
  model: ModelSelection;
  goal: string;
  verdict: "PASS" | "FAIL";
  checks: readonly BenchmarkCheck[];
  /** The fixture's suite before the agent touched it. Must already be red. */
  baseline: ProcessOutcome;
  /** The fixture's suite after, re-run here rather than taken on trust. */
  visible: ProcessOutcome;
  hidden: ProcessOutcome;
  diff: { produced: boolean; lines: number; changedPaths: readonly string[] };
  /** Test files the run modified or deleted. Any entry fails the benchmark. */
  tamperedTests: readonly string[];
  receipt: RunReceipt | null;
  runError: string | null;
  wallClockMs: number;
  scratchPath: string;
  artifactsPath: string;
};

/**
 * A child environment with provider credentials removed.
 *
 * The live variant loads a key into this process, and everything below spawns
 * git, npm, and node with output that lands in an artifacts directory a human
 * will read. `run_command` already scrubs its own children for this reason; the
 * scorer's children are not exempt just because the scorer wrote them.
 *
 * NODE_TEST_CONTEXT goes too, and that one is not about secrets. Node's test
 * runner sets it on every file it spawns, and a nested `node --test` that sees
 * it reports its results up a channel to a parent that is not listening and
 * exits 0 regardless. Since this benchmark runs from the gate, inheriting it
 * would make every scored test run — the baseline, the visible suite, the
 * hidden test — report success unconditionally. The scorer would then agree
 * with everything, which is the one failure mode it cannot have.
 */
const scrubbedEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (name === "SSH_AUTH_SOCK") {
      environment[name] = value;
      continue;
    }

    if (name.startsWith("NODE_TEST_")) {
      continue;
    }

    if (/key|secret|token|password|credential/i.test(name)) {
      continue;
    }

    environment[name] = value;
  }

  return environment;
};

const runProcess = (
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<ProcessOutcome> =>
  new Promise((settle, fail) => {
    const startedAt = Date.now();
    const child = spawn(command, [...args], {
      cwd,
      env: scrubbedEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      settle({
        command: [command, ...args].join(" "),
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });

const git = async (
  cwd: string,
  args: readonly string[],
): Promise<ProcessOutcome> => {
  // Identity and signing are forced rather than inherited: the scratch commit
  // must succeed on a machine whose global Git config demands a GPG key.
  const outcome = await runProcess(cwd, "git", [
    "-c",
    "user.name=Novus Benchmark",
    "-c",
    "user.email=benchmark@novus.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);

  if (outcome.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with ${outcome.exitCode}: ${outcome.stderr.trim() || outcome.stdout.trim()}`,
    );
  }

  return outcome;
};

/**
 * The deterministic model.
 *
 * Same shape as `ScriptedModelAdapter` in model.ts: a fixed sequence of
 * decisions, driven off how many tool exchanges the current turn has already
 * accumulated. Everything the decisions touch is real — the repository is a
 * real checkout, the search is ripgrep, the patch is computed and applied by
 * the real tools under the real approval gate, and the test run is the
 * fixture's actual suite. Only the choosing is canned.
 *
 * The third step deliberately misses. `propose_patch` refuses text that matches
 * twice, the model gets that refusal back as an error, and the run continues —
 * which is the invariant that a failing tool never ends a run, exercised rather
 * than asserted.
 */
export class ScriptedBugFixAdapter implements ModelAdapter {
  readonly selection: ModelSelection = scriptedSelection("bug-fix");

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "search_repository",
          input: { query: "lastRefillAt", limit: 20 },
        },
      };
    }

    if (step === 1) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "src/rate-limiter.js" },
        },
      };
    }

    if (step === 2) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/rate-limiter.js",
            intent: "Carry the unearned remainder of an interval forward.",
            // Ambiguous on purpose: this line appears in the constructor too.
            edits: [
              {
                oldText: "    this.lastRefillAt = this.now();",
                newText: "    this.lastRefillAt += earned * this.intervalMs;",
              },
            ],
          },
        },
      };
    }

    if (step === 3) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/rate-limiter.js",
            intent:
              "Advance lastRefillAt by the intervals actually credited, so a partly elapsed interval is not discarded by the next call.",
            edits: [
              {
                oldText: [
                  "    this.tokens = Math.min(this.burst, this.tokens + earned * this.refill);",
                  "    this.lastRefillAt = this.now();",
                ].join("\n"),
                newText: [
                  "    this.tokens = Math.min(this.burst, this.tokens + earned * this.refill);",
                  "    // Advance by the time credited, not the time elapsed. Setting this to",
                  "    // now() would discard the part of the interval that has not completed,",
                  "    // and a caller polling faster than intervalMs would never earn again.",
                  "    this.lastRefillAt += earned * this.intervalMs;",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 4) {
      const proposal = request.toolExchanges.find(
        (exchange) =>
          exchange.status === "ok" && exchange.result.name === "propose_patch",
      );

      if (proposal?.status !== "ok" || proposal.result.name !== "propose_patch") {
        return {
          type: "final",
          summary:
            "No patch proposal survived, so there was nothing to apply. The bug is unfixed.",
        };
      }

      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "apply_patch",
          input: { patchId: proposal.result.output.patchId },
        },
      };
    }

    if (step === 5) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "run_tests",
          input: { args: [] },
        },
      };
    }

    const tests = request.toolExchanges.find(
      (exchange) =>
        exchange.status === "ok" && exchange.result.name === "run_tests",
    );

    if (tests?.status === "ok" && tests.result.name === "run_tests") {
      return {
        type: "final",
        summary: tests.result.output.passed
          ? "settle() reset lastRefillAt to now, discarding the part of the interval that had not completed, so a caller polling faster than intervalMs destroyed its own credit a fraction at a time. It now advances by the intervals it actually credited. The fixture's suite passes."
          : `The patch was applied but the suite still fails (exit ${tests.result.output.exitCode}).`,
      };
    }

    return {
      type: "final",
      summary: "The run ended without a test result to report.",
    };
  }
}

/**
 * The id of the most recent proposal, for a script that patches more than once.
 *
 * The bug-fix script proposes once and can look for the first proposal that
 * survived. A script that patches three files cannot: it has to apply the one
 * it just made, so this walks backwards and takes the newest.
 */
const lastPatchId = (request: ModelRequest): string | null => {
  for (let index = request.toolExchanges.length - 1; index >= 0; index -= 1) {
    const exchange = request.toolExchanges[index];

    if (
      exchange?.status === "ok" &&
      exchange.result.name === "propose_patch"
    ) {
      return exchange.result.output.patchId;
    }
  }

  return null;
};

const applyOrGiveUp = (request: ModelRequest, what: string): ModelResponse => {
  const patchId = lastPatchId(request);

  if (patchId === null) {
    return {
      type: "final",
      summary: `No patch proposal survived for ${what}, so there was nothing to apply.`,
    };
  }

  return {
    type: "tool_call",
    call: {
      id: crypto.randomUUID(),
      name: "apply_patch",
      input: { patchId },
    },
  };
};

/**
 * The deterministic model for the small-feature benchmark.
 *
 * Three proposals and three applications, one file each, because a patch names
 * a single path. That sequence — propose, apply, propose against a file the
 * script has not re-read since the last write, apply again — is the part of the
 * harness the single-file bug-fix script never touches. Only the choosing is
 * canned; the anchors are matched against the real files by the real tool, so a
 * fixture edited without updating this script fails loudly rather than quietly
 * producing a smaller diff.
 */
export class ScriptedSmallFeatureAdapter implements ModelAdapter {
  readonly selection: ModelSelection = scriptedSelection("small-feature");

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "list_directory",
          input: { path: "src" },
        },
      };
    }

    if (step === 1) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "src/tokenize.js" },
        },
      };
    }

    if (step === 2) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/tokenize.js",
            intent:
              "Declare the membership operator and read its operand as a list of options.",
            edits: [
              {
                oldText: [
                  '  { id: "contains", spelling: "~", operand: "scalar" },',
                  "];",
                ].join("\n"),
                newText: [
                  '  { id: "contains", spelling: "~", operand: "scalar" },',
                  '  { id: "isOneOf", spelling: "in", operand: "list" },',
                  "];",
                ].join("\n"),
              },
              {
                oldText: [
                  "  throw new SyntaxError(",
                  '    `operator "${operator.spelling}" declares operand kind "${operator.operand}", which the lexer does not know how to read`,',
                  "  );",
                ].join("\n"),
                newText: [
                  '  if (operator.operand === "list") {',
                  '    const options = text.split("|").map((option) => option.trim());',
                  "",
                  "    if (options.some((option) => option.length === 0)) {",
                  "      throw new SyntaxError(",
                  '        `"${operator.spelling}" was given an empty option in "${text}"`,',
                  "      );",
                  "    }",
                  "",
                  "    return options;",
                  "  }",
                  "",
                  "  throw new SyntaxError(",
                  '    `operator "${operator.spelling}" declares operand kind "${operator.operand}", which the lexer does not know how to read`,',
                  "  );",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 3) {
      return applyOrGiveUp(request, "the lexer");
    }

    if (step === 4) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/evaluate.js",
            intent:
              "Match when the field equals any option, comparing on the string form as equals does.",
            edits: [
              {
                oldText: [
                  "  contains: (value, operand) => String(value).includes(operand),",
                  "};",
                ].join("\n"),
                newText: [
                  "  contains: (value, operand) => String(value).includes(operand),",
                  "  isOneOf: (value, options) =>",
                  "    options.some((option) => String(value) === option),",
                  "};",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 5) {
      return applyOrGiveUp(request, "the predicate");
    }

    if (step === 6) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/explain.js",
            intent:
              "Describe a membership clause, with the comma-and-or rule for three or more options.",
            edits: [
              {
                oldText: "export const DESCRIPTIONS = {",
                newText: [
                  "const listOptions = (options) => {",
                  "  if (options.length < 2) {",
                  '    return options.join("");',
                  "  }",
                  "",
                  "  if (options.length === 2) {",
                  "    return `${options[0]} or ${options[1]}`;",
                  "  }",
                  "",
                  '  return `${options.slice(0, -1).join(", ")}, or ${options.at(-1)}`;',
                  "};",
                  "",
                  "export const DESCRIPTIONS = {",
                ].join("\n"),
              },
              {
                oldText: [
                  "  contains: (field, operand) => `${field} contains ${operand}`,",
                  "};",
                ].join("\n"),
                newText: [
                  "  contains: (field, operand) => `${field} contains ${operand}`,",
                  "  isOneOf: (field, options) => `${field} is one of ${listOptions(options)}`,",
                  "};",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 7) {
      return applyOrGiveUp(request, "the description");
    }

    if (step === 8) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "run_tests",
          input: { args: [] },
        },
      };
    }

    const tests = request.toolExchanges.find(
      (exchange) =>
        exchange.status === "ok" && exchange.result.name === "run_tests",
    );

    if (tests?.status === "ok" && tests.result.name === "run_tests") {
      return {
        type: "final",
        summary: tests.result.output.passed
          ? "Membership is now declared in the operator table with a list operand, implemented in the predicates, and described in the explanations. The glue was left alone. The fixture's suite passes."
          : `The three patches were applied but the suite still fails (exit ${tests.result.output.exitCode}).`,
      };
    }

    return {
      type: "final",
      summary: "The run ended without a test result to report.",
    };
  }
}

/**
 * The deterministic model for the repository-reasoning benchmark.
 *
 * It takes the path the task is asking for rather than the short one: it
 * searches for every caller of the shared range function and reads both of them
 * before it proposes anything, and then patches the caller that is wrong rather
 * than the function they share. That the script does this proves the fixture and
 * the scorer work end to end. It proves nothing whatsoever about whether a model
 * would have read the second caller first — only the live run says that.
 */
export class ScriptedRepoReasoningAdapter implements ModelAdapter {
  readonly selection: ModelSelection = scriptedSelection("repo-reasoning");

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const step = request.toolExchanges.length;

    if (step === 0) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "search_repository",
          input: { query: "entriesBetween", limit: 20 },
        },
      };
    }

    if (step === 1) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "src/rollup.js" },
        },
      };
    }

    if (step === 2) {
      // The other caller, before touching anything. This is the step the whole
      // benchmark is about.
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "src/purge.js" },
        },
      };
    }

    if (step === 3) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "propose_patch",
          input: {
            path: "src/rollup.js",
            intent:
              "Ask for the day as a half-open span, since the range selector's closed upper bound is what retention depends on.",
            edits: [
              {
                oldText:
                  "      count: entriesBetween(entries, dayStart, dayStart + DAY_MS).length,",
                newText: [
                  "      // A day ends at the instant before the next one starts. entriesBetween",
                  "      // is closed at both ends and retention needs it to stay that way, so the",
                  "      // half-open day is expressed here, in the caller that wants one.",
                  "      count: entriesBetween(entries, dayStart, dayStart + DAY_MS - 1)",
                  "        .length,",
                ].join("\n"),
              },
            ],
          },
        },
      };
    }

    if (step === 4) {
      return applyOrGiveUp(request, "the rollup");
    }

    if (step === 5) {
      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "run_tests",
          input: { args: [] },
        },
      };
    }

    const tests = request.toolExchanges.find(
      (exchange) =>
        exchange.status === "ok" && exchange.result.name === "run_tests",
    );

    if (tests?.status === "ok" && tests.result.name === "run_tests") {
      return {
        type: "final",
        summary: tests.result.output.passed
          ? "The rollup asked for a whole day as a closed range, so consecutive days overlapped at midnight and an entry there was counted twice. The range selector is closed at both ends on purpose — retention's window ends at now, and the newest entry is stamped now — so the day is made half-open in the rollup instead. The fixture's suite passes."
          : `The patch was applied but the suite still fails (exit ${tests.result.output.exitCode}).`,
      };
    }

    return {
      type: "final",
      summary: "The run ended without a test result to report.",
    };
  }
}

const SCRIPTED_ADAPTERS: Record<BenchmarkName, () => ModelAdapter> = {
  "bug-fix": () => new ScriptedBugFixAdapter(),
  "small-feature": () => new ScriptedSmallFeatureAdapter(),
  "repo-reasoning": () => new ScriptedRepoReasoningAdapter(),
};

const buildAdapter = (
  benchmark: BenchmarkName,
  variant: BenchmarkVariant,
): ModelAdapter =>
  variant === "live"
    ? new AnthropicModelAdapter(LIVE_SELECTION)
    : SCRIPTED_ADAPTERS[benchmark]();

export type BenchmarkOptions = {
  benchmark: BenchmarkName;
  variant: BenchmarkVariant;
  /**
   * A model to run instead of the variant's own.
   *
   * The seam exists so the scorer can be tested against an agent that cheats.
   * A scorer nobody has watched reject anything is a scorer that has only ever
   * been observed agreeing.
   */
  adapter?: ModelAdapter | undefined;
  /** Where diff, receipt, event log, and test output are written. */
  artifactsPath?: string | undefined;
  /** Leave the scratch repository on disk for inspection. */
  keepScratch?: boolean | undefined;
};

/**
 * Copies the fixture, hands it to the agent, then scores what came back.
 *
 * The committed fixture is never the working directory. Everything the agent
 * can reach is a throwaway copy under the system temporary directory, made
 * fresh per run and committed to its own Git repository so the diff the
 * benchmark reports is a diff against a named base.
 */
export const runBenchmark = async (
  options: BenchmarkOptions,
): Promise<BenchmarkResult> => {
  const startedAt = Date.now();
  const benchmarkDir = join(BENCHMARKS_DIR, options.benchmark);
  const fixtureDir = join(benchmarkDir, "fixture");
  const hiddenDir = join(benchmarkDir, "hidden");
  const goal = (await readFile(join(benchmarkDir, "goal.txt"), "utf8")).trim();
  const scratchParent = await mkdtemp(join(tmpdir(), "novus-benchmark-"));
  const scratchPath = join(scratchParent, SCRATCH_DIRECTORY[options.benchmark]);
  const artifactsPath =
    options.artifactsPath ??
    join(
      REPO_ROOT,
      ".novus",
      "benchmarks",
      `${new Date().toISOString().replaceAll(":", "-")}-${options.benchmark}-${options.variant}`,
    );

  await cp(fixtureDir, scratchPath, { recursive: true });
  await git(scratchPath, ["init", "--quiet", "--initial-branch=benchmark"]);
  await git(scratchPath, ["add", "--all"]);
  await git(scratchPath, ["commit", "--quiet", "--message", "fixture"]);

  // Writes and commands are enabled here, which the rest of Novus refuses to do
  // by default. The reason it is safe is exactly one fact, so assert it rather
  // than trust it: the repository is a directory this function created under
  // the system temporary directory moments ago. If that ever stops being true,
  // stop before granting anything.
  const realScratch = resolve(scratchPath);

  if (!realScratch.startsWith(resolve(tmpdir()) + sep)) {
    throw new Error(
      `Refusing to run the benchmark against ${realScratch}, which is not a scratch copy under ${tmpdir()}.`,
    );
  }

  const baseline = await runProcess(scratchPath, "npm", ["test"]);

  const adapter =
    options.adapter ?? buildAdapter(options.benchmark, options.variant);
  const eventStore = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    eventStore,
    new FixedModelRouter(adapter.selection),
    [adapter],
    { allowWrites: true, allowCommands: true },
  );

  const session = await sessions.create({
    repositoryPath: scratchPath,
    allowWrites: true,
    allowCommands: true,
  });

  let runError: string | null = null;

  // The agent's own run_tests spawns through the scrubber in tools.ts, which has
  // no reason to know about Node's test runner. When this benchmark is itself
  // running from the gate, NODE_TEST_CONTEXT is set on this process and would be
  // inherited into the fixture's suite, which then exits 0 whatever it found —
  // and the receipt would report a green suite the agent never actually saw.
  // Take it off for the duration of the run and put it back afterwards.
  const inheritedTestContext = process.env.NODE_TEST_CONTEXT;

  delete process.env.NODE_TEST_CONTEXT;

  try {
    await session.runner.run({
      sessionId: session.id,
      actorId: "benchmark",
      goal,
    });
  } catch (error) {
    // A thrown run is a result, not a crash: a missing adapter or a provider
    // rejection is exactly the kind of failure the benchmark exists to report.
    runError = (error as Error).message;
  } finally {
    killRunningCommands();

    if (inheritedTestContext !== undefined) {
      process.env.NODE_TEST_CONTEXT = inheritedTestContext;
    }
  }

  const events = eventStore.list(session.id);
  const receiptEvent = events.find((event) => event.type === "receipt.created");
  const receipt =
    receiptEvent?.type === "receipt.created" ? receiptEvent.payload.receipt : null;

  // Staged rather than worked out from `git status`, so a file the run created
  // shows up in the diff instead of being invisible as an untracked path.
  await git(scratchPath, ["add", "--all"]);
  const diffOutcome = await git(scratchPath, ["diff", "--cached"]);
  const nameStatus = await git(scratchPath, [
    "diff",
    "--cached",
    "--name-status",
  ]);

  const changedRows = nameStatus.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split("\t"));

  const changedPaths = changedRows.flatMap((row) => row.slice(1));
  // Adding a test is allowed; changing or removing one that shipped with the
  // fixture is the cheat the hidden test exists to catch, named here so a
  // reviewer sees the reason rather than only the verdict.
  const tamperedTests = changedRows
    .filter((row) => !(row[0] ?? "").startsWith("A"))
    .filter((row) => row.slice(1).some((path) => path.startsWith("tests/")))
    .map((row) => row.join(" "));

  const visible = await runProcess(scratchPath, "npm", ["test"]);

  // Every file in the benchmark's hidden/ directory, named explicitly rather
  // than globbed: these are spawned without a shell, so a pattern would arrive
  // at Node as a literal and quietly match nothing — a hidden suite that ran no
  // tests and exited 0 would be the scorer agreeing with everything again.
  await mkdir(join(scratchPath, HIDDEN_TEST_DIR), { recursive: true });

  const hiddenFiles = (await readdir(hiddenDir))
    .filter((file) => file.endsWith(".test.js"))
    .sort();

  if (hiddenFiles.length === 0) {
    throw new Error(
      `The ${options.benchmark} benchmark has no hidden test in ${hiddenDir}, so a pass would mean only that the agent satisfied the tests it could read.`,
    );
  }

  await Promise.all(
    hiddenFiles.map((file) =>
      cp(join(hiddenDir, file), join(scratchPath, HIDDEN_TEST_DIR, file)),
    ),
  );

  const hidden = await runProcess(scratchPath, "node", [
    "--test",
    ...hiddenFiles.map((file) => join(HIDDEN_TEST_DIR, file)),
  ]);

  const diffProduced = diffOutcome.stdout.trim().length > 0;
  const diffLines = diffProduced ? diffOutcome.stdout.trimEnd().split("\n").length : 0;

  const checks: BenchmarkCheck[] = [
    {
      label: "fixture was broken before the run",
      passed: baseline.exitCode !== 0,
      detail:
        baseline.exitCode !== 0
          ? `npm test exited ${baseline.exitCode}`
          : "the fixture's own suite passed before the agent ran — the benchmark is not testing anything",
    },
    {
      label: "visible suite passes",
      passed: visible.exitCode === 0,
      detail: `npm test exited ${visible.exitCode}`,
    },
    {
      label: "hidden regression test passes",
      passed: hidden.exitCode === 0,
      detail: `node --test exited ${hidden.exitCode}`,
    },
    {
      label: "tests were left alone",
      passed: tamperedTests.length === 0,
      detail:
        tamperedTests.length === 0
          ? "no committed test file was modified or deleted"
          : tamperedTests.join("; "),
    },
    {
      label: "diff produced",
      passed: diffProduced,
      detail: diffProduced
        ? `${diffLines} lines across ${changedPaths.length} path(s)`
        : "the working tree is identical to the base commit",
    },
    {
      label: "receipt produced",
      passed: receipt !== null,
      detail:
        receipt === null
          ? (runError ?? "no receipt.created event was emitted")
          : `run ${receipt.status}, ${receipt.toolCalls.length} tool call(s), base ${receipt.base.revision?.slice(0, 8) ?? "unknown"}`,
    },
  ];

  const result: BenchmarkResult = {
    benchmark: options.benchmark,
    variant: options.variant,
    model: adapter.selection,
    goal,
    verdict: checks.every((check) => check.passed) ? "PASS" : "FAIL",
    checks,
    baseline,
    visible,
    hidden,
    diff: { produced: diffProduced, lines: diffLines, changedPaths },
    tamperedTests,
    receipt,
    runError,
    wallClockMs: Date.now() - startedAt,
    scratchPath,
    artifactsPath,
  };

  await mkdir(artifactsPath, { recursive: true });
  await Promise.all([
    writeFile(join(artifactsPath, "diff.patch"), diffOutcome.stdout, "utf8"),
    writeFile(
      join(artifactsPath, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(artifactsPath, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    ),
    writeFile(
      join(artifactsPath, "baseline-test.log"),
      `${baseline.command}\nexit ${baseline.exitCode}\n\n${baseline.stdout}${baseline.stderr}`,
      "utf8",
    ),
    writeFile(
      join(artifactsPath, "visible-test.log"),
      `${visible.command}\nexit ${visible.exitCode}\n\n${visible.stdout}${visible.stderr}`,
      "utf8",
    ),
    writeFile(
      join(artifactsPath, "hidden-test.log"),
      `${hidden.command}\nexit ${hidden.exitCode}\n\n${hidden.stdout}${hidden.stderr}`,
      "utf8",
    ),
    writeFile(
      join(artifactsPath, "result.json"),
      `${JSON.stringify({ ...result, baseline: undefined, visible: undefined, hidden: undefined }, null, 2)}\n`,
      "utf8",
    ),
  ]);

  if (!options.keepScratch) {
    await rm(scratchParent, { recursive: true, force: true });
  }

  return result;
};

/** Tokens as the receipt reports them, including that they may be a floor. */
const formatUsage = (receipt: RunReceipt | null): string => {
  if (!receipt) {
    return "no receipt";
  }

  const { inputTokens, outputTokens, modelCalls, callsMissingUsage } =
    receipt.usage;

  if (callsMissingUsage >= modelCalls) {
    return `not reported · ${modelCalls} model call(s), none reporting usage`;
  }

  return `${callsMissingUsage > 0 ? "≥" : ""}${inputTokens} in / ${outputTokens} out over ${modelCalls} call(s)${
    callsMissingUsage > 0 ? ` (${callsMissingUsage} without usage)` : ""
  }`;
};

export const formatBenchmarkResult = (result: BenchmarkResult): string => {
  const lines = [
    "",
    `${result.benchmark} benchmark · ${result.variant} · ${result.model.provider}/${result.model.model}`,
    "",
  ];

  for (const check of result.checks) {
    lines.push(
      `  ${check.passed ? "✓" : "✗"} ${check.label.padEnd(34)} ${check.detail}`,
    );
  }

  lines.push(
    "",
    `  tokens   ${formatUsage(result.receipt)}`,
    `  elapsed  ${Math.round(result.wallClockMs / 100) / 10}s wall${
      result.receipt
        ? ` · ${Math.round(result.receipt.elapsedMs / 100) / 10}s in the run`
        : ""
    }`,
    `  files    ${result.receipt ? result.receipt.filesChanged.map((file) => `${file.path} (+${file.additions}/-${file.deletions})`).join(", ") || "none patched" : "unknown"}`,
  );

  if (result.receipt?.summary) {
    lines.push("", `  ${result.receipt.summary.replaceAll("\n", "\n  ")}`);
  }

  if (result.runError) {
    lines.push("", `  run error: ${result.runError}`);
  }

  lines.push(
    "",
    `  artifacts ${result.artifactsPath}`,
    "",
    `BENCHMARK ${result.verdict}`,
    "",
  );

  return lines.join("\n");
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const variant: BenchmarkVariant =
    argv.includes("--live") || process.env.NOVUS_BENCHMARK_LIVE === "1"
      ? "live"
      : "scripted";

  const named = argv.filter((argument) => !argument.startsWith("-"));
  const unknown = named.filter((argument) => !isBenchmarkName(argument));

  if (unknown.length > 0) {
    console.error(
      `Unknown benchmark: ${unknown.join(", ")}. Known: ${BENCHMARK_NAMES.join(", ")}.`,
    );
    process.exit(2);
  }

  const selected: readonly BenchmarkName[] =
    named.length > 0 && !argv.includes("--all")
      ? (named as BenchmarkName[])
      : BENCHMARK_NAMES;

  // Sequential on purpose. Each run spawns a test suite and a coding agent
  // against its own scratch repository, and the numbers a benchmark reports —
  // elapsed time above all — mean less when three of them were competing for
  // the same machine.
  const results: BenchmarkResult[] = [];

  for (const benchmark of selected) {
    const result = await runBenchmark({
      benchmark,
      variant,
      keepScratch: argv.includes("--keep"),
    });

    console.log(formatBenchmarkResult(result));
    results.push(result);
  }

  if (results.length > 1) {
    console.log(
      [
        "",
        ...results.map(
          (result) =>
            `  ${result.verdict === "PASS" ? "✓" : "✗"} ${result.benchmark.padEnd(16)} ${result.verdict}`,
        ),
        "",
        `BENCHMARKS ${results.every((result) => result.verdict === "PASS") ? "PASS" : "FAIL"} · ${results.filter((result) => result.verdict === "PASS").length}/${results.length}`,
        "",
      ].join("\n"),
    );
  }

  process.exit(
    results.every((result) => result.verdict === "PASS") ? 0 : 1,
  );
}
