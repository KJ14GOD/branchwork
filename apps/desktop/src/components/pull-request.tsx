import { useState } from "react";
import type { Decision, MissionDetailResponse, PullRequest } from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, plural, shortSha } from "../format";
import { GatedAction } from "./gated";

/**
 * Publishing a decision, and the page of the pull request it became (D-099).
 *
 * Two shapes on one surface, in order. Before a request exists: the branch's
 * standing on the host (never pushed / pushing / pushed at {sha} / failed,
 * with the reason) with **Push branch**, then **Create draft PR**, enabled
 * only once the remote serves exactly the decided revision — the server
 * enforces the same rule, this only says it early. After: the tracked
 * request — approach, branches, changed files, checks, rationale, risks,
 * review status with its ingested threads, the snapshot that was sent,
 * conflicts in words, and what happened to it on the host.
 *
 * There is no merge control anywhere on this surface, and the surface says
 * why in words: merging happens on GitHub, by humans. Novus tracks it.
 */

const DENIAL = "Publishing this decision needs the pr.manage capability.";

export function PullRequestPanel({
  detail,
  decision
}: {
  detail: MissionDetailResponse;
  decision: Decision;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missionId = detail.mission.missionId;
  // Publishing is the decision's act: every verb targets the decided lane,
  // whichever lane the reader has on screen (D-099). The detail's pullRequest
  // and branchPush are already computed for the same lane by the server.
  const workstreamId = decision.workstreamId;
  const lane =
    detail.workstreams.find((entry) => entry.workstreamId === decision.workstreamId) ??
    detail.workstream;
  const push = detail.branchPush;
  const pull = detail.pullRequest;

  const act = async (call: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setNote(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) setNote(result.message ?? "That did not work.");
  };

  const pushed = lane?.remoteHeadSha ?? null;
  const decidedServed = pushed !== null && pushed === decision.checkpointSha;

  if (!pull) {
    return (
      <section className="pull-publish" data-testid="pull-publish">
        <h3 className="field-label">Publish</h3>
        {/* The branch's standing on the host, in words (D-099). */}
        <p className="receipt-line" data-testid="push-state">
          {push?.state === "pending"
            ? "Pushing the branch to GitHub…"
            : push?.state === "failed"
              ? `The push failed: ${push.failureReason ?? "no reason was reported"}`
              : decidedServed
                ? `Branch pushed — GitHub serves the decided revision ${shortSha(decision.checkpointSha ?? "")}`
                : pushed !== null
                  ? `GitHub serves ${shortSha(pushed)}, not the decided revision — push again`
                  : "The branch has never been pushed to GitHub."}
        </p>
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void act(() => novus().pulls.push({ missionId, workstreamId }))}
            variant="secondary"
            testid="push-branch"
          >
            Push branch
          </GatedAction>
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void act(() => novus().pulls.create({ missionId, workstreamId }))}
            variant="secondary"
            disabled={busy || !decidedServed}
            disabledReason="The draft opens once GitHub serves the decided revision — push the branch first."
            testid="create-pull-request"
          >
            Create draft PR
          </GatedAction>
        </div>
        <p className="quiet">
          Novus opens only a draft, and never merges — merging happens on GitHub, by humans.
        </p>
        {note && (
          <p className="inline-error" role="alert" data-testid="pull-note">
            {note}
          </p>
        )}
      </section>
    );
  }

  const chosen = detail.approaches.find((approach) => approach.workstreamId === pull.workstreamId);
  const openThreads = pull.reviewThreads.filter((thread) => thread.state === "open");

  return (
    <section className="pull-page" data-testid="pull-page">
      <h3 className="field-label">Pull request</h3>
      <p className="receipt-line" data-testid="pull-headline">
        <strong>PR #{pull.number}</strong>{" "}
        {pull.state === "draft"
          ? "is a draft on GitHub"
          : pull.state === "ready"
            ? "awaits review on GitHub"
            : pull.state === "merged"
              ? `was merged${pull.mergedBy ? ` by ${pull.mergedBy}` : ""} on GitHub${
                  pull.mergedAt ? ` at ${clockTime(pull.mergedAt)}` : ""
                }`
              : "was closed on GitHub without merging"}
        {" · "}
        <a href={pull.url} target="_blank" rel="noreferrer" data-testid="pull-url">
          Open on GitHub
        </a>
      </p>

      {/* The approach it publishes, and the branches it moves between. */}
      <p className="receipt-line" data-testid="pull-approach">
        Publishes <strong>{chosen?.name ?? "the chosen approach"}</strong>
        {chosen?.intent ? ` — ${chosen.intent}` : ""}
      </p>
      <p className="receipt-line mono" data-testid="pull-branches">
        {pull.headRef} → {pull.baseRef}
        {pull.headSha ? ` · ${shortSha(pull.headSha)}` : ""}
      </p>

      {/* Changed files and checks: the same arithmetic the room uses. */}
      {chosen && (
        <p className="receipt-line" data-testid="pull-evidence">
          {plural(chosen.filesChanged, "file")} changed (+{chosen.additions} −{chosen.deletions}) ·{" "}
          {chosen.checksRun === 0
            ? "no verification ran against this revision"
            : `${plural(chosen.checksPassed, "check")} passed, ${chosen.checksFailed} failed, ${chosen.unresolvedChecks} unresolved`}
        </p>
      )}

      {/* Merge conflicts, said as the host's own fact. */}
      <p
        className={pull.mergeable === "conflict" ? "receipt-line tone-warn" : "receipt-line"}
        data-testid="pull-mergeable"
      >
        {pull.mergeable === "conflict"
          ? `Conflicts with ${pull.baseRef} — resolve on GitHub before anyone can merge it.`
          : pull.mergeable === "clean"
            ? `Merges cleanly into ${pull.baseRef}.`
            : "GitHub has not said yet whether this merges cleanly."}
      </p>

      {/* Review status: who was asked, and what came back — ingested
          read-only; resolution happens on GitHub and is reflected here. */}
      <h3 className="field-label">Review</h3>
      <p className="receipt-line" data-testid="pull-reviewers">
        {pull.requestedReviewers.length === 0
          ? "Nobody has been asked for review yet."
          : `Review requested from ${pull.requestedReviewers.join(", ")}.`}
        {openThreads.length > 0 ? ` ${plural(openThreads.length, "comment")} open.` : ""}
      </p>
      {pull.reviewThreads.length > 0 && (
        <ul className="tool-list" data-testid="pull-threads">
          {pull.reviewThreads.map((thread, index) => (
            <li key={index}>
              <span className="tool-name">
                {thread.author}
                {thread.path ? (
                  <>
                    {" "}
                    · <span className="mono">{thread.path}</span>
                  </>
                ) : null}
                {" · "}
                {thread.state === "open" ? "open" : "resolved"}
              </span>
              <span className="tool-detail">{thread.body}</span>
            </li>
          ))}
        </ul>
      )}
      {(pull.state === "draft" || pull.state === "ready") && (
        <ReviewControls detail={detail} pull={pull} busy={busy} onAct={act} />
      )}

      {/* Visual evidence: the honest sentence until the artifact store exists.
          Stating the absence is the evidence rule, not an apology (D-022,
          PROGRESS's named gap). */}
      <h3 className="field-label">Screenshots and videos</h3>
      <p className="quiet" data-testid="pull-visuals">
        No visual evidence is attached — capturing and storing it is not built yet. The checks and
        the diff above are the evidence this request carries.
      </p>

      {/* The receipt that travelled: exactly what was sent, kept verbatim. */}
      <h3 className="field-label">What was sent</h3>
      <pre className="prepared-body" data-testid="pull-body">
        {pull.body}
      </pre>

      <p className="quiet" data-testid="pull-no-merge">
        Novus never merges. Merging happens on GitHub, by humans, and the mission records who.
      </p>
      {note && (
        <p className="inline-error" role="alert" data-testid="pull-note">
          {note}
        </p>
      )}
    </section>
  );
}

