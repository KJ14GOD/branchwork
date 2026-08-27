import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubUserRepositoryProvider } from "../src/github-user-provider.ts";
import type { RepoActor } from "../src/repo-provider.ts";
import { newDecisionId, newPullRequestId } from "../src/ids.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The webhook, in anger (D-101): GitHub's own servers deliver a signed
 * `pull_request` event to this control plane — through a disposable
 * cloudflared quick-tunnel — and the receiver verifies the signature and
 * syncs the named request into PostgreSQL, with no poll involved anywhere.
 * Opt-in, because it acts on the scratch repository and stands up a public
 * tunnel to this machine for the duration of one test:
 *
 *   NOVUS_LIVE_WEBHOOK=1 pnpm --filter @novus/control-plane exec vitest run test/live-webhook.test.ts
 *
 * Requires NOVUS_LIVE_USER_TOKEN (the person's own repo-scoped token — `gh
 * auth token` works, D-223), `gh` signed in as the human who merges, and
 * `cloudflared` on PATH. The webhook secret is minted
 * for this run alone, registered on a repository-level hook, and the hook is
 * deleted afterwards.
 */

const LIVE = process.env.NOVUS_LIVE_WEBHOOK === "1";
const TARGET = process.env.NOVUS_LIVE_PR_REPO ?? "KJ14GOD/novus-live-pr-scratch";
const SECRET = `novus-live-${randomUUID()}`;
process.env.NOVUS_GITHUB_WEBHOOK_SECRET = SECRET;

let harness: Harness;
let kartik: SignedIn;
let provider: GithubUserRepositoryProvider;
let actor: RepoActor;
let tunnel: ChildProcess | null = null;
let hookId: number | null = null;
let scratchDir: string | null = null;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();
const gh = (args: string[]): string =>
  execFileSync("gh", args, { env: process.env }).toString().trim();

beforeAll(async () => {
  if (!LIVE) return;
  const token = process.env.NOVUS_LIVE_USER_TOKEN ?? "";
  provider = new GithubUserRepositoryProvider();
  actor = { token, login: null };
  harness = await createHarness("novus_test_live_webhook", provider);
  kartik = await harness.signIn("kartik");
  // The webhook's sync reads the row with its creator's stored token (D-223).
  await harness.db.query("update users set github_token = $2 where user_id = $1", [kartik.userId, token]);
}, 120_000);

afterAll(async () => {
  if (hookId !== null) {
    try {
      gh(["api", "-X", "DELETE", `repos/${TARGET}/hooks/${hookId}`]);
    } catch {
      /* best effort: a dead hook on a scratch repository harms nothing */
    }
  }
  tunnel?.kill("SIGTERM");
  await harness?.close();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

/** A public URL for this process, minted for the run: cloudflared prints its
 *  trycloudflare hostname on stderr once the tunnel is up. */
async function openTunnel(port: number): Promise<string> {
  tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    env: process.env
  });
  let seen = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no tunnel URL in:\n${seen}`)), 45_000);
    const watch = (chunk: Buffer) => {
      seen += chunk.toString();
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    tunnel!.stderr?.on("data", watch);
    tunnel!.stdout?.on("data", watch);
    tunnel!.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  // The edge takes its time to route a fresh hostname; the health probe is
  // the honest signal, and it is given the two minutes propagation can take.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${url}/health`);
      if (probe.ok) return url;
    } catch {
      /* not routed yet */
    }
    await new Promise((settle) => setTimeout(settle, 1_000));
  }
  throw new Error("the tunnel never routed to the control plane");
}

