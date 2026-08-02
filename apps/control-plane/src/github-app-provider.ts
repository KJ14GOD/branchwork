import { createSign } from "node:crypto";
import type { AvailableRepository, BaseRevision } from "@novus/contracts";
import {
  BranchConflictError,
  ProviderTransientError,
  UnknownBaseError,
  UnknownRepositoryError,
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
export class GithubAppRepositoryProvider implements RepositoryProvider {
  readonly kind = "fake" as const; // narrow union kept until the contract widens; behavior is live
  private token: { value: string; expiresAt: number } | null = null;
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

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const headers = { authorization: `Bearer ${this.appJwt()}`, accept: "application/vnd.github+json" };
    const installations = await fetch(`${API}/app/installations?per_page=1`, { headers });
    if (!installations.ok) throw new ProviderTransientError(`installation lookup failed (${installations.status})`);
    const list = (await installations.json()) as { id: number }[];
    const installation = list[0];
    if (!installation) throw new ProviderTransientError("the GitHub App has no installation yet");
    const minted = await fetch(`${API}/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      headers
    });
    if (!minted.ok) throw new ProviderTransientError(`installation token failed (${minted.status})`);
    const body = (await minted.json()) as { token: string; expires_at: string };
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
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
}
