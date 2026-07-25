import assert from "node:assert/strict";
import test from "node:test";

import { buildUnifiedDiff } from "./diff.ts";

test("renders a unified diff with surrounding context", () => {
  const before = ["one", "two", "three", "four", "five", "six"].join("\n") + "\n";
  const after = ["one", "two", "THREE", "four", "five", "six"].join("\n") + "\n";

  const { diff, additions, deletions } = buildUnifiedDiff(
    "src/example.ts",
    before,
    after,
  );

  assert.equal(additions, 1);
  assert.equal(deletions, 1);
  assert.equal(
    diff,
    [
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,6 +1,6 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
      " six",
      "",
    ].join("\n"),
  );
});

test("separates distant changes into independent hunks", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[1] = "changed top";
  after[17] = "changed bottom";

  const { diff, additions, deletions } = buildUnifiedDiff(
    "src/example.ts",
    `${before.join("\n")}\n`,
    `${after.join("\n")}\n`,
  );

  assert.equal(additions, 2);
  assert.equal(deletions, 2);

  const hunkHeaders = diff
    .split("\n")
    .filter((line) => line.startsWith("@@"));

  assert.deepEqual(hunkHeaders, ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
});

test("reports pure insertions and deletions", () => {
  const inserted = buildUnifiedDiff("a.txt", "one\n", "one\ntwo\n");
  assert.equal(inserted.additions, 1);
  assert.equal(inserted.deletions, 0);
  assert.match(inserted.diff, /^\+two$/m);

  const deleted = buildUnifiedDiff("a.txt", "one\ntwo\n", "one\n");
  assert.equal(deleted.additions, 0);
  assert.equal(deleted.deletions, 1);
  assert.match(deleted.diff, /^-two$/m);
});

test("marks a missing trailing newline", () => {
  const { diff } = buildUnifiedDiff("a.txt", "one\ntwo", "one\nTWO");

  assert.match(diff, /\\ No newline at end of file/);
});

test("returns an empty diff when nothing changed", () => {
  const { diff, additions, deletions } = buildUnifiedDiff(
    "a.txt",
    "same\n",
    "same\n",
  );

  assert.equal(diff, "");
  assert.equal(additions, 0);
  assert.equal(deletions, 0);
});
