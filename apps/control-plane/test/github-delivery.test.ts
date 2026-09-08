import { describe, it, expect } from "vitest";
import { GithubDelivery } from "../src/github-delivery.ts";
import { randomUUID } from "node:crypto";

const sha = "a".repeat(40);
const rawRun = { id: 7, name: "Deploy", head_sha: sha, run_attempt: 2, status: "waiting", conclusion: null, event: "push", html_url: "https://github.com/o/r/actions/runs/7", updated_at: "2026-09-08T00:00:00Z" };
function fixture() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let canApprove = true;
  let runSha = sha;
  let refused = false;
  const provider = new GithubDelivery(async (path, init) => {
    if (refused) return new Response("{}", { status: 403 });
    if (init?.method === "POST") { posts.push({ path, body: JSON.parse(String(init.body)) }); return Response.json([]); }
    if (path === "/repos/o/r/pulls/1") return Response.json({ head: { sha }, merge_commit_sha: null, state: "open", draft: false });
    if (path.includes("/actions/runs?")) return Response.json({ total_count: 51, workflow_runs: [rawRun] });
    if (path.endsWith("/actions/runs/7")) return Response.json({ ...rawRun, head_sha: runSha });
    if (path.includes("/attempts/2/jobs")) return Response.json({ total_count: 101, jobs: [{ id: 8, name: "Deploy", status: "queued", conclusion: null, html_url: "https://github.com/o/r/actions/runs/7/job/8", steps: [] }] });
    if (path.endsWith("/pending_deployments")) return Response.json([{ environment: { id: 42, name: "production" }, current_user_can_approve: canApprove, wait_timer: 0, wait_timer_started_at: null, reviewers: [{ reviewer: { login: "reviewer" } }] }]);
    if (path.includes("/deployments?")) return Response.json([{ id: 10, sha, environment: "production" }]);
    if (path.includes("/deployments/10/statuses")) return Response.json([{ state: "failure", environment_url: "https://example.com", updated_at: rawRun.updated_at }]);
    throw new Error(path);
  }, "/repos/o/r");
  return { provider, posts, deny: () => { canApprove = false; }, move: () => { runSha = "b".repeat(40); }, refuse: () => { refused = true; } };
}
const input = () => ({ pullRequestId: "pr_test", runId: 7, attempt: 2, expectedSha: sha, requestId: randomUUID(), environmentId: 42, decision: "approved" as const, comment: "Checked this release." });
describe("GitHub delivery adapter", () => {
  it("projects bounded runs, jobs and actual deployment outcomes without provider payloads", async () => {
    const f = fixture();
    const list = await f.provider.list(1);
    expect(list.truncated).toBe(true);
    expect(list.deployments[0]?.state).toBe("failure");
    expect((await f.provider.detail(1, 7)).jobsTruncated).toBe(true);
  });
  it("posts only the selected environment and exact formal review commit", async () => {
    const f = fixture();
    await f.provider.reviewDeployment(1, input());
    expect(f.posts[0]?.body).toEqual({ environment_ids: [42], state: "approved", comment: "Checked this release." });
    await f.provider.reviewPull(1, { ...input(), decision: "REQUEST_CHANGES" });
    expect(f.posts[1]?.body).toEqual({ commit_id: sha, event: "REQUEST_CHANGES", body: "Checked this release." });
  });
  it("refuses stale attempts, unrelated revisions, and ineligible people without posting", async () => {
    const f = fixture();
    await expect(f.provider.reviewDeployment(1, { ...input(), attempt: 1 })).rejects.toThrow("changed");
    f.deny(); await expect(f.provider.reviewDeployment(1, input())).rejects.toThrow("permit");
    f.move(); await expect(f.provider.detail(1, 7)).rejects.toThrow("no longer belongs");
    expect(f.posts).toEqual([]);
  });
  it("does not translate missing access into empty successful data", async () => {
    const f = fixture(); f.refuse();
    await expect(f.provider.list(1)).rejects.toThrow("403");
  });
});
