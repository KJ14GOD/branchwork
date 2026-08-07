import { useState } from "react";
import type {
  ApproachSummary,
  ContestedPath,
  Decision,
  MissionDetailResponse,
  PreparedPullRequest
} from "@novus/contracts";
import { clockTime, compactCount, elapsed, plural, shortSha, usd } from "../format";
import { Dialog } from "./dialog";

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
  onRecord: (input: { workstreamId: string; rationale: string; acceptedRisks: string }) => void;
  onRequestRevision: (input: { workstreamId: string; reason: string }) => void;
  onInspectPath: (path: string) => void;
  onClose: () => void;
}

export function DecisionRoom({
  detail,
  busy,
  error,
  onRecord,
  onRequestRevision,
  onInspectPath,
  onClose
}: DecisionRoomProps) {
  const decision = detail.decisions.find((entry) => entry.supersededAt === null) ?? null;
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

  /**
   * Three or more lanes compare as a chosen pair, not a wall of columns: a
   * selectable list decides which two render (DESIGN.md#component-behavior).
   * Two lanes need no selection and get no selector.
   */
  const [pair, setPair] = useState<string[]>([]);
  const all = detail.approaches;
  const chosen = pair.filter((id) => all.some((entry) => entry.workstreamId === id));
  const compared =
    all.length <= 2
      ? all
      : all.filter((entry) =>
          (chosen.length === 2 ? chosen : all.slice(0, 2).map((lane) => lane.workstreamId)).includes(
            entry.workstreamId
          )
        );
  const comparedIds = compared.map((entry) => entry.workstreamId);
  const togglePair = (workstreamId: string) => {
    if (comparedIds.includes(workstreamId)) return;
    // The newest pick evicts the *least recently* picked — selection order,
    // not column order — so one click swaps one column and any pair is
    // reachable in at most two clicks.
    const ordered = chosen.length === 2 ? chosen : comparedIds;
    setPair([ordered[1] ?? ordered[0] ?? workstreamId, workstreamId].filter(Boolean) as string[]);
  };

  return (
    <section className="decision-room" data-testid="decision-room">
      <header className="decision-head">
        <div className="decision-head-titles">
          <h2 className="section-title">{decision ? "The decision" : "Compare approaches"}</h2>
          {sharedOrigin && (
            <p className="decision-shared" data-testid="decision-shared">
              Shared checkpoint · <span className="mono">{shortSha(sharedOrigin)}</span>
            </p>
          )}
        </div>
        {/* Leaving is not deciding, and the label says so (DESIGN.md's four
            actions for this surface). */}
        <button className="btn btn-text" onClick={onClose} data-testid="decision-close">
          Keep exploring
        </button>
      </header>

      {all.length > 2 && (
        <div className="decision-pair" role="group" aria-label="Approaches to compare" data-testid="decision-pair">
          {all.map((entry, index) => (
            <button
              key={entry.workstreamId}
              className={
                comparedIds.includes(entry.workstreamId) ? "chip-button pair-chip active" : "chip-button pair-chip"
              }
              aria-pressed={comparedIds.includes(entry.workstreamId)}
              onClick={() => togglePair(entry.workstreamId)}
              data-testid="pair-chip"
            >
              <span
                className={index === 0 ? "lane-dot lane-dot-current" : "lane-dot lane-dot-alt"}
                aria-hidden="true"
              />
              {entry.name}
            </button>
          ))}
          <span className="quiet">Comparing two at a time — pick which two.</span>
        </div>
      )}

      {decision ? (
        <DecisionReceipt
          decision={decision}
          approaches={detail.approaches}
          prepared={detail.preparedPullRequest}
          superseded={detail.decisions.filter((entry) => entry.supersededAt !== null)}
        />
      ) : null}

      <div className="approach-columns" data-testid="approach-columns">
        {compared.map((approach) => (
          <ApproachColumn
            key={approach.workstreamId}
            approach={approach}
            chosen={decision?.workstreamId === approach.workstreamId}
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
          approach={detail.approaches.find((approach) => approach.workstreamId === choosing)}
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

/** One approach, in the same shape as every other approach. */
function ApproachColumn({
  approach,
  chosen,
  mayDecide,
  busy,
  onChoose,
  onRequestRevision
}: {
  approach: ApproachSummary;
  chosen: boolean;
  mayDecide: boolean;
  busy: boolean;
  onChoose: () => void;
  onRequestRevision: () => void;
}) {
  const verification =
    approach.checksRun === 0
      ? "Nothing ran"
      : `${approach.checksPassed} passed · ${approach.checksFailed} failed · ${approach.unresolvedChecks} unresolved`;
  return (
    <article
      className={approach.approach ? "approach-column is-approach" : "approach-column"}
      data-testid="approach-column"
      data-workstream={approach.workstreamId}
    >
      <header>
        <h3 className="approach-name">{approach.name}</h3>
        <p className="approach-intent" data-testid="approach-intent">
          {/* The baseline has no intent to state, and says so rather than
              leaving a gap somebody reads as an omission. */}
          {approach.intent ?? "The work this mission started with."}
        </p>
      </header>

      <dl className="approach-facts">
        <Fact label="State" value={approach.state.replace(/_/g, " ")} />
        <Fact label="Baton" value={approach.controllerLogin ?? "nobody holds it"} />
        <Fact
          label="Changes"
          value={
            approach.filesChanged === 0 ? (
              "Nothing changed"
            ) : (
              <>
                {plural(approach.filesChanged, "file")}{" "}
                <span className="change-counts mono">
                  <span className="count-add">+{approach.additions}</span>
                  <span className="count-del">−{approach.deletions}</span>
                </span>
              </>
            )
          }
        />
        <Fact label="Verification" value={verification} />
        <Fact
          label="Not verified"
          value={
            approach.checksRun === 0
              ? "Everything — no check has run against this"
              : approach.unresolvedChecks === 0
                ? "Nothing outstanding"
                : `${plural(approach.unresolvedChecks, "check")} unresolved or proving an earlier revision`
          }
        />
        <Fact
          label="People"
          value={`${plural(approach.directions, "direction")} · ${plural(approach.approvalsAnswered, "approval")} answered · ${plural(approach.stops, "stop")}`}
        />
        <Fact
          label="Cost"
          value={
            approach.usage.costUsd === null && approach.usage.outputTokens === null
              ? "Not reported"
              : [
                  approach.usage.inputTokens !== null && approach.usage.outputTokens !== null
                    ? `${compactCount(approach.usage.inputTokens)} in · ${compactCount(approach.usage.outputTokens)} out`
                    : null,
                  approach.usage.costUsd !== null ? usd(approach.usage.costUsd) : null,
                  approach.usage.durationMs !== null ? elapsed(approach.usage.durationMs) : null
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
        />
        <Fact
          label="Revision"
          value={approach.checkpointSha ? <span className="mono">{shortSha(approach.checkpointSha)}</span> : "No checkpoint yet"}
        />
      </dl>

      {approach.paths.length > 0 && (
        <details className="disclosure">
          <summary>
            Files
            <span className="disclosure-count">{plural(approach.paths.length, "path")}</span>
          </summary>
          <ul className="tool-list">
            {approach.paths.map((path) => (
              <li key={path}>
                <span className="mono tool-name">{path}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="approach-actions">
        {chosen ? (
          <span className="approach-chosen" data-testid="approach-chosen">
            Chosen — not published yet
          </span>
        ) : (
          <>
            <button
              className="btn btn-primary"
              disabled={!mayDecide || busy}
              onClick={onChoose}
              data-testid="choose-approach"
              title={mayDecide ? undefined : "Only participants who can resolve this mission may choose."}
            >
              Choose this approach
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

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="approach-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
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
  approach,
  busy,
  onCancel,
  onRecord
}: {
  approach: ApproachSummary | undefined;
  busy: boolean;
  onCancel: () => void;
  onRecord: (input: { rationale: string; acceptedRisks: string }) => void;
}) {
  const [rationale, setRationale] = useState("");
  const [risks, setRisks] = useState("");
  const ready = rationale.trim().length > 0;
  return (
    <Dialog label="Record this decision" onClose={onCancel} testId="record-decision">
        <header className="dialog-head">
          <h2>Choose {approach?.name ?? "this approach"}</h2>
          <p className="dialog-sub">
            This records what you decided and why. It does not publish anything.
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
        </div>
        <footer className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!ready || busy}
            onClick={() => onRecord({ rationale: rationale.trim(), acceptedRisks: risks.trim() })}
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
  decision,
  approaches,
  prepared,
  superseded
}: {
  decision: Decision;
  approaches: ApproachSummary[];
  prepared: PreparedPullRequest | null;
  superseded: Decision[];
}) {
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

      <h3 className="field-label">Why</h3>
      <p className="prose" data-testid="receipt-rationale">
        {decision.rationale}
      </p>

      {decision.acceptedRisks && (
        <>
          <h3 className="field-label">Risk accepted</h3>
          <p className="prose" data-testid="receipt-risks">
            {decision.acceptedRisks}
          </p>
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

      {prepared && (
        <section className="prepared-pr" data-testid="prepared-pr">
          <h3 className="field-label">Pull request, prepared</h3>
          <p className="quiet">
            Nothing has been sent. Novus does not open or merge pull requests
            {prepared.publishable ? "" : ", and this repository is a folder on a machine rather than a host that could receive one"}.
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
    </section>
  );
}
