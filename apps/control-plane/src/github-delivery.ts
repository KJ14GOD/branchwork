import { z } from "zod";
import { DeliveryResponseSchema, WorkflowDetailSchema, type DeliveryResponse, type WorkflowDetail, type DeploymentReviewInput, type PullReviewInput } from "@novus/contracts";
import { MergeRefusedError, ProviderTransientError } from "./repo-provider.ts";

const Id = z.number().int().positive().safe();
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Run = z.object({ id: Id, name: z.string().nullable(), head_sha: Sha, run_attempt: Id,
  status: z.string(), conclusion: z.string().nullable(), event: z.string(), html_url: z.string().url(), updated_at: z.string() });
const Job = z.object({ id: Id, name: z.string(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string().url(),
  steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })).default([]) });
const Pending = z.object({ environment: z.object({ id: Id, name: z.string() }), current_user_can_approve: z.boolean(),
  wait_timer: z.number(), wait_timer_started_at: z.string().nullable(),
  reviewers: z.array(z.object({ reviewer: z.object({ login: z.string().optional(), name: z.string().optional(), slug: z.string().optional() }) })).default([]) });
const mapRun = (r: z.infer<typeof Run>) => ({ id: r.id, name: (r.name ?? "Workflow").slice(0, 300), sha: r.head_sha,
  attempt: r.run_attempt, status: r.status, conclusion: r.conclusion, event: r.event, url: r.html_url, updatedAt: r.updated_at });

/** GitHub Actions and formal reviews. All paths are constructed from IDs;
 * response links are never fetched, and raw logs never enter Novus storage. */
export class GithubDelivery {
  private request: (path: string, init?: RequestInit) => Promise<Response>;
  private root: string;
  constructor(request: (path: string, init?: RequestInit) => Promise<Response>, root: string) { this.request = request; this.root = root; }
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(this.root + path, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if ([403, 404, 409, 422].includes(response.status)) {
      throw new MergeRefusedError(`GitHub refused this request (${response.status}). Check repository access, reviewer eligibility, protection rules, and the current revision on GitHub.`);
    }
    if (!response.ok) throw new ProviderTransientError(`GitHub delivery request failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  async revisions(number: number) {
    const raw = z.object({ head: z.object({ sha: Sha }), merge_commit_sha: Sha.nullable(), state: z.string(), draft: z.boolean().optional() })
      .parse(await this.json(`/pulls/${number}`));
    return { headSha: raw.head.sha, mergeSha: raw.merge_commit_sha, state: raw.state, draft: raw.draft ?? false };
  }
  async list(number: number): Promise<DeliveryResponse> {
    const refs = await this.revisions(number);
    const pages = await Promise.all([...new Set([refs.headSha, refs.mergeSha].filter((s): s is string => s !== null))].map(async (sha) =>
      z.object({ total_count: z.number(), workflow_runs: z.array(Run) }).parse(await this.json(`/actions/runs?head_sha=${sha}&per_page=50`))));
    const runs = [...new Map(pages.flatMap(p => p.workflow_runs).map(r => [r.id, mapRun(r)])).values()];
    const deploymentPages = await Promise.all([...new Set([refs.headSha, refs.mergeSha].filter((s): s is string => s !== null))].map(async sha =>
      z.array(z.object({ id: Id, sha: Sha, environment: z.string() })).parse(await this.json(`/deployments?sha=${sha}&per_page=9`))));
    const deployments = await Promise.all([...new Map(deploymentPages.flatMap(page => page.slice(0, 8)).map(d => [d.id, d])).values()].map(async d => {
      const statuses = z.array(z.object({ state: z.string(), environment_url: z.string().nullable().optional(), updated_at: z.string() }))
        .parse(await this.json(`/deployments/${d.id}/statuses?per_page=1`));
      const status = statuses[0];
      const url = status?.environment_url;
      return { id: d.id, sha: d.sha, environment: d.environment.slice(0, 300), state: status?.state ?? "unknown", updatedAt: status?.updated_at ?? null,
        url: url && URL.canParse(url) && new URL(url).protocol === "https:" ? url : null };
    }));
    return DeliveryResponseSchema.parse({ ...refs, deployments, deploymentsTruncated: deploymentPages.some(p => p.length > 8), runs: runs.sort((a, b) => b.id - a.id),
      truncated: pages.some(p => p.total_count > p.workflow_runs.length), observedAt: new Date().toISOString() });
  }
  async detail(number: number, runId: number): Promise<WorkflowDetail> {
    const refs = await this.revisions(number);
    const raw = Run.parse(await this.json(`/actions/runs/${runId}`));
    if (raw.head_sha !== refs.headSha && raw.head_sha !== refs.mergeSha) throw new MergeRefusedError("This workflow no longer belongs to this pull request's current revisions. Refresh before continuing.");
    const [jobs, pending] = await Promise.all([
      this.json(`/actions/runs/${runId}/attempts/${raw.run_attempt}/jobs?per_page=100`).then(v => z.object({ total_count: z.number(), jobs: z.array(Job) }).parse(v)),
      this.json(`/actions/runs/${runId}/pending_deployments`).then(v => z.array(Pending).parse(v))
    ]);
    return WorkflowDetailSchema.parse({ run: mapRun(raw), jobsTruncated: jobs.total_count > jobs.jobs.length,
      jobs: jobs.jobs.map(j => ({ id: j.id, name: j.name.slice(0, 300), status: j.status, conclusion: j.conclusion, url: j.html_url, stepsTruncated: j.steps.length > 100,
        steps: j.steps.slice(0, 100).map(s => ({ ...s, name: s.name.slice(0, 300) })) })),
      pending: pending.map(p => ({ environmentId: p.environment.id, name: p.environment.name.slice(0, 300), canApprove: p.current_user_can_approve,
        waitMinutes: p.wait_timer, waitStartedAt: p.wait_timer_started_at,
        reviewers: p.reviewers.map(r => (r.reviewer.login ?? r.reviewer.slug ?? r.reviewer.name ?? "Reviewer").slice(0, 300)) })) });
  }
  async reviewDeployment(number: number, input: DeploymentReviewInput): Promise<void> {
    const current = await this.detail(number, input.runId);
    const pending = current.pending.find(p => p.environmentId === input.environmentId);
    if (current.run.sha !== input.expectedSha || current.run.attempt !== input.attempt || !pending?.canApprove) {
      throw new MergeRefusedError("The deployment changed or GitHub does not permit you to review it. Refresh before continuing.");
    }
    await this.json(`/actions/runs/${input.runId}/pending_deployments`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_ids: [input.environmentId], state: input.decision, comment: input.comment }) });
  }
  async reviewPull(number: number, input: PullReviewInput): Promise<void> {
    const current = await this.revisions(number);
    if (current.headSha !== input.expectedSha || current.state !== "open" || current.draft) throw new MergeRefusedError("This pull request changed, is a draft, or is closed. Refresh before reviewing.");
    await this.json(`/pulls/${number}/reviews`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit_id: input.expectedSha, event: input.decision, body: input.comment }) });
  }
}
