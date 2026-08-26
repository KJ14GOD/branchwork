import type { ReceiptSnapshot } from "@novus/contracts";
import { roleLabel } from "./identity";

/**
 * The receipt's export projection (D-220): the stored snapshot rendered to
 * markdown, for the record to leave Novus — a postmortem appendix, a message
 * to someone not in the room, a file kept beside the code.
 *
 * Deterministic on purpose, like the transcript (D-173): same snapshot, same
 * document, every time. Everything here is read from the snapshot alone —
 * no clock, no recomputation, no model — so the exported file and the receipt
 * on screen cannot disagree. Bounded because the snapshot is bounded.
 */

const shortSha = (sha: string | null): string | null => (sha ? sha.slice(0, 8) : null);

export function renderReceipt(receipt: ReceiptSnapshot, missionId: string): string {
  const ended = receipt.outcome === "completed" ? "Completed" : "Cancelled";
  const lines: string[] = [
    `# Receipt · ${receipt.goal}`,
    "",
    `${ended} by ${receipt.closedByLogin} · ${receipt.closedAt}`,
    "",
    `Mission ${missionId} · events ${receipt.eventRange.fromSeq}–${receipt.eventRange.toSeq}. ` +
      "A deterministic projection of the mission record, exported from Novus."
  ];
  if (receipt.reason) lines.push("", `> ${receipt.reason}`);

  lines.push("", "## Success criteria", "", receipt.successCriteria);

  lines.push("", "## Participants", "");
  for (const participant of receipt.participants) {
    lines.push(`- ${participant.login} — ${roleLabel(participant.role)}`);
  }
  lines.push("", `Directions applied: ${receipt.directionsApplied}`);

  if (receipt.decisions.length > 0) {
    lines.push("", "## Decisions");
    for (const decision of receipt.decisions) {
      const sha = shortSha(decision.checkpointSha);
      lines.push(
        "",
        `### ${decision.decidedByLogin} chose ${decision.workstreamName}` +
          `${sha ? ` · ${sha}` : ""}${decision.superseded ? " · superseded" : ""}`,
        "",
        `Decided ${decision.decidedAt}.`,
        "",
        `> ${decision.rationale}`
      );
      if (decision.acceptedRisks) lines.push("", `Accepted risks: ${decision.acceptedRisks}`);
      if (decision.artifactIds.length > 0) {
        lines.push("", `Cited visual evidence: ${decision.artifactIds.join(", ")}`);
      }
    }
  }

  lines.push(
    "",
    "## Changes",
    "",
    `${receipt.changes.filesChanged} ${receipt.changes.filesChanged === 1 ? "file" : "files"} changed, ` +
      `+${receipt.changes.additions} −${receipt.changes.deletions}`
  );

  lines.push("", "## Verification", "");
  if (receipt.checks.length === 0) {
    lines.push("No checks were observed.");
  } else {
    for (const check of receipt.checks) {
      const sha = shortSha(check.checkpointSha);
      lines.push(
        `- ${check.name} — ${check.outcome}${sha ? ` at ${sha}` : ""}` +
          `${check.currentAtClose ? "" : " (since superseded)"}`
      );
    }
  }

  if (receipt.artifacts.length > 0) {
    lines.push(
      "",
      "## Visual evidence",
      "",
      "References frozen at close — ids and digests, never the bytes; viewing happens in Novus."
    );
    for (const artifact of receipt.artifacts) {
      lines.push(
        "",
        `- ${artifact.label} (${artifact.kind}, ${artifact.state}) · captured ${artifact.capturedAt}` +
          `${artifact.revisionSha ? ` at ${shortSha(artifact.revisionSha)}` : ""}`,
        `  id ${artifact.artifactId} · sha256 ${artifact.sha256}` +
          `${artifact.attachedTo.length > 0 ? ` · evidence for: ${artifact.attachedTo.join("; ")}` : ""}`
      );
    }
  }

  lines.push("", "## Remains uncertain", "");
  if (receipt.remainingUncertain.length === 0) {
    lines.push("Nothing was recorded as uncertain.");
  } else {
    for (const line of receipt.remainingUncertain) lines.push(`- ${line}`);
  }

  if (receipt.pullRequest) {
    lines.push("", `Pull request #${receipt.pullRequest.number} · ${receipt.pullRequest.state}`);
  }

  return lines.join("\n") + "\n";
}
