import { useEffect } from "react";
import type { Artifact } from "@novus/contracts";
import {
  artifactAttachmentsLine,
  artifactClaim,
  artifactMetaLine,
  artifactProvenanceRows,
  artifactProvenanceText,
  artifactStateWord
} from "./artifacts";

/**
 * One artifact, looked at closely (D-122): the full image or the recording's
 * player over the room's canvas, with the provenance beneath — the
 * worker-inspector's own shape (D-108): the canvas, never a tab, `Esc` or
 * Back to chat returning to the conversation where the reader left it.
 *
 * The media src is the `novus-artifact:` protocol: the main process
 * authorizes each request against the mission and spends a fresh temporary
 * grant. No signed URL and no object key ever reaches this component.
 */
export function ArtifactView({ artifact, onBack }: { artifact: Artifact; onBack: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const state = artifactStateWord(artifact);
  const viewable = artifact.state === "available" || artifact.state === "interrupted";

  const copyProvenance = () => {
    void navigator.clipboard?.writeText(artifactProvenanceText(artifact)).catch(() => undefined);
  };

  return (
    <section className="artifact-view" data-testid="artifact-view" aria-label={artifact.label}>
      <header className="artifact-view-head">
        <span className="artifact-view-title">{artifact.label}</span>
        {state && <span className={`artifact-word ${state.tone}`}>{state.word}</span>}
        <span className="file-meta">{artifactMetaLine(artifact)}</span>
        <span className="head-spacer" />
        <button className="btn btn-text" onClick={copyProvenance} data-testid="artifact-copy-provenance">
          Copy provenance
        </button>
        <button className="btn btn-text" onClick={onBack} data-testid="artifact-back">
          Back to chat
        </button>
      </header>

      {viewable ? (
        artifact.kind === "recording" ? (
          <video
            className="artifact-media"
            controls
            preload="metadata"
            src={`novus-artifact://${artifact.artifactId}/blob`}
            poster={
              artifact.hasThumbnail ? `novus-artifact://${artifact.artifactId}/thumb` : undefined
            }
            data-testid="artifact-video"
          />
        ) : (
          <img
            className="artifact-media"
            src={`novus-artifact://${artifact.artifactId}/blob`}
            alt={artifact.label}
            data-testid="artifact-image"
          />
        )
      ) : (
        <p className="quiet" data-testid="artifact-unviewable">
          {artifact.state === "failed"
            ? `This capture failed: ${artifact.failureReason ?? "the upload did not complete"}. There is nothing verified to show.`
            : "This capture is still uploading; there is nothing verified to show yet."}
        </p>
      )}

      <p className="quiet artifact-claim" data-testid="artifact-claim">
        {artifactClaim(artifact)}
      </p>

      <div className="artifact-provenance" data-testid="artifact-provenance">
        {artifactProvenanceRows(artifact).map((row) => (
          <div className="artifact-provenance-row" key={row.label}>
            <span className="artifact-provenance-label">{row.label}</span>
            <span className={row.mono ? "artifact-provenance-value mono" : "artifact-provenance-value"}>
              {row.value}
            </span>
          </div>
        ))}
        <div className="artifact-provenance-row">
          <span className="artifact-provenance-label">Used as</span>
          <span className="artifact-provenance-value" data-testid="artifact-attachments">
            {artifactAttachmentsLine(artifact)}
          </span>
        </div>
      </div>
    </section>
  );
}
