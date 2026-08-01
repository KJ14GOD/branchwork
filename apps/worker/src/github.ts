import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GithubStatus } from "@novus/contracts/protocol";

const run = promisify(execFile);

/**
 * What GitHub says about the branch this repository is on.
 *
 * Local tests prove the change works on this machine. Required checks prove it
 * works on a machine that is not yours, against a configuration you did not
 * set up for yourself — which is a different and usually stronger claim, and
 * the one a reviewer actually wants before adopting an approach.
 *
 * Read through the `gh` CLI rather than the REST API on purpose. `gh` already
 * holds the operator's credential in their keychain, so Novus never sees a
 * token, never stores one, and never has to ask for one. The alternative —
 * a GITHUB_TOKEN in the environment — would put a credential with `repo`
 * scope inside the same process that runs model-authored code, which is
 * exactly the thing this project keeps away from the agent everywhere else.
 *
 * This is a *host* capability, not a tool. Nothing the model emits reaches
 * these arguments; the renderer asks and the host answers. That is why it is
 * not behind the approval gate, and why it must stay read-only — every
 * command here reports, none of them mutate.
 */

/** Bounded so a hanging network call cannot wedge the route that asked. */
const GH_TIMEOUT_MS = 8_000;

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string }>;

const ghRunner: CommandRunner = (command, args, cwd) =>
  run(command, [...args], {
    cwd,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    // The credential lives in gh's own store. Nothing here reads it, and
    // nothing here should inherit a token from this process's environment
    // either — if the operator has not authenticated gh, the honest answer is
    // "not connected", not a quiet fallback to some other credential.
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });

const jsonOrNull = async <T>(
  runner: CommandRunner,
  args: readonly string[],
  cwd: string,
): Promise<T | null> => {
  try {
    const { stdout } = await runner("gh", args, cwd);

    return stdout.trim() === "" ? null : (JSON.parse(stdout) as T);
  } catch {
    // Every failure here is expected somewhere: no PR for this branch, no
    // workflow configured, no network. None of them is worth an exception —
    // the caller renders "not connected" or "no checks" and moves on.
    return null;
  }
};

type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
};

type CheckRun = {
  name: string;
  state: string;
  link?: string;
};

type WorkflowRun = {
  displayTitle: string;
  status: string;
  conclusion: string;
  workflowName: string;
  url: string;
};

/**
 * Whether the checks, taken together, amount to a pass.
 *
 * "None" is its own answer and is never folded into passing. A branch nobody
 * has configured checks for has not been verified by anything — it is exactly
 * as unproven as a run that skipped its tests, and the same rule applies:
 * completion is not verification.
 */
type Connected = Extract<GithubStatus, { connected: true }>;

const verdictOf = (checks: readonly CheckRun[]): Connected["verdict"] => {
  if (checks.length === 0) {
    return "none";
  }

  const state = (check: CheckRun) => check.state.toUpperCase();

  if (checks.some((check) => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(state(check)))) {
    return "failing";
  }

  if (checks.some((check) => ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING"].includes(state(check)))) {
    return "running";
  }

  return checks.every((check) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state(check)))
    ? "passing"
    : // An unfamiliar state is not a pass. Guessing in the optimistic
      // direction is how a screen ends up claiming something was verified by
      // a check nobody has read.
      "failing";
};

export const readGithubStatus = async (
  repositoryPath: string,
  runner: CommandRunner = ghRunner,
): Promise<GithubStatus> => {
  const repository = await jsonOrNull<{ nameWithOwner: string }>(
    runner,
    ["repo", "view", "--json", "nameWithOwner"],
    repositoryPath,
  );

  if (repository === null) {
    return {
      connected: false,
      reason:
        "No GitHub connection. This needs a GitHub remote and the gh CLI signed in — run `gh auth login`.",
    };
  }

  // Resolved rather than assumed. `gh run list --branch HEAD` looks for a
  // branch *named* HEAD and quietly returns an empty list, which this reported
  // as "no checks configured" — a repository with a red CI would have looked
  // exactly like one with no CI at all.
  const branch = await runner("git", ["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath)
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");

  const pullRequest = await jsonOrNull<PullRequest>(
    runner,
    ["pr", "view", "--json", "number,title,url,state,isDraft"],
    repositoryPath,
  );

  // A pull request's checks are the ones that gate a merge. Without one, the
  // branch's own workflow runs are the closest honest equivalent — they say
  // whether CI is happy, they just do not say whether anyone would let it in.
  const checks =
    pullRequest !== null
      ? ((await jsonOrNull<CheckRun[]>(
          runner,
          ["pr", "checks", "--json", "name,state,link"],
          repositoryPath,
        )) ?? [])
      : ((await jsonOrNull<WorkflowRun[]>(
          runner,
          branch === ""
            ? ["run", "list", "--limit", "10", "--json", "displayTitle,status,conclusion,workflowName,url"]
            : ["run", "list", "--branch", branch, "--limit", "10", "--json", "displayTitle,status,conclusion,workflowName,url"],
          repositoryPath,
        )) ?? [])
          // Newest run per workflow, not every run in the window. gh returns
          // these newest-first, so the first sighting of a workflow name is
          // its current state — and folding all ten together meant one
          // failure a week ago made a green branch read as red for as long as
          // it stayed in the list.
          .filter(
            (entry, index, all) =>
              all.findIndex((other) => other.workflowName === entry.workflowName) ===
              index,
          )
          .map((entry) => ({
            name: entry.workflowName,
            state:
              entry.status === "completed"
                ? entry.conclusion.toUpperCase()
                : "IN_PROGRESS",
            link: entry.url,
          }));

  return {
    connected: true,
    repository: repository.nameWithOwner,
    pullRequest:
      pullRequest === null
        ? null
        : {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            state: pullRequest.state,
            draft: pullRequest.isDraft,
          },
    checks: checks.map((check) => ({
      name: check.name,
      state: check.state,
      ...(check.link ? { url: check.link } : {}),
    })),
    verdict: verdictOf(checks),
  };
};
