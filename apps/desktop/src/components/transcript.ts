import { TRANSCRIPT_CLAIM } from "@novus/contracts";
import type { Feed, TraceBlock } from "./derive-feed";

/**
 * The transcript projection (D-173): one conversation's feed, rendered to
 * markdown for a new chat to continue from.
 *
 * Deterministic on purpose — this is a projection of the record, like the
 * receipt, never a model's summary of it: nothing here can be fabricated,
 * emphasized, or quietly dropped. The one feed derivation the room renders
 * from is the one this projects from, so what a person read in the source
 * chat and what the new chat receives cannot disagree.
 */

/** Tool activity is context, not the conversation: carried compactly and
 *  bounded, with the truncation stated rather than silent. */
const MAX_STEPS_PER_TURN = 50;

function turnLines(block: TraceBlock): string[] {
  const lines: string[] = [];
  const author = block.authorLogin ?? "the room";
  lines.push(`## ${author}${block.at ? ` — ${block.at}` : ""}`);
  if (block.body) lines.push("", block.body);
  const steps = block.toolSteps.slice(0, MAX_STEPS_PER_TURN);
  if (steps.length > 0) {
    lines.push(
      "",
      `Activity: ${steps
        .map((step) => (step.detail ? `${step.label} ${step.detail}` : step.label))
        .join(" · ")}${
        block.toolSteps.length > steps.length
          ? ` · +${block.toolSteps.length - steps.length} more`
          : ""
      }`
    );
  }
  for (const segment of block.segments) {
    if (segment.kind === "harness") {
      lines.push("", "**Agent:**", "", ...segment.texts);
    } else if (segment.kind === "checkpoint" && segment.sha) {
      lines.push("", `Checkpoint: ${segment.sha.slice(0, 8)}`);
    } else if (segment.kind === "checks" && segment.checks.length > 0) {
      lines.push(
        "",
        `Checks: ${segment.checks
          .map((check) => `${check.name} — ${check.outcome}`)
          .join(" · ")}`
      );
    } else if (segment.kind === "note") {
      lines.push("", `Note${segment.login ? ` (${segment.login})` : ""}: ${segment.text}`);
    } else if (segment.kind === "outcome") {
      lines.push("", `Outcome: ${segment.text}`);
    }
  }
  return lines;
}

/** Renders one conversation's feed as a markdown transcript. `title` is the
 *  source chat's own title; `projectedAt` is stated so the document says what
 *  moment of the record it reflects. */
export function renderTranscript(feed: Feed, title: string, projectedAt: string): string {
  const lines: string[] = [
    `# Transcript · ${title}`,
    "",
    `Projected ${projectedAt} from the mission record. ${TRANSCRIPT_CLAIM}`
  ];
  for (const block of feed.blocks) {
    if (block.kind === "control") {
      lines.push("", `— ${block.text}${block.login ? ` (${block.login})` : ""}`);
    } else {
      lines.push("", ...turnLines(block));
    }
  }
  return lines.join("\n");
}
