import { useState } from "react";
import type { Artifact } from "@novus/contracts";
import { novus } from "../bridge";
import { FileBadge } from "./identity";
import { clockTime } from "../format";
import { artifactIsEvidence, artifactMetaLine, artifactStateWord } from "./artifacts";


/**
 * One artifact as a restrained thumbnail row (D-122): the same anatomy
 * wherever evidence is listed — the panel's Evidence section, beside a check,
 * on the pull request's page, in a decision's receipt — so evidence always
 * looks like evidence and never becomes decoration. Bytes ride the
 * `novus-artifact:` protocol; nothing here ever holds a URL.
 */
export function ArtifactThumbRow({
  artifact,
  onOpen,
  testid = "evidence-row"
}: {
  artifact: Artifact;
  /** Opens the artifact's own view on the canvas; absent renders inert. */
  onOpen?: (artifactId: string) => void;
  testid?: string;
}) {
  const state = artifactStateWord(artifact);
  // A kind the canvas can show opens on the canvas; everything else — a PDF,
  // an mp4, an mp3 — opens with the machine's own default app (D-165), which
  // is what clicking a file means everywhere else on the machine.
  const [openError, setOpenError] = useState<string | null>(null);
  const canvasViewable =
    artifact.mimeType.startsWith("image/") ||
    artifact.mimeType.startsWith("video/") ||
    artifact.mimeType.startsWith("audio/") ||
    artifact.mimeType === "application/pdf";
  const openRow = onOpen && canvasViewable
    ? () => onOpen(artifact.artifactId)
    : artifactIsEvidence(artifact)
      ? () => {
          void novus()
            .artifacts.openLocal(artifact.artifactId)
            .then((result) => setOpenError(result.ok ? null : result.message ?? null));
        }
      : undefined;
  const body = (
    <>
      {artifactIsEvidence(artifact) && artifact.hasThumbnail ? (
        <img
          className="evidence-thumb"
          src={`novus-artifact://${artifact.artifactId}/thumb`}
          alt=""
        />
      ) : artifactIsEvidence(artifact) && artifact.mimeType.startsWith("image/") ? (
        // An attached image is its own thumbnail (the begin-attachment
        // contract's words) — the row finally honors them.
        <img
          className="evidence-thumb"
          src={`novus-artifact://${artifact.artifactId}/blob`}
          alt=""
        />
      ) : (
        // Not blank: the mark a person already knows — a red PDF is a red
        // PDF (D-165 amended), the tree badges' fact-tint family.
        <span className="evidence-thumb empty" aria-hidden="true">
          <FileBadge mime={artifact.mimeType} size={22} />
        </span>
      )}
      <span className="evidence-text">
        <span className="evidence-label">
          {artifact.label}
          {state && <span className={`artifact-word ${state.tone}`}> · {state.word}</span>}
        </span>
        <span className="evidence-meta">{openError ?? artifactMetaLine(artifact)}</span>
      </span>
    </>
  );
  if (!openRow) {
    return (
      <span className="evidence-row" data-testid={testid} data-artifact={artifact.artifactId}>
        {body}
      </span>
    );
  }
  return (
    <button
      className="evidence-row"
      onClick={openRow}
      aria-label={`${artifact.label} — ${artifactMetaLine(artifact)}`}
      data-testid={testid}
      data-artifact={artifact.artifactId}
    >
      {body}
    </button>
  );
}

/**
 * A frozen artifact reference from a terminal receipt's snapshot (D-122):
 * the stored facts — never a recomputation — with the thumbnail still loading
 * through a freshly authorized grant, because the reference is durable and
 * the viewing access never is.
 */
export function ReceiptArtifactRow({
  reference
}: {
  reference: {
    artifactId: string;
    kind: string;
    label: string;
    state: string;
    capturedAt: string;
    revisionSha: string | null;
    hasThumbnail: boolean;
    attachedTo: string[];
  };
}) {
  return (
    <div className="evidence-row receipt-artifact" data-testid="receipt-artifact" data-artifact={reference.artifactId}>
      {reference.hasThumbnail &&
      (reference.state === "available" || reference.state === "interrupted") ? (
        <img
          className="evidence-thumb"
          src={`novus-artifact://${reference.artifactId}/thumb`}
          alt=""
        />
      ) : (
        <span className="evidence-thumb empty" aria-hidden="true" />
      )}
      <span className="evidence-text">
        <span className="evidence-label">
          {reference.label}
          {reference.state === "interrupted" && <span className="artifact-word warn"> · interrupted</span>}
        </span>
        <span className="evidence-meta">
          {clockTime(reference.capturedAt)}
          {reference.revisionSha ? ` · ${reference.revisionSha.slice(0, 8)}` : " · revision unknown"}
          {reference.attachedTo.length > 0 ? ` · evidence for ${reference.attachedTo.join(", ")}` : ""}
        </span>
      </span>
    </div>
  );
}
