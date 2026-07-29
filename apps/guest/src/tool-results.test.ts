import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUnifiedDiff } from "./diff.ts";
import { describeWorkingTree } from "./tool-results.ts";

test("an unreadable repository never reads as a clean one", () => {
  // The worker returns null rather than false when git could not be run, for
  // exactly this reason. A panel that renders `clean ? … : …` tells the guest
  // the most reassuring of the three answers.
  const unknown = describeWorkingTree({ branch: null, clean: null, files: [] });

  assert.equal(unknown.certainty, "unknown");
  assert.doesNotMatch(unknown.state, /^clean/);
  assert.match(unknown.state, /unknown/);
  assert.match(unknown.state, /not a report that nothing changed/);
});

test("a clean tree and a dirty tree say which they are", () => {
  const clean = describeWorkingTree({ branch: "main", clean: true, files: [] });

  assert.equal(clean.certainty, "clean");
  assert.equal(clean.branch, "main");
  assert.equal(clean.state, "clean");

  const dirty = describeWorkingTree({
    branch: "main",
    clean: false,
    files: [
      { path: "src/app.tsx", status: "M", staged: false },
      { path: "src/new.ts", status: "??", staged: false },
    ],
  });

  assert.equal(dirty.certainty, "dirty");
  assert.equal(dirty.state, "2 files changed");

  // The worker caps the file list, so "dirty with nothing listed" is reachable
  // and still must not fall through to something that sounds clean.
  const capped = describeWorkingTree({ branch: null, clean: false, files: [] });

  assert.equal(capped.certainty, "dirty");
  assert.equal(capped.branch, "detached HEAD");
  assert.match(capped.state, /changed/);
});

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
