import { createHash } from "node:crypto";
import type {
  AvailableRepository,
  BaseRevision,
  HostCheck,
  MergeMethod,
  MergeReadiness,
  PullFilesResponse,
  ReviewThread
} from "@novus/contracts";
import type { Config } from "./config.ts";
import type { CloneCredential } from "./repo-clone.ts";

/**
 * The repository-provider boundary (D-025, D-031). Repository authorization is
 * distinct from user identity: nothing here ever sees or uses an OAuth user
 * token. The live implementation will be a GitHub App installation; until that
 * exists, the boundary is exercised by a deterministic fake and refuses
 * honestly when unconfigured.
 */

export class ProviderUnconfiguredError extends Error {
  constructor() {
    super("Repository access isn't configured for this organization yet.");
  }
}
export class ProviderTransientError extends Error {}
export class BranchConflictError extends Error {
  constructor(branch: string) {
    super(`Branch ${branch} already exists at a different commit.`);
  }
}
export class UnknownRepositoryError extends Error {
  constructor() {
    super("No such repository is available to this organization.");
  }
}
export class UnknownBaseError extends Error {
  constructor() {
    super("The base revision no longer exists on the provider. Reselect the repository to pin a fresh base.");
  }
}
export class UnknownPullRequestError extends Error {
  constructor() {
    super("No such pull request exists on the provider.");
  }
}
export class PullRequestExistsError extends Error {
  constructor(headRef: string) {
    super(`An open pull request for ${headRef} already exists on the provider.`);
  }
}
/** The host itself cannot or will not perform the act — conflicts, failing
 *  required checks, a draft, branch protection. The first gating tier of
 *  D-100: refused in the host's own words, never overridable. */
export class MergeRefusedError extends Error {}

/** The fake host's own record of one request: the host view plus the knobs
 *  the test-only driver routes turn. */
interface FakePull extends HostPullRequest {
  headRef: string;
  title: string;
  body: string;
  labels: string[];
  checks: HostCheck[];
  approvals: number;
  changesRequested: number;
  behindBy: number;
  aheadBy: number;
  files: PullFilesResponse["files"];
  commits: PullFilesResponse["commits"];
}

/**
 * The host's view of one pull request (D-099). What ingestion reads and what
 * a create returns — never Novus's own row, which additionally carries the
 * decision, the snapshot, and the attribution the host cannot know.
 */
export interface HostPullRequest {
  number: number;
  url: string;
  state: "draft" | "ready" | "merged" | "closed";
  mergeable: "unknown" | "clean" | "conflict";
  requestedReviewers: string[];
  reviewThreads: ReviewThread[];
  /** Who merged it, as the host names them. Null until merged. */
  mergedBy: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  headSha: string | null;
}

