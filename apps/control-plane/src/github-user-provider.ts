import type { BranchInfo, BaseStatus,
  AvailableRepository,
  BaseRevision,
  HostCheck,
  MergeMethod,
  MergeReadiness,
  PullFilesResponse,
  ReviewThread
} from "@novus/contracts";
import type { CloneCredential, CloneCredentialMinter, PushCredentialMinter } from "./repo-clone.ts";
import {
  BranchConflictError,
  MergeRefusedError,
  ProviderTransientError,
  PullRequestExistsError,
  RepoTokenMissingError,
  UnknownBaseError,
  UnknownPullRequestError,
  UnknownRepositoryError,
  type RepoActor,
  type HostPullRequest,
  type RepositoryProvider,
  type HostPullRequestListing
} from "./repo-provider.ts";

const API = "https://api.github.com";

interface CachedRepo {
  providerRepoId: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * The live repository provider (D-223, replacing the D-031/D-032 GitHub App
 * adapter): every call is performed with the acting person's own OAuth token,
 * so GitHub answers with exactly that person's reach — owned, collaborator,
 * and organization repositories alike — and enforces their authorization on
 * every act. The server holds no GitHub credential of its own; a call with no
 * token, or a token GitHub rejects, refuses by name rather than falling back
 * to anything shared.
 */
export class GithubUserRepositoryProvider
  implements RepositoryProvider, CloneCredentialMinter, PushCredentialMinter
{
  readonly kind = "github" as const;
  private repoCache = new Map<string, CachedRepo>();
  /** api.github.com in production; a local stub in the deterministic test. */
  private readonly apiBase: string;

  constructor(apiBase: string = API) {
    this.apiBase = apiBase;
  }

  /** One authenticated request: the actor's token or a named refusal. A 401
   *  is the token dying (revoked, expired), which no retry cures — the same
   *  named refusal as holding no token at all. */
  private async authed(actor: RepoActor, path: string, init: RequestInit = {}): Promise<Response> {
    if (!actor.token) throw new RepoTokenMissingError();
    const response = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${actor.token}`,
        accept: "application/vnd.github+json"
      }
    });
    if (response.status === 401) {
      throw new RepoTokenMissingError("GitHub no longer accepts the stored sign-in. Sign out of Novus and back in.");
    }
    return response;
  }

  private async cachedRepo(actor: RepoActor, providerRepoId: string): Promise<CachedRepo> {
    const hit = this.repoCache.get(providerRepoId);
    if (hit) return hit;
    const response = await this.authed(actor, `/repositories/${encodeURIComponent(providerRepoId)}`);
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`repository lookup failed (${response.status})`);
    const repo = (await response.json()) as { id: number; full_name: string; default_branch: string };
    const cached = { providerRepoId: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch };
    this.repoCache.set(cached.providerRepoId, cached);
    return cached;
  }

  /**
   * The clone credential is the owner's own token (D-223): the same
   * credential their own `git` would present, handed to the runner they
   * enrolled, spent per operation and never stored. Unlike the retired App
   * mint it cannot be narrowed to one repository — the trade D-223 names —
   * so `expiresAt` bounds the *handout*, not the token's own life: the
   * runner must use it promptly and come back for another.
   */
  async mintCloneCredential(actor: RepoActor, providerRepoId: string): Promise<CloneCredential> {
    if (!actor.token) throw new RepoTokenMissingError();
    const repo = await this.cachedRepo(actor, providerRepoId);
    return {
      remoteUrl: `https://github.com/${repo.fullName}.git`,
      username: "x-access-token",
      token: actor.token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };
  }

  /** The push credential (D-099) is the same handout: with a user token
   *  there is no separate narrower grant to mint, so read and write differ
   *  only in what GitHub lets this person do to this repository. */
  async mintPushCredential(actor: RepoActor, providerRepoId: string): Promise<CloneCredential> {
    return this.mintCloneCredential(actor, providerRepoId);
  }

