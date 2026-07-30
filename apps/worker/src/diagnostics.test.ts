import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEslintJson,
  parseGenericOutput,
  parseStylishOutput,
  parseTscOutput,
  RunDiagnosticsTool,
} from "./diagnostics.ts";

const temporaryRepository = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-diagnostics-"));

const diagnosticsCall = (id: string, kind: "typecheck" | "lint") =>
  ({ id, name: "run_diagnostics" as const, input: { kind } });

test("parseTscOutput reads located, locationless, and continued messages", () => {
  const parsed = parseTscOutput(
    [
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from property 'port'.",
      "error TS5023: Unknown compiler option 'strick'.",
      "src/b.ts(3,1): warning TS6133: 'x' is declared but never read.",
      "some unrelated line the compiler printed",
    ].join("\n"),
  );

  assert.equal(parsed.length, 3);
  // The located error, with its continuation folded into the message — tsc
  // wraps elaborations onto indented lines, and losing them loses the reason.
  assert.equal(parsed[0]?.path, "src/a.ts");
  assert.equal(parsed[0]?.line, 12);
  assert.equal(parsed[0]?.column, 5);
  assert.equal(parsed[0]?.code, "TS2322");
  assert.match(parsed[0]?.message ?? "", /expected type comes from/);
  // The locationless kind: a tsconfig problem names no file, and inventing
  // one would be a fabricated citation — null is the honest answer.
  assert.equal(parsed[1]?.path, null);
  assert.equal(parsed[1]?.line, null);
  assert.equal(parsed[1]?.code, "TS5023");
  assert.equal(parsed[2]?.severity, "warning");
});

test("parseStylishOutput reads eslint's default format and relativizes paths", () => {
  const parsed = parseStylishOutput(
    [
      "/repo/src/index.js",
      "  10:3   error    Unexpected console statement  no-console",
      "  12:15  warning  'x' is defined but never used  no-unused-vars",
      "",
      "✖ 2 problems (1 error, 1 warning)",
    ].join("\n"),
    "/repo",
  );

  assert.equal(parsed.length, 2);
  // Stylish prints absolute paths; the model works in repository-relative
  // ones, so an absolute path under the root is cut down to what every other
  // tool would call the same file.
  assert.equal(parsed[0]?.path, "src/index.js");
  assert.equal(parsed[0]?.line, 10);
  assert.equal(parsed[0]?.severity, "error");
  assert.equal(parsed[0]?.code, "no-console");
  assert.equal(parsed[1]?.severity, "warning");
  assert.equal(parsed[1]?.code, "no-unused-vars");
});

test("parseEslintJson maps severities and refuses non-JSON quietly", () => {
  const parsed = parseEslintJson(
    JSON.stringify([
      {
        filePath: "/repo/src/a.js",
        messages: [
          { line: 4, column: 2, severity: 2, message: "Bad.", ruleId: "eqeqeq" },
          { line: 9, column: 1, severity: 1, message: "Meh.", ruleId: null },
        ],
      },
    ]),
    "/repo",
  );

  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0]?.severity, "error");
  assert.equal(parsed?.[1]?.severity, "warning");
  assert.equal(parsed?.[1]?.code, null);

  // Not-JSON must be "this parser does not apply", never a throw — a checker
  // that printed half a JSON document is an ordinary event in a truncated
  // stream.
  assert.equal(parseEslintJson("not json at all", "/repo"), null);
});

test("parseGenericOutput reads path:line:col lines and nothing else", () => {
  const parsed = parseGenericOutput(
    [
      "src/lib.rs:14:9: error: mismatched types",
      "compiling 3 files",
      "src/other.c:9: warning: unused variable 'n'",
    ].join("\n"),
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.path, "src/lib.rs");
  assert.equal(parsed[0]?.column, 9);
  assert.equal(parsed[1]?.line, 9);
  assert.equal(parsed[1]?.column, null);
  assert.equal(parsed[1]?.severity, "warning");
});