/** Request review and mark ready — the two stewarding verbs, gated like the
 *  publish ones. Reviewers are typed as GitHub logins, comma-separated. */
function ReviewControls({
  detail,
  pull,
  busy,
  onAct
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  busy: boolean;
  onAct: (call: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
}) {
  const [reviewers, setReviewers] = useState("");
  const names = reviewers
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return (
    <div className="pull-review-controls">
      <div className="inline-actions">
        <input
          className="input"
          value={reviewers}
          onChange={(event) => setReviewers(event.target.value)}
          placeholder="GitHub logins, comma-separated"
          aria-label="Reviewers to request"
          data-testid="reviewer-input"
        />
        <GatedAction
          capability="pr.manage"
          capabilities={detail.capabilities}
          denialReason={DENIAL}
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void onAct(async () => {
              const result = await novus().pulls.requestReview({
                pullRequestId: pull.pullRequestId,
                reviewers: names
              });
              if (result.ok) setReviewers("");
              return result;
            })
          }
          variant="secondary"
          disabled={busy || names.length === 0}
          disabledReason="Name at least one reviewer."
          testid="request-review"
        >
          Request review
        </GatedAction>
        {pull.state === "draft" && (
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void onAct(() => novus().pulls.markReady(pull.pullRequestId))}
            variant="secondary"
            disabled={busy}
            testid="mark-ready"
          >
            Mark ready for review
          </GatedAction>
        )}
      </div>
    </div>
  );
}
