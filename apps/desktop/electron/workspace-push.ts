import { createSanitizer } from "./evidence";
import {
  cloneGitExec,
  type CloneCredential,
  type CloneGitExec
} from "./workspace-clone";

/**
 * Pushing the mission branch to the repository host (D-099) — the runner's
 * half of the remote-head guarantee.
 *
 * The push is precise: it pushes the **decided revision** to the branch ref
 * (`{sha}:refs/heads/{branch}`), never the local branch head, which may have
 * moved past the decision by the time the command arrives. The revision must
 * exist here and must be on the mission branch's own history; anything else
 * is refused before git is asked. The credential is injected per operation
 * through the same fd-3 pipe the clone path uses — never on the command line,
 * never in the environment, never in any config — and the push goes to the
 * URL the credential named, so no repository configuration on disk decides
 * where these bytes land.
 *
 * A non-fast-forward refusal is surfaced in words rather than forced: the
 * host holding commits this push would discard is a fact a person resolves,
 * and there is no `--force` here or anywhere (D-025's no-history-rewriting
 * rule holds on the way out too).
 */

/** Server-allocated branch shapes only, matching the clone path's own gate. */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+(-a[0-9]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export class BranchPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchPushError";
  }
}

export interface PushRequest {
  /** The checkout this machine holds for the repository. */
  repositoryPath: string;
  branch: string;
  /** The decided checkpoint — exactly what the remote branch will serve. */
  sha: string;
  credential: CloneCredential;
  git?: CloneGitExec;
}

function assertPlainRemote(remoteUrl: string): void {
  const authority = remoteUrl.split("://")[1]?.split("/")[0] ?? "";
  const supported =
    remoteUrl.startsWith("https://") || (remoteUrl.startsWith("http://") && LOOPBACK.test(authority));
  if (!supported || authority.includes("@")) {
    throw new BranchPushError("Novus will not push to that remote.");
  }
}

/** What a git failure may say out loud: no token, no local path. */
function cleaner(repositoryPath: string, token: string): (text: string) => string {
  const maskPaths = createSanitizer([{ path: repositoryPath, label: "the checkout" }]);
  return (text: string) => {
    const masked = maskPaths(text.trim());
    const redacted = token.length > 0 ? masked.split(token).join("[redacted]") : masked;
    return redacted.replace(/\s+/g, " ").slice(0, 240);
  };
}

/** Pushes the decided revision to the branch on the host. Returns the SHA the
 *  remote now serves — which is the input, or nothing. */
export async function pushMissionBranch(request: PushRequest): Promise<{ sha: string }> {
  const { repositoryPath, branch, sha, credential } = request;
  const git = request.git ?? cloneGitExec;
  const clean = cleaner(repositoryPath, credential.token);

  if (!MISSION_BRANCH.test(branch)) {
    throw new BranchPushError("Novus pushes only the mission branches it allocated.");
  }
  if (!FULL_SHA.test(sha)) {
    throw new BranchPushError("The decided revision is not a full commit id.");
  }
  assertPlainRemote(credential.remoteUrl);

  // The revision must be real here, and must be the mission branch's own
  // history. A commit this checkout does not hold, or one from some other
  // line of work, is refused before the host is ever contacted.
  const exists = await git(repositoryPath, ["cat-file", "-e", `${sha}^{commit}`], null);
  if (exists.code !== 0) {
    throw new BranchPushError("The decided revision is not in this checkout.");
  }
  const onBranch = await git(
    repositoryPath,
    ["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`],
    null
  );
  if (onBranch.code !== 0) {
    throw new BranchPushError("The decided revision is not on the mission branch.");
  }

  // No --force, ever: a host holding commits this push would discard is a
  // fact for a person, not something to overwrite quietly.
  const pushed = await git(
    repositoryPath,
    ["push", credential.remoteUrl, `${sha}:refs/heads/${branch}`],
    credential
  );
  if (pushed.code !== 0) {
    const said = clean(pushed.stderr || pushed.stdout);
    if (/non-fast-forward|rejected|fetch first|stale info/i.test(said)) {
      throw new BranchPushError(
        "GitHub already has commits on this branch that the decided revision does not include. Nothing was pushed; resolve the branch on GitHub first."
      );
    }
    throw new BranchPushError(said === "" ? "The push did not finish." : `The push failed: ${said}`);
  }
  return { sha };
}