  async listRepositories(actor: RepoActor): Promise<AvailableRepository[]> {
    // The person's whole reach (D-223): owned, collaborator, and org-member
    // repositories — exactly what their own `git` could clone — freshest
    // push first (D-139), from the host's own ordering.
    const repos: AvailableRepository[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.authed(
        actor,
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=${page}`
      );
      if (!response.ok) throw new ProviderTransientError(`repository listing failed (${response.status})`);
      const body = (await response.json()) as {
        id: number;
        full_name: string;
        default_branch: string;
        pushed_at?: string | null;
      }[];
      for (const repo of body) {
        const cached = { providerRepoId: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch };
        this.repoCache.set(cached.providerRepoId, cached);
        repos.push({
          providerRepoId: cached.providerRepoId,
          name: cached.fullName,
          defaultBranch: cached.defaultBranch,
          pushedAt: repo.pushed_at ?? null
        });
      }
      // A short page is the last page; /user/repos carries no total_count.
      if (body.length < 100) break;
    }
    return repos;
  }

  async resolveBase(actor: RepoActor, providerRepoId: string, ref?: string): Promise<BaseRevision> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const target = ref ?? repo.defaultBranch;
    const response = await this.authed(actor, `/repos/${repo.fullName}/branches/${encodeURIComponent(target)}`);
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`base resolution failed (${response.status})`);
    const branch = (await response.json()) as { commit: { sha: string } };
    return { ref: target, sha: branch.commit.sha };
  }

  async listBranches(actor: RepoActor, providerRepoId: string): Promise<BranchInfo[]> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    // One page of 100 is the cap, stated rather than silently paged: a
    // repository with more branches shows its first hundred by name and the
    // default is always present because the host sorts it in.
    const response = await this.authed(actor, `/repos/${repo.fullName}/branches?per_page=100`);
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`branch listing failed (${response.status})`);
    const body = (await response.json()) as { name: string; commit: { sha: string } }[];
    const rows = body.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      isDefault: branch.name === repo.defaultBranch
    }));
    rows.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : a.name.localeCompare(b.name)));
    if (!rows.some((row) => row.isDefault)) {
      const base = await this.resolveBase(actor, providerRepoId);
      rows.unshift({ name: base.ref, sha: base.sha, isDefault: true });
    }
    return rows;
  }

  async baseStatus(actor: RepoActor, providerRepoId: string, ref: string, pinnedSha: string): Promise<BaseStatus> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const checkedAt = new Date().toISOString();
    const head = await this.authed(actor, `/repos/${repo.fullName}/branches/${encodeURIComponent(ref)}`);
    if (head.status === 404) return { state: "missing", aheadBy: null, checkedAt };
    if (!head.ok) throw new ProviderTransientError(`base check failed (${head.status})`);
    const tip = ((await head.json()) as { commit: { sha: string } }).commit.sha;
    if (tip === pinnedSha) return { state: "current", aheadBy: null, checkedAt };
    // The host's own ancestry answer: comparing pin...tip says "ahead" when
    // the pin is an ancestor (the branch moved forward over it), anything
    // else means the pinned commit is no longer in the branch's history.
    const compare = await this.authed(
      actor,
      `/repos/${repo.fullName}/compare/${encodeURIComponent(pinnedSha)}...${encodeURIComponent(tip)}`
    );
    if (compare.status === 404) return { state: "rewritten", aheadBy: null, checkedAt };
    if (!compare.ok) throw new ProviderTransientError(`base comparison failed (${compare.status})`);
    const result = (await compare.json()) as { status: string; ahead_by: number };
    if (result.status === "ahead") return { state: "moved", aheadBy: result.ahead_by, checkedAt };
    return { state: "rewritten", aheadBy: null, checkedAt };
  }

  async ensureBranch(
    actor: RepoActor,
    providerRepoId: string,
    branch: string,
    fromSha: string
  ): Promise<{ alreadyExisted: boolean }> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const create = await this.authed(actor, `/repos/${repo.fullName}/git/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
    });
    if (create.status === 201) return { alreadyExisted: false };

    const body = (await create.json().catch(() => ({}))) as { message?: string };
    if (create.status === 422 && /already exists/i.test(body.message ?? "")) {
      const existing = await this.authed(actor, `/repos/${repo.fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
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
  // The write half is draft-create, reviewer-request, and mark-ready. Read is
  // one GET per open request, for the poll that keeps the mission's story
  // current. Every act is the actor's own: GitHub shows the person, not an
  // app, as the author (D-223).

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
    actor: RepoActor,
    providerRepoId: string,
    input: { title: string; body: string; headRef: string; baseRef: string }
  ): Promise<HostPullRequest> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const created = await this.authed(actor, `/repos/${repo.fullName}/pulls`, {
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

  async listPullRequestsForHead(
    actor: RepoActor,
    providerRepoId: string,
    headRef: string
  ): Promise<HostPullRequestListing[]> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const owner = repo.fullName.split("/")[0] ?? "";
    const response = await this.authed(
      actor,
      `/repos/${repo.fullName}/pulls?state=all&per_page=20&sort=created&direction=desc&head=${encodeURIComponent(`${owner}:${headRef}`)}`
    );
    if (response.status === 404) throw new UnknownRepositoryError();
    if (!response.ok) throw new ProviderTransientError(`pull request listing failed (${response.status})`);
    const raw = (await response.json()) as (Parameters<typeof this.toHostPull>[0] & {
      title?: string;
      body?: string | null;
      base?: { ref?: string };
      head?: { ref?: string; sha?: string };
      user?: { login?: string } | null;
    })[];
    return raw.map((entry) => ({
      ...this.toHostPull(entry),
      title: entry.title ?? `PR #${entry.number}`,
      body: entry.body ?? "",
      headRef: entry.head?.ref ?? headRef,
      baseRef: entry.base?.ref ?? repo.defaultBranch,
      authorLogin: entry.user?.login ?? null
    }));
  }

  async getPullRequest(actor: RepoActor, providerRepoId: string, number: number): Promise<HostPullRequest> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`);
    if (response.status === 404) throw new UnknownPullRequestError();
    if (!response.ok) throw new ProviderTransientError(`pull request lookup failed (${response.status})`);
    const raw = (await response.json()) as Parameters<typeof this.toHostPull>[0] & { node_id?: string };
    const pull = this.toHostPull(raw);
    // Review threads ride the same poll — the GraphQL threads API, which is
    // the one place resolution state and thread ids live (D-100; it also
    // retires D-099's REST limitation of every comment reading as open).
    if (raw.node_id) {
      try {
        const data = (await this.graphql(
          actor,
          `query($id: ID!) { node(id: $id) { ... on PullRequest { reviewThreads(first: 50) { nodes {
             id isResolved comments(first: 1) { nodes { author { login } body path line url createdAt } } } } } } }`,
          { id: raw.node_id }
        )) as {
          node?: {
            reviewThreads?: {
              nodes?: {
                id?: string;
                isResolved?: boolean;
                comments?: {
                  nodes?: {
                    author?: { login?: string } | null;
                    body?: string;
                    path?: string | null;
                    line?: number | null;
                    url?: string;
                    createdAt?: string;
                  }[];
                };
              }[];
            };
          };
        };
        const nodes = data.node?.reviewThreads?.nodes ?? [];
        pull.reviewThreads = nodes.slice(0, 50).flatMap((thread): ReviewThread[] => {
          const first = thread.comments?.nodes?.[0];
          if (!first) return [];
          return [
            {
              threadId: thread.id?.slice(0, 200) ?? null,
              author: (first.author?.login ?? "unknown").slice(0, 120),
              body: (first.body ?? "").slice(0, 2_000),
              path: first.path?.slice(0, 300) ?? null,
              line: first.line ?? null,
              state: thread.isResolved ? "resolved" : "open",
              url: first.url?.slice(0, 600) ?? null,
              postedAt: first.createdAt ?? new Date().toISOString()
            }
          ];
        });
      } catch {
        // Threads are enrichment on this read; the pull itself already
        // answered. The next poll asks again.
      }
    }
    return pull;
  }

  private async graphql(actor: RepoActor, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await this.authed(actor, `/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new ProviderTransientError(`GraphQL failed (${response.status})`);
    const body = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new ProviderTransientError(`GraphQL was refused: ${body.errors[0]?.message.slice(0, 200)}`);
    }
    return body.data ?? {};
  }

  // --- The gate and the completion verbs (D-100) -----------------------------

  async getMergeReadiness(actor: RepoActor, providerRepoId: string, number: number): Promise<MergeReadiness> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const pullResponse = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`);
    if (pullResponse.status === 404) throw new UnknownPullRequestError();
    if (!pullResponse.ok) throw new ProviderTransientError(`pull request lookup failed (${pullResponse.status})`);
    const pull = (await pullResponse.json()) as {
      head: { sha: string; ref: string };
      base: { ref: string };
    };

    // Which contexts branch protection requires. Degrades to "none required"
    // where the person cannot read protection — the merge call itself remains
    // the authority on what the host refuses.
    let required = new Set<string>();
    const protection = await this.authed(
      actor,
      `/repos/${repo.fullName}/branches/${encodeURIComponent(pull.base.ref)}/protection/required_status_checks`
    );
    if (protection.ok) {
      const body = (await protection.json()) as { contexts?: string[] };
      required = new Set(body.contexts ?? []);
    }

    const checks: HostCheck[] = [];
    const runs = await this.authed(actor, `/repos/${repo.fullName}/commits/${pull.head.sha}/check-runs?per_page=50`);
    if (runs.ok) {
      const body = (await runs.json()) as {
        check_runs?: { name: string; status: string; conclusion: string | null; html_url?: string | null }[];
      };
      for (const run of (body.check_runs ?? []).slice(0, 50)) {
        const status: HostCheck["status"] =
          run.status !== "completed"
            ? "pending"
            : run.conclusion === "success"
              ? "passed"
              : run.conclusion === "skipped" || run.conclusion === "neutral"
                ? "skipped"
                : "failed";
        checks.push({
          name: run.name.slice(0, 200),
          status,
          required: required.has(run.name),
          kind: "check",
          url: run.html_url?.slice(0, 600) ?? null
        });
      }
    }
    const statuses = await this.authed(actor, `/repos/${repo.fullName}/commits/${pull.head.sha}/status`);
    if (statuses.ok) {
      const body = (await statuses.json()) as {
        statuses?: { context: string; state: string; target_url?: string | null }[];
      };
      for (const status of (body.statuses ?? []).slice(0, 50 - checks.length)) {
        checks.push({
          name: status.context.slice(0, 200),
          status: status.state === "success" ? "passed" : status.state === "pending" ? "pending" : "failed",
          required: required.has(status.context),
          kind: "status",
          url: status.target_url?.slice(0, 600) ?? null
        });
      }
    }

    // The latest review per person is their standing answer.
    let approvals = 0;
    let changesRequested = 0;
    const reviews = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/reviews?per_page=100`);
    if (reviews.ok) {
      const list = (await reviews.json()) as { user?: { login?: string }; state?: string }[];
      const latest = new Map<string, string>();
      for (const review of list) {
        const login = review.user?.login;
        const state = review.state;
        if (!login || !state) continue;
        if (state === "APPROVED" || state === "CHANGES_REQUESTED") latest.set(login, state);
      }
      for (const state of latest.values()) {
        if (state === "APPROVED") approvals += 1;
        else changesRequested += 1;
      }
    }

    let behindBy: number | null = null;
    let aheadBy: number | null = null;
    const compare = await this.authed(
      actor,
      `/repos/${repo.fullName}/compare/${encodeURIComponent(pull.base.ref)}...${encodeURIComponent(pull.head.ref)}`
    );
    if (compare.ok) {
      const body = (await compare.json()) as { ahead_by?: number; behind_by?: number };
      aheadBy = body.ahead_by ?? null;
      behindBy = body.behind_by ?? null;
    }

    // The repository's own allowed methods, read fresh — never assumed.
    const allowed: MergeMethod[] = [];
    const repoResponse = await this.authed(actor, `/repositories/${encodeURIComponent(providerRepoId)}`);
    if (repoResponse.ok) {
      const body = (await repoResponse.json()) as {
        allow_merge_commit?: boolean;
        allow_squash_merge?: boolean;
        allow_rebase_merge?: boolean;
      };
      if (body.allow_merge_commit !== false) allowed.push("merge");
      if (body.allow_squash_merge !== false) allowed.push("squash");
      if (body.allow_rebase_merge !== false) allowed.push("rebase");
    } else {
      allowed.push("merge", "squash", "rebase");
    }

    return {
      checks,
      reviewDecision: changesRequested > 0 ? "changes_requested" : approvals > 0 ? "approved" : "none",
      approvals,
      changesRequested,
      behindBy,
      aheadBy,
      allowedMergeMethods: allowed,
      syncedAt: new Date().toISOString()
    };
  }

  async mergePullRequest(
    actor: RepoActor,
    providerRepoId: string,
    number: number,
    method: MergeMethod
  ): Promise<{ sha: string | null }> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merge_method: method })
    });
    if (response.status === 404) throw new UnknownPullRequestError();
    if (response.status === 405 || response.status === 409 || response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      // The host's own refusal, in the host's own words — the first gating
      // tier of D-100, never overridable from Novus.
      throw new MergeRefusedError(body.message?.slice(0, 300) ?? "GitHub refused the merge.");
    }
    if (!response.ok) throw new ProviderTransientError(`merge failed (${response.status})`);
    const body = (await response.json()) as { sha?: string; merged?: boolean };
    if (body.merged !== true) throw new MergeRefusedError("GitHub did not perform the merge.");
    return { sha: body.sha ?? null };
  }

  async updatePullRequestBranch(actor: RepoActor, providerRepoId: string, number: number): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/update-branch`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    if (response.status === 404) throw new UnknownPullRequestError();
    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new MergeRefusedError(body.message?.slice(0, 300) ?? "GitHub could not update the branch.");
    }
    if (!response.ok && response.status !== 202) {
      throw new ProviderTransientError(`update-branch failed (${response.status})`);
    }
  }

  async closePullRequest(actor: RepoActor, providerRepoId: string, number: number): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" })
    });
    if (response.status === 404) throw new UnknownPullRequestError();
    if (!response.ok) throw new ProviderTransientError(`close failed (${response.status})`);
  }

  async deleteBranchRef(actor: RepoActor, providerRepoId: string, branch: string): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "DELETE"
    });
    if (response.status === 404 || response.status === 422) throw new UnknownBaseError();
    if (!response.ok && response.status !== 204) {
      throw new ProviderTransientError(`branch deletion failed (${response.status})`);
    }
  }

  async listPullFiles(actor: RepoActor, providerRepoId: string, number: number): Promise<PullFilesResponse> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const filesResponse = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/files?per_page=100`);
    if (filesResponse.status === 404) throw new UnknownPullRequestError();
    if (!filesResponse.ok) throw new ProviderTransientError(`file listing failed (${filesResponse.status})`);
    const rawFiles = (await filesResponse.json()) as {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[];
    const files = rawFiles.slice(0, 150).map((file) => ({
      path: file.filename.slice(0, 300),
      changeState:
        file.status === "added" || file.status === "copied"
          ? ("added" as const)
          : file.status === "removed"
            ? ("deleted" as const)
            : file.status === "renamed"
              ? ("renamed" as const)
              : ("modified" as const),
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch?.slice(0, 12_000) ?? null
    }));
    const commitsResponse = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/commits?per_page=100`);
    const commits = commitsResponse.ok
      ? ((await commitsResponse.json()) as {
          sha: string;
          commit: { message: string; author?: { name?: string } };
          author?: { login?: string } | null;
        }[])
          .slice(0, 100)
          .map((commit) => ({
            sha: commit.sha.slice(0, 64),
            message: (commit.commit.message.split("\n")[0] ?? "").slice(0, 400),
            author: (commit.author?.login ?? commit.commit.author?.name ?? "unknown").slice(0, 120)
          }))
      : [];
    return { files, commits };
  }

  async createPullComment(
    actor: RepoActor,
    providerRepoId: string,
    number: number,
    input: { body: string; path?: string; line?: number }
  ): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    // The author is the actor whose token performs the call (D-101; the app
    // fallback is gone since D-223 — no token, no comment).
    if (input.path !== undefined && input.line !== undefined) {
      const pullResponse = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`);
      if (pullResponse.status === 404) throw new UnknownPullRequestError();
      if (!pullResponse.ok) throw new ProviderTransientError(`pull request lookup failed (${pullResponse.status})`);
      const pull = (await pullResponse.json()) as { head: { sha: string } };
      const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: input.body,
          commit_id: pull.head.sha,
          path: input.path,
          line: input.line,
          side: "RIGHT"
        })
      });
      if (response.status === 404) throw new UnknownPullRequestError();
      if (response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new ProviderTransientError(
          `GitHub refused the inline comment: ${body.message?.slice(0, 200) ?? "the line may not be part of the diff"}`
        );
      }
      if (!response.ok) throw new ProviderTransientError(`comment failed (${response.status})`);
      return;
    }
    const response = await this.authed(actor, `/repos/${repo.fullName}/issues/${number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: input.body })
    });
    if (response.status === 404) throw new UnknownPullRequestError();
    if (!response.ok && response.status !== 201) {
      throw new ProviderTransientError(`comment failed (${response.status})`);
    }
  }

  async resolveReviewThread(actor: RepoActor, providerRepoId: string, threadId: string): Promise<void> {
    void providerRepoId; // resolution is by the host's own global thread id
    await this.graphql(
      actor,
      `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
      { id: threadId }
    );
  }

  async setPullRequestMetadata(
    actor: RepoActor,
    providerRepoId: string,
    number: number,
    input: { title?: string; body?: string; labels?: string[] }
  ): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    if (input.title !== undefined || input.body !== undefined) {
      const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {})
        })
      });
      if (response.status === 404) throw new UnknownPullRequestError();
      if (!response.ok) throw new ProviderTransientError(`metadata update failed (${response.status})`);
    }
    if (input.labels !== undefined) {
      const response = await this.authed(actor, `/repos/${repo.fullName}/issues/${number}/labels`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels: input.labels })
      });
      if (response.status === 404) throw new UnknownPullRequestError();
      if (!response.ok) throw new ProviderTransientError(`label update failed (${response.status})`);
    }
  }

  async requestReviewers(actor: RepoActor, providerRepoId: string, number: number, reviewers: string[]): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    const response = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}/requested_reviewers`, {
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

  async markPullRequestReady(actor: RepoActor, providerRepoId: string, number: number): Promise<void> {
    const repo = await this.cachedRepo(actor, providerRepoId);
    // REST cannot un-draft a pull request; GraphQL is the one way (D-099).
    const lookup = await this.authed(actor, `/repos/${repo.fullName}/pulls/${number}`);
    if (lookup.status === 404) throw new UnknownPullRequestError();
    if (!lookup.ok) throw new ProviderTransientError(`pull request lookup failed (${lookup.status})`);
    const nodeId = ((await lookup.json()) as { node_id: string }).node_id;
    await this.graphql(
      actor,
      "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
      { id: nodeId }
    );
  }
}
