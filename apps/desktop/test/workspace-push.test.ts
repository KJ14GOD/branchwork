import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushMissionBranch, BranchPushError } from "../electron/workspace-push";
import type { CloneCredential } from "../electron/workspace-clone";

/**
 * Pushing the mission branch (D-099), against a real git and a real smart-HTTP
 * remote on loopback that demands a credential — the same standard the clone
 * suite set: the part that matters is the credential path and the refusals,
 * and a stubbed transport would prove neither.
 *
 * The remote speaks the smart protocol through `git http-backend`, because a
 * push needs `git-receive-pack`; it answers 401 until a Basic credential
 * arrives, and the tests then assert the token reached git through the fd-3
 * helper and exists nowhere on disk afterwards.
 */

const TOKEN = "push-token-abcdef123456";

let root: string;
let checkout: string;
let originDir: string;
let remote: { url: string; seen: string[]; close: () => Promise<void> } | null = null;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();

function credential(remoteUrl: string): CloneCredential {
  return {
    remoteUrl,
    username: "x-access-token",
    token: TOKEN,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
}

/** A smart-HTTP git remote that refuses anonymous access. CGI over
 *  `git http-backend`, which is what a push genuinely needs. */
async function startRemote(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Basic ")) {
      seen.push(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8"));
    }
    if (!authorization.startsWith("Basic ")) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="novus"' });
      response.end("authentication required");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: originDir,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      }
    });
    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf("\r\n\r\n");
      if (split === -1) return;
      const headerText = head.subarray(0, split).toString("utf8");
      const rest = head.subarray(split + 4);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const at = line.indexOf(":");
        if (at === -1) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number(value.split(" ")[0]) || 200;
        } else {
          headers[name] = value;
        }
      }
      response.writeHead(status, headers);
      if (rest.length > 0) response.write(rest);
      headersDone = true;
    });
    backend.on("close", () => response.end());
    backend.on("error", () => {
      if (!headersDone) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

/** Every regular file under a directory, for the token-on-disk sweep. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

let baseSha: string;
let headSha: string;
const BRANCH = "novus/m-pushtest";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "novus-push-"));
  checkout = join(root, "checkout");
  originDir = join(root, "origins");
  git(root, ["init", "-b", "main", checkout]);
  git(checkout, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "--allow-empty", "-m", "base"]);
  git(checkout, ["checkout", "-b", BRANCH]);
  git(checkout, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "--allow-empty", "-m", "decided"]);
  baseSha = git(checkout, ["rev-parse", `${BRANCH}~0`]);
  git(checkout, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "--allow-empty", "-m", "after the decision"]);
  headSha = git(checkout, ["rev-parse", BRANCH]);
  expect(baseSha).not.toBe(headSha);

  git(root, ["init", "--bare", join(originDir, "repo.git")]);
  git(join(originDir, "repo.git"), ["config", "http.receivepack", "true"]);
  remote = await startRemote();
});

afterEach(async () => {
  await remote?.close();
  remote = null;
  rmSync(root, { recursive: true, force: true });
});

describe("pushing the decided revision (D-099)", () => {
  it("pushes exactly the decided revision, not the branch head, through the injected credential", async () => {
    const pushed = await pushMissionBranch({
      repositoryPath: checkout,
      branch: BRANCH,
      sha: baseSha,
      credential: credential(remote!.url)
    });
    expect(pushed.sha).toBe(baseSha);
    // The remote serves the decision, even though the local branch moved past it.
    const served = git(join(originDir, "repo.git"), ["rev-parse", `refs/heads/${BRANCH}`]);
    expect(served).toBe(baseSha);
    expect(served).not.toBe(headSha);
    // The credential reached git through the helper, as basic auth on the wire.
    expect(remote!.seen).toContain(`x-access-token:${TOKEN}`);
    // And it is nowhere on this machine afterwards: not in the checkout's
    // config, not in any file git touched.
    for (const path of filesUnder(checkout)) {
      expect(readFileSync(path, "latin1").includes(TOKEN), path).toBe(false);
    }
  });

  it("refuses a foreign branch name, a malformed revision, and a credentialed authority", async () => {
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: "main",
        sha: baseSha,
        credential: credential(remote!.url)
      })
    ).rejects.toThrowError(/mission branches it allocated/);
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: BRANCH,
        sha: "abc123",
        credential: credential(remote!.url)
      })
    ).rejects.toThrowError(/full commit id/);
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: BRANCH,
        sha: baseSha,
        credential: credential("http://user@127.0.0.1:9/repo.git")
      })
    ).rejects.toThrowError(/will not push/);
    // Nothing reached the remote for any of them.
    expect(remote!.seen).toHaveLength(0);
  });

  it("refuses a revision this checkout does not hold, and one that is not the branch's own history", async () => {
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: BRANCH,
        sha: "d".repeat(40),
        credential: credential(remote!.url)
      })
    ).rejects.toThrowError(/not in this checkout/);
    // A real commit from another line of work: main's tip is not on the
    // mission branch... main's tip is an ancestor here, so make a divergent one.
    git(checkout, ["checkout", "main"]);
    git(checkout, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "--allow-empty", "-m", "elsewhere"]);
    const foreign = git(checkout, ["rev-parse", "main"]);
    git(checkout, ["checkout", BRANCH]);
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: BRANCH,
        sha: foreign,
        credential: credential(remote!.url)
      })
    ).rejects.toThrowError(/not on the mission branch/);
    expect(remote!.seen).toHaveLength(0);
  });

  it("surfaces a non-fast-forward as words, forces nothing, and leaves the remote as it was", async () => {
    // The head lands first; then the decision tries to move the remote back.
    await pushMissionBranch({
      repositoryPath: checkout,
      branch: BRANCH,
      sha: headSha,
      credential: credential(remote!.url)
    });
    await expect(
      pushMissionBranch({
        repositoryPath: checkout,
        branch: BRANCH,
        sha: baseSha,
        credential: credential(remote!.url)
      })
    ).rejects.toThrowError(BranchPushError);
    const served = git(join(originDir, "repo.git"), ["rev-parse", `refs/heads/${BRANCH}`]);
    expect(served).toBe(headSha);
  });
});
