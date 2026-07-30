import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CheckpointInput } from "./worktree-manager.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { applyDecision } from "./apply-decision.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });

/**
 * A real repository with one committed file, in a scratch directory.
 *
 * The whole point of this module is refusing to overwrite a parent that
 * moved on, and a fake Git cannot be wrong about "moved on" in the way a
 * real one can.
 */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-apply-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "answer.txt"), "parent\n");
  await writeFile(join(root, "other.txt"), "unrelated\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

const checkpointInput = (): CheckpointInput => ({
  sessionId: "session-1",
  parentRunId: "run-parent",
  parentSequence: 3,
  agentState: "Read answer.txt.",
  goal: "Change the answer.",
  model: { provider: "anthropic", model: "claude-opus-4" },
  toolPolicy: { allowWrites: true, allowCommands: false },
});

const managerFor = (root: string) =>
  new WorktreeManager(root, { portBase: 47_300, portsPerFork: 2 });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

test("the chosen attempt's edit lands in the parent's working tree", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    await writeFile(join(fork.worktreePath, "answer.txt"), "attempt a\n");

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, true);
    if (outcome.applied) {
      assert.deepEqual(outcome.files, ["answer.txt"]);
    }
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "attempt a\n");
    // The file the fork never touched is left exactly alone.
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated\n");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an attempt that created a file writes it into the parent", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    await writeFile(join(fork.worktreePath, "new-file.txt"), "brand new\n");

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, true);
    assert.equal(await readFile(join(root, "new-file.txt"), "utf8"), "brand new\n");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an attempt that deleted a file removes it from the parent", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    await rm(join(fork.worktreePath, "other.txt"));

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, true);
    assert.equal(await exists(join(root, "other.txt")), false);
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a real conflicting parent edit refuses the apply and leaves the parent untouched", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    // The fork proposes one change to answer.txt.
    await writeFile(join(fork.worktreePath, "answer.txt"), "attempt a\n");

    // Meanwhile the host keeps working in the parent and commits a
    // *different* change to the same file — a real conflicting edit, not a
    // simulated one.
    await writeFile(join(root, "answer.txt"), "parent moved on\n");
    await git(root, ["commit", "-qam", "parent edits answer.txt too"]);

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, false);
    if (!outcome.applied) {
      assert.equal(outcome.conflicts.length, 1);
      assert.equal(outcome.conflicts[0]?.path, "answer.txt");
    }

    // Refused, not partially applied: the parent's own edit is exactly as it
    // left it.
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent moved on\n");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("one conflicting file refuses the whole apply, not just that file", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    // The fork changes two files.
    await writeFile(join(fork.worktreePath, "answer.txt"), "attempt a\n");
    await writeFile(join(fork.worktreePath, "other.txt"), "attempt touched this too\n");

    // The parent only diverges on one of them.
    await writeFile(join(root, "answer.txt"), "parent moved on\n");
    await git(root, ["commit", "-qam", "parent edits answer.txt"]);

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, false);
    // other.txt would have applied cleanly on its own — proving this is a
    // preflight-then-apply, not a per-file best effort.
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated\n");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an attempt that changed nothing reports nothing to apply", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    const outcome = await applyDecision(root, manager, "fork-a");

    assert.equal(outcome.applied, false);
    if (!outcome.applied) {
      assert.match(outcome.reason, /no changes/);
    }
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("applying twice is a conflict the second time, not a silent double-write", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const fork = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });

    await writeFile(join(fork.worktreePath, "answer.txt"), "attempt a\n");

    const first = await applyDecision(root, manager, "fork-a");
    assert.equal(first.applied, true);

    // The parent's file now equals the fork's, but it no longer equals the
    // checkpoint base the fork started from — applying a second time must
    // not treat that coincidence as a clean base.
    const second = await applyDecision(root, manager, "fork-a");
    assert.equal(second.applied, false);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "attempt a\n");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
