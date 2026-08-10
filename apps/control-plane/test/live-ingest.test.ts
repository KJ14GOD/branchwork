import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAppRepositoryProvider } from "../src/github-app-provider.ts";
import { sweepPullRequestsOnce } from "../src/pull-requests.ts";
import { newDecisionId, newPullRequestId } from "../src/ids.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The reverse direction, live (D-099/D-100 ingestion): a real human acts on a
 * real GitHub pull request — comments, then merges — and Novus's poll turns
 * the host's story into durable PostgreSQL state and external-actor events.
 * Opt-in, because it writes to the account holder's scratch repository and
 * acts on GitHub as their own `gh` login:
 *
 *   NOVUS_LIVE_INGEST=1 pnpm --filter @novus/control-plane exec vitest run test/live-ingest.test.ts
 *
 * Requires NOVUS_GHAPP_ID / NOVUS_GHAPP_PEM_B64 (the App), and `gh` signed in
 * as the human whose comment and merge this ingests. Identity auth stays the
 * deterministic fake; the repository provider is the real one — exactly the
 * split ARCHITECTURE.md draws (App = machine access, the human is `gh`'s).
 *
 * What this proves that the fake cannot: the poll against api.github.com —
 * GraphQL review threads with the host's own ids and resolution state, live
 * readiness, and a merge performed by a person's own hand arriving as
 * `pr.merged` with their login, attributed external, in the events table.
 * The renderer's automatic poll of these same rows is proven in the app by
 * `e2e/pr.spec.ts`; this closes the half between GitHub and the rows.
 */

const LIVE = process.env.NOVUS_LIVE_INGEST === "1";
const TARGET = process.env.NOVUS_LIVE_PR_REPO ?? "KJ14GOD/novus-live-pr-scratch";

let harness: Harness;
let kartik: SignedIn;
let provider: GithubAppRepositoryProvider;
let scratchDir: string | null = null;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();
const gh = (args: string[]): string =>
  execFileSync("gh", args, { env: process.env }).toString().trim();

beforeAll(async () => {
  if (!LIVE) return;
  const pem = Buffer.from(process.env.NOVUS_GHAPP_PEM_B64 ?? "", "base64").toString("utf8");
  provider = new GithubAppRepositoryProvider(process.env.NOVUS_GHAPP_ID ?? "", pem);
  harness = await createHarness("novus_test_live_ingest", provider);
  kartik = await harness.signIn("kartik");
}, 120_000);

afterAll(async () => {
  await harness?.close();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("the poll ingests a real human's acts on a real pull request", () => {
  it(
    "a comment and a merge made on GitHub land in PostgreSQL as external-actor events",
    async () => {
      // --- A mission on the real repository: the server cuts a real branch --
      const repos = await provider.listRepositories();
      const target = repos.find((repo) => repo.name === TARGET);
      expect(target, `${TARGET} must be visible to the installation`).toBeTruthy();
      const providerRepoId = target!.providerRepoId;
      const base = await provider.resolveBase(providerRepoId);

      const created = await harness.app.inject({
        method: "POST",
        url: "/missions",
        headers: bearer(kartik),
        payload: {
          goal: "Live ingestion probe",
          successCriteria: "The host's story lands in the record",
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
        `select w.mission_branch, w.branch_status, m.org_id
           from workstreams w join missions m on m.mission_id = w.mission_id
          where w.wst_id = $1`,
        [workstreamId]
      );
      const missionBranch = laneRow.rows[0].mission_branch as string;
      const orgId = laneRow.rows[0].org_id as string;
      expect(laneRow.rows[0].branch_status).toBe("created");

      // --- Test setup, not the product path: give the branch a diff --------
      // (The product's own push was proven live by live-pr-adapter.test.ts;
      // this test is about ingestion, so plain gh-authenticated git does the
      // scaffolding.)
      scratchDir = mkdtempSync(join(tmpdir(), "novus-live-ingest-"));
      gh(["repo", "clone", TARGET, join(scratchDir, "repo")]);
      const checkout = join(scratchDir, "repo");
      git(checkout, ["fetch", "origin", missionBranch]);
      git(checkout, ["checkout", missionBranch]);
      writeFileSync(join(checkout, "live-ingest.txt"), "a line for a human to comment on\n");
      git(checkout, ["add", "-A"]);
      git(checkout, [
        "-c",
        "user.name=Live ingest probe",
        "-c",
        "user.email=novus@invalid",
        "commit",
        "-m",
        "The revision under review"
      ]);
      git(checkout, ["push", "origin", missionBranch]);
      const headSha = git(checkout, ["rev-parse", missionBranch]);

      // The draft opens through the product's own provider verb.
      const opened = await provider.createPullRequest(providerRepoId, {
        title: "Live ingestion probe",
        body: "Opened by the opt-in reverse-direction proof. A human will comment and merge on GitHub; Novus ingests.",
        headRef: missionBranch,
        baseRef: base.ref
      });
      await provider.markPullRequestReady(providerRepoId, opened.number);

      // The rows the sweep joins, seeded the way the create route writes them.
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
          "Live ingestion probe",
          "the sent snapshot",
          base.ref,
          missionBranch,
          headSha,
          kartik.userId
        ]
      );

      // --- The reverse direction: a real human comments on GitHub ----------
      const human = gh(["api", "user", "--jq", ".login"]);
      gh([
        "api",
        `repos/${TARGET}/pulls/${opened.number}/comments`,
        "-f",
        "body=Live probe from a human: is this line bounded?",
        "-f",
        "path=live-ingest.txt",
        "-F",
        "line=1",
        "-f",
        `commit_id=${headSha}`
      ]);

      await sweepPullRequestsOnce(harness.db, provider);
      const afterComment = await harness.db.query(
        "select review_threads, readiness, last_synced_at from pull_requests where pr_id = $1",
        [pullRequestId]
      );
      const threads = afterComment.rows[0].review_threads as {
        author: string;
        body: string;
        path: string | null;
        state: string;
        threadId: string | null;
      }[];
      const probe = threads.find((thread) => thread.body.includes("is this line bounded"));
      expect(probe, "the human's comment must be ingested").toBeTruthy();
      expect(probe!.author).toBe(human);
      expect(probe!.path).toBe("live-ingest.txt");
      expect(probe!.state).toBe("open");
      expect(probe!.threadId).toBeTruthy();
      // Live readiness rode the same pass: the repository's own merge methods.
      expect(afterComment.rows[0].readiness.allowedMergeMethods.length).toBeGreaterThan(0);
      expect(afterComment.rows[0].last_synced_at).toBeTruthy();
      const commentEvent = await harness.db.query(
        `select actor_kind, actor_id, payload from events where mission_id = $1 and kind = 'pr.comments'`,
        [missionId]
      );
      expect(commentEvent.rowCount).toBe(1);
      expect(commentEvent.rows[0].actor_kind).toBe("external");
      expect(commentEvent.rows[0].actor_id).toBe("github");
      console.warn(`[live-ingest] ${human}'s comment on ${opened.url} landed in PostgreSQL`);

      // --- And a real human merges, with their own hand ---------------------
      gh(["pr", "merge", String(opened.number), "--repo", TARGET, "--squash"]);
      await sweepPullRequestsOnce(harness.db, provider);
      const afterMerge = await harness.db.query(
        "select state, merged_by from pull_requests where pr_id = $1",
        [pullRequestId]
      );
      expect(afterMerge.rows[0].state).toBe("merged");
      expect(afterMerge.rows[0].merged_by).toBe(human);
      const mergeEvent = await harness.db.query(
        `select actor_kind, payload from events where mission_id = $1 and kind = 'pr.merged'`,
        [missionId]
      );
      expect(mergeEvent.rowCount).toBe(1);
      expect(mergeEvent.rows[0].actor_kind).toBe("external");
      expect(mergeEvent.rows[0].payload.mergedBy).toBe(human);
      console.warn(`[live-ingest] ${human}'s merge landed as an external event`);
    },
    240_000
  );
});
