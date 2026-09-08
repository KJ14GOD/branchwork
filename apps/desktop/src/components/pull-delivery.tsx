import { useEffect, useState } from "react";
import type { DeliveryResponse, WorkflowDetail, PullReviewInput, PullRequest } from "@novus/contracts";
import { novus } from "../bridge";
import { Dialog } from "./dialog";
import { shortSha } from "../format";

export function PullDelivery({ pull, canManage }: { pull: PullRequest; canManage: boolean }) {
  const [data, setData] = useState<DeliveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    const read = async () => {
      try {
        const result = await novus().pulls.delivery(pull.pullRequestId);
        if (disposed) return;
        if (result.ok) { setData(result.value); setError(null); }
        else setError(result.message);
      } catch { if (!disposed) setError("GitHub Actions could not be read."); }
      if (!disposed) timer = setTimeout(() => void read(), 15_000);
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [pull.pullRequestId, refresh]);
  return <section className="pull-readiness" data-testid="pull-delivery">
    <div className="inline-actions"><h3 className="field-label">GitHub Actions</h3><button className="btn btn-text" onClick={() => setRefresh(n => n + 1)}>Refresh Actions</button></div>
    <p className="quiet">Runs for this pull request's current head and merge revision. GitHub controls execution and deployment protection.</p>
    {error && <p role="alert" className="quiet">{error} Previously loaded results may be out of date.</p>}
    {!data && !error && <p className="quiet">Reading GitHub Actions…</p>}
    {data && <>
      <p className="quiet">Head {shortSha(data.headSha)}{data.mergeSha && ` · merge revision ${shortSha(data.mergeSha)}`} · checked {new Date(data.observedAt).toLocaleTimeString()}</p>
      {data.deployments.length > 0 && <><h4 className="field-label">Deployment history</h4><ul className="tool-list delivery-list">{data.deployments.map(d => <li key={d.id}><span className="tool-name">{d.environment}</span><span className="tool-detail">{d.state} · {shortSha(d.sha)}</span>{d.url && <a href={d.url} target="_blank" rel="noreferrer">Open environment</a>}</li>)}</ul></>}
      {data.deploymentsTruncated && <p className="quiet">Showing the latest eight deployments per revision. GitHub holds the remaining history.</p>}
      {data.runs.length === 0 && <p className="quiet">No workflow runs were returned for these revisions. This does not mean checks passed.</p>}
      <ul className="tool-list delivery-list">{data.runs.map(run => <li key={run.id}>
        <button className="btn btn-text" aria-expanded={selected === run.id} onClick={() => setSelected(selected === run.id ? null : run.id)}>{run.name}</button>
        <span className="tool-detail">{run.conclusion ?? run.status} · {run.event} · attempt {run.attempt} · {shortSha(run.sha)}</span>
        <a href={run.url} target="_blank" rel="noreferrer">Open run on GitHub</a>
        {selected === run.id && <RunDetail key={`${pull.pullRequestId}:${run.id}`} pull={pull} runId={run.id} canManage={canManage && !pull.downstreamOf} />}
      </li>)}</ul>
      {data.truncated && <p className="quiet">Showing up to 50 runs per revision. Open GitHub for the remaining runs.</p>}
    </>}
  </section>;
}

