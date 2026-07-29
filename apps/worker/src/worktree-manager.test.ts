import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SessionEventDraftSchema } from "@novus/contracts";

import {
  WorktreeManager,
  checkpointCreatedEvent,
  forkCreatedEvent,
  type CheckpointInput,
} from "./worktree-manager.ts";

const run = promisify(execFile);

const git = (cwd: string, args: string[]) => run("git", args, { cwd });

/**
 * A real repository with one commit, in a scratch directory.
 *
 * Nothing here is faked. The whole claim of this module is that two attempts
 * get genuinely separate working directories, and a fake Git cannot be wrong
 * about that in the way a real one can.
 */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-fork-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "answer.txt"), "parent\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

const checkpointInput = (): CheckpointInput => ({
  sessionId: "session-1",
  parentRunId: "run-parent",
  parentSequence: 12,
  agentState: "Read answer.txt and decided to change it.",
  goal: "Change the answer.",
  model: { provider: "anthropic", model: "claude-opus-4" },
  toolPolicy: { allowWrites: true, allowCommands: false },
  contextManifest: ["answer.txt"],
  constraints: ["Do not touch the tests."],
});

/** Ports are probed for real, so tests stay off the range a host might use. */
const managerFor = (root: string, forkRoot?: string) =>
  new WorktreeManager(root, {
    forkRoot,
    portBase: 47_100,
    portsPerFork: 2,
  });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
};

const branchExists = async (root: string, branch: string): Promise<boolean> =>
  git(root, ["rev-parse", "--verify", "--quiet", branch]).then(
    () => true,
    () => false,
  );

test("a fork is a separate checkout of the checkpoint's commit", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const handle = await manager.createFork(checkpoint, {
      runId: "fork-a",
      label: "Attempt A",
    });

    assert.equal(handle.fork.revision, checkpoint.base.revision);
    assert.equal(handle.fork.checkpointId, checkpoint.id);
    // The fork's stream lives under the parent session, not a new one.
    assert.equal(handle.fork.sessionId, checkpoint.sessionId);
    assert.equal(handle.branch, "novus/fork/fork-a");

    // Outside the repository, which is what keeps it out of the parent's own
    // status, listings, and searches.
    assert.ok(
      !handle.worktreePath.startsWith(`${await realpath(root)}/`),
      `${handle.worktreePath} is inside the repository`,
    );

    const head = await git(handle.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), checkpoint.base.revision);
    assert.equal(
      await readFile(join(handle.worktreePath, "answer.txt"), "utf8"),
      "parent\n",
    );
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("writes in one fork are invisible in the other and in the parent", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const a = await manager.createFork(checkpoint, { runId: "fork-a", label: "A" });
    const b = await manager.createFork(checkpoint, { runId: "fork-b", label: "B" });

    assert.notEqual(a.worktreePath, b.worktreePath);

    await writeFile(join(a.worktreePath, "answer.txt"), "attempt a\n");
    await writeFile(join(a.worktreePath, "only-in-a.txt"), "a\n");
    await writeFile(join(b.worktreePath, "answer.txt"), "attempt b\n");

    // Each attempt sees only its own work — this is the isolation V1 requires,
    // stated as three reads rather than as an assertion about directories.
    assert.equal(await readFile(join(a.worktreePath, "answer.txt"), "utf8"), "attempt a\n");
    assert.equal(await readFile(join(b.worktreePath, "answer.txt"), "utf8"), "attempt b\n");
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");

    assert.equal(await exists(join(b.worktreePath, "only-in-a.txt")), false);
    assert.equal(await exists(join(root, "only-in-a.txt")), false);

    // The parent's own view of itself is unchanged: a fork is not a working
    // copy of the parent's tree, so nothing shows up in its status.
    const status = await git(root, ["status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");

    // Separate branches, and both are separate from the parent's.
    assert.notEqual(a.branch, b.branch);
    const parentBranch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(parentBranch.stdout.trim(), "main");

    // Separate development ports, so two dev servers cannot collide.
    const shared = a.fork.devPorts.filter((port) => b.fork.devPorts.includes(port));
    assert.deepEqual(shared, []);
    assert.notEqual(a.environment.PORT, b.environment.PORT);
    assert.equal(a.environment.NOVUS_REPO, a.worktreePath);
    assert.equal(b.environment.NOVUS_REPO, b.worktreePath);
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork starts from the parent's uncommitted work, and keeps it after the parent moves on", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    await writeFile(join(root, "answer.txt"), "uncommitted\n");

    const checkpoint = await manager.createCheckpoint(checkpointInput());
    assert.notEqual(checkpoint.base.patch, null);

    // The parent throws the work away *after* the checkpoint was taken. An
    // immutable base means the fork still gets it.
    await git(root, ["checkout", "--", "answer.txt"]);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");

    const handle = await manager.createFork(checkpoint, {
      runId: "fork-late",
      label: "Late",
    });

    assert.equal(
      await readFile(join(handle.worktreePath, "answer.txt"), "utf8"),
      "uncommitted\n",
    );
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("teardown removes the worktree, the branch, and Git's record of both", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const handle = await manager.createFork(checkpoint, {
      runId: "fork-temp",
      label: "Temporary",
    });

    assert.equal(await exists(handle.worktreePath), true);
    assert.equal(await branchExists(root, handle.branch), true);

    await manager.removeFork("fork-temp");

    assert.equal(await exists(handle.worktreePath), false);
    assert.equal(await branchExists(root, handle.branch), false);
    assert.equal(manager.get("fork-temp"), undefined);
    assert.deepEqual(manager.list(), []);

    // A registration pointing at a directory that is gone is the failure mode
    // `git worktree prune` exists for, and it makes the path unusable again.
    const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
    assert.ok(
      !worktrees.stdout.includes(handle.worktreePath),
      `git still lists ${handle.worktreePath}`,
    );

    // Proof that the teardown was complete: the same fork can be made again.
    const again = await manager.createFork(checkpoint, {
      runId: "fork-temp",
      label: "Temporary",
    });
    assert.equal(again.worktreePath, handle.worktreePath);
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a creation that fails leaves no half-made worktree behind", async () => {
  const root = await repository();
  const forkRoot = await mkdtemp(join(tmpdir(), "novus-fork-root-"));
  const manager = managerFor(root, forkRoot);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    // A base whose patch cannot apply: the worktree add succeeds, and the step
    // after it fails. That is exactly the shape `scripts/fleet.sh` hit when a
    // worktree was created and its install failed, and its answer was the same
    // — remove the worktree rather than hand anyone a checkout that is not
    // what it claims to be.
    const impossible = {
      ...checkpoint,
      base: {
        revision: checkpoint.base.revision,
        patch:
          "diff --git a/absent.txt b/absent.txt\n" +
          "--- a/absent.txt\n" +
          "+++ b/absent.txt\n" +
          "@@ -1 +1 @@\n" +
          "-was never here\n" +
          "+nor this\n",
      },
    };

    const worktreePath = join(await realpath(forkRoot), "fork-doomed");

    // What a successful fork holds, so the failed one can be shown to hold
    // nothing: the same ports, handed back and reissued.
    const probe = await manager.createFork(checkpoint, {
      runId: "probe",
      label: "Probe",
    });
    const ports = probe.fork.devPorts;
    await manager.removeFork("probe");

    await assert.rejects(
      () => manager.createFork(impossible, { runId: "fork-doomed", label: "Doomed" }),
      /Could not start fork fork-doomed/,
    );

    assert.equal(await exists(worktreePath), false);
    assert.equal(await branchExists(root, "novus/fork/fork-doomed"), false);
    assert.equal(manager.get("fork-doomed"), undefined);

    const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
    assert.ok(!worktrees.stdout.includes("fork-doomed"), "git still lists the fork");

    // The ports it reserved went back too, so a run of failed attempts cannot
    // exhaust the range.
    const survivor = await manager.createFork(checkpoint, {
      runId: "fork-after",
      label: "After",
    });
    assert.deepEqual(survivor.fork.devPorts, ports);
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(forkRoot, { recursive: true, force: true });
  }
});

