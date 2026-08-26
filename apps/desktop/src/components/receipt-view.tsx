import { useState } from "react";
import type { MissionDetailResponse, ReceiptSnapshot } from "@novus/contracts";
import { ReceiptArtifactRow } from "./artifact-row";
import { roleLabel } from "./identity";
import { renderReceipt } from "./receipt-export";
import { novus } from "../bridge";
import { shortSha } from "../format";

/**
 * The mission's receipt (D-121): a single document at the receipt measure —
 * what was decided and by whom with the rationale verbatim, who was in the
 * room, what the work touched, the ledger's final rows with the revision each
 * proved, and an explicit "remains uncertain" section, because a receipt that
 * omits uncertainty is a claim (PRODUCT.md, Receipt). Rendered from the
 * snapshot stored at close — the same facts a re-projection would produce —
 * never recomputed at read time. A receipt is the room, frozen: the most
 * restrained surface in the product, words and rows, nothing decorated.
 */
export function ReceiptView({
  detail,
  receipt
}: {
  detail: MissionDetailResponse;
  receipt: ReceiptSnapshot;
}) {
  const ended =
    receipt.outcome === "completed"
      ? `Completed by ${receipt.closedByLogin}`
      : `Cancelled by ${receipt.closedByLogin}`;
  // The one word this document says about the export: where it went, or why
  // it did not. A cancelled dialog says nothing — a cancel is an answer.
  const [exportWord, setExportWord] = useState<string | null>(null);
  const exportReceipt = async () => {
    const result = await novus().missions.exportReceipt({
      missionId: detail.mission.missionId,
      markdown: renderReceipt(receipt, detail.mission.missionId)
    });
    if (!result.ok) setExportWord(result.message);
    else if (result.value) setExportWord(`Saved to ${result.value.path}`);
  };
  return (
    <div className="receipt" data-testid="receipt-view">
      <p className="receipt-head">
        {ended} ·{" "}
        {new Date(receipt.closedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric"
        })}
        <button
          className="btn btn-text receipt-export"
          onClick={() => void exportReceipt()}
          data-testid="export-receipt"
        >
          Export
        </button>
      </p>
      {exportWord && (
        <p className="receipt-quiet" data-testid="export-receipt-word">
          {exportWord}
        </p>
      )}
      {receipt.reason && <p className="receipt-reason">“{receipt.reason}”</p>}
      <p className="receipt-criteria">{detail.mission.successCriteria}</p>

      <h3 className="receipt-heading">Participants</h3>
      <ul className="receipt-list">
        {receipt.participants.map((participant) => (
          <li key={participant.login} className="receipt-row">
            <span>{participant.login}</span>
            <span className="receipt-quiet">{roleLabel(participant.role)}</span>
          </li>
        ))}
      </ul>

      {receipt.decisions.length > 0 && (
        <>
          <h3 className="receipt-heading">Decisions</h3>
          {receipt.decisions.map((decision, index) => (
            <div className="receipt-decision" key={index}>
              <p className="receipt-row">
                <span>
                  {decision.decidedByLogin} chose {decision.workstreamName}
                  {decision.checkpointSha && (
                    <span className="mono receipt-quiet"> · {shortSha(decision.checkpointSha)}</span>
                  )}
                </span>
                {decision.superseded && <span className="receipt-quiet">superseded</span>}
              </p>
              <p className="receipt-rationale">“{decision.rationale}”</p>
              {decision.acceptedRisks && (
                <p className="receipt-quiet">Accepted risks: {decision.acceptedRisks}</p>
              )}
              {decision.artifactIds.length > 0 && (
                <p className="receipt-quiet" data-testid="receipt-decision-artifacts">
                  Cited {decision.artifactIds.length === 1 ? "1 visual artifact" : `${decision.artifactIds.length} visual artifacts`}, below.
                </p>
              )}
            </div>
          ))}
        </>
      )}

      <h3 className="receipt-heading">Changes</h3>
      <p className="receipt-row mono">
        <span>
          {receipt.changes.filesChanged} {receipt.changes.filesChanged === 1 ? "file" : "files"}{" "}
          <span className="tone-ok">+{receipt.changes.additions.toLocaleString()}</span>{" "}
          <span className="tone-danger">−{receipt.changes.deletions.toLocaleString()}</span>
        </span>
      </p>

      <h3 className="receipt-heading">Verification</h3>
      {receipt.checks.length === 0 && <p className="receipt-quiet">No checks were observed.</p>}
      <ul className="receipt-list">
        {receipt.checks.map((check, index) => (
          <li key={index} className="receipt-row mono">
            <span>{check.name}</span>
            <span
              className={
                check.outcome === "passed"
                  ? "tone-ok"
                  : check.outcome === "failed" || check.outcome === "errored"
                    ? "tone-danger"
                    : "receipt-quiet"
              }
            >
              {check.outcome}
              {check.checkpointSha && (
                <span className="receipt-quiet"> · {shortSha(check.checkpointSha)}</span>
              )}
              {!check.currentAtClose && <span className="receipt-quiet"> · since superseded</span>}
            </span>
          </li>
        ))}
      </ul>

      {/* The frozen evidence set (D-122): the references stored at close —
          never a recomputation — with each thumbnail loading through a freshly
          authorized grant, because references are durable and viewing access
          never is. */}
      {receipt.artifacts.length > 0 && (
        <>
          <h3 className="receipt-heading">Visual evidence</h3>
          <div className="evidence-list">
            {receipt.artifacts.map((reference) => (
              <ReceiptArtifactRow key={reference.artifactId} reference={reference} />
            ))}
          </div>
        </>
      )}

      <h3 className="receipt-heading">Remains uncertain</h3>
      {receipt.remainingUncertain.length === 0 && (
        <p className="receipt-quiet">Nothing was recorded as uncertain.</p>
      )}
      <ul className="receipt-list">
        {receipt.remainingUncertain.map((line, index) => (
          <li key={index} className="receipt-row">
            <span className="tone-warn">{line}</span>
          </li>
        ))}
      </ul>

      {receipt.pullRequest && (
        <p className="receipt-quiet">
          Pull request #{receipt.pullRequest.number} · {receipt.pullRequest.state}
        </p>
      )}
    </div>
  );
}
