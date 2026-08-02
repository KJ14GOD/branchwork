import { createHash } from "node:crypto";
import type { AvailableRepository, BaseRevision } from "@novus/contracts";
import type { Config } from "./config.ts";

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

export interface RepositoryProvider {
  readonly kind: "fake" | "unconfigured";
  listRepositories(orgId: string): Promise<AvailableRepository[]>;
  /** Resolves a ref (default branch when omitted) to its exact current SHA. */
  resolveBase(providerRepoId: string, ref?: string): Promise<BaseRevision>;
  /** Idempotent: succeeds if the branch already exists at `fromSha`;
   *  BranchConflictError if it exists at a different commit. */
  ensureBranch(providerRepoId: string, branch: string, fromSha: string): Promise<{ alreadyExisted: boolean }>;
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
