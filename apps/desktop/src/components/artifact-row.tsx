import type { Artifact } from "@novus/contracts";
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
  const body = (
    <>
      {artifactIsEvidence(artifact) && artifact.hasThumbnail ? (
        <img
          className="evidence-thumb"
          src={`novus-artifact://${artifact.artifactId}/thumb`}
          alt=""
        />
      ) : (
        <span className="evidence-thumb empty" aria-hidden="true" />
      )}
      <span className="evidence-text">
        <span className="evidence-label">
          {artifact.label}
          {state && <span className={`artifact-word ${state.tone}`}> · {state.word}</span>}
        </span>
        <span className="evidence-meta">{artifactMetaLine(artifact)}</span>
      </span>
    </>
  );
  if (!onOpen) {
    return (
      <span className="evidence-row" data-testid={testid} data-artifact={artifact.artifactId}>
        {body}
      </span>
    );
  }
  return (
    <button
      className="evidence-row"
      onClick={() => onOpen(artifact.artifactId)}
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