export interface RepositoryProvider {
  /** `github` is the live App adapter saying so honestly; the union carried
   *  only the other two while nothing branched on it (D-099). Nothing should
   *  branch on it now either — repository rows carry the provider that
   *  matters — but a label must not lie. */
  readonly kind: "fake" | "github" | "unconfigured";
  listRepositories(orgId: string): Promise<AvailableRepository[]>;
  /** Resolves a ref (default branch when omitted) to its exact current SHA. */
  resolveBase(providerRepoId: string, ref?: string): Promise<BaseRevision>;
  /** Idempotent: succeeds if the branch already exists at `fromSha`;
   *  BranchConflictError if it exists at a different commit. */
  ensureBranch(providerRepoId: string, branch: string, fromSha: string): Promise<{ alreadyExisted: boolean }>;
  /**
   * Opens a pull request — always as a draft, which is the only way Novus
   * opens one: readiness is a person's own later claim (D-099).
   *
   * There is deliberately no merge method on this interface, and there never
   * will be: Novus can put a branch on a host and open a request from it, and
   * can never combine one branch with another. Merging happens on the host,
   * by humans, and ingestion records who.
   */
  createPullRequest(
    providerRepoId: string,
    input: { title: string; body: string; headRef: string; baseRef: string }
  ): Promise<HostPullRequest>;
  /** The host's current story for one request — state, mergeability, review
   *  threads — for poll ingestion. */
  getPullRequest(providerRepoId: string, number: number): Promise<HostPullRequest>;
  requestReviewers(providerRepoId: string, number: number, reviewers: string[]): Promise<void>;
  /** Marks a draft ready for review. A person's act, relayed. */
  markPullRequestReady(providerRepoId: string, number: number): Promise<void>;
  /**
   * The aggregated gate (D-100): the host's checks with their required flags,
   * the review decision, how far the branch is behind its base, and the
   * repository's own allowed merge methods — read, never assumed.
   */
  getMergeReadiness(providerRepoId: string, number: number): Promise<MergeReadiness>;
  /**
   * Performs the merge a person explicitly asked for (D-100). The host does
   * the merging and stays the source of truth; a host that cannot — draft,
   * conflict, failing required check, protection — answers MergeRefusedError
   * in its own words. Novus never calls this on its own account.
   */
  mergePullRequest(
    providerRepoId: string,
    number: number,
    method: MergeMethod
  ): Promise<{ sha: string | null }>;
  /** Brings the branch up to date with its base, host-side. */
  updatePullRequestBranch(providerRepoId: string, number: number): Promise<void>;
  /** Closes without merging. */
  closePullRequest(providerRepoId: string, number: number): Promise<void>;
  /** Deletes one branch ref. The route above this gates it to a resolved
   *  request; the provider just does what it is told. */
  deleteBranchRef(providerRepoId: string, branch: string): Promise<void>;
  /** The request's changed files with bounded patches, and its commits. */
  listPullFiles(providerRepoId: string, number: number): Promise<PullFilesResponse>;
  /** One comment — inline when a path anchors it, conversation otherwise.
   *  With `asUser`, the host sees the person as the author (their own OAuth
   *  token performs the call, D-101); without, the App authors it. */
  createPullComment(
    providerRepoId: string,
    number: number,
    input: { body: string; path?: string; line?: number },
    asUser?: { token: string; login: string }
  ): Promise<void>;
  /** Resolves one review thread by the host's own thread id. */
  resolveReviewThread(providerRepoId: string, threadId: string): Promise<void>;
  /** Title, description, labels — patched on the host. */
  setPullRequestMetadata(
    providerRepoId: string,
    number: number,
    input: { title?: string; body?: string; labels?: string[] }
  ): Promise<void>;
}

