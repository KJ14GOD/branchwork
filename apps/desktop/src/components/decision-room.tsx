import { useEffect, useRef, useState } from "react";
import type {
  ApproachSummary,
  Artifact,
  ContestedPath,
  Decision,
  MissionDetailResponse,
  PreparedPullRequest
} from "@novus/contracts";
import { clockTime, compactCount, elapsed, plural, shortSha, usd } from "../format";
import { ArtifactThumbRow } from "./artifact-row";
import { Dialog } from "./dialog";
import { Markdown } from "./markdown";
import { decisionPullRequest, standingDecision } from "./derive";
import { PullRequestPanel } from "./pull-request";

/**
 * The Decision Room (D-074, D-075): where competing approaches are compared and
 * a person — never the product — chooses one.
 *
 * The rules this file exists to keep, all of them checkable by reading it:
 *
 *  - **Nothing ranks.** Columns render in the order the server sent, which is
 *    creation order. There is no sort, no total, no "recommended", no highlight
 *    on the better one. Every column has the same width and the same rows.
 *  - **Absence is a finding.** A row with no evidence says *not verified* or
 *    *none recorded* in words. A blank would let a reader assume the opposite.
 *  - **Nothing here is an agent's summary.** Every number comes from the
 *    server's projection over checkpoints, checks, directions and approvals —
 *    never from anything the harness said about itself (PRODUCT.md P3).
 *  - **Choosing is not applying.** Recording a decision writes a record. What
 *    it produces afterwards is a *prepared* pull request nobody has opened.
 */

export interface DecisionRoomProps {
  detail: MissionDetailResponse;
  /** Set while a call is in flight, so a decision cannot be double-clicked. */
  busy: boolean;
  error: string | null;
  onRecord: (input: {
    workstreamId: string;
    rationale: string;
    acceptedRisks: string;
    artifactIds: string[];
  }) => void;
  onRequestRevision: (input: { workstreamId: string; reason: string }) => void;
  onInspectPath: (path: string) => void;
  /** Opens the pull request's own tab (D-100); threaded to the receipt. */
  onOpenPull: (pullRequestId: string) => void;
  onClose: () => void;
}