test("a fork root inside the repository is refused", async () => {
  const root = await repository();
  const manager = managerFor(root, join(root, "forks"));

  try {
    const checkpoint = await new WorktreeManager(root).createCheckpoint(
      checkpointInput(),
    );

    await assert.rejects(
      () => manager.createFork(checkpoint, { runId: "fork-inside", label: "Inside" }),
      /must live outside the selected repository/,
    );

    // Refused before it was created: nothing was left in the repository.
    assert.equal(await exists(join(root, "forks")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run id that would escape the fork root is refused", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());

    for (const runId of ["../escape", "/etc/passwd", "..", "a/b", ""]) {
      await assert.rejects(
        () => manager.createFork(checkpoint, { runId, label: "Escape" }),
        /must be letters, digits, dot, dash, or underscore/,
        `accepted ${JSON.stringify(runId)}`,
      );
    }

    assert.deepEqual(manager.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository with no commit cannot be checkpointed", async () => {
  const root = await mkdtemp(join(tmpdir(), "novus-fork-empty-"));

  try {
    await git(root, ["init", "-q", "-b", "main"]);

    await assert.rejects(
      () => managerFor(root).createCheckpoint(checkpointInput()),
      /no commit to fork from|not a Git repository with a commit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both events cross the boundary as drafts the store can accept", async () => {
  const root = await repository();
  const manager = managerFor(root);

  try {
    const checkpoint = await manager.createCheckpoint(checkpointInput());
    const handle = await manager.createFork(checkpoint, {
      runId: "fork-evented",
      label: "Evented",
    });

    const created = SessionEventDraftSchema.parse(
      checkpointCreatedEvent(checkpoint, "human-1"),
    );
    const forked = SessionEventDraftSchema.parse(
      forkCreatedEvent(handle.fork, "human-1"),
    );

    if (created.type !== "checkpoint.created") return assert.fail("wrong event");
    if (forked.type !== "fork.created") return assert.fail("wrong event");

    // Everything V1 says a fork begins from, carried in the event rather than
    // in some registry the log cannot see.
    assert.equal(created.payload.checkpoint.parentRunId, "run-parent");
    assert.equal(created.payload.checkpoint.parentSequence, 12);
    assert.equal(created.payload.checkpoint.goal, "Change the answer.");
    assert.deepEqual(created.payload.checkpoint.constraints, [
      "Do not touch the tests.",
    ]);
    assert.deepEqual(created.payload.checkpoint.contextManifest, ["answer.txt"]);
    assert.equal(created.payload.checkpoint.model.model, "claude-opus-4");
    assert.equal(created.payload.checkpoint.toolPolicy.allowWrites, true);
    assert.equal(created.payload.checkpoint.budget.remainingModelCalls, null);
    assert.equal(created.sessionId, "session-1");

    assert.equal(forked.payload.fork.runId, "fork-evented");
    assert.equal(forked.payload.fork.checkpointId, checkpoint.id);
    assert.equal(forked.payload.fork.worktreePath, handle.worktreePath);
    assert.equal(forked.sessionId, "session-1");
  } finally {
    await manager.removeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