test("run_diagnostics runs the project's typecheck script and structures its output", async () => {
  const repository = await temporaryRepository();

  // A script that fails the way tsc fails: known format on stdout, exit 2.
  // The emitter is a plain node script so the fixture runs anywhere the
  // suite does, with no real compiler needed.
  await writeFile(
    join(repository, "emit.js"),
    `console.log("src/broken.ts(7,3): error TS2304: Cannot find name 'missing'.");
process.exit(2);
`,
  );
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { typecheck: "node emit.js" },
    }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const result = await new RunDiagnosticsTool(repository).execute(
    diagnosticsCall("1", "typecheck"),
  );

  if (result.name !== "run_diagnostics") return assert.fail("wrong result");

  // The verdict comes from the exit code; the list is the structure the tool
  // exists to add on top of it.
  assert.equal(result.output.ok, false);
  assert.equal(result.output.diagnostics.length, 1);
  assert.equal(result.output.diagnostics[0]?.path, "src/broken.ts");
  assert.equal(result.output.diagnostics[0]?.line, 7);
  assert.equal(result.output.diagnostics[0]?.code, "TS2304");
  // The checker's own words survive beside the parse, so an unrecognised
  // format is degraded evidence rather than no evidence.
  assert.match(result.output.raw, /TS2304/);
});

test("run_diagnostics falls back to the installed tsc when no script exists", async () => {
  const repository = await temporaryRepository();

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  await writeFile(join(repository, "tsconfig.json"), "{}");
  await mkdir(join(repository, "node_modules/typescript/bin"), {
    recursive: true,
  });
  // Stands in for the real compiler: same bin path, same output format. The
  // fallback runs `node <this file>` directly, so a JS file is exactly what
  // the real package provides there too.
  await writeFile(
    join(repository, "node_modules/typescript/bin/tsc"),
    `console.log("index.ts(1,1): error TS1005: ';' expected.");
process.exit(2);
`,
  );

  const result = await new RunDiagnosticsTool(repository).execute(
    diagnosticsCall("2", "typecheck"),
  );

  if (result.name !== "run_diagnostics") return assert.fail("wrong result");

  assert.equal(result.output.ok, false);
  assert.equal(result.output.diagnostics[0]?.code, "TS1005");
  assert.match(result.output.command, /typescript\/bin\/tsc/);
});

test("run_diagnostics reports lint warnings even when the checker exits clean", async () => {
  const repository = await temporaryRepository();

  // ESLint exits 0 when it found only warnings. If the parse were gated on a
  // failing exit, exactly the output this tool exists to surface would be
  // dropped on the floor.
  await writeFile(
    join(repository, "emit.js"),
    `console.log(process.cwd() + "/src/app.js");
console.log("  3:1  warning  Unexpected todo comment  no-warning-comments");
process.exit(0);
`,
  );
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { lint: "node emit.js" } }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const result = await new RunDiagnosticsTool(repository).execute(
    diagnosticsCall("3", "lint"),
  );

  if (result.name !== "run_diagnostics") return assert.fail("wrong result");

  assert.equal(result.output.ok, true);
  assert.equal(result.output.diagnostics.length, 1);
  assert.equal(result.output.diagnostics[0]?.severity, "warning");
  assert.equal(result.output.diagnostics[0]?.path, "src/app.js");
});

test("run_diagnostics explains itself when the project offers no checker", async () => {
  const repository = await temporaryRepository();

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );

  // The refusal lists what was looked for — the model's next move should be
  // obvious from the message alone, not from trying variations.
  await assert.rejects(
    () =>
      new RunDiagnosticsTool(repository).execute(diagnosticsCall("4", "typecheck")),
    /no way to typecheck/,
  );

  await assert.rejects(
    () => new RunDiagnosticsTool(repository).execute(diagnosticsCall("5", "lint")),
    /no way to lint/,
  );
});

test("a failing checker whose output parses to nothing is still a failure with evidence", async () => {
  const repository = await temporaryRepository();

  await writeFile(
    join(repository, "emit.js"),
    `console.error("everything is on fire in a format nobody standardised");
process.exit(1);
`,
  );
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { typecheck: "node emit.js" } }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const result = await new RunDiagnosticsTool(repository).execute(
    diagnosticsCall("6", "typecheck"),
  );

  if (result.name !== "run_diagnostics") return assert.fail("wrong result");

  // Zero parsed diagnostics must never read as a clean run: ok is false from
  // the exit code, and the raw text carries the only evidence there is.
  assert.equal(result.output.ok, false);
  assert.equal(result.output.diagnostics.length, 0);
  assert.match(result.output.raw, /on fire/);
});
