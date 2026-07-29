import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("git_status names the file a rename produced, not the arrow", async () => {
  const root = await gitRepository();
  await writeFile(join(root, "sp ace.txt"), "spaced\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "second"], { cwd: root });
  await run("git", ["mv", "tracked.txt", "renamed.txt"], { cwd: root });
  await run("git", ["mv", "sp ace.txt", "sp aced.txt"], { cwd: root });

  const result = await new GitStatusTool(root).execute({
    id: "30",
    name: "git_status",
    input: {},
  });

  if (result.name !== "git_status") return assert.fail("wrong result");

  const paths = result.output.files.map((file) => file.path);

  // Porcelain v1 prints `R  old -> new` on one line and C-quotes a path that
  // contains a space. Slicing the line yielded `tracked.txt -> renamed.txt`
  // and `"sp ace.txt" -> "sp aced.txt"` — strings no other tool can be given.
  assert.deepEqual(paths.sort(), ["renamed.txt", "sp aced.txt"]);
  assert.equal(result.output.files.length, 2);

  for (const file of result.output.files) {
    assert.equal(file.status, "R");
    assert.equal(file.staged, true);
  }
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

test("git_diff does not run a program the repository asked it to", async () => {
  const root = await gitRepository();
  const marker = join(root, "EXECUTED");

  await writeFile(
    join(root, "ext.sh"),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho ran\n`,
    { mode: 0o755 },
  );
  // .git/config belongs to whoever wrote the repository. These tools run with
  // no approval, so honouring this would be arbitrary execution by any repo the
  // agent is pointed at.
  await run("git", ["config", "diff.external", join(root, "ext.sh")], {
    cwd: root,
  });
  await writeFile(join(root, "tracked.txt"), "changed\n");

  const result = await new GitDiffTool(root).execute({
    id: "20",
    name: "git_diff",
    input: {},
  });

  if (result.name !== "git_diff") return assert.fail("wrong result");

  await assert.rejects(() => stat(marker), "the external diff program ran");
  assert.match(result.output.diff, /^diff --git/m);
  assert.doesNotMatch(result.output.diff, /ran/);
});

test("git_status does not run the repository's fsmonitor hook", async () => {
  const root = await gitRepository();
  const marker = join(root, "FSMONITOR");

  await writeFile(
    join(root, "fsm.sh"),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
    { mode: 0o755 },
  );
  await run("git", ["config", "core.fsmonitor", join(root, "fsm.sh")], {
    cwd: root,
  });

  await new GitStatusTool(root).execute({
    id: "21",
    name: "git_status",
    input: {},
  });

  await assert.rejects(() => stat(marker), "the fsmonitor program ran");
});

test("git_diff never prints the contents of .env", async () => {
  const root = await gitRepository();

  await writeFile(join(root, ".env"), "SECRET=before\n");
  await run("git", ["add", "-f", ".env"], { cwd: root });
  await run("git", ["commit", "-qm", "env"], { cwd: root });
  await writeFile(join(root, ".env"), "SECRET=after\n");
  await writeFile(join(root, "tracked.txt"), "changed\n");

  const result = await new GitDiffTool(root).execute({
    id: "22",
    name: "git_diff",
    input: {},
  });

  if (result.name !== "git_diff") return assert.fail("wrong result");

  // read_file refuses .env; a diff that prints it is the same disclosure by
  // another route.
  assert.doesNotMatch(result.output.diff, /SECRET=after/);
  assert.match(result.output.diff, /tracked\.txt/);
});

test("git tools refuse a directory inside a larger repository", async () => {
  const root = await gitRepository();
  const inner = join(root, "packages", "inner");

  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, "own.txt"), "inner\n");

  // Git walks up to find its top level, so reporting from here would describe
  // — and diff — files above the directory that was actually selected.
  await assert.rejects(
    () =>
      new GitDiffTool(inner).execute({ id: "23", name: "git_diff", input: {} }),
    /inside a larger Git repository/,
  );

  const status = await new GitStatusTool(inner).execute({
    id: "24",
    name: "git_status",
    input: {},
  });

  if (status.name !== "git_status") return assert.fail("wrong result");
  assert.equal(status.output.clean, null);
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

test("git_diff can diff a file that was deleted", async () => {
  const root = await gitRepository();
  await rm(join(root, "tracked.txt"));

  // "Read back what my patch changed" is what this tool is for, and a deletion
  // is a change. Resolving the path through realpath meant the one diff that
  // proves the file is gone was the one diff it refused to produce.
  const result = await new GitDiffTool(root).execute({
    id: "31",
    name: "git_diff",
    input: { path: "tracked.txt" },
  });

  if (result.name !== "git_diff") return assert.fail("wrong result");

  assert.equal(result.output.filesChanged, 1);
  assert.match(result.output.diff, /deleted file/);
  assert.match(result.output.diff, /-one/);
});

test("a missing path is still confined to the repository", async () => {
  const root = await gitRepository();
  await symlink(tmpdir(), join(root, "escape"));

  // The confinement is the same rule as before: the missing tail is re-attached
  // to the deepest ancestor that does exist, resolved through its symlinks.
  // Allowing a path to be absent must not allow it to be anywhere.
  for (const path of ["../../etc/passwd", "escape/missing.txt"]) {
    await assert.rejects(
      () =>
        new GitDiffTool(root).execute({
          id: "32",
          name: "git_diff",
          input: { path },
        }),
      /outside the repository/,
      path,
    );
  }

  // A deleted .env is refused for being .env, not for being gone.
  await assert.rejects(
    () =>
      new GitDiffTool(root).execute({
        id: "33",
        name: "git_diff",
        input: { path: ".env" },
      }),
    /protected repository paths/,
  );
});

test("list_directory does not claim truncation for entries it filtered", async () => {
  // A directory holding exactly the cap plus a .env: nothing is dropped, so
  // reporting truncation sends the agent looking for entries that never
  // existed. The count has to be taken after the protected entries are gone.
  const root = await mkdtemp(join(tmpdir(), "novus-full-"));

  await Promise.all(
    Array.from({ length: 500 }, (_unused, index) =>
      writeFile(join(root, `file-${String(index).padStart(3, "0")}.txt`), "x\n"),
    ),
  );
  await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=leak\n");

  const result = await new ListDirectoryTool(root).execute({
    id: "34",
    name: "list_directory",
    input: {},
  });

  if (result.name !== "list_directory") return assert.fail("wrong result");

  assert.equal(result.output.entries.length, 500);
  assert.ok(!result.output.entries.some((entry) => entry.name === ".env"));
  assert.equal(result.output.truncated, false);
});
