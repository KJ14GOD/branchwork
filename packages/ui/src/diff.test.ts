import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUnifiedDiff } from "./diff.ts";

const GIT_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 8f3c1a2..b71d004 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,3 +10,3 @@ export const start = () => {",
  " const port = 4319;",
  "-  listen(port);",
  "+  listen(port, '127.0.0.1');",
  " };",
  "diff --git a/README.md b/README.md",
  "index 1111111..2222222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-Novus",
  "+Novus, a coding harness",
  "\\ No newline at end of file",
].join("\n");

test("a multi-file git diff keeps its headers intact", () => {
  const lines = parseUnifiedDiff(GIT_DIFF);
  const headers = lines
    .filter((line) => line.kind === "meta")
    .map((line) => line.text);

  // A patch-shaped parser treats an unrecognised line as context and slices
  // its first character off, printing "iff --git a/src/app.ts b/src/app.ts".
  assert.ok(headers.includes("diff --git a/src/app.ts b/src/app.ts"));
  assert.ok(headers.includes("diff --git a/README.md b/README.md"));
  assert.ok(headers.includes("index 8f3c1a2..b71d004 100644"));
  assert.ok(headers.includes("\\ No newline at end of file"));
});

test("a hunk without line counts is still a hunk", () => {
  const lines = parseUnifiedDiff(GIT_DIFF);
  const second = lines.find((line) => line.text === "@@ -1 +1 @@");

  // Git omits the count for a single-line hunk. Requiring the comma sent the
  // whole hunk down the header path with its body mangled.
  assert.equal(second?.kind, "hunk");

  const added = lines.find((line) => line.text === "Novus, a coding harness");

  assert.equal(added?.kind, "add");
  assert.equal(added?.afterLine, 1);
});

test("line numbers follow the hunk they are in", () => {
  const lines = parseUnifiedDiff(GIT_DIFF);
  const removed = lines.find((line) => line.kind === "del");
  const added = lines.find((line) => line.kind === "add");
  const context = lines.find((line) => line.kind === "context");

  assert.equal(context?.text, "const port = 4319;");
  assert.equal(context?.beforeLine, 10);
  assert.equal(removed?.text, "  listen(port);");
  assert.equal(removed?.beforeLine, 11);
  assert.equal(added?.afterLine, 11);
});

test("a single-file patch still parses the way it always did", () => {
  const lines = parseUnifiedDiff("@@ -1,1 +1,1 @@\n-old\n+new\n");

  assert.deepEqual(
    lines.map((line) => line.kind),
    ["hunk", "del", "add"],
  );
});

test("a propose_patch diff parses as both copies used to parse it", () => {
  // The shape the worker writes: a --- / +++ pair, then a counted hunk. Both
  // implementations agreed here, and reconciling them must not move it.
  const lines = parseUnifiedDiff(
    [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n"),
  );

  assert.deepEqual(
    lines.map((line) => line.kind),
    ["meta", "meta", "hunk", "context", "del", "add"],
  );
  assert.deepEqual(
    lines.map((line) => line.text),
    [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      "const a = 1;",
      "const b = 2;",
      "const b = 3;",
    ],
  );
});

test("a removed line that reads like a header is still a removed line", () => {
  // The one place the two copies disagreed rather than one merely lagging: a
  // deleted line whose own text starts with "--" arrives as "---", and matching
  // on the prefix called it a header. Inside a hunk the first column is the
  // marker Git wrote, whatever follows it.
  const lines = parseUnifiedDiff("@@ -1,1 +1,1 @@\n---\n+++\n");

  assert.deepEqual(
    lines.map((line) => line.kind),
    ["hunk", "del", "add"],
  );
  assert.equal(lines[1]?.text, "--");
  assert.equal(lines[1]?.beforeLine, 1);
  assert.equal(lines[2]?.text, "++");
  assert.equal(lines[2]?.afterLine, 1);
});