describe.skipIf(!LIVE)("GitHub delivers, the receiver verifies, PostgreSQL moves", () => {
  it(
    "a human's merge arrives by webhook — signed by GitHub, synced with no poll",
    async () => {
      // The control plane listens for real: a webhook cannot be injected.
      await harness.app.listen({ port: 0, host: "127.0.0.1" });
      const address = harness.app.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      const publicUrl = await openTunnel(port);
      console.warn(`[live-webhook] control plane public at ${publicUrl}`);

      // The repository-level hook, secret minted for this run alone.
      const hook = gh([
        "api",
        `repos/${TARGET}/hooks`,
        "-f",
        "name=web",
        "-F",
        "active=true",
        "-f",
        "events[]=pull_request",
        "-f",
        `config[url]=${publicUrl}/webhooks/github`,
        "-f",
        `config[secret]=${SECRET}`,
        "-f",
        "config[content_type]=json",
        "--jq",
        ".id"
      ]);
      hookId = Number(hook);
      expect(hookId).toBeGreaterThan(0);

      // --- A tracked request to be knocked about: same scaffolding as the
      // live ingestion proof. --------------------------------------------------
      expect(actor.token, "NOVUS_LIVE_USER_TOKEN must carry the person's token").toBeTruthy();
      const repos = await provider.listRepositories(actor);
      const target = repos.find((repo) => repo.name === TARGET);
      expect(target).toBeTruthy();
      const providerRepoId = target!.providerRepoId;
      const base = await provider.resolveBase(actor, providerRepoId);
      const created = await harness.app.inject({
        method: "POST",
        url: "/missions",
        headers: bearer(kartik),
        payload: {
          goal: "Live webhook probe",
          successCriteria: "The knock lands",
          provider: "github",
          providerRepoId,
          baseRef: base.ref,
          baseSha: base.sha,
          creationKey: randomUUID()
        }
      });
      expect(created.statusCode).toBe(201);
      const missionId = created.json().mission.missionId as string;
      const workstreamId = created.json().workstream.workstreamId as string;
      const laneRow = await harness.db.query(
        `select w.mission_branch, m.org_id from workstreams w
           join missions m on m.mission_id = w.mission_id where w.wst_id = $1`,
        [workstreamId]
      );
      const missionBranch = laneRow.rows[0].mission_branch as string;
      const orgId = laneRow.rows[0].org_id as string;

      scratchDir = mkdtempSync(join(tmpdir(), "novus-live-webhook-"));
      gh(["repo", "clone", TARGET, join(scratchDir, "repo")]);
      const checkout = join(scratchDir, "repo");
      git(checkout, ["fetch", "origin", missionBranch]);
      git(checkout, ["checkout", missionBranch]);
      writeFileSync(join(checkout, "live-webhook.txt"), `the knock's own line ${randomUUID()}\n`);
      git(checkout, ["add", "-A"]);
      git(checkout, ["-c", "user.name=Live webhook probe", "-c", "user.email=novus@invalid", "commit", "-m", "The revision"]);
      git(checkout, ["push", "origin", missionBranch]);
      const headSha = git(checkout, ["rev-parse", missionBranch]);
      const opened = await provider.createPullRequest(actor, providerRepoId, {
        title: "Live webhook probe",
        body: "GitHub will deliver the merge to a tunnel; no poll runs.",
        headRef: missionBranch,
        baseRef: base.ref
      });
      await provider.markPullRequestReady(actor, providerRepoId, opened.number);
      const decisionId = newDecisionId();
      const pullRequestId = newPullRequestId();
      await harness.db.query(
        `insert into decisions (dec_id, org_id, mission_id, wst_id, checkpoint_sha, decided_by, rationale)
         values ($1, $2, $3, $4, $5, $6, 'It holds.')`,
        [decisionId, orgId, missionId, workstreamId, headSha, kartik.userId]
      );
      await harness.db.query(
        `insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url,
                                    state, mergeable, title, body, base_ref, head_ref, head_sha, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'ready', 'unknown', $8, $9, $10, $11, $12, $13)`,
        [
          pullRequestId,
          orgId,
          missionId,
          workstreamId,
          decisionId,
          opened.number,
          opened.url,
          "Live webhook probe",
          "the sent snapshot",
          base.ref,
          missionBranch,
          headSha,
          kartik.userId
        ]
      );

      // --- The human merges on GitHub. Nothing polls; the knock must land. --
      const human = gh(["api", "user", "--jq", ".login"]);
      gh(["pr", "merge", String(opened.number), "--repo", TARGET, "--squash"]);
      const deadline = Date.now() + 90_000;
      let state = "ready";
      while (Date.now() < deadline) {
        const row = await harness.db.query("select state, merged_by from pull_requests where pr_id = $1", [
          pullRequestId
        ]);
        state = row.rows[0].state as string;
        if (state === "merged") {
          expect(row.rows[0].merged_by).toBe(human);
          break;
        }
        await new Promise((settle) => setTimeout(settle, 1_000));
      }
      expect(state, "the webhook delivery must sync the merge with no poll").toBe("merged");
      const event = await harness.db.query(
        `select actor_kind from events where mission_id = $1 and kind = 'pr.merged'`,
        [missionId]
      );
      expect(event.rowCount).toBe(1);
      expect(event.rows[0].actor_kind).toBe("external");
      console.warn(
        `[live-webhook] ${human}'s merge of ${opened.url} arrived by GitHub's own delivery and landed in PostgreSQL`
      );
    },
    300_000
  );
});