function RunDetail({ pull, runId, canManage }: { pull: PullRequest; runId: number; canManage: boolean }) {
  const [data, setData] = useState<WorkflowDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<{ environmentId: number; name: string; decision: "approved" | "rejected"; sha: string; attempt: number; requestId: string } | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await novus().pulls.workflow({ pullRequestId: pull.pullRequestId, runId });
        if (disposed) return;
        if (result.ok) { setData(result.value); }
        else { setData(null); setNote(result.message); }
      } catch { if (!disposed) { setData(null); setNote("The workflow could not be read."); } }
      if (!disposed) timer = setTimeout(() => void read(), 15_000);
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [pull.pullRequestId, runId, refresh]);
  const submit = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const result = await novus().pulls.reviewDeployment({ pullRequestId: pull.pullRequestId, runId, environmentId: review.environmentId,
        attempt: review.attempt, expectedSha: review.sha, requestId: review.requestId, decision: review.decision, comment });
      setNote(result.ok ? "GitHub accepted the deployment review. The workflow status will show what happens next." : result.message);
      setReview(null); setRefresh(n => n + 1);
    } catch { setNote("The review outcome is unknown. Check GitHub before submitting another review."); setReview(null); }
    finally { setBusy(false); }
  };
  return <section className="pull-readiness" aria-label="Workflow details">
    {note && <p role="status" className="quiet">{note}</p>}
    {data && <>
      <h4 className="field-label">Deployments</h4>
      {data.pending.length === 0 && <p className="quiet">No deployment is awaiting a reviewer. Jobs below show deployment progress and results.</p>}
      {data.pending.map(p => <div key={p.environmentId} className="pull-readiness">
        <p>{p.name} · waiting for review</p>
        <p className="quiet">Reviewers: {p.reviewers.join(", ") || "Determined by GitHub"}{p.waitMinutes > 0 && ` · wait timer ${p.waitMinutes} minutes`}</p>
        {canManage && p.canApprove ? <div className="inline-actions">{(["approved", "rejected"] as const).map(decision => <button key={decision} className="btn btn-secondary" onClick={() => { setComment(""); setReview({ ...p, decision, sha: data.run.sha, attempt: data.run.attempt, requestId: crypto.randomUUID() }); }}>{decision === "approved" ? "Approve deployment" : "Reject deployment"}</button>)}</div> : <p className="quiet">Review requires a Novus PR manager and GitHub reviewer eligibility.</p>}
      </div>)}
      <h4 className="field-label">Jobs and steps</h4>
      <ul className="tool-list delivery-list">{data.jobs.map(job => <li key={job.id}><span className="tool-name">{job.name}</span><span className="tool-detail">{job.conclusion ?? job.status}</span><a href={job.url} target="_blank" rel="noreferrer">View logs on GitHub</a>
        {job.steps.map((step, i) => <p className="quiet" key={i}>{step.name} · {step.conclusion ?? step.status}</p>)}{job.stepsTruncated && <p className="quiet">Showing the first 100 steps. Open GitHub for all steps.</p>}</li>)}</ul>
      {data.jobsTruncated && <p className="quiet">Showing the first 100 jobs. Open the run on GitHub for all jobs.</p>}
    </>}
    {review && <Dialog label={`Review deployment to ${review.name}`} onClose={() => { if (!busy) setReview(null); }}>
      <header className="dialog-head"><h2>{review.decision === "approved" ? "Approve" : "Reject"} deployment to {review.name}</h2><p className="quiet">Run {runId}, attempt {review.attempt}, revision {shortSha(review.sha)}. This decision does not approve or merge a pull request.</p></header>
      <div className="dialog-body"><label className="field-label" htmlFor="deployment-comment">Reason</label><textarea className="input pull-comment-input" id="deployment-comment" value={comment} maxLength={2000} onChange={e => setComment(e.target.value)} /></div>
      <footer className="dialog-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setReview(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || !comment.trim()} onClick={() => void submit()}>Confirm deployment review</button></footer>
    </Dialog>}
  </section>;
}

export function FormalPullReview({ pull, canManage }: { pull: PullRequest; canManage: boolean }) {
  const [review, setReview] = useState<{ requestId: string; sha: string } | null>(null);
  const [decision, setDecision] = useState<PullReviewInput["decision"]>("COMMENT");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!canManage || pull.state !== "ready") return null;
  const open = () => {
    if (!pull.headSha) { setNote("The pull request's revision is not available yet. Refresh before reviewing."); return; }
    setComment("");
    setDecision("COMMENT");
    setReview({ requestId: crypto.randomUUID(), sha: pull.headSha });
  };
  const submit = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const result = await novus().pulls.submitReview({ pullRequestId: pull.pullRequestId, requestId: review.requestId, expectedSha: review.sha, decision, comment });
      setNote(result.ok ? "GitHub accepted your review. This does not merge the pull request or approve a deployment." : result.message);
      setReview(null);
    } catch { setNote("The review outcome is unknown. Check GitHub before submitting another review."); setReview(null); }
    finally { setBusy(false); }
  };
  return <section className="pull-readiness"><button className="btn btn-secondary" disabled={busy} onClick={() => void open()}>Submit GitHub review</button>{note && <p role="status" className="quiet">{note}</p>}
    {review && <Dialog label="Submit GitHub review" onClose={() => { if (!busy) setReview(null); }}>
      <header className="dialog-head"><h2>Review PR #{pull.number}</h2><p className="quiet">Reviewing {shortSha(review.sha)}. GitHub enforces reviewer eligibility and branch protection.</p></header>
      <div className="dialog-body"><label className="field-label" htmlFor="review-verdict">Decision</label><select className="input" id="review-verdict" value={decision} onChange={e => setDecision(e.target.value as PullReviewInput["decision"])}><option value="COMMENT">Comment</option><option value="APPROVE">Approve pull request</option><option value="REQUEST_CHANGES">Request changes</option></select><label className="field-label" htmlFor="review-comment">Review</label><textarea className="input pull-comment-input" id="review-comment" value={comment} maxLength={2000} onChange={e => setComment(e.target.value)} /></div>
      <footer className="dialog-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setReview(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || !comment.trim()} onClick={() => void submit()}>Send review to GitHub</button></footer>
    </Dialog>}
  </section>;
}
