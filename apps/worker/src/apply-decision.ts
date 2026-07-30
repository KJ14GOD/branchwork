import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DecisionOutcome } from "@novus/contracts";

import { ApplyPatchTool, ProposePatchTool, resolveInsideRepository } from "./tools.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/**
 * Writes a chosen attempt's changes into the parent's working tree.
 *
 * For every file the attempt modified, this reuses `propose_patch` and
 * `apply_patch` exactly as the agent loop does — a whole-file `oldText` /
 * `newText` edit, checked against the file's live content before anything is
 * written — rather than inventing a second way to touch the working tree.
 * `oldText` is the file's content at the checkpoint the fork started from, so
 * the same substring check `apply_patch` already performs for drift ("this
 * file changed after the proposal was made") is what catches a parent that
 * moved on since the fork was cut. `newText` is the fork's current content,
 * so the edit degenerates to a full replacement — which is fine, because
 * `oldText` matching the entire file guarantees it is found exactly once.
 *
 * Two things those tools cannot do at all: create a file that does not yet
 * exist, and delete one. `propose_patch` refuses a path that is not already a
 * file, by design — nothing in this harness creates files outside
 * `run_command`. Those two cases get the same discipline by hand: read what
 * is actually there, compare it with what the fork started from, and only
 * write or remove on a clean match.
 *
 * Preflight, then apply. Every file is checked against its expected base
 * before anything is written, and one conflicting file refuses the *whole*
 * apply rather than leaving the parent's tree half updated.
 */
export const applyDecision = async (
  repositoryPath: string,
  worktrees: WorktreeManager,
  runId: string,
): Promise<DecisionOutcome> => {
  const changed = await worktrees.diffFork(runId);

  if (changed.length === 0) {
    return {
      applied: false,
      reason: "This attempt made no changes to apply.",
      conflicts: [],
    };
  }

  const proposePatch = new ProposePatchTool(repositoryPath);
  const applyPatch = new ApplyPatchTool(repositoryPath, proposePatch);

  type Plan =
    | { path: string; kind: "edit"; patchId: string }
    | { path: string; kind: "create"; content: string }
    | { path: string; kind: "delete" };

  const conflicts: Array<{ path: string; reason: string }> = [];
  const plans: Plan[] = [];

  for (const file of changed) {
    const baseContent = await worktrees.readForkBaseFile(runId, file.path);

    if (file.status === "added") {
      const forkContent = (await worktrees.readForkFile(runId, file.path)) ?? "";
      const { targetPath } = await resolveInsideRepository(
        repositoryPath,
        file.path,
        { allowMissing: true },
      );
      const alreadyExists = await readOrNull(targetPath);

      if (alreadyExists !== null) {
        conflicts.push({
          path: file.path,
          reason:
            "This attempt added a file that now also exists in the parent repository.",
        });
        continue;
      }

      plans.push({ path: file.path, kind: "create", content: forkContent });
      continue;
    }

    if (file.status === "deleted") {
      const { targetPath } = await resolveInsideRepository(
        repositoryPath,
        file.path,
        { allowMissing: true },
      );
      const currentContent = await readOrNull(targetPath);

      if (currentContent === null) {
        // Already gone from the parent — nothing left for this apply to do.
        continue;
      }

      if (currentContent !== baseContent) {
        conflicts.push({
          path: file.path,
          reason:
            "This file changed in the parent repository since the attempt started, so Novus will not delete it automatically.",
        });
        continue;
      }

      plans.push({ path: file.path, kind: "delete" });
      continue;
    }

    // Modified. propose_patch performs the actual drift check — reading the
    // parent's live content itself and refusing when the base text cannot be
    // found in it — so nothing is read here beyond what the fork holds.
    if (baseContent === null) {
      conflicts.push({
        path: file.path,
        reason: "This attempt's starting point for this file could not be read.",
      });
      continue;
    }

    const forkContent = await worktrees.readForkFile(runId, file.path);

    if (forkContent === null) {
      conflicts.push({
        path: file.path,
        reason: "This attempt's current content for this file could not be read.",
      });
      continue;
    }

    if (forkContent === baseContent) {
      continue;
    }

    try {
      const proposed = await proposePatch.execute({
        id: crypto.randomUUID(),
        name: "propose_patch",
        input: {
          path: file.path,
          intent: `Apply the chosen attempt (${runId})`,
          edits: [{ oldText: baseContent, newText: forkContent }],
        },
      });

      if (proposed.name !== "propose_patch") {
        throw new Error("propose_patch returned an unexpected result shape.");
      }

      plans.push({ path: file.path, kind: "edit", patchId: proposed.output.patchId });
    } catch (error) {
      conflicts.push({
        path: file.path,
        reason:
          error instanceof Error
            ? error.message
            : "This attempt's change no longer applies.",
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      applied: false,
      reason: `${conflicts.length} of ${changed.length} changed file${changed.length === 1 ? "" : "s"} no longer applies cleanly.`,
      conflicts,
    };
  }

  const files: string[] = [];

  for (const plan of plans) {
    if (plan.kind === "edit") {
      await applyPatch.execute({
        id: crypto.randomUUID(),
        name: "apply_patch",
        input: { patchId: plan.patchId },
      });
      files.push(plan.path);
      continue;
    }

    if (plan.kind === "create") {
      const { targetPath } = await resolveInsideRepository(
        repositoryPath,
        plan.path,
        { allowMissing: true },
      );
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, plan.content, "utf8");
      files.push(plan.path);
      continue;
    }

    const { targetPath } = await resolveInsideRepository(repositoryPath, plan.path);
    await unlink(targetPath);
    files.push(plan.path);
  }

  return { applied: true, files };
};

const readOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};
