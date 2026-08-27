import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { GithubUserRepositoryProvider } from "../src/github-user-provider.ts";
import { RepoTokenMissingError } from "../src/repo-provider.ts";

/**
 * The user-token provider's load-bearing behavior (D-223), proven against a
 * local stub standing in for api.github.com — the exact requests it sends and
 * the exact refusals it makes, none of which the route-level suites can see
 * through the deterministic fake:
 *
 *  - listing asks for the person's whole reach (`/user/repos` with the
 *    owner,collaborator,organization_member affiliation — the Conductor-shaped
 *    fix the decision exists for) under `Bearer {token}`;
 *  - a null token refuses by name before any network call;
 *  - a 401 — the token revoked or expired — refuses the same way, never as a
 *    transient error a retry would wrongly soothe;
 *  - the clone credential hands back the owner's own token, not a mint.
 */

let server: Server;
let base: string;
let seen: { path: string; authorization: string | null }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization ?? null });
    const url = request.url ?? "";
    if (request.headers.authorization === "Bearer gho_dead") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    if (url.startsWith("/user/repos")) {
      const page = Number(new URL(url, "http://x").searchParams.get("page") ?? "1");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          page === 1
            ? [
                { id: 9001, full_name: "kartik/own-repo", default_branch: "main", pushed_at: "2026-08-27T00:00:00Z" },
                // The row the whole decision exists for: someone else's
                // repository the person was invited to.
                { id: 9002, full_name: "teammate/shared-repo", default_branch: "dev", pushed_at: null }
              ]
            : []
        )
      );
      return;
    }
    if (url.startsWith("/repositories/9002")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 9002, full_name: "teammate/shared-repo", default_branch: "dev" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Not Found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no stub port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("the user-token provider (D-223)", () => {
  it("lists the person's whole reach — collaborator repositories included — under their own token", async () => {
    seen = [];
    const provider = new GithubUserRepositoryProvider(base);
    const repos = await provider.listRepositories({ token: "gho_live", login: "kartik" });
    expect(repos.map((repo) => repo.name)).toEqual(["kartik/own-repo", "teammate/shared-repo"]);
    expect(repos[0]?.pushedAt).toBe("2026-08-27T00:00:00Z");
    const listing = seen.find((request) => request.path.startsWith("/user/repos"));
    expect(listing?.authorization).toBe("Bearer gho_live");
    // The affiliation is the point: owner alone would hide the invited rows.
    expect(listing?.path).toContain("affiliation=owner,collaborator,organization_member");
    expect(listing?.path).toContain("sort=pushed");
  });

  it("refuses a null token by name before any network call", async () => {
    seen = [];
    const provider = new GithubUserRepositoryProvider(base);
    await expect(provider.listRepositories({ token: null, login: "kartik" })).rejects.toBeInstanceOf(
      RepoTokenMissingError
    );
    expect(seen).toEqual([]);
  });

  it("treats a 401 — the token revoked — as the same named refusal, never a transient error", async () => {
    const provider = new GithubUserRepositoryProvider(base);
    await expect(provider.listRepositories({ token: "gho_dead", login: "kartik" })).rejects.toBeInstanceOf(
      RepoTokenMissingError
    );
  });

  it("hands the owner's own token back as the clone credential, aimed at the real remote", async () => {
    const provider = new GithubUserRepositoryProvider(base);
    const credential = await provider.mintCloneCredential({ token: "gho_live", login: "kartik" }, "9002");
    expect(credential.remoteUrl).toBe("https://github.com/teammate/shared-repo.git");
    expect(credential.username).toBe("x-access-token");
    expect(credential.token).toBe("gho_live");
    expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.now());
  });
});