export class UnconfiguredRepositoryProvider implements RepositoryProvider {
  readonly kind = "unconfigured" as const;
  async listRepositories(): Promise<AvailableRepository[]> {
    throw new ProviderUnconfiguredError();
  }
  async resolveBase(): Promise<BaseRevision> {
    throw new ProviderUnconfiguredError();
  }
  async ensureBranch(): Promise<{ alreadyExisted: boolean }> {
    throw new ProviderUnconfiguredError();
  }
  async createPullRequest(): Promise<HostPullRequest> {
    throw new ProviderUnconfiguredError();
  }
  async getPullRequest(): Promise<HostPullRequest> {
    throw new ProviderUnconfiguredError();
  }
  async requestReviewers(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async markPullRequestReady(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async getMergeReadiness(): Promise<MergeReadiness> {
    throw new ProviderUnconfiguredError();
  }
  async mergePullRequest(): Promise<{ sha: string | null }> {
    throw new ProviderUnconfiguredError();
  }
  async updatePullRequestBranch(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async closePullRequest(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async deleteBranchRef(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async listPullFiles(): Promise<PullFilesResponse> {
    throw new ProviderUnconfiguredError();
  }
  async createPullComment(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async resolveReviewThread(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
  async setPullRequestMetadata(): Promise<void> {
    throw new ProviderUnconfiguredError();
  }
}

const fixedSha = (seed: string) => createHash("sha1").update(seed).digest("hex");

interface FakeRepo {
  providerRepoId: string;
  name: string;
  defaultBranch: string;
  headSha: string;
  /** Branch creation fails this many times before succeeding. */
  transientFailures: number;
}

/**
 * Deterministic in-memory provider exercising the exact same boundary the live
 * GitHub App adapter will. `flaky/payments` fails its first ensureBranch call
 * per branch so retry paths are testable end to end.
 */
export class FakeRepositoryProvider implements RepositoryProvider {
  readonly kind = "fake" as const;
  private readonly repos: FakeRepo[];

  /**
   * The three fixed repositories every deterministic test relies on, plus —
   * only when asked — enough filler to exercise a long, searchable, scrollable
   * picker. The extra entries are generated deterministically so a test can
   * assert on any of them by name.
   */
  constructor(extraRepositories = 0) {
    this.repos = [
      { providerRepoId: "9001", name: "novus/demo-app", defaultBranch: "main", headSha: fixedSha("demo-app@main"), transientFailures: 0 },
      { providerRepoId: "9002", name: "novus/api", defaultBranch: "main", headSha: fixedSha("api@main"), transientFailures: 0 },
      { providerRepoId: "9003", name: "flaky/payments", defaultBranch: "main", headSha: fixedSha("payments@main"), transientFailures: 1 }
    ];
    const owners = ["novus", "acme", "northwind", "helios", "meridian"];
    const subjects = [
      "auth", "billing", "gateway", "ingest", "ledger", "notifier", "pipeline",
      "registry", "scheduler", "telemetry", "webhooks", "workers"
    ];
    for (let index = 0; index < extraRepositories; index += 1) {
      const owner = owners[index % owners.length] as string;
      const subject = subjects[index % subjects.length] as string;
      const name = `${owner}/${subject}-${String(index + 1).padStart(3, "0")}`;
      this.repos.push({
        providerRepoId: String(10_000 + index),
        name,
        defaultBranch: index % 4 === 0 ? "develop" : "main",
        headSha: fixedSha(`${name}@head`),
        transientFailures: 0
      });
    }
  }
  private readonly branches = new Map<string, Map<string, string>>();
  private readonly failuresSeen = new Map<string, number>();

  private repo(providerRepoId: string): FakeRepo {
    const found = this.repos.find((candidate) => candidate.providerRepoId === providerRepoId);
    if (!found) throw new UnknownRepositoryError();
    return found;
  }

  async listRepositories(): Promise<AvailableRepository[]> {
    return this.repos.map(({ providerRepoId, name, defaultBranch }) => ({ providerRepoId, name, defaultBranch }));
  }

  async resolveBase(providerRepoId: string, ref?: string): Promise<BaseRevision> {
    const repo = this.repo(providerRepoId);
    const target = ref ?? repo.defaultBranch;
    if (target !== repo.defaultBranch) throw new UnknownRepositoryError();
    return { ref: target, sha: repo.headSha };
  }

  async ensureBranch(providerRepoId: string, branch: string, fromSha: string): Promise<{ alreadyExisted: boolean }> {
    const repo = this.repo(providerRepoId);
    const repoBranches = this.branches.get(providerRepoId) ?? new Map<string, string>();
    this.branches.set(providerRepoId, repoBranches);

    const existing = repoBranches.get(branch);
    if (existing !== undefined) {
      if (existing !== fromSha) throw new BranchConflictError(branch);
      return { alreadyExisted: true };
    }

    // A live provider rejects branch creation from a commit it doesn't know;
    // the fake must too, or stale-base bugs pass silently (D-031 audit).
    if (fromSha !== repo.headSha) throw new UnknownBaseError();

    const failureKey = `${providerRepoId}:${branch}`;
    const seen = this.failuresSeen.get(failureKey) ?? 0;
    if (seen < repo.transientFailures) {
      this.failuresSeen.set(failureKey, seen + 1);
      throw new ProviderTransientError("The provider timed out creating the branch.");
    }

    repoBranches.set(branch, fromSha);
    return { alreadyExisted: false };
  }

  // --- Pull requests (D-099) -------------------------------------------------
  // The same seam the live adapter implements, in memory. The fake's "host
  // side" — a reviewer commenting, a human merging or closing, a thread being
  // resolved — is driven by the `fake*` methods below, exposed as test-only
  // routes under NOVUS_FAKE_GITHUB so a deterministic suite can *be* GitHub.
  // There is no merge on the RepositoryProvider interface; `fakeMerge` is the
  // host's own act, which is exactly the distinction the product draws.

  private readonly pulls = new Map<string, Map<number, FakePull>>();
  private nextNumber = 1;
  private nextThread = 1;

  private repoPulls(providerRepoId: string): Map<number, FakePull> {
    this.repo(providerRepoId);
    const existing = this.pulls.get(providerRepoId) ?? new Map();
    this.pulls.set(providerRepoId, existing);
    return existing;
  }

  private pull(providerRepoId: string, number: number): FakePull {
    const found = this.repoPulls(providerRepoId).get(number);
    if (!found) throw new UnknownPullRequestError();
    return found;
  }

  async createPullRequest(
    providerRepoId: string,
    input: { title: string; body: string; headRef: string; baseRef: string }
  ): Promise<HostPullRequest> {
    const pulls = this.repoPulls(providerRepoId);
    for (const pull of pulls.values()) {
      // GitHub refuses a second open request for the same head; the fake must
      // too, or a duplicate-create bug passes silently.
      if (pull.headRef === input.headRef && (pull.state === "draft" || pull.state === "ready")) {
        throw new PullRequestExistsError(input.headRef);
      }
    }
    const repo = this.repo(providerRepoId);
    const number = this.nextNumber;
    this.nextNumber += 1;
    const created: FakePull = {
      number,
      url: `https://github.com/${repo.name}/pull/${number}`,
      state: "draft",
      mergeable: "unknown",
      requestedReviewers: [],
      reviewThreads: [],
      mergedBy: null,
      mergedAt: null,
      closedAt: null,
      headSha: this.branches.get(providerRepoId)?.get(input.headRef) ?? null,
      headRef: input.headRef,
      title: input.title,
      body: input.body,
      labels: [],
      checks: [],
      approvals: 0,
      changesRequested: 0,
      behindBy: 0,
      aheadBy: 1,
      // One synthetic file and commit, so the in-house diff has something
      // real-shaped to show without the fake growing a git of its own.
      files: [
        {
          path: "live-change.txt",
          changeState: "modified" as const,
          additions: 3,
          deletions: 0,
          patch: "@@ -0,0 +1,3 @@\n+the change\n+this request\n+publishes"
        }
      ],
      commits: [
        {
          sha: this.branches.get(providerRepoId)?.get(input.headRef) ?? "0".repeat(40),
          message: "The decided revision",
          author: "novus"
        }
      ]
    };
    pulls.set(number, created);
    return { ...created };
  }

  async getPullRequest(providerRepoId: string, number: number): Promise<HostPullRequest> {
    const pull = this.pull(providerRepoId, number);
    // Mergeability settles on read, the way GitHub computes it lazily: clean
    // unless the test marked a conflict.
    if (pull.mergeable === "unknown" && pull.state !== "merged" && pull.state !== "closed") {
      pull.mergeable = "clean";
    }
    return { ...pull, reviewThreads: pull.reviewThreads.map((thread) => ({ ...thread })) };
  }

  async requestReviewers(providerRepoId: string, number: number, reviewers: string[]): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    for (const reviewer of reviewers) {
      if (!pull.requestedReviewers.includes(reviewer)) pull.requestedReviewers.push(reviewer);
    }
  }

  async markPullRequestReady(providerRepoId: string, number: number): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    if (pull.state === "draft") pull.state = "ready";
  }

  // --- The gate and the completion verbs (D-100) -----------------------------

  async getMergeReadiness(providerRepoId: string, number: number): Promise<MergeReadiness> {
    const pull = this.pull(providerRepoId, number);
    return {
      checks: pull.checks.map((check) => ({ ...check })),
      reviewDecision:
        pull.changesRequested > 0 ? "changes_requested" : pull.approvals > 0 ? "approved" : "none",
      approvals: pull.approvals,
      changesRequested: pull.changesRequested,
      behindBy: pull.behindBy,
      aheadBy: pull.aheadBy,
      allowedMergeMethods: ["merge", "squash", "rebase"],
      syncedAt: new Date().toISOString()
    };
  }

  async mergePullRequest(
    providerRepoId: string,
    number: number,
    method: MergeMethod
  ): Promise<{ sha: string | null }> {
    const pull = this.pull(providerRepoId, number);
    // The host's own refusals, mirrored, or host-tier bugs pass silently: a
    // draft cannot merge, a conflict cannot merge, a failing required check
    // cannot merge past protection.
    if (pull.state === "merged") throw new MergeRefusedError("This pull request is already merged.");
    if (pull.state === "closed") throw new MergeRefusedError("This pull request is closed.");
    if (pull.state === "draft") throw new MergeRefusedError("A draft cannot be merged; mark it ready first.");
    if (pull.mergeable === "conflict") {
      throw new MergeRefusedError("The branch has conflicts with its base that must be resolved.");
    }
    if (pull.checks.some((check) => check.required && check.status === "failed")) {
      throw new MergeRefusedError("A required check is failing; branch protection refuses the merge.");
    }
    void method;
    pull.state = "merged";
    // The token's identity performs the merge, which for Novus is the App.
    pull.mergedBy = "app/novus";
    pull.mergedAt = new Date().toISOString();
    pull.mergeable = "clean";
    const sha = fixedSha(`merge:${providerRepoId}:${number}`);
    return { sha };
  }

  async updatePullRequestBranch(providerRepoId: string, number: number): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    pull.behindBy = 0;
  }

  async closePullRequest(providerRepoId: string, number: number): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    if (pull.state === "merged") throw new MergeRefusedError("This pull request is already merged.");
    pull.state = "closed";
    pull.closedAt = new Date().toISOString();
  }

  async deleteBranchRef(providerRepoId: string, branch: string): Promise<void> {
    const repoBranches = this.branches.get(providerRepoId);
    if (!repoBranches?.has(branch)) throw new UnknownBaseError();
    repoBranches.delete(branch);
  }

  async listPullFiles(providerRepoId: string, number: number): Promise<PullFilesResponse> {
    const pull = this.pull(providerRepoId, number);
    return {
      files: pull.files.map((file) => ({ ...file })),
      commits: pull.commits.map((commit) => ({ ...commit }))
    };
  }

  async createPullComment(
    providerRepoId: string,
    number: number,
    input: { body: string; path?: string; line?: number },
    asUser?: { token: string; login: string }
  ): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    pull.reviewThreads.push({
      threadId: `thr_${this.nextThread}`,
      // The fake host reads the author off the token's identity, exactly as
      // the live host would (D-101).
      author: asUser?.login ?? "app/novus",
      body: input.body,
      path: input.path ?? null,
      line: input.line ?? null,
      state: "open",
      url: `${pull.url}#discussion_r${this.nextThread}`,
      postedAt: new Date().toISOString()
    });
    this.nextThread += 1;
  }

  async resolveReviewThread(providerRepoId: string, threadId: string): Promise<void> {
    for (const pull of this.repoPulls(providerRepoId).values()) {
      const thread = pull.reviewThreads.find((candidate) => candidate.threadId === threadId);
      if (thread) {
        thread.state = "resolved";
        return;
      }
    }
    throw new UnknownPullRequestError();
  }

  async setPullRequestMetadata(
    providerRepoId: string,
    number: number,
    input: { title?: string; body?: string; labels?: string[] }
  ): Promise<void> {
    const pull = this.pull(providerRepoId, number);
    if (input.title !== undefined) pull.title = input.title;
    if (input.body !== undefined) pull.body = input.body;
    if (input.labels !== undefined) pull.labels = [...input.labels];
  }

  // --- The fake host's own hands ---------------------------------------------

  /** The host side of review: somebody commented on GitHub. */
  fakeComment(
    providerRepoId: string,
    number: number,
    comment: { author: string; body: string; path?: string | null }
  ): void {
    const pull = this.pull(providerRepoId, number);
    pull.reviewThreads.push({
      threadId: `thr_${this.nextThread}`,
      author: comment.author,
      body: comment.body,
      path: comment.path ?? null,
      line: null,
      state: "open",
      url: `${pull.url}#discussion_r${this.nextThread}`,
      postedAt: new Date().toISOString()
    });
    this.nextThread += 1;
  }

  /** The host side of resolution: a thread was resolved on GitHub. */
  fakeResolveComments(providerRepoId: string, number: number): void {
    const pull = this.pull(providerRepoId, number);
    for (const thread of pull.reviewThreads) thread.state = "resolved";
  }

  /** The host side of conflict: the base moved and the branch no longer merges. */
  fakeConflict(providerRepoId: string, number: number): void {
    const pull = this.pull(providerRepoId, number);
    pull.mergeable = "conflict";
  }

  /** The host side of CI: a check ran on GitHub. Replaces by name. */
  fakeCheck(providerRepoId: string, number: number, check: HostCheck): void {
    const pull = this.pull(providerRepoId, number);
    const at = pull.checks.findIndex((candidate) => candidate.name === check.name);
    if (at === -1) pull.checks.push({ ...check });
    else pull.checks[at] = { ...check };
  }

  /** The host side of review decisions: an approval or a change request. */
  fakeReview(providerRepoId: string, number: number, verdict: "approve" | "request_changes"): void {
    const pull = this.pull(providerRepoId, number);
    if (verdict === "approve") pull.approvals += 1;
    else pull.changesRequested += 1;
  }

  /** The base moved: the branch is now behind by this many commits. */
  fakeBehind(providerRepoId: string, number: number, behindBy: number): void {
    const pull = this.pull(providerRepoId, number);
    pull.behindBy = behindBy;
  }

  /** A human merged it on GitHub. Novus can also ask (D-100); either way the
   *  host performs it and this is the host performing it. */
  fakeMerge(providerRepoId: string, number: number, mergedBy: string): void {
    const pull = this.pull(providerRepoId, number);
    pull.state = "merged";
    pull.mergedBy = mergedBy;
    pull.mergedAt = new Date().toISOString();
    pull.mergeable = "clean";
  }

  /** A human closed it on GitHub without merging. */
  fakeClose(providerRepoId: string, number: number): void {
    const pull = this.pull(providerRepoId, number);
    pull.state = "closed";
    pull.closedAt = new Date().toISOString();
  }

  /**
   * The push credential, faked (D-099). A deterministic suite points this at
   * a loopback git remote it runs itself — the credential decides where the
   * bytes go, exactly as the live mint's canonical URL does, so a test push
   * is a real `git push` against a real HTTP remote that demands the token.
   * Refused honestly when no remote was configured, like every fake refusal.
   */
  async mintPushCredential(providerRepoId: string): Promise<CloneCredential> {
    this.repo(providerRepoId);
    const remote = process.env.NOVUS_FAKE_PUSH_REMOTE;
    if (!remote) {
      throw new ProviderTransientError(
        "The fake provider has no push remote configured (NOVUS_FAKE_PUSH_REMOTE)."
      );
    }
    return {
      remoteUrl: remote,
      username: "x-access-token",
      token: "fake-push-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    };
  }
}

export function selectRepositoryProvider(config: Config, env: NodeJS.ProcessEnv = process.env): RepositoryProvider {
  const fakeRepos = config.fakeGithub || env.NOVUS_FAKE_REPOS === "1";
  if (fakeRepos && env.NODE_ENV === "production") {
    throw new Error("Fake repository provider must never be enabled in production");
  }
  if (fakeRepos) {
    // A long list is the honest shape of a real GitHub account; the picker has
    // to survive it. Off by default so deterministic suites stay small.
    const extra = Number(env.NOVUS_FAKE_REPO_COUNT ?? 0);
    return new FakeRepositoryProvider(Number.isFinite(extra) && extra > 0 ? Math.min(extra, 500) : 0);
  }
  if (config.githubAppId && config.githubAppPem) {
    return new GithubAppRepositoryProvider(config.githubAppId, config.githubAppPem);
  }
  return new UnconfiguredRepositoryProvider();
}

// Placed after the classes it selects among to avoid a cycle at type level.
import { GithubAppRepositoryProvider } from "./github-app-provider.ts";
