import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSanitizer } from "./evidence";

/**
 * OWNER: putting a GitHub repository on this machine so the local runner can
 * work it (D-025, D-032, D-035).
 *
 * A GitHub project has no worktree anywhere, so it has no workspace and no
 * runner. The fix is not cloud execution — that remains unbuilt — it is the
 * host desktop fetching the repository into its own user-data area and then
 * behaving exactly as it does for a folder the user added by hand: same
 * worktree, same runner, same workspace runtime. Nothing after this module
 * knows the difference.
 *
 * The credential is the whole reason this module exists rather than a line of
 * `git clone` somewhere. ARCHITECTURE.md#the-supervisorharness-boundary is
 * explicit: credentials are injected **per operation** through a credential
 * helper, never written to `~/.git-credentials`, never exported into an
 * environment the harness can read. So the token here:
 *
 *  - never reaches disk — not `.git/config`, not a helper script, not a file;
 *  - never reaches a command line, where `ps` would publish it to every
 *    process this user owns;
 *  - never reaches an environment variable, for the same reason;
 *  - reaches git through a pipe on file descriptor 3, read by a one-line
 *    credential helper git invokes for that operation and nothing else.
 *
 * The helper chain is reset first (`-c credential.helper=`), so the machine's
 * own keychain never answers for Novus: identity is not repository
 * authorization (D-031), and a personal token must not silently do this work.
 */

/** What one fetch needs. Held in memory for the length of the operation. */
export interface CloneCredential {
  /** Plain: a secret in the URL would land in `.git/config` and stay there. */
  remoteUrl: string;
  username: string;
  token: string;
}

export type CloneErrorCode =
  | "bad_repository"
  | "bad_branch"
  | "bad_remote"
  | "clone_failed"
  | "fetch_failed"
  | "branch_missing";

/** A refusal with a name, so a failed clone reads as a stated problem rather
 *  than a workspace that is half there. */
export class RepositoryCloneError extends Error {
  readonly code: CloneErrorCode;
  constructor(code: CloneErrorCode, message: string) {
    super(message);
    this.name = "RepositoryCloneError";
    this.code = code;
  }
}

export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Git with a credential injected for this operation, or none at all. */
export type CloneGitExec = (
  cwd: string | null,
  args: string[],
  credential: CloneCredential | null
) => Promise<GitOutcome>;

/**
 * Reads the answer git is waiting for from file descriptor 3, which the
 * supervisor holds open and nothing else can see. `cat` and `sh` are the whole
 * dependency; the secret is never an argument to either.
 */
const CREDENTIAL_HELPER = "!f() { cat <&3; }; f";

/** A clone of a real repository is allowed to take a while; everything else
 *  here is a local or single-ref operation. */
const CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;

export const cloneGitExec: CloneGitExec = (cwd, args, credential) =>
  new Promise((resolve) => {
    const injected =
      credential === null
        ? []
        : // The empty value first clears every helper the system, global, and
          // local configs installed, so ours is the only one asked.
          ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];

    const child = spawn("git", [...injected, ...args], {
      ...(cwd === null ? {} : { cwd }),
      // Constructed, never inherited (D-041). Nothing of Novus's is in here,
      // and neither is the token.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // No terminal to prompt on: a missing credential must fail in seconds
        // rather than wedge a background operation forever.
        GIT_TERMINAL_PROMPT: "0"
      },
      stdio: ["ignore", "pipe", "pipe", credential === null ? "ignore" : "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: GitOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 128, stdout, stderr: stderr.trim() || "git took too long and was stopped." });
    }, args[0] === "clone" ? CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (credential !== null) {
      const pipe = child.stdio[3];
      if (pipe !== null && pipe !== undefined && "write" in pipe) {
        // Git's credential protocol: one record, terminated by a blank line.
        // Written once; a helper asked twice reads EOF and git fails the
        // operation rather than replaying a spent secret.
        pipe.on("error", () => undefined); // git exited first: nothing to tell
        pipe.end(
          `username=${credential.username}\npassword=${credential.token}\n\n`
        );
      }
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: 128, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 128, stdout, stderr });
    });
  });

// --- Paths this machine owns --------------------------------------------------

/** Novus's own checkouts, kept apart from any folder a user added by hand. */
export function clonedRepositoryRoot(userDataPath: string): string {
  return join(userDataPath, "repositories");
}

/** Server-allocated branch names only; nothing else is ever fetched or made.
 *  The same shape `workspace.ts` refuses to prepare a worktree on. */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+$/;
/** A provider repository id is an opaque provider string, and it is about to
 *  become a directory name. Anything that could climb out of the root is not
 *  one. */
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** True when this machine already holds the checkout. */
export function isClonePresent(path: string | null): boolean {
  return path !== null && existsSync(join(path, ".git"));
}

/**
 * True when this checkout already has the workstream's mission branch.
 *
 * Holding the repository is not the same as holding *this workstream's*
 * branch. A second mission on a repository this machine already cloned needs
 * its own branch fetched, and asking git is the only honest way to know: a ref
 * may be loose or packed, so a file under `.git/refs` proves nothing either way.
 */
