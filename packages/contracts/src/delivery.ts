import { z } from "zod";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Id = z.number().int().positive().safe();
const Url = z.string().url().max(2000).refine(value => new URL(value).protocol === "https:");
export const WorkflowRunSchema = z.object({
  id: Id, name: z.string().max(300), sha: Sha, attempt: Id,
  status: z.string().max(80), conclusion: z.string().max(80).nullable(),
  event: z.string().max(80), url: Url, updatedAt: z.string().max(80)
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export const WorkflowJobSchema = z.object({
  id: Id, name: z.string().max(300), status: z.string().max(80),
  conclusion: z.string().max(80).nullable(), url: Url,
  stepsTruncated: z.boolean().default(false),
  steps: z.array(z.object({ name: z.string().max(300), status: z.string().max(80), conclusion: z.string().max(80).nullable() })).max(100)
});
export const PendingDeploymentSchema = z.object({
  environmentId: Id, name: z.string().max(300), canApprove: z.boolean(),
  waitMinutes: z.number().nonnegative(), waitStartedAt: z.string().nullable(),
  reviewers: z.array(z.string().max(300)).max(100)
});
export const WorkflowDetailSchema = z.object({
  run: WorkflowRunSchema, jobs: z.array(WorkflowJobSchema).max(100), jobsTruncated: z.boolean(),
  pending: z.array(PendingDeploymentSchema).max(100)
});
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;
export const DeliveryResponseSchema = z.object({
  headSha: Sha, mergeSha: Sha.nullable(), runs: z.array(WorkflowRunSchema).max(100),
  deployments: z.array(z.object({ id: Id, sha: Sha, environment: z.string().max(300), state: z.string().max(80), url: Url.nullable(), updatedAt: z.string().nullable() })).max(16),
  deploymentsTruncated: z.boolean(), truncated: z.boolean(), observedAt: z.string()
});
export type DeliveryResponse = z.infer<typeof DeliveryResponseSchema>;
const Base = z.object({ pullRequestId: z.string().startsWith("pr_"), requestId: z.string().uuid(), expectedSha: Sha });
export const DeploymentReviewInputSchema = Base.extend({
  runId: Id, attempt: Id, environmentId: Id, decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().min(1).max(2000)
});
export type DeploymentReviewInput = z.infer<typeof DeploymentReviewInputSchema>;
export const PullReviewInputSchema = Base.extend({
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), comment: z.string().trim().min(1).max(2000)
});
export type PullReviewInput = z.infer<typeof PullReviewInputSchema>;
