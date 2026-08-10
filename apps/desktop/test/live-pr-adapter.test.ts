import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAppRepositoryProvider } from "../../control-plane/src/github-app-provider.ts";
import { cloneGitExec } from "../electron/workspace-clone";
import { pushMissionBranch } from "../electron/workspace-push";

/**
 * The live GitHub half of D-099, exercised for real — opt-in, because it
 * writes to a real repository on the account holder's GitHub:
 *
 *   NOVUS_LIVE_PR=1 pnpm --filter @novus/desktop exec vitest run test/live-pr-adapter.test.ts
 *
 * Requires `NOVUS_GHAPP_ID` and `NOVUS_GHAPP_PEM_B64` in the environment (the
 * control plane's own .env), the app installation covering the target
 * repository, and the installation re-approved with `pull_requests: write`.
 * The target defaults to a scratch repository and must never be a real one:
 * the test pushes a branch and opens a draft pull request there.
 *
 * What this proves that the fake cannot: the App JWT → installation token →
 * per-repository credential chain against api.github.com; a real clone and a
 * real push through the fd-3 helper; a real draft opening; reviewers really
 * requested; mark-ready really un-drafting (the GraphQL call). What it
 * deliberately does not do: merge anything — no verb for that exists to call.
 */

const LIVE = process.env.NOVUS_LIVE_PR === "1";
const TARGET = process.env.NOVUS_LIVE_PR_REPO ?? "KJ14GOD/novus-live-pr-scratch";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();

describe.skipIf(!LIVE)("the live GitHub adapter publishes a decision (D-099)", () => {
  it(
    "clones, pushes the decided revision, opens a draft, requests review, and marks it ready — against real GitHub",
    async () => {
      const appId = process.env.NOVUS_GHAPP_ID ?? "";
      const pem = Buffer.from(process.env.NOVUS_GHAPP_PEM_B64 ?? "", "base64").toString("utf8");
      expect(appId, "NOVUS_GHAPP_ID must be set").not.toBe("");
      expect(pem, "NOVUS_GHAPP_PEM_B64 must be set").not.toBe("");
      const provider = new GithubAppRepositoryProvider(appId, pem);

      // The installation must actually cover the scratch repository.
      const repos = await provider.listRepositories("live");
      const target = repos.find((repo) => repo.name === TARGET);
      expect(target, `${TARGET} must be visible to the installation`).toBeTruthy();
      const providerRepoId = target!.providerRepoId;

      const base = await provider.resolveBase(providerRepoId);
      expect(base.sha).toMatch(/^[0-9a-f]{40}$/);

      // A real clone through the minted read credential, exactly the runner's
      // own path.
      const root = mkdtempSync(join(tmpdir(), "novus-live-pr-"));
      try {
        const readCredential = await provider.mintCloneCredential(providerRepoId);
        const checkout = join(root, "checkout");
        const cloned = await cloneGitExec(
          null,
          ["clone", readCredential.remoteUrl, checkout],
          readCredential
        );
        expect(cloned.code, cloned.stderr).toBe(0);

        // A mission-shaped branch with one real commit: the decided revision.
        const branch = `novus/m-live${Date.now().toString(36)}`;
        git(checkout, ["checkout", "-b", branch]);
        writeFileSync(join(checkout, "live-proof.txt"), `pushed by the live D-099 proof\n`);
        git(checkout, ["add", "-A"]);
        git(checkout, [
          "-c",
          "user.name=Novus live proof",
          "-c",
          "user.email=novus@invalid",
          "commit",
          "-m",
          "The decided revision"
        ]);
        const decided = git(checkout, ["rev-parse", branch]);

        // The push half: the desktop's own module, a write-scoped credential.
        const writeCredential = await provider.mintPushCredential(providerRepoId);
        const pushed = await pushMissionBranch({
          repositoryPath: checkout,
          branch,
          sha: decided,
          credential: writeCredential
        });
        expect(pushed.sha).toBe(decided);

        // The draft opens on real GitHub, from the pushed branch.
        const opened = await provider.createPullRequest(providerRepoId, {
          title: "Novus live proof: a decision publishes as a draft",
          body: "Opened by the opt-in live D-099 proof. Novus opens only drafts, and never merges — merging happens on GitHub, by humans.",
          headRef: branch,
          baseRef: base.ref
        });
        expect(opened.state).toBe("draft");
        expect(opened.number).toBeGreaterThan(0);
        expect(opened.url).toContain(`github.com/${TARGET}/pull/`);
        console.warn(`[live-pr] opened ${opened.url}`);

        // Reviewers, really requested.
        await provider.requestReviewers(providerRepoId, opened.number, ["KJ14GOD"]);
        const afterAsk = await provider.getPullRequest(providerRepoId, opened.number);
        expect(afterAsk.requestedReviewers).toContain("KJ14GOD");

        // Ready, really un-drafted — the GraphQL call.
        await provider.markPullRequestReady(providerRepoId, opened.number);
        const deadline = Date.now() + 30_000;
        let state = "draft";
        while (Date.now() < deadline) {
          const current = await provider.getPullRequest(providerRepoId, opened.number);
          state = current.state;
          if (state === "ready") break;
          await new Promise((settle) => setTimeout(settle, 1_000));
        }
        expect(state).toBe("ready");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000
  );
});
