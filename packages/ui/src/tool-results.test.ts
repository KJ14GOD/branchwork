import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeWorkingTree,
  summariseCall,
  summariseToolResult,
} from "./tool-results.ts";

test("an unreadable repository never reads as a clean one", () => {
  // The worker returns null rather than false when git could not be run, for
  // exactly this reason. A panel that renders `clean ? … : …` tells the reader
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

test("a requested call says what it is about to do", () => {
  assert.equal(
    summariseCall({ id: "c1", name: "read_file", input: { path: "src/a.ts" } }),
    "src/a.ts",
  );

  assert.equal(
    summariseCall({
      id: "c2",
      name: "search_repository",
      input: { query: "listen", path: "apps" },
    }),
    '"listen" in apps',
  );

  // An omitted directory is the repository root, and a row that printed nothing
  // would read as a call with no argument rather than a call on everything.
  assert.equal(
    summariseCall({ id: "c3", name: "list_directory", input: {} }),
    ".",
  );

  assert.equal(
    summariseCall({ id: "c4", name: "run_tests", input: { args: [] } }),
    "full suite",
  );

  assert.equal(
    summariseCall({ id: "c5", name: "apply_patch", input: { patchId: "p1" } }),
    "p1",
  );
});

test("a completed git_status keeps its third answer in the summary too", () => {
  // The collapsed line above the panel has the same trap as the panel itself:
  // two booleans' worth of states in one ternary loses the unreadable case.
  assert.equal(
    summariseToolResult({
      toolCallId: "c1",
      name: "git_status",
      output: { branch: null, clean: null, files: [] },
    }),
    "status unavailable",
  );

  assert.equal(
    summariseToolResult({
      toolCallId: "c2",
      name: "git_status",
      output: { branch: "main", clean: true, files: [] },
    }),
    "working tree clean",
  );

  assert.equal(
    summariseToolResult({
      toolCallId: "c3",
      name: "git_status",
      output: {
        branch: "main",
        clean: false,
        files: [{ path: "a.ts", status: "M", staged: false }],
      },
    }),
    "1 file dirty",
  );
});

test("a completed tool counts what it found in the reader's grammar", () => {
  assert.equal(
    summariseToolResult({
      toolCallId: "c1",
      name: "search_repository",
      output: { query: "listen", matches: [] },
    }),
    '0 matches for "listen"',
  );

  assert.equal(
    summariseToolResult({
      toolCallId: "c2",
      name: "list_directory",
      output: {
        path: "src",
        entries: [{ name: "a.ts", kind: "file" }],
        truncated: false,
      },
    }),
    "1 entry",
  );

  assert.equal(
    summariseToolResult({
      toolCallId: "c3",
      name: "git_diff",
      output: { staged: false, diff: "", filesChanged: 2, truncated: false },
    }),
    "2 files in diff",
  );
});
