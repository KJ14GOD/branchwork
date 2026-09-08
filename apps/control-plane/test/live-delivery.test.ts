import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubUserRepositoryProvider } from "../src/github-user-provider.ts";
import { createHarness } from "./harness.ts";
import { newDecisionId, newPullRequestId } from "../src/ids.ts";
import type { DeliveryResponse, WorkflowDetail } from "@novus/contracts";

// Requires an explicitly selected, disposable repository with GitHub environment
// reviewers available. Never changes visibility or buys an account upgrade.
const enabled = process.env.NOVUS_LIVE_DELIVERY === "1";
const gh = (args: string[], input?: unknown) => execFileSync("gh", args, {
  encoding: "utf8", timeout: 60_000, input: input === undefined ? undefined : JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"]
}).trim();
async function until<T>(read: () => Promise<T>, matches: (v: T) => boolean, label: string): Promise<T> {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
it.skipIf(!enabled)("real GitHub: inspect Actions, approve one environment, reject another, review and merge the exact PR revision", async () => {
  const target = process.env.NOVUS_LIVE_DELIVERY_REPO;
  if (!target || !/^[\w-]+\/novus-[\w-]*scratch$/.test(target)) throw new Error("Name an explicitly authorized novus-…scratch repository in NOVUS_LIVE_DELIVERY_REPO.");
  const user = JSON.parse(gh(["api", "user"])) as { id: number; login: string };
  const token = gh(["auth", "token"]);
  const actor = { token, login: user.login };
  const repo = JSON.parse(gh(["api", `repos/${target}`])) as { id: number };
  const provider = new GithubUserRepositoryProvider();
  const harness = await createHarness("novus_test_live_delivery", provider);
  const signed = await harness.signIn("delivery-proof");
  await harness.db.query("update users set github_token = $2, login = $3 where user_id = $1", [signed.userId, token, user.login]);
  await harness.app.listen({ host: "127.0.0.1", port: 0 });
  const address = harness.app.server.address();
  if (!address || typeof address === "string") throw new Error("No listening server");
  const root = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, input?: unknown) => {
    const response = await fetch(root + path, { method: input === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const dir = mkdtempSync(join(tmpdir(), "novus-live-delivery-"));
  let branch: string | null = null;
  let number: number | null = null;
  let merged = false;
  try {
    // These names belong to this disposable proof, never a production environment.
    for (const name of ["novus-delivery-proof", "novus-delivery-rejection"]) gh(["api", "-X", "PUT", `repos/${target}/environments/${name}`, "--input", "-"], { reviewers: [{ type: "User", id: user.id }], prevent_self_review: false });
    const base = await provider.resolveBase(actor, String(repo.id));
    const created = await request("/missions", { goal: "GitHub delivery live proof", successCriteria: "Separate review, deployment approval and merge are enforced", provider: "github", providerRepoId: String(repo.id), baseRef: base.ref, baseSha: base.sha, creationKey: randomUUID() });
    expect(created.status).toBe(201);
    const missionId = created.body.mission.missionId as string;
    const workstreamId = created.body.workstream.workstreamId as string;
    const lane = (await harness.db.query("select mission_branch from workstreams where wst_id = $1", [workstreamId])).rows[0];
    branch = lane.mission_branch;
    gh(["repo", "clone", target, join(dir, "repo")]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: join(dir, "repo"), encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    git(["checkout", branch!]);
    mkdirSync(join(dir, "repo", ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, "repo", ".github", "workflows", "novus-delivery.yml"), readFileSync(new URL("./fixtures/delivery-workflow.yml", import.meta.url)));
    writeFileSync(join(dir, "repo", "delivery-proof.txt"), `Generated integration fixture ${randomUUID()}\n`);
    git(["add", ".github/workflows/novus-delivery.yml", "delivery-proof.txt"]);
    git(["-c", "user.name=Novus delivery proof", "-c", "user.email=novus@invalid", "commit", "-m", "Verify separate GitHub deployment reviews"]);
    git(["push", "origin", branch!]);
    const headSha = git(["rev-parse", "HEAD"]);
    const opened = await provider.createPullRequest(actor, String(repo.id), { headRef: branch!, baseRef: base.ref, title: "Novus delivery integration proof", body: "Generated test files only. This verifies separate deployment reviews, a formal PR comment, and revision-bound merge." });
    number = opened.number;
    await provider.markPullRequestReady(actor, String(repo.id), number);
    const decisionId = newDecisionId(), pullId = newPullRequestId();
    await harness.db.query("insert into decisions (dec_id, org_id, mission_id, wst_id, checkpoint_sha, decided_by, rationale) values ($1,$2,$3,$4,$5,$6,'Integration fixture')", [decisionId, signed.orgId, missionId, workstreamId, headSha, signed.userId]);
    await harness.db.query("insert into pull_requests (pr_id, org_id, mission_id, wst_id, dec_id, provider_number, url, state, mergeable, title, body, base_ref, head_ref, head_sha, created_by) values ($1,$2,$3,$4,$5,$6,$7,'ready','unknown','Delivery proof','Generated fixture',$8,$9,$10,$11)", [pullId, signed.orgId, missionId, workstreamId, decisionId, number, opened.url, base.ref, branch, headSha, signed.userId]);
    const path = `/pull-requests/${pullId}`;
    const list = await until(async () => {
      const r = await request(`${path}/delivery`); expect(r.status).toBe(200); return r.body as DeliveryResponse;
    }, r => r.runs.some(run => run.name === "Novus delivery proof"), "the Actions run");
    const runId = list.runs.find(r => r.name === "Novus delivery proof")!.id;
    const detail = await until(async () => {
      const r = await request(`${path}/workflow?runId=${runId}`); expect(r.status).toBe(200); return r.body as WorkflowDetail;
    }, r => r.pending.length === 2, "both protected environments");
    for (const environment of detail.pending) {
      const decision = environment.name === "novus-delivery-proof" ? "approved" : "rejected";
      const input = { requestId: randomUUID(), runId, attempt: detail.run.attempt, expectedSha: detail.run.sha, environmentId: environment.environmentId, decision, comment: `Generated live integration proof: ${decision}.` };
      expect((await request(`${path}/review-deployment`, input)).status).toBe(200);
      expect((await request(`${path}/review-deployment`, input)).status).toBe(200);
    }
    const completed = await until(async () => (await request(`${path}/workflow?runId=${runId}`)).body as WorkflowDetail, r => r.run.status === "completed", "workflow completion");
    expect(completed.jobs.some(j => j.conclusion === "success")).toBe(true);
    expect(completed.jobs.some(j => j.conclusion === "failure" || j.conclusion === "cancelled" || j.conclusion === "skipped")).toBe(true);
    expect((await request(`${path}/submit-review`, { requestId: randomUUID(), expectedSha: headSha, decision: "COMMENT", comment: "Live Novus review: deployment decisions were separate from this PR review." })).status).toBe(200);
    expect((await request(`${path}/merge`, { method: "squash", expectedSha: "f".repeat(40), acknowledgeBlockers: true })).status).toBe(409);
    const result = await request(`${path}/merge`, { method: "squash", expectedSha: headSha, acknowledgeBlockers: true });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    merged = true;
    const audit = await harness.db.query("select payload->>'status' as status from events where mission_id = $1 and kind = 'delivery.review_result'", [missionId]);
    expect(audit.rows.map(r => r.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    console.warn(`Live delivery proof passed: ${opened.url}; Actions run ${runId}; approved and rejected environments; formal review; stale-head refusal; exact-head merge.`);
  } finally {
    if (number && !merged) { try { gh(["pr", "close", String(number), "--repo", target]); } catch { /* Keep the original failure. */ } }
    if (branch) { try { gh(["api", "-X", "DELETE", `repos/${target}/git/refs/heads/${branch}`]); } catch { /* Remote cleanup can be retried independently. */ } }
    rmSync(dir, { recursive: true, force: true });
    await harness.close();
  }
}, 480_000);