export async function hasMissionBranch(
  path: string | null,
  branch: string,
  git: CloneGitExec = cloneGitExec
): Promise<boolean> {
  if (path === null || !isClonePresent(path)) return false;
  if (!MISSION_BRANCH.test(branch)) return false;
  const found = await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], null);
  return found.code === 0;
}

export interface EnsureCloneRequest {
  /** `clonedRepositoryRoot(userDataPath)`. */
  root: string;
  providerRepoId: string;
  /** The branch the **server** allocated for this workstream. */
  missionBranch: string;
  credential: CloneCredential;
  git?: CloneGitExec;
}

export interface ClonedRepository {
  path: string;
  /** True only for the fetch that created the checkout. */
  cloned: boolean;
}

/**
 * The repository on this machine, cloned if it is not here yet and fetched if
 * it is, with the workstream's mission branch present as a local branch so the
 * ordinary worktree path can create a worktree from it.
 *
 * Clone once, reuse afterwards: a second workstream on the same repository
 * shares this checkout and takes its own worktree from it, exactly as two
 * missions on one local folder already do.
 *
 * The fetch happens *before* any worktree is created, so a mission branch the
 * server allocated after this checkout was made is here by the time anything
 * needs it. An existing local branch is never moved — it may carry checkpoint
 * commits — and nothing is ever merged or rebased (D-025).
 */
export async function ensureRepositoryClone(request: EnsureCloneRequest): Promise<ClonedRepository> {
  const git = request.git ?? cloneGitExec;
  const branch = request.missionBranch;
  const { credential } = request;

  if (!REPOSITORY_ID.test(request.providerRepoId) || request.providerRepoId.includes("..")) {
    throw new RepositoryCloneError("bad_repository", "Novus was given a repository id it will not use as a folder.");
  }
  if (!MISSION_BRANCH.test(branch)) {
    throw new RepositoryCloneError("bad_branch", "Refusing to fetch anything but a Novus mission branch.");
  }
  assertPlainRemote(credential.remoteUrl);

  const path = join(request.root, request.providerRepoId);
  const clean = errorCleaner(request.root, credential.token);
  const fresh = !isClonePresent(path);

  if (fresh) {
    mkdirSync(request.root, { recursive: true });
    // Cloned beside its final name and moved into place, so a clone that dies
    // half way leaves nothing that could be mistaken for a checkout.
    const staging = `${path}.incoming-${randomBytes(4).toString("hex")}`;
    const cloned = await git(null, ["clone", "--", credential.remoteUrl, staging], credential);
    if (cloned.code !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new RepositoryCloneError("clone_failed", `Novus could not clone this repository: ${clean(cloned.stderr)}`);
    }
    rmSync(path, { recursive: true, force: true });
    renameSync(staging, path);
  }

  // Set every time and carrying no secret: a repository renamed on the provider
  // must not strand a checkout, and a URL is the one place a credential is
  // never allowed to live.
  await git(path, ["remote", "set-url", "origin", credential.remoteUrl], null);

  const fetched = await git(
    path,
    ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    credential
  );
  if (fetched.code !== 0) {
    throw new RepositoryCloneError(
      "fetch_failed",
      `Novus could not fetch the mission branch: ${clean(fetched.stderr)}`
    );
  }

  const local = await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], null);
  if (local.code !== 0) {
    const created = await git(path, ["branch", "--", branch, `refs/remotes/origin/${branch}`], null);
    if (created.code !== 0) {
      throw new RepositoryCloneError(
        "branch_missing",
        `The mission branch isn't on the remote yet: ${clean(created.stderr)}`
      );
    }
  }

  return { path, cloned: fresh };
}

const LOOPBACK = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/;

/**
 * Refuses a remote that carries a credential in its authority, and any scheme
 * that would send one in the clear. The control plane composes this URL, so
 * this is the guard that keeps a mistake there from becoming a token written
 * into `.git/config` on somebody's laptop.
 *
 * Plain HTTP is allowed on loopback only. That is not a convenience: it is what
 * lets a test stand up a remote that genuinely demands a credential, so the
 * injection path is exercised for real rather than stubbed.
 */
function assertPlainRemote(remoteUrl: string): void {
  const authority = remoteUrl.split("://")[1]?.split("/")[0] ?? "";
  const supported =
    remoteUrl.startsWith("https://") || (remoteUrl.startsWith("http://") && LOOPBACK.test(authority));
  if (!supported || authority.includes("@")) {
    throw new RepositoryCloneError("bad_remote", "Novus will not fetch from that remote.");
  }
}

/** What a git failure is allowed to say out loud: no token, and no path on
 *  this machine (D-032 — paths stay here). */
function errorCleaner(root: string, token: string): (text: string) => string {
  const maskPaths = createSanitizer([{ path: root, label: "the Novus checkouts" }]);
  return (text: string) => {
    const masked = maskPaths(text.trim());
    const redacted = token.length > 0 ? masked.split(token).join("[redacted]") : masked;
    return redacted.replace(/\s+/g, " ").slice(0, 240);
  };
}
