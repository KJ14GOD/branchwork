import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

import {
  detectPackageManager,
  readPackageManifest,
  runProcess,
  type AgentTool,
  type CommandOutcome,
} from "./tools.ts";

/**
 * Typecheck and lint as first-class tools.
 *
 * The value over run_command is not that the checker runs — run_command could
 * do that — it is what comes back: a list of file/line/severity/message the
 * model can act on and the UI can render, instead of a wall of stdout in a
 * format that differs per checker. The parsing is best-effort over formats
 * nobody standardised, so the checker's own words are kept (tail-capped)
 * beside the parsed list, and `ok` comes from the exit code rather than from
 * the parse — zero recognised diagnostics must never read as a clean run.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTICS = 200;
const MAX_RAW_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 500;

export type Diagnostic = {
  path: string | null;
  line: number | null;
  column: number | null;
  severity: "error" | "warning";
  message: string;
  code: string | null;
};

/**
 * `tsc --pretty false` lines: `src/a.ts(12,5): error TS2322: message`, and the
 * locationless kind a tsconfig problem produces: `error TS5023: message`.
 * Indented lines that follow are the message's own continuation — tsc wraps
 * elaborations that way — and are folded into the diagnostic they follow.
 */
const TSC_LOCATED = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_LOCATIONLESS = /^(error|warning)\s+(TS\d+):\s+(.*)$/;

export const parseTscOutput = (text: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const line of text.split("\n")) {
    const located = TSC_LOCATED.exec(line);

    if (located) {
      diagnostics.push({
        path: located[1]!,
        line: Number(located[2]),
        column: Number(located[3]),
        severity: located[4] as "error" | "warning",
        message: located[6]!,
        code: located[5]!,
      });
      continue;
    }

    const bare = TSC_LOCATIONLESS.exec(line);

    if (bare) {
      diagnostics.push({
        path: null,
        line: null,
        column: null,
        severity: bare[1] as "error" | "warning",
        message: bare[3]!,
        code: bare[2]!,
      });
      continue;
    }

    const last = diagnostics.at(-1);

    if (last && /^\s+\S/.test(line) && last.message.length < MAX_MESSAGE_CHARS) {
      last.message = `${last.message} ${line.trim()}`.slice(0, MAX_MESSAGE_CHARS);
    }
  }

  return diagnostics;
};

/**
 * ESLint's default "stylish" format: a path on its own line, then indented
 * `12:5  error  message  rule-id` rows under it. The rule id is separated
 * from the message by two-plus spaces, which is also the only thing
 * separating them — a message containing a double space would fool this,
 * which is one of the reasons the raw text is kept alongside.
 */
const STYLISH_ROW =
  /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([\w@/-]+))?\s*$/;

export const parseStylishOutput = (
  text: string,
  repositoryRoot: string,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  let currentPath: string | null = null;
  const rootPrefix = repositoryRoot.endsWith("/")
    ? repositoryRoot
    : `${repositoryRoot}/`;

  for (const line of text.split("\n")) {
    const row = STYLISH_ROW.exec(line);

    if (row && currentPath !== null) {
      diagnostics.push({
        path: currentPath,
        line: Number(row[1]),
        column: Number(row[2]),
        severity: row[3] as "error" | "warning",
        message: (row[4] ?? "").trim().slice(0, MAX_MESSAGE_CHARS) || "(no message)",
        code: row[5] ?? null,
      });
      continue;
    }

    // A header line is a bare path: no leading whitespace, and it has to look
    // like a file rather than a sentence — stylish prints absolute paths.
    if (/^\S/.test(line) && line.includes("/") && !line.includes(" ")) {
      currentPath = line.startsWith(rootPrefix)
        ? line.slice(rootPrefix.length)
        : line;
    }
  }

  return diagnostics;
};

/** ESLint's `--format json`: exact structure, no guessing. */
export const parseEslintJson = (
  text: string,
  repositoryRoot: string,
): Diagnostic[] | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const rootPrefix = repositoryRoot.endsWith("/")
    ? repositoryRoot
    : `${repositoryRoot}/`;
  const diagnostics: Diagnostic[] = [];

  for (const file of parsed) {
    if (typeof file !== "object" || file === null) {
      continue;
    }

    const filePath = (file as { filePath?: unknown }).filePath;
    const messages = (file as { messages?: unknown }).messages;

    if (typeof filePath !== "string" || !Array.isArray(messages)) {
      continue;
    }

    const path = filePath.startsWith(rootPrefix)
      ? filePath.slice(rootPrefix.length)
      : filePath;

    for (const message of messages) {
      if (typeof message !== "object" || message === null) {
        continue;
      }

      const record = message as {
        line?: unknown;
        column?: unknown;
        severity?: unknown;
        message?: unknown;
        ruleId?: unknown;
      };

      diagnostics.push({
        path,
        line: typeof record.line === "number" && record.line > 0 ? record.line : null,
        column:
          typeof record.column === "number" && record.column > 0
            ? record.column
            : null,
        severity: record.severity === 1 ? "warning" : "error",
        message:
          typeof record.message === "string" && record.message.length > 0
            ? record.message.slice(0, MAX_MESSAGE_CHARS)
            : "(no message)",
        code: typeof record.ruleId === "string" ? record.ruleId : null,
      });
    }
  }

  return diagnostics;
};

/**
 * `path:line:col: message` — the convention a long tail of tools share. The
 * last resort, because it is also the loosest: it only runs when the
 * specific parsers recognised nothing, so a checker Novus has never heard of
 * degrades to this before degrading to raw text alone.
 */