export function DecisionRoom({
  detail,
  busy,
  error,
  onRecord,
  onRequestRevision,
  onInspectPath,
  onOpenPull,
  onClose
}: DecisionRoomProps) {
  // The decision the room is about (D-207): a fulfilled, outrun decision
  // is history, and the columns offer choosing again.
  const decision = standingDecision(detail);
  const decisionPull = decision ? decisionPullRequest(detail, decision) : null;
  /** The receipt appears above where the person just was, so the surface
   *  carries them to it (D-141): when a decision lands while this room is
   *  open, scroll to its own top — once per decision, never on mount with
   *  an old receipt. */
  const sectionRef = useRef<HTMLElement>(null);
  const seenDecision = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const current = decision?.decisionId ?? null;
    if (seenDecision.current === undefined) {
      seenDecision.current = current;
      return;
    }
    if (current !== null && seenDecision.current === null) {
      sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    seenDecision.current = current;
  }, [decision?.decisionId]);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const mayDecide = detail.capabilities.includes("review.approve");

  // The one checkpoint every fork started from, when they genuinely share one;
  // with mixed origins each column's own Revision row carries the truth and
  // the header claims nothing (D-079).
  const origins = [
    ...new Set(detail.approaches.filter((entry) => entry.approach).map((entry) => entry.originSha))
  ];
  const sharedOrigin = origins.length === 1 && origins[0] !== null ? origins[0] : null;

  /** Every approach is a column (D-138, reversing the pair rule): the sheet
   *  scrolls sideways past what fits, and a picker over columns the sheet
   *  can reach was a gate, not a tool. Creation order, as everywhere. */
  const all = detail.approaches;
  const compared = all;

  return (
    <section className="decision-room" data-testid="decision-room" ref={sectionRef}>
      <header className="decision-head">
        <div className="decision-head-titles">
          {/* The goal is the title (D-136); the surface names itself in the
              meta line, lowercase and quiet (D-137 — the tracked-caps eyebrow
              read as 2010s chrome). */}
          <h2 className="decision-title">{decision ? "The decision" : detail.mission.goal}</h2>
          {sharedOrigin && (
            <p className="decision-shared" data-testid="decision-shared">
              Decision room · {plural(all.length, "approach", "approaches")} · Shared checkpoint ·{" "}
              <span className="mono">{shortSha(sharedOrigin)}</span>
            </p>
          )}
        </div>
        {/* Leaving is not deciding, and the label says so (DESIGN.md's four
            actions for this surface). */}
        <button className="btn btn-text" onClick={onClose} data-testid="decision-close">
          Keep exploring
        </button>
      </header>

      {decision ? (
        <DecisionReceipt
          onOpenPull={onOpenPull}
          detail={detail}
          decision={decision}
          approaches={detail.approaches}
          prepared={detail.preparedPullRequest}
          superseded={detail.decisions.filter((entry) => entry.supersededAt !== null)}
        />
      ) : null}

      {/* No fork diagram (D-137, removing D-136's the same day): the header
          already states the shared checkpoint in words, and a drawing that
          retells the sentence is ornament. */}
      <div
        className="approach-columns"
        data-testid="approach-columns"
        style={{ "--compare-count": compared.length } as React.CSSProperties}
      >
        {/* One shared row axis (D-136): the labels live in a gutter and every
            column's cells align to the same tracks, so a row reads across.
            The columns still carry their own labels for readers without the
            geometry. */}
        <div className="compare-gutter" aria-hidden="true">
          <span className="gutter-cell gutter-head" />
          {GUTTER_ROWS.map((label) => (
            <span className="gutter-cell" key={label}>
              {label}
            </span>
          ))}
          <span className="gutter-cell gutter-foot" />
        </div>
        {compared.map((approach) => (
          <ApproachColumn
            key={approach.workstreamId}
            approach={approach}
            chosen={decision?.workstreamId === approach.workstreamId}
            chosenLabel={
              decisionPull
                ? `Chosen — PR #${decisionPull.number} · ${decisionPull.state}`
                : "Chosen — not published yet"
            }
            sole={compared.length === 1}
            mayDecide={mayDecide}
            busy={busy}
            onChoose={() => setChoosing(approach.workstreamId)}
            onRequestRevision={() => setRevising(approach.workstreamId)}
          />
        ))}
      </div>

      {detail.contested.length > 0 && (
        <section className="contested" data-testid="contested">
          <h3 className="section-title">
            {plural(detail.contested.length, "file")} more than one approach changed
          </h3>
          {/* Named, not resolved: Novus shows both sides and merges nothing. */}
          <ul className="contested-list">
            {detail.contested.map((path) => (
              <ContestedRow key={path.path} contested={path} onInspect={() => onInspectPath(path.path)} />
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="inline-error" role="alert" data-testid="decision-error">
          {error}
        </p>
      )}

      {choosing && (
        <RecordDecisionDialog
          sole={all.length === 1}
          approach={detail.approaches.find((approach) => approach.workstreamId === choosing)}
          artifacts={detail.artifacts.filter(
            (artifact) =>
              (artifact.workstreamId === choosing || artifact.workstreamId === null) &&
              (artifact.state === "available" || artifact.state === "interrupted")
          )}
          busy={busy}
          onCancel={() => setChoosing(null)}
          onRecord={(input) => {
            onRecord({ workstreamId: choosing, ...input });
            setChoosing(null);
          }}
        />
      )}

      {revising && (
        <RequestRevisionDialog
          approach={detail.approaches.find((approach) => approach.workstreamId === revising)}
          busy={busy}
          onCancel={() => setRevising(null)}
          onRequest={(reason) => {
            onRequestRevision({ workstreamId: revising, reason });
            setRevising(null);
          }}
        />
      )}
    </section>
  );
}

/** The shared row axis, in fixed order — the gutter prints these, and every
 *  column renders exactly one cell per row (D-136). */
const GUTTER_ROWS = [
  "State",
  "Changes",
  "Verification",
  "Not verified",
  "People",
  "Cost",
  "Revision",
  "Files"
] as const;

/** One approach, in the same shape as every other approach. */
function ApproachColumn({
  approach,
  chosen,
  chosenLabel,
  sole,
  mayDecide,
  busy,
  onChoose,
  onRequestRevision
}: {
  approach: ApproachSummary;
  chosen: boolean;
  /** What the chosen column says in place of its actions: whether the
   *  decision is published yet, and as what (D-207). */
  chosenLabel: string;
  /** The only lane there is (D-140): "choose" would be absurd with nothing
   *  to choose against, so the action says what it does — accept. */
  sole: boolean;
  mayDecide: boolean;
  busy: boolean;
  onChoose: () => void;
  onRequestRevision: () => void;
}) {
  const verification =
    approach.checksRun === 0
      ? "Nothing ran"
      : `${approach.checksPassed} passed · ${approach.checksFailed} failed · ${approach.unresolvedChecks} unresolved`;
  /* Standing, not judgment: whether every check that ran against the current
     revision passed. Absence reads as its own state, never as green. */
  const standing =
    approach.checksRun > 0 && approach.checksFailed === 0 && approach.unresolvedChecks === 0;
  return (
    <article
      className="approach-column"
      data-testid="approach-column"
      data-workstream={approach.workstreamId}
    >
      <header className="approach-head">
        <div className="approach-head-line">
          <h3 className="approach-name">{approach.name}</h3>
          <span className={standing ? "verify-badge tone-ok" : "verify-badge tone-warn"}>
            {standing ? "Verified" : "Not verified"}
          </span>
        </div>
        <p className="approach-intent" data-testid="approach-intent">
          {/* The baseline has no intent to state, and says so rather than
              leaving a gap somebody reads as an omission. */}
          {approach.intent ?? "The work this mission started with."}
        </p>
      </header>

      <Cell label="State">
        {approach.state.replace(/_/g, " ")}
        <span className="cell-sub">{approach.controllerLogin ?? "nobody holds the baton"}</span>
      </Cell>
      <Cell label="Changes">
        {approach.filesChanged === 0 ? (
          "Nothing changed"
        ) : (
          <>
            {plural(approach.filesChanged, "file")}{" "}
            <span className="change-counts mono">
              <span className="count-add">+{approach.additions}</span>
              <span className="count-del">−{approach.deletions}</span>
            </span>
          </>
        )}
      </Cell>
      <Cell label="Verification">{verification}</Cell>
      <Cell label="Not verified">
        {approach.checksRun === 0
          ? "Not verified at all — no check has run against this"
          : approach.unresolvedChecks === 0
            ? "Nothing outstanding"
            : `${plural(approach.unresolvedChecks, "check")} unresolved or proving an earlier revision`}
      </Cell>
      <Cell label="People">
        {`${plural(approach.directions, "direction")} · ${plural(approach.approvalsAnswered, "approval")} answered · ${plural(approach.stops, "stop")}`}
      </Cell>
      <Cell label="Cost">
        {approach.usage.costUsd === null && approach.usage.outputTokens === null
          ? "Not reported"
          : [
              approach.usage.inputTokens !== null && approach.usage.outputTokens !== null
                ? `${compactCount(approach.usage.inputTokens)} in · ${compactCount(approach.usage.outputTokens)} out`
                : null,
              approach.usage.costUsd !== null ? usd(approach.usage.costUsd) : null,
              approach.usage.durationMs !== null ? elapsed(approach.usage.durationMs) : null
            ]
              .filter(Boolean)
              .join(" · ")}
      </Cell>
      <Cell label="Revision">
        {approach.checkpointSha ? (
          <span className="mono">{shortSha(approach.checkpointSha)}</span>
        ) : (
          "No checkpoint yet"
        )}
      </Cell>
      <Cell label="Files">
        {approach.paths.length === 0 ? (
          "None yet"
        ) : (
          <details className="disclosure">
            {/* The row's own label already says "Files"; the summary carries
                only what opening it adds — the count. Repeating the word made
                the cell read "Files Files 1 path". */}
            <summary>{plural(approach.paths.length, "path")}</summary>
            <ul className="tool-list">
              {approach.paths.map((path) => (
                <li key={path}>
                  <span className="mono tool-name">{path}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Cell>

      <footer className="approach-actions">
        {chosen ? (
          <span className="approach-chosen" data-testid="approach-chosen">
            {chosenLabel}
          </span>
        ) : (
          <>
            <button
              className="btn btn-secondary"
              disabled={!mayDecide || busy}
              onClick={onChoose}
              data-testid="choose-approach"
              title={mayDecide ? undefined : "Only participants who can resolve this mission may choose."}
            >
              {sole ? "Accept this work" : "Choose this approach"}
            </button>
            <button
              className="btn btn-text"
              disabled={!mayDecide || busy}
              onClick={onRequestRevision}
              data-testid="request-revision"
            >
              Request revision
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

/** One cell on the shared axis. The label renders inside the cell too — shown
 *  only when the gutter is gone (narrow widths) and for readers without the
 *  geometry. */
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="approach-cell">
      <span className="cell-label">{label}</span>
      <span className="cell-value">{children}</span>
    </div>
  );
}

function ContestedRow({ contested, onInspect }: { contested: ContestedPath; onInspect: () => void }) {
  return (
    <li className="contested-row">
      <span className="mono">{contested.path}</span>
      <span className="quiet">{plural(contested.workstreamIds.length, "approach", "approaches")}</span>
      <button className="btn btn-text" onClick={onInspect} data-testid="inspect-contested">
        Inspect contested changes
      </button>
    </li>
  );
}

/**
 * Recording a decision. The rationale is required here *and* at the server;
 * this dialog only refuses earlier, and shows what is about to be recorded as
 * unresolved while the person can still change their mind (D-075).
 */
function RecordDecisionDialog({
  sole,
  approach,
  artifacts,
  busy,
  onCancel,
  onRecord
}: {
  sole: boolean;
  approach: ApproachSummary | undefined;
  /** The lane's completed visual evidence (D-122), offered for the decider to
   *  cite. The chosen ids freeze with the rationale. */
  artifacts: Artifact[];
  busy: boolean;
  onCancel: () => void;
  onRecord: (input: { rationale: string; acceptedRisks: string; artifactIds: string[] }) => void;
}) {
  const [rationale, setRationale] = useState("");
  const [risks, setRisks] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const ready = rationale.trim().length > 0;
  const toggleCited = (artifactId: string) =>
    setCited((previous) =>
      previous.includes(artifactId)
        ? previous.filter((id) => id !== artifactId)
        : [...previous, artifactId]
    );
  return (
    <Dialog label="Record this decision" onClose={onCancel} testId="record-decision">
        <header className="dialog-head">
          <h2>{sole ? "Accept this work" : `Choose ${approach?.name ?? "this approach"}`}</h2>
          <p className="dialog-sub">
            {sole
              ? "This records your acceptance and why. Publishing — push and pull request — is the next step, on the receipt this opens."
              : "This records what you decided and why. It does not publish anything."}
          </p>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span className="field-label">Why this one?</span>
            <textarea
              className="input"
              rows={4}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="In your own words — this is what a reviewer reads in six months."
              data-testid="decision-rationale"
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Risk you are accepting (optional)</span>
            <textarea
              className="input"
              rows={3}
              value={risks}
              onChange={(event) => setRisks(event.target.value)}
              placeholder="What could still be wrong, that you are choosing to live with."
              data-testid="decision-risks"
            />
          </label>
          {/* What is being accepted, at the moment of accepting it: the lane's
              own evidence and the exact revision the decision will pin. The
              record captures the checkpoint; this puts it in front of the
              person while they can still change their mind (D-075). */}
          <section className="decision-evidence" data-testid="decision-evidence">
            <h3 className="field-label">The evidence this decides on</h3>
            <p className="quiet">
              {approach
                ? [
                    approach.filesChanged === 0
                      ? "nothing changed"
                      : `${plural(approach.filesChanged, "file")} changed (+${approach.additions} −${approach.deletions})`,
                    approach.checksRun === 0
                      ? "no checks ran"
                      : `${approach.checksPassed} of ${plural(approach.checksRun, "check")} passed`,
                    approach.checkpointSha ? `revision ${shortSha(approach.checkpointSha)}` : "no checkpoint"
                  ].join(" · ")
                : "This approach is still loading."}
            </p>
          </section>
          <section className="decision-unresolved" data-testid="decision-unresolved">
            <h3 className="field-label">Recorded as unresolved</h3>
            <p className="quiet">
              {!approach || approach.checksRun === 0
                ? "No verification has run against this approach at all."
                : approach.unresolvedChecks === 0
                  ? "Nothing — every check against this revision passed."
                  : `${plural(approach.unresolvedChecks, "check")} did not pass against this revision.`}
            </p>
          </section>
          {/* The visual evidence that mattered (D-122): the decider chooses,
              and the chosen ids freeze with the rationale into the decision
              and the terminal receipt. Rendered only when any exists —
              a picker over nothing is prohibited pattern 11. */}
          {artifacts.length > 0 && (
            <section className="decision-artifacts" data-testid="decision-artifacts">
              <h3 className="field-label">Visual evidence to cite (optional)</h3>
              {artifacts.map((artifact) => (
                <label className="decision-artifact-option" key={artifact.artifactId}>
                  <input
                    type="checkbox"
                    checked={cited.includes(artifact.artifactId)}
                    onChange={() => toggleCited(artifact.artifactId)}
                    data-testid="decision-artifact-option"
                    data-artifact={artifact.artifactId}
                  />
                  <ArtifactThumbRow artifact={artifact} testid="decision-artifact-row" />
                </label>
              ))}
            </section>
          )}
        </div>
        <footer className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!ready || busy}
            onClick={() =>
              onRecord({ rationale: rationale.trim(), acceptedRisks: risks.trim(), artifactIds: cited })
            }
            data-testid="record-decision-confirm"
          >
            Record decision
          </button>
        </footer>
    </Dialog>
  );
}

function RequestRevisionDialog({
  approach,
  busy,
  onCancel,
  onRequest
}: {
  approach: ApproachSummary | undefined;
  busy: boolean;
  onCancel: () => void;
  onRequest: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog label="Request a revision" onClose={onCancel} testId="request-revision-dialog">
        <header className="dialog-head">
          <h2>Ask {approach?.name ?? "this approach"} for a revision</h2>
          <p className="dialog-sub">The reason becomes the context for the next direction.</p>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span className="field-label">What needs to change?</span>
            <textarea
              className="input"
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-testid="revision-reason"
              autoFocus
            />
          </label>
        </div>
        <footer className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={reason.trim().length === 0 || busy}
            onClick={() => onRequest(reason.trim())}
            data-testid="request-revision-confirm"
          >
            Request revision
          </button>
        </footer>
    </Dialog>
  );
}

/**
 * The receipt of a decision: what was chosen, by whom, why, at which revision,
 * what was accepted, what was never verified — and the pull request that would
 * carry it, prepared and unsent.
 */
function DecisionReceipt({
  onOpenPull,
  detail,
  decision,
  approaches,
  prepared,
  superseded
}: {
  onOpenPull: (pullRequestId: string) => void;
  detail: MissionDetailResponse;
  decision: Decision;
  approaches: ApproachSummary[];
  prepared: PreparedPullRequest | null;
  superseded: Decision[];
}) {
  // This decision's own request, never the lane's latest (D-207).
  const decisionPull = decisionPullRequest(detail, decision);
  const chosen = approaches.find((approach) => approach.workstreamId === decision.workstreamId);
  const others = approaches.filter((approach) => approach.workstreamId !== decision.workstreamId);
  const [copied, setCopied] = useState(false);
  return (
    <section className="decision-receipt" data-testid="decision-receipt">
      <p className="receipt-line">
        <strong>{decision.decidedByLogin}</strong> chose <strong>{chosen?.name ?? "an approach"}</strong> at{" "}
        {clockTime(decision.decidedAt)}
        {decision.checkpointSha && (
          <>
            {" "}
            · <span className="mono">{shortSha(decision.checkpointSha)}</span>
          </>
        )}
      </p>

      {/* Rationale and risks are often agent-drafted markdown; they render
          through the same element-only renderer as speech (D-145). */}
      <h3 className="field-label">Why</h3>
      <div className="prose" data-testid="receipt-rationale">
        <Markdown source={decision.rationale} />
      </div>

      {decision.acceptedRisks && (
        <>
          <h3 className="field-label">Risk accepted</h3>
          <div className="prose" data-testid="receipt-risks">
            <Markdown source={decision.acceptedRisks} />
          </div>
        </>
      )}

      {/* The visual evidence the decider chose (D-122): the exact ids, frozen
          with the rationale — shown beside it, never recomputed. */}
      {decision.artifactIds.length > 0 && (
        <>
          <h3 className="field-label">Visual evidence cited</h3>
          <div className="evidence-list" data-testid="receipt-artifacts">
            {decision.artifactIds.map((artifactId) => {
              const artifact = detail.artifacts.find(
                (candidate) => candidate.artifactId === artifactId
              );
              return artifact ? (
                <ArtifactThumbRow key={artifactId} artifact={artifact} testid="receipt-artifact-row" />
              ) : (
                <p className="quiet mono" key={artifactId}>
                  {artifactId}
                </p>
              );
            })}
          </div>
        </>
      )}

      <h3 className="field-label">Not verified when this was decided</h3>
      {decision.unresolvedSummary.length === 0 ? (
        <p className="quiet" data-testid="receipt-unresolved">
          Nothing was outstanding.
        </p>
      ) : (
        <ul className="tool-list" data-testid="receipt-unresolved">
          {decision.unresolvedSummary.map((entry, index) => (
            <li key={index}>
              <span className="mono tool-name">{entry}</span>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <>
          <h3 className="field-label">Not chosen, and kept</h3>
          <ul className="tool-list" data-testid="receipt-not-chosen">
            {others.map((approach) => (
              <li key={approach.workstreamId}>
                <span className="tool-name">{approach.name}</span>
                <span className="tool-detail">{approach.intent ?? "the work this mission started with"}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {superseded.length > 0 && (
        <p className="quiet" data-testid="receipt-superseded">
          {plural(superseded.length, "earlier decision")} was superseded and kept in the record.
        </p>
      )}

      {/* The tracked request, or the way to open one (D-099). The prepared
          projection below stays for the un-opened case; once a request
          exists, its own page carries the snapshot that was actually sent. */}
      {decisionPull === null && prepared && (
        <section className="prepared-pr" data-testid="prepared-pr">
          <h3 className="field-label">Pull request, prepared</h3>
          <p className="quiet">
            Nothing has been sent yet.
            {prepared.publishable
              ? " Novus opens only a draft, and never merges."
              : " Novus does not open or merge pull requests, and this repository is a folder on a machine rather than a host that could receive one."}
          </p>
          <p className="receipt-line mono">
            {prepared.headRef} → {prepared.baseRef}
          </p>
          <p className="receipt-line">{prepared.title}</p>
          <pre className="prepared-body" data-testid="prepared-body">
            {prepared.body}
          </pre>
          <button
            className="btn btn-secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(`${prepared.title}\n\n${prepared.body}`);
              setCopied(true);
            }}
            data-testid="copy-prepared"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </section>
      )}
      {(decisionPull !== null || prepared?.publishable) && (
        <PullRequestPanel detail={detail} decision={decision} onOpenPull={onOpenPull} />
      )}
    </section>
  );
}
