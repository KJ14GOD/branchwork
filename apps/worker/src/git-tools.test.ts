import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GitDiffTool, GitStatusTool, ListDirectoryTool } from "./tools.ts";

const run = promisify(execFile);

const gitRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-git-"));

  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "one\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "initial"], { cwd: root });

  return root;
};

test("list_directory reports entries and their kinds", async () => {
  const root = await gitRepository();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export {};\n");

  const result = await new ListDirectoryTool(root).execute({
    id: "1",
    name: "list_directory",
    input: { path: "src" },
  });

  if (result.name !== "list_directory") return assert.fail("wrong result");

  assert.equal(result.output.path, "src");
  assert.deepEqual(result.output.entries, [
    { name: "index.ts", kind: "file" },
  ]);
  assert.equal(result.output.truncated, false);
});

test("list_directory hides .git and .env from the listing", async () => {
  const root = await gitRepository();
  await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=leak\n");

  const result = await new ListDirectoryTool(root).execute({
    id: "2",
    name: "list_directory",
    input: {},
  });

  if (result.name !== "list_directory") return assert.fail("wrong result");

  const names = result.output.entries.map((entry) => entry.name);

  // read_file refuses these, so listing them would only advertise a path the
  // agent cannot use and should not be thinking about.
  assert.ok(!names.includes(".git"), "listed .git");
  assert.ok(!names.includes(".env"), "listed .env");
  assert.ok(names.includes("tracked.txt"));
});

test("list_directory refuses to escape the repository", async () => {
  const root = await gitRepository();

  await assert.rejects(
    () =>
      new ListDirectoryTool(root).execute({
        id: "3",
        name: "list_directory",
        input: { path: "../.." },
      }),
    /outside the repository/,
  );
});

test("list_directory refuses a symlink that points outside", async () => {
  const root = await gitRepository();
  await symlink(tmpdir(), join(root, "escape"));

  await assert.rejects(
    () =>
      new ListDirectoryTool(root).execute({
        id: "4",
        name: "list_directory",
        input: { path: "escape" },
      }),
    /outside the repository/,
  );
});

test("git_status reports a clean tree, then a dirty one", async () => {
  const root = await gitRepository();

  const clean = await new GitStatusTool(root).execute({
    id: "5",
    name: "git_status",
    input: {},
  });

  if (clean.name !== "git_status") return assert.fail("wrong result");
  assert.equal(clean.output.clean, true);
  assert.deepEqual(clean.output.files, []);
  assert.ok(clean.output.branch);

  await writeFile(join(root, "tracked.txt"), "two\n");

  const dirty = await new GitStatusTool(root).execute({
    id: "6",
    name: "git_status",
    input: {},
  });

  if (dirty.name !== "git_status") return assert.fail("wrong result");
  assert.equal(dirty.output.clean, false);
  assert.equal(dirty.output.files.length, 1);
  assert.equal(dirty.output.files[0]?.path, "tracked.txt");
  assert.equal(dirty.output.files[0]?.staged, false);
});

test("git_status says unknown rather than clean when git cannot run", async () => {
  // A plain directory is not a repository, so the command fails. Reporting that
  // as a clean tree would let the agent conclude nothing changed.
  const notARepository = await mkdtemp(join(tmpdir(), "novus-plain-"));

  const result = await new GitStatusTool(notARepository).execute({
    id: "7",
    name: "git_status",
    input: {},
  });

  if (result.name !== "git_status") return assert.fail("wrong result");

  assert.equal(result.output.clean, null);
  assert.equal(result.output.branch, null);
});

test("git_diff shows unstaged work and counts the files", async () => {
  const root = await gitRepository();
  await writeFile(join(root, "tracked.txt"), "changed\n");

  const result = await new GitDiffTool(root).execute({
    id: "8",
    name: "git_diff",
    input: {},
  });

  if (result.name !== "git_diff") return assert.fail("wrong result");

  assert.equal(result.output.staged, false);
  assert.equal(result.output.filesChanged, 1);
  assert.match(result.output.diff, /-one/);
  assert.match(result.output.diff, /\+changed/);
});

test("git_diff separates staged from unstaged", async () => {
  const root = await gitRepository();
  await writeFile(join(root, "tracked.txt"), "staged\n");
  await run("git", ["add", "tracked.txt"], { cwd: root });

  const unstaged = await new GitDiffTool(root).execute({
    id: "9",
    name: "git_diff",
    input: {},
  });
  const staged = await new GitDiffTool(root).execute({
    id: "10",
    name: "git_diff",
    input: { staged: true },
  });

  if (unstaged.name !== "git_diff" || staged.name !== "git_diff") {
    return assert.fail("wrong result");
  }

  assert.equal(unstaged.output.filesChanged, 0);
  assert.equal(staged.output.filesChanged, 1);
});

test("git_diff will not diff a path outside the repository", async () => {
  const root = await gitRepository();

  await assert.rejects(
    () =>
      new GitDiffTool(root).execute({
        id: "11",
        name: "git_diff",
        input: { path: "../../etc" },
      }),
    /outside the repository/,
  );
});
