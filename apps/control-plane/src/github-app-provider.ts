import { createSign } from "node:crypto";
import type { AvailableRepository, BaseRevision, ReviewThread } from "@novus/contracts";
import type { CloneCredential, CloneCredentialMinter } from "./repo-clone.ts";
import {
  BranchConflictError,
  ProviderTransientError,
  PullRequestExistsError,
  UnknownBaseError,
  UnknownPullRequestError,
  UnknownRepositoryError,
  type HostPullRequest,
  type RepositoryProvider
} from "./repo-provider.ts";

const API = "https://api.github.com";

interface CachedRepo {
  providerRepoId: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * The live repository provider: a GitHub App installation (D-031/D-032).
 * App JWT → installation token (cached, refreshed before expiry) → REST.
 * Identity OAuth is never used here. Same interface and idempotency
 * semantics the fake enforces; V0 binds to the app's first installation.
 */
export class GithubAppRepositoryProvider implements RepositoryProvider, CloneCredentialMinter {
  readonly kind = "github" as const; // the union widened (D-099); the label stops lying
  private token: { value: string; expiresAt: number } | null = null;
  private installation: number | null = null;
  private repoCache = new Map<string, CachedRepo>();

  private readonly appId: string;
  private readonly pem: string;

  constructor(appId: string, pem: string) {
    this.appId = appId;
    this.pem = pem;
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 300, iss: this.appId })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.pem).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  private appHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" };
  }

  /** V0 binds to the app's first installation; remembered so minting a
   *  per-repository token is one request rather than two. */
  private async installationId(): Promise<number> {
    if (this.installation !== null) return this.installation;
    const installations = await fetch(`${API}/app/installations?per_page=1`, { headers: this.appHeaders() });
    if (!installations.ok) throw new ProviderTransientError(`installation lookup failed (${installations.status})`);
    const list = (await installations.json()) as { id: number }[];
    const installation = list[0];
    if (!installation) throw new ProviderTransientError("the GitHub App has no installation yet");
    this.installation = installation.id;
    return installation.id;
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const minted = await fetch(`${API}/app/installations/${await this.installationId()}/access_tokens`, {
      method: "POST",
      headers: this.appHeaders()
    });
    if (!minted.ok) throw new ProviderTransientError(`installation token failed (${minted.status})`);
    const body = (await minted.json()) as { token: string; expires_at: string };
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  /**
   * A credential for **one** repository, read-only, ~1h, minted fresh for the
   * operation that asked and never cached
   * (ARCHITECTURE.md#secret-placement). The control-plane-wide installation
   * token above is deliberately not what a runner receives: a runner sees one
   * repository, exactly as it sees one mission.
   *
   * Read, not write: nothing on the runner pushes today — a checkpoint is a
   * local commit — so this is the narrowest permission that does the job.
   */
  async mintCloneCredential(providerRepoId: string): Promise<CloneCredential> {
    const repo = await this.cachedRepo(providerRepoId);
    const numericId = Number(repo.providerRepoId);
    if (!Number.isSafeInteger(numericId)) throw new UnknownRepositoryError();
    const minted = await fetch(`${API}/app/installations/${await this.installationId()}/access_tokens`, {
      method: "POST",
      headers: { ...this.appHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        repository_ids: [numericId],
        permissions: { contents: "read", metadata: "read" }
      })
    });
    if (minted.status === 404) throw new UnknownRepositoryError();
    if (!minted.ok) throw new ProviderTransientError(`repository credential failed (${minted.status})`);
    const body = (await minted.json()) as { token: string; expires_at: string };
    return {
      // Plain: the token goes to the runner separately and is injected per
      // operation, never baked into a remote that would persist in a config.
      remoteUrl: `https://github.com/${repo.fullName}.git`,
      username: "x-access-token",
      token: body.token,
      expiresAt: body.expires_at
    };
  }

  /**
   * The push credential (D-099): one repository, `contents: write`, minted
   * fresh for the one push that asked and never cached. A second,
   * deliberately separate mint rather than a widening of the clone
   * credential — reading a repository and writing to one are different
   * grants, and every operation gets the narrowest one that does its job.
   */
  async mintPushCredential(providerRepoId: string): Promise<CloneCredential> {
    const repo = await this.cachedRepo(providerRepoId);
    const numericId = Number(repo.providerRepoId);
    if (!Number.isSafeInteger(numericId)) throw new UnknownRepositoryError();
    const minted = await fetch(`${API}/app/installations/${await this.installationId()}/access_tokens`, {
      method: "POST",
      headers: { ...this.appHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        repository_ids: [numericId],
        permissions: { contents: "write", metadata: "read" }
      })
    });
    if (minted.status === 404) throw new UnknownRepositoryError();
    if (!minted.ok) throw new ProviderTransientError(`push credential failed (${minted.status})`);
    const body = (await minted.json()) as { token: string; expires_at: string };
    return {
      remoteUrl: `https://github.com/${repo.fullName}.git`,
      username: "x-access-token",
      token: body.token,
      expiresAt: body.expires_at
    };
  }

  private async rest(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.installationToken();
    return fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json"
      }
    });
  }

  private async cachedRepo(providerRepoId: string): Promise<CachedRepo> {
    const hit = this.repoCache.get(providerRepoId);
    if (hit) return hit;
    const response = await this.rest(`/repositories/${encodeURIComponent(providerRepoId)}`);
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`repository lookup failed (${response.status})`);
    const repo = (await response.json()) as { id: number; full_name: string; default_branch: string };
    const cached = { providerRepoId: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch };
    this.repoCache.set(cached.providerRepoId, cached);
    return cached;
  }

  async listRepositories(): Promise<AvailableRepository[]> {
    const repos: AvailableRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.rest(`/installation/repositories?per_page=100&page=${page}`);
      if (!response.ok) throw new ProviderTransientError(`repository listing failed (${response.status})`);
      const body = (await response.json()) as {
        repositories: { id: number; full_name: string; default_branch: string }[];
        total_count: number;
      };
      for (const repo of body.repositories) {
        const cached = { providerRepoId: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch };
        this.repoCache.set(cached.providerRepoId, cached);
        repos.push({ providerRepoId: cached.providerRepoId, name: cached.fullName, defaultBranch: cached.defaultBranch });
      }
      if (repos.length >= body.total_count) break;
    }
    return repos;
  }

  async resolveBase(providerRepoId: string, ref?: string): Promise<BaseRevision> {
    const repo = await this.cachedRepo(providerRepoId);
    const target = ref ?? repo.defaultBranch;
    const response = await this.rest(
      `/repos/${repo.fullName}/branches/${encodeURIComponent(target)}`
    );
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`base resolution failed (${response.status})`);
    const branch = (await response.json()) as { commit: { sha: string } };
    return { ref: target, sha: branch.commit.sha };
  }

  async ensureBranch(providerRepoId: string, branch: string, fromSha: string): Promise<{ alreadyExisted: boolean }> {
    const repo = await this.cachedRepo(providerRepoId);
    const create = await this.rest(`/repos/${repo.fullName}/git/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
    });
    if (create.status === 201) return { alreadyExisted: false };

    const body = (await create.json().catch(() => ({}))) as { message?: string };
    if (create.status === 422 && /already exists/i.test(body.message ?? "")) {
      const existing = await this.rest(`/repos/${repo.fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (existing.ok) {
        const ref = (await existing.json()) as { object: { sha: string } };
        if (ref.object.sha === fromSha) return { alreadyExisted: true };
      }
      throw new BranchConflictError(branch);
    }
    if (create.status === 422) throw new UnknownBaseError();
    throw new ProviderTransientError(`branch creation failed (${create.status})`);
  }

  // --- Pull requests (D-099) -------------------------------------------------
  // The write half is draft-create, reviewer-request, and mark-ready; there
  // is no merge call here and never will be. Read is one GET per open
  // request, for the poll that keeps the mission's story current.

  private toHostPull(raw: {
    number: number;
    html_url: string;
    state: string;
    draft?: boolean;
    merged_at: string | null;
    closed_at: string | null;
    merged_by?: { login: string } | null;
    mergeable?: boolean | null;
    mergeable_state?: string;
    requested_reviewers?: { login: string }[];
    head?: { sha?: string };
  }): HostPullRequest {
    const state: HostPullRequest["state"] =
      raw.merged_at !== null
        ? "merged"
        : raw.state === "closed"
          ? "closed"
          : raw.draft
            ? "draft"
            : "ready";
    // GitHub's mergeable is computed lazily: null means "still thinking", and
    // the honest word for that is unknown, never either answer.
    const mergeable: HostPullRequest["mergeable"] =
      raw.mergeable === null || raw.mergeable === undefined
        ? "unknown"
        : raw.mergeable
          ? "clean"
          : "conflict";
    return {
      number: raw.number,
      url: raw.html_url,
      state,
      mergeable,
      requestedReviewers: (raw.requested_reviewers ?? []).map((reviewer) => reviewer.login),
      reviewThreads: [],
      mergedBy: raw.merged_by?.login ?? null,
      mergedAt: raw.merged_at,
      closedAt: raw.closed_at,
      headSha: raw.head?.sha ?? null
    };
  }

  async createPullRequest(
    providerRepoId: string,
    input: { title: string; body: string; headRef: string; baseRef: string }
  ): Promise<HostPullRequest> {
    const repo = await this.cachedRepo(providerRepoId);
    const created = await this.rest(`/repos/${repo.fullName}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headRef,
        base: input.baseRef,
        // Always a draft: the only way Novus opens one (D-099).
        draft: true
      })
    });
    if (created.status === 404) throw new UnknownRepositoryError();
    if (created.status === 422) {
      const body = (await created.json().catch(() => ({}))) as { errors?: { message?: string }[] };
      const message = body.errors?.map((error) => error.message ?? "").join(" ") ?? "";
      if (/already exists/i.test(message)) throw new PullRequestExistsError(input.headRef);
      throw new ProviderTransientError(`pull request creation was refused (422): ${message.slice(0, 200)}`);
    }
    if (!created.ok) throw new ProviderTransientError(`pull request creation failed (${created.status})`);
    return this.toHostPull((await created.json()) as Parameters<typeof this.toHostPull>[0]);
  }

  async getPullRequest(providerRepoId: string, number: number): Promise<HostPullRequest> {
    const repo = await this.cachedRepo(providerRepoId);
    const response = await this.rest(`/repos/${repo.fullName}/pulls/${number}`);
    if (response.status === 404) throw new UnknownPullRequestError();
    if (!response.ok) throw new ProviderTransientError(`pull request lookup failed (${response.status})`);
    const pull = this.toHostPull((await response.json()) as Parameters<typeof this.toHostPull>[0]);
    // Review comments ride the same poll, bounded like every ingested claim.
    const comments = await this.rest(`/repos/${repo.fullName}/pulls/${number}/comments?per_page=50`);
    if (comments.ok) {
      const list = (await comments.json()) as {
        user?: { login?: string };
        body?: string;
        path?: string | null;
        html_url?: string;
        created_at?: string;
      }[];
      pull.reviewThreads = list.slice(0, 50).map(
        (comment): ReviewThread => ({
          author: (comment.user?.login ?? "unknown").slice(0, 120),
          body: (comment.body ?? "").slice(0, 2_000),
          path: comment.path?.slice(0, 300) ?? null,
          // The REST comments list does not carry thread resolution; the
          // reflection stays honest by saying open until the threads API
          // (GraphQL) joins a later slice with review.comment.
          state: "open",
          url: comment.html_url?.slice(0, 600) ?? null,
          postedAt: comment.created_at ?? new Date().toISOString()
        })
      );
    }
    return pull;
  }

  async requestReviewers(providerRepoId: string, number: number, reviewers: string[]): Promise<void> {
    const repo = await this.cachedRepo(providerRepoId);
    const response = await this.rest(`/repos/${repo.fullName}/pulls/${number}/requested_reviewers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewers })
    });
    if (response.status === 404) throw new UnknownPullRequestError();
    if (response.status === 422) {
      throw new ProviderTransientError(
        "GitHub refused the reviewer request — a named reviewer may not be a collaborator on the repository."
      );
    }
    if (!response.ok) throw new ProviderTransientError(`reviewer request failed (${response.status})`);
  }

  async markPullRequestReady(providerRepoId: string, number: number): Promise<void> {
    const repo = await this.cachedRepo(providerRepoId);
    // REST cannot un-draft a pull request; this is the codebase's first and
    // only GraphQL call, recorded as such in D-099.
    const lookup = await this.rest(`/repos/${repo.fullName}/pulls/${number}`);
    if (lookup.status === 404) throw new UnknownPullRequestError();
    if (!lookup.ok) throw new ProviderTransientError(`pull request lookup failed (${lookup.status})`);
    const nodeId = ((await lookup.json()) as { node_id: string }).node_id;
    const token = await this.installationToken();
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: nodeId }
      })
    });
    if (!response.ok) throw new ProviderTransientError(`mark ready failed (${response.status})`);
    const body = (await response.json()) as { errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new ProviderTransientError(`mark ready was refused: ${body.errors[0]?.message.slice(0, 200)}`);
    }
  }
}
