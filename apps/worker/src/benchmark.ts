import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
 * The bug-fix benchmark from V1_README's *Evaluation* section, and its scorer.
 *
 * Milestone 2's exit condition is "the agent completes the bug-fix benchmark
 * locally and produces a reproducible diff and test receipt". Every part of
 * that sentence existed before this file did, and none of it had been observed
 * happening at once. This runs it and says what actually occurred.
 *
 * Two things are load-bearing about how it scores. It re-runs the fixture's own
 * suite itself rather than believing the run_tests result the agent saw, and it
 * runs a hidden test the agent could not read. Between them they close the two
 * ways a run can look successful without being it: reporting a green suite that
 * was green for the wrong reason, and passing the visible test by deleting or
 * special-casing it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BENCHMARK_DIR = join(REPO_ROOT, "benchmarks", "bug-fix");
const FIXTURE_DIR = join(BENCHMARK_DIR, "fixture");
const HIDDEN_TEST_SOURCE = join(BENCHMARK_DIR, "hidden", "regression.test.js");
const GOAL_FILE = join(BENCHMARK_DIR, "goal.txt");

// Copied in only after the agent has stopped, so it is never on disk while the
// agent can search, read, or run it. The leading dot also keeps it out of the
// fixture's own `tests/*.test.js` glob if the ordering ever changed.
const HIDDEN_TEST_DIR = ".novus-hidden";

const SCRIPTED_SELECTION: ModelSelection = {
  provider: "scripted",
  model: "bug-fix-fixture",
};

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
  readonly selection: ModelSelection = SCRIPTED_SELECTION;

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

const buildAdapter = (variant: BenchmarkVariant): ModelAdapter =>
  variant === "live"
    ? new AnthropicModelAdapter(LIVE_SELECTION)
    : new ScriptedBugFixAdapter();

export type BenchmarkOptions = {
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
export const runBugFixBenchmark = async (
  options: BenchmarkOptions,
): Promise<BenchmarkResult> => {
  const startedAt = Date.now();
  const goal = (await readFile(GOAL_FILE, "utf8")).trim();
  const scratchParent = await mkdtemp(join(tmpdir(), "novus-benchmark-"));
  const scratchPath = join(scratchParent, "throttle");
  const artifactsPath =
    options.artifactsPath ??
    join(
      REPO_ROOT,
      ".novus",
      "benchmarks",
      `${new Date().toISOString().replaceAll(":", "-")}-${options.variant}`,
    );

  await cp(FIXTURE_DIR, scratchPath, { recursive: true });
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

  const adapter = options.adapter ?? buildAdapter(options.variant);
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

  await mkdir(join(scratchPath, HIDDEN_TEST_DIR), { recursive: true });
  await cp(
    HIDDEN_TEST_SOURCE,
    join(scratchPath, HIDDEN_TEST_DIR, "regression.test.js"),
  );

  const hidden = await runProcess(scratchPath, "node", [
    "--test",
    join(HIDDEN_TEST_DIR, "regression.test.js"),
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
    `bug-fix benchmark · ${result.variant} · ${result.model.provider}/${result.model.model}`,
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

  const result = await runBugFixBenchmark({
    variant,
    keepScratch: argv.includes("--keep"),
  });

  console.log(formatBenchmarkResult(result));
  process.exit(result.verdict === "PASS" ? 0 : 1);
}
