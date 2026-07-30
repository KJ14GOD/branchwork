import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { listDirectory, readFileForViewer, resolveInTree } from "./fs-browser.ts";

describe("fs-browser", () => {
  let root: string;
  let outside: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "novus-tree-"));
    // Named so a bare prefix comparison — the mistake the containment check
    // exists to catch — would wrongly call it inside `root`.
    outside = `${root}-secret`;

    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "README.md"), "# hi\n");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await writeFile(outside, "nope");
    await symlink(outside, join(root, "escape-link"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  test("lists a directory, directories first then alphabetical", async () => {
    const entries = await listDirectory(root, ".");
    const names = entries.map((entry) => entry.name);

    // src (a directory) sorts ahead of everything else despite the alphabet;
    // escape-link (a symlink) and README.md are both plain entries within
    // the non-directory group. .env and .git are absent entirely, checked
    // below — listing shows a symlink exists (as apps/worker's own
    // list_directory does), confinement only bites when something tries to
    // read through it, covered by its own test below.
    assert.deepEqual(names, ["src", "escape-link", "README.md"]);
    assert.equal(entries[0]?.kind, "directory");
    assert.equal(entries[1]?.kind, "symlink");
  });

  test("never lists .git or .env", async () => {
    const entries = await listDirectory(root, ".");
    const names = entries.map((entry) => entry.name);

    assert.ok(!names.includes(".git"));
    assert.ok(!names.includes(".env"));
  });

  test("reads a real file's content", async () => {
    const content = await readFileForViewer(root, "src/index.ts");

    assert.deepEqual(content, {
      kind: "text",
      content: "export const x = 1;\n",
      truncated: false,
    });
  });

  test("refuses an absolute path", async () => {
    await assert.rejects(resolveInTree(root, "/etc/passwd"), /repository-relative/);
  });

  test("refuses a path that climbs out with ..", async () => {
    await assert.rejects(resolveInTree(root, "../secret"), /outside the repository/);
  });

  test("refuses .git even by an exact relative path", async () => {
    await assert.rejects(resolveInTree(root, ".git/config"), /protected/);
  });

  test("refuses .env even by an exact relative path", async () => {
    await assert.rejects(resolveInTree(root, ".env"), /protected/);
  });

  test("a symlink pointing outside the repository is refused, not followed", async () => {
    await assert.rejects(resolveInTree(root, "escape-link"), /outside the repository/);
  });

  test("a binary file is reported as binary, not decoded as text", async () => {
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));

    const content = await readFileForViewer(root, "blob.bin");

    assert.deepEqual(content, { kind: "binary" });
  });

  test("a file larger than the cap is truncated, not refused", async () => {
    const big = "x".repeat(2_500_000);
    await writeFile(join(root, "big.txt"), big);

    const content = await readFileForViewer(root, "big.txt");

    assert.equal(content.kind, "text");
    if (content.kind === "text") {
      assert.equal(content.truncated, true);
      assert.equal(content.content.length, 2_000_000);
    }
  });

  test("resolveInTree returns repository-relative posix paths from listDirectory", async () => {
    const entries = await listDirectory(root, "src");

    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["src/index.ts"],
    );
  });
});
