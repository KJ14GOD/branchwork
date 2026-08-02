import type { PreparedFile, WorkspaceProposal, WorkspaceSettings } from "@novus/contracts";

/**
 * OWNER: the workspace runtime's desktop half (D-040, D-041).
 *
 * Everything that reads a project, writes its configuration, supplies its
 * local files, builds its environments, allocates its ports, and supervises
 * its processes lives behind this module. `main.ts` resolves which workstream
 * is meant and calls in; it never touches a path, a command, or a secret
 * itself.
 *
 * Two rules bind every function here:
 *
 *  - Nothing a person did not confirm ever runs. `inspect` proposes; only an
 *    explicit `save` followed by an explicit command executes anything.
 *  - A secret value never leaves this process. Filenames and variable names
 *    cross the bridge; contents do not, and never reach the control plane.
 */

/** Where a workstream's work actually happens on this machine. */
export interface WorkspaceTarget {
  missionId: string;
  workstreamId: string;
  /** The registered local repository this workstream came from. */
  localId: string;
  missionBranch: string;
}

/** Reads the project and says what it would propose. Executes nothing. */
export async function inspectWorkspace(_target: WorkspaceTarget): Promise<WorkspaceProposal> {
  throw new Error("the workspace runtime is not installed");
}

/** Writes `.novus/settings.toml` or `.novus/settings.local.toml`. */
export async function saveWorkspaceSettings(
  _target: WorkspaceTarget,
  _scope: "shared" | "local",
  _settings: WorkspaceSettings
): Promise<void> {
  throw new Error("the workspace runtime is not installed");
}

/**
 * Copies confirmed Git-ignored files from the source repository into the
 * worktree. Refuses anything that is not ignored, any path escaping either
 * end, any symlink resolving outside the repository, and any directory.
 */
export async function prepareLocalFiles(
  _target: WorkspaceTarget,
  _paths: string[]
): Promise<PreparedFile[]> {
  throw new Error("the workspace runtime is not installed");
}