const GENERIC_ROW = /^(\S[^:\n]*):(\d+)(?::(\d+))?:\s+(?:(error|warning)[:\s]\s*)?(\S.*)$/;

export const parseGenericOutput = (text: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const line of text.split("\n")) {
    const row = GENERIC_ROW.exec(line);

    if (!row) {
      continue;
    }

    diagnostics.push({
      path: row[1]!,
      line: Number(row[2]),
      column: row[3] ? Number(row[3]) : null,
      severity: row[4] === "warning" ? "warning" : "error",
      message: row[5]!.slice(0, MAX_MESSAGE_CHARS),
      code: null,
    });
  }

  return diagnostics;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

type DiagnosticsPlan = {
  command: string;
  args: readonly string[];
  /** How the output should be read, when known ahead of running it. */
  format: "tsc" | "eslint-json" | "unknown";
};

const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "tsc"];

const planTypecheck = async (repositoryRoot: string): Promise<DiagnosticsPlan> => {
  const manifest = await readPackageManifest(repositoryRoot, "run_diagnostics");
  const script = TYPECHECK_SCRIPTS.find((name) => manifest.scripts?.[name]);

  if (script) {
    return {
      command: await detectPackageManager(repositoryRoot),
      args: ["run", script],
      format: "unknown",
    };
  }

  // No script, but a TypeScript project all the same: run the project's own
  // installed compiler. The package's bin file rather than node_modules/.bin,
  // because pnpm writes shell wrappers there and this must stay `node <file>`
  // — a fixed program, no shell, no PATH lookup inside the repository.
  const tscBin = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");

  if (
    (await exists(resolve(repositoryRoot, "tsconfig.json"))) &&
    (await exists(tscBin))
  ) {
    return {
      command: "node",
      args: [tscBin, "--noEmit", "--pretty", "false"],
      format: "tsc",
    };
  }

  throw new Error(
    `run_diagnostics found no way to typecheck this project: no ${TYPECHECK_SCRIPTS.map((name) => `"${name}"`).join(", ")} script in package.json, and no tsconfig.json with an installed typescript to fall back to.`,
  );
};

const planLint = async (repositoryRoot: string): Promise<DiagnosticsPlan> => {
  const manifest = await readPackageManifest(repositoryRoot, "run_diagnostics");

  if (manifest.scripts?.["lint"]) {
    return {
      command: await detectPackageManager(repositoryRoot),
      args: ["run", "lint"],
      format: "unknown",
    };
  }

  const eslintBin = resolve(repositoryRoot, "node_modules/eslint/bin/eslint.js");

  if (await exists(eslintBin)) {
    // --format json because when Novus composes the invocation itself it can
    // ask for structure instead of parsing a display format.
    return {
      command: "node",
      args: [eslintBin, ".", "--format", "json"],
      format: "eslint-json",
    };
  }

  throw new Error(
    'run_diagnostics found no way to lint this project: no "lint" script in package.json and no installed eslint to fall back to.',
  );
};

const parseDiagnostics = (
  plan: DiagnosticsPlan,
  outcome: CommandOutcome,
  repositoryRoot: string,
): Diagnostic[] => {
  const combined = `${outcome.stdout}\n${outcome.stderr}`;

  if (plan.format === "eslint-json") {
    // JSON arrives on stdout alone; stderr is eslint's own complaints, which
    // the raw text carries.
    const parsed = parseEslintJson(outcome.stdout, repositoryRoot);

    if (parsed !== null) {
      return parsed;
    }
  }

  if (plan.format === "tsc") {
    return parseTscOutput(combined);
  }

  // A script could have run anything, so try the known formats from most to
  // least specific and keep the first that recognises something.
  const tsc = parseTscOutput(combined);

  if (tsc.length > 0) {
    return tsc;
  }

  const eslintJson = parseEslintJson(outcome.stdout, repositoryRoot);

  if (eslintJson !== null && eslintJson.length > 0) {
    return eslintJson;
  }

  const stylish = parseStylishOutput(combined, repositoryRoot);

  if (stylish.length > 0) {
    return stylish;
  }

  return parseGenericOutput(combined);
};

export class RunDiagnosticsTool implements AgentTool {
  readonly name = "run_diagnostics";
  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The run_diagnostics tool cannot execute ${call.name}.`);
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    const plan =
      call.input.kind === "typecheck"
        ? await planTypecheck(repositoryRoot)
        : await planLint(repositoryRoot);

    const outcome = await runProcess(
      repositoryRoot,
      plan.command,
      plan.args,
      call.input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    // ESLint exits 1 when it found problems and 2 when it could not run at
    // all; tsc exits 2 on type errors. `ok` only ever means "the checker ran
    // and exited clean" — and the parse still runs when it did, because a
    // clean exit can carry warnings (eslint exits 0 on warning-only output)
    // and dropping those would hide exactly the list this tool exists for.
    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    const diagnostics = parseDiagnostics(plan, outcome, repositoryRoot);
    const raw = `${outcome.stdout}\n${outcome.stderr}`.trim();

    return ToolResultSchema.parse({
      toolCallId: call.id,
      name: this.name,
      output: {
        kind: call.input.kind,
        command: outcome.command,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        ok,
        diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
        diagnosticsTruncated: diagnostics.length > MAX_DIAGNOSTICS,
        // The tail rather than the head: checkers print summaries and the
        // final errors last, and the front of a long run is progress noise.
        raw: raw.slice(-MAX_RAW_CHARS),
        rawTruncated: raw.length > MAX_RAW_CHARS || outcome.truncated,
      },
    });
  }
}
