import { useEffect, useState } from "react";
import type { Artifact, MissionDetailResponse } from "@novus/contracts";
import { novus } from "../bridge";
import {
  artifactClaim,
  artifactIsEvidence,
  artifactMetaLine,
  artifactProvenanceRows,
  artifactProvenanceText,
  artifactStateWord
} from "./artifacts";
import { GatedAction } from "./gated";
import { Markdown } from "./markdown";

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
export function ArtifactView({
  artifact,
  detail,
  onBack,
  onViewInSession
}: {
  artifact: Artifact;
  /** The lane's own view, for the attachment targets and the capability. */
  detail: MissionDetailResponse;
  onBack: () => void;
  /** Jumps to the conversation this capture is honestly attributable to
   *  (D-167), and where possible the exact turn (D-168) — the execution's
   *  starting direction, when the execution that captured it is still on
   *  record. Omitted entirely when `artifact.sessionId` is null — a person's
   *  own click belongs to no chat, and there is nowhere honest to jump: the
   *  provenance below is the whole answer for that capture. */
  onViewInSession?: (target: {
    sessionId: string;
    executionId: string | null;
    artifactId: string;
  }) => void;
}) {
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
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  const copyProvenance = () => {
    void navigator.clipboard?.writeText(artifactProvenanceText(artifact)).catch(() => undefined);
  };

  // Where this can be attached (D-122): the lane's checks by name, and the
  // tracked pull request while one is open — only what actually exists, and
  // only what it is not already attached to. Detach is each live ref's own
  // action. The refreshed relationship arrives with the room's next poll.
  const attachedTo = new Set(artifact.attachments.map((ref) => `${ref.kind}:${ref.id}`));
  const targets: { kind: "check" | "pull_request"; id: string; label: string }[] = [
    ...detail.checks
      .filter((check) => !attachedTo.has(`check:${check.checkId}`))
      .map((check) => ({
        kind: "check" as const,
        id: check.checkId,
        label: `check "${check.name}"`
      })),
    ...(detail.pullRequest &&
    (detail.pullRequest.state === "draft" || detail.pullRequest.state === "ready") &&
    !attachedTo.has(`pull_request:${detail.pullRequest.pullRequestId}`)
      ? [
          {
            kind: "pull_request" as const,
            id: detail.pullRequest.pullRequestId,
            label: `PR #${detail.pullRequest.number}`
          }
        ]
      : [])
  ];
  const [target, setTarget] = useState("");

  const attach = async () => {
    const chosen = targets.find((candidate) => `${candidate.kind}:${candidate.id}` === target);
    if (!chosen) return;
    setAttaching(true);
    setAttachError(null);
    const result = await novus().artifacts.attach({
      artifactId: artifact.artifactId,
      target: { kind: chosen.kind, id: chosen.id }
    });
    setAttaching(false);
    if (!result.ok) setAttachError(result.message);
    else setTarget("");
  };

  const detach = async (ref: { kind: string; id: string }) => {
    if (ref.kind !== "check" && ref.kind !== "pull_request") return;
    setAttachError(null);
    const result = await novus().artifacts.detach({
      artifactId: artifact.artifactId,
      target: { kind: ref.kind, id: ref.id }
    });
    if (!result.ok) setAttachError(result.message);
  };

  return (
    <section className="artifact-view" data-testid="artifact-view" aria-label={artifact.label}>
      <header className="artifact-view-head">
        <span className="artifact-view-title">{artifact.label}</span>
        {state && <span className={`artifact-word ${state.tone}`}>{state.word}</span>}
        <span className="file-meta">{artifactMetaLine(artifact)}</span>
        <span className="head-spacer" />
        {artifact.sessionId && onViewInSession && (
          <button
            className="btn btn-text"
            onClick={() =>
              onViewInSession({
                sessionId: artifact.sessionId!,
                executionId: artifact.executionId,
                artifactId: artifact.artifactId
              })
            }
            title="Opens the conversation this capture came from"
            data-testid="artifact-view-in-session"
          >
            View in conversation
          </button>
        )}
        <button
          className="btn btn-text"
          onClick={() => void novus().artifacts.revealLocal(artifact.artifactId)}
          title="Fetches the file into Novus's own temp corner and shows it in the file manager"
          data-testid="artifact-reveal"
        >
          Reveal in Finder
        </button>
        <button className="btn btn-text" onClick={copyProvenance} data-testid="artifact-copy-provenance">
          Copy provenance
        </button>
        <button className="btn btn-text" onClick={onBack} data-testid="artifact-back">
          Back to chat
        </button>
      </header>

      {viewable ? (
        // By what the bytes are, not what made them (D-165 amended): a
        // recording and an attached mp4 are both video; a PDF renders in
        // Chromium's own viewer, in the app, never handed outside first.
        artifact.kind === "recording" || artifact.mimeType.startsWith("video/") ? (
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
        ) : artifact.mimeType === "application/pdf" ? (
          <iframe
            className="artifact-media artifact-pdf"
            src={`novus-artifact://${artifact.artifactId}/blob`}
            title={artifact.label}
            data-testid="artifact-pdf"
          />
        ) : artifact.mimeType.startsWith("audio/") ? (
          <audio
            className="artifact-audio"
            controls
            preload="metadata"
            src={`novus-artifact://${artifact.artifactId}/blob`}
            data-testid="artifact-audio"
          />
        ) : artifact.mimeType === "text/markdown" ? (
          // A transcript (D-173) — or any markdown attachment — is read here
          // as the document it is, through the same renderer the feed uses.
          <ArtifactText artifactId={artifact.artifactId} />
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
            {artifact.attachments.length === 0 ? (
              "Not attached to anything yet."
            ) : (
              <span className="artifact-attachment-list">
                {artifact.attachments.map((ref) => (
                  <span className="artifact-attachment" key={`${ref.kind}:${ref.id}`}>
                    evidence for {ref.label}
                    {(ref.kind === "check" || ref.kind === "pull_request") && (
                      <GatedAction
                        capability="artifact.attach"
                        capabilities={detail.capabilities}
                        denialReason="Changing what the record presents as evidence needs the artifact.attach capability."
                        onClick={() => void detach(ref)}
                        variant="text"
                        testid="artifact-detach"
                      >
                        Detach
                      </GatedAction>
                    )}
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>
        {/* Attaching is a relationship change, never a change to the artifact
            (D-122) — and never a verdict: a screenshot beside a check supports
            it, it does not pass it. Only completed evidence can be attached. */}
        {artifactIsEvidence(artifact) && targets.length > 0 && (
          <div className="artifact-provenance-row">
            <span className="artifact-provenance-label">Attach to</span>
            <span className="artifact-provenance-value artifact-attach-controls">
              <span className="select-wrap">
                <select
                  className="select"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  aria-label="What to attach this artifact beside"
                  data-testid="artifact-attach-target"
                >
                  <option value="">Choose…</option>
                  {targets.map((candidate) => (
                    <option
                      key={`${candidate.kind}:${candidate.id}`}
                      value={`${candidate.kind}:${candidate.id}`}
                    >
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </span>
              <GatedAction
                capability="artifact.attach"
                capabilities={detail.capabilities}
                denialReason="Changing what the record presents as evidence needs the artifact.attach capability."
                onClick={() => void attach()}
                variant="secondary"
                busy={attaching}
                disabled={target === ""}
                disabledReason="Choose what to attach this beside."
                testid="artifact-attach"
              >
                Attach
              </GatedAction>
            </span>
          </div>
        )}
        {attachError && (
          <p className="inline-error" role="alert" data-testid="artifact-attach-error">
            {attachError}
          </p>
        )}
      </div>
    </section>
  );
}

/** A markdown artifact's bytes, fetched through the artifact protocol like
 *  every other blob and rendered as the document they are (D-173). */
function ArtifactText({ artifactId }: { artifactId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stale = false;
    setText(null);
    setFailed(false);
    fetch(`novus-artifact://${artifactId}/blob`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((body) => {
        if (!stale) setText(body);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [artifactId]);
  if (failed) {
    return (
      <p className="quiet" data-testid="artifact-text-failed">
        The document's bytes could not be read.
      </p>
    );
  }
  if (text === null) return <p className="quiet">Loading…</p>;
  return (
    <div className="artifact-text" data-testid="artifact-text">
      <Markdown source={text} />
    </div>
  );
}
