import { RECORDING_CLAIM, SCREENSHOT_CLAIM, TRANSCRIPT_CLAIM, type Artifact } from "@novus/contracts";
import { clockTime, elapsed, shortSha } from "../format";

/**
 * Artifact presentation (D-122): the words, derived pure so a plain-Node
 * suite can pin them. Status is stated in words, never a pill and never
 * color alone (DESIGN.md#status-semantics); an artifact that is not evidence
 * says exactly what it is instead.
 */

export type ArtifactTone = "quiet" | "warn" | "danger";

/** The state word on a row — null for plain available evidence, which needs
 *  no badge: the thumbnail and the meta line are the fact. */
export function artifactStateWord(artifact: Artifact): { word: string; tone: ArtifactTone } | null {
  if (artifact.state === "pending") return { word: "uploading", tone: "quiet" };
  if (artifact.state === "uploading") return { word: "uploading", tone: "quiet" };
  if (artifact.state === "interrupted") return { word: "interrupted", tone: "warn" };
  if (artifact.state === "failed") return { word: "failed", tone: "danger" };
  return null;
}

/** Whether this row is evidence a person may open and cite. */
export function artifactIsEvidence(artifact: Artifact): boolean {
  return artifact.state === "available" || artifact.state === "interrupted";
}

/** The row's meta line: when, and against what. */
export function artifactMetaLine(artifact: Artifact): string {
  const parts = [clockTime(artifact.capturedAt)];
  // A transcript has no capture revision and does not pretend to (D-173):
  // it is a projection of the conversation record, not a photograph of a
  // worktree, so "revision unknown" would state a gap that never existed.
  if (artifact.kind === "transcript") return parts.join(" · ");
  if (artifact.revisionSha) {
    parts.push(
      artifact.revisionDirty
        ? `${shortSha(artifact.revisionSha)} + uncommitted changes`
        : shortSha(artifact.revisionSha)
    );
  } else {
    parts.push("revision unknown");
  }
  if (artifact.kind === "recording" && artifact.durationMs !== null) {
    parts.push(elapsed(artifact.durationMs));
  }
  return parts.join(" · ");
}

/** Who caused it, in one sentence — a person's own act, or the agent's
 *  approved request, never ambiguous. */
export function artifactActorLine(artifact: Artifact): string {
  if (artifact.initiator === "agent") return "Requested by the agent, approved in the room";
  if (artifact.kind === "transcript") {
    // Nobody photographed anything (D-173): a person carried a projection.
    return artifact.createdByLogin
      ? `Carried over by ${artifact.createdByLogin}`
      : "Carried over by a person";
  }
  return artifact.createdByLogin ? `Captured by ${artifact.createdByLogin}` : "Captured by a person";
}

/** The honest claim to print beside the artifact, by kind (D-122, D-173). */
export function artifactClaim(artifact: Artifact): string {
  if (artifact.kind === "transcript") return TRANSCRIPT_CLAIM;
  return artifact.kind === "recording" ? RECORDING_CLAIM : SCREENSHOT_CLAIM;
}

export interface ProvenanceRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** The inspector's provenance ledger: every fact the capture bound, each
 *  absent stated as absent rather than dropped. */
export function artifactProvenanceRows(artifact: Artifact): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [
    { label: "Captured", value: `${clockTime(artifact.capturedAt)} · ${artifact.capturedAt.slice(0, 10)}` },
    { label: "By", value: artifactActorLine(artifact) },
    {
      label: "Revision",
      value: artifact.revisionSha
        ? `${artifact.revisionSha}${artifact.revisionDirty ? " — uncommitted changes were present" : ""}`
        : "unknown — the worktree could not be read",
      mono: artifact.revisionSha !== null
    },
    {
      label: "Process",
      value: artifact.processName
        ? `${artifact.processName}${artifact.origin ? ` · ${artifact.origin}` : ""}`
        : "unknown",
      mono: true
    },
    {
      label: "Readiness",
      value:
        artifact.readiness === "ready"
          ? "the declared signal had answered"
          : artifact.readiness === "pending"
            ? "starting — the declared signal had not answered"
            : artifact.readiness === "unreachable"
              ? "not answering — the declared signal's deadline had passed"
              : "no readiness signal declared"
    },
    { label: "Reported by", value: artifact.environment },
    { label: "Digest", value: `sha256 ${artifact.sha256}`, mono: true },
    { label: "Size", value: byteLabel(artifact.byteSize) }
  ];
  if (artifact.state === "interrupted") {
    rows.push({
      label: "Interrupted",
      value: artifact.interruptionReason ?? "the recording did not end by its own stop"
    });
  }
  if (artifact.state === "failed") {
    rows.push({ label: "Failed", value: artifact.failureReason ?? "the upload did not complete" });
  }
  return rows;
}

/** Copyable provenance, for handing to a teammate or a ticket. */
export function artifactProvenanceText(artifact: Artifact): string {
  return [
    artifact.label,
    `artifact ${artifact.artifactId}`,
    ...artifactProvenanceRows(artifact).map((row) => `${row.label}: ${row.value}`),
    artifactClaim(artifact)
  ].join("\n");
}

/** Where this artifact is currently evidence, in words. */
export function artifactAttachmentsLine(artifact: Artifact): string {
  if (artifact.attachments.length === 0) return "Not attached to anything yet.";
  return `Evidence for ${artifact.attachments.map((ref) => ref.label).join(", ")}.`;
}

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
