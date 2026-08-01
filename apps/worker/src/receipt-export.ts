import type { SessionEvent } from "@novus/contracts";

import { compareAttempts, forksFromLog } from "./compare.ts";
import { projectSession } from "./projection.ts";

/**
 * A mission's decision and its evidence, as something you can send to someone
 * who does not have Novus.
 *
 * The whole argument of this product is that a decision about agent-written
 * code should be reviewable. That stopped at the window: the evidence lived in
 * a screen, and the moment the tab closed the only thing left was a diff in
 * somebody's working tree with no record of what it was chosen over or why.
 *
 * Markdown rather than JSON, because the audience is a person — a reviewer, a
 * teammate who was asleep, the author three weeks later. A machine-readable
 * export would be a different feature with a different consumer, and choosing
 * JSON here would have served neither well.
 *
 * Derived from the same projection and comparison the screens read. A second
 * derivation would eventually disagree, and the disagreement would surface in
 * the artefact people trust *most* because it looks official.
 */

const heading = (goal: string | null): string =>
  goal === null ? "# Mission" : `# ${goal}`;

const money = (costUsd: number | null, isFloor: boolean): string => {
  if (costUsd === null) {
    // Never "$0.00". A run reported as free because nobody priced its model is
    // a worse answer than one that says it does not know.
    return "not counted (no published rate for the model used)";
  }

  return `${isFloor ? "at least " : ""}$${costUsd.toFixed(4)}`;
};

const verdict = (green: boolean | null, testsRun: number, passed: number): string => {
  if (green === null) {
    // The rule the whole product turns on, restated in the artefact that
    // outlives the screen: finishing is not the same as being verified.
    return "**Unverified** — ran no tests";
  }

  return green ? `Verified — ${testsRun} test run(s) passed` : `**Failing** — ${passed} of ${testsRun} test run(s) passed`;
};

export const exportReceipt = (
  sessionId: string,
  repositoryPath: string,
  events: readonly SessionEvent[],
): string => {
  const projected = projectSession(sessionId, events);
  const comparison = compareAttempts(sessionId, events, forksFromLog(events));
  const lines: string[] = [];

  lines.push(heading(projected.runs[0]?.goal ?? null));
  lines.push("");
  lines.push(`- Repository: \`${repositoryPath}\``);
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(
    `- Cost: ${money(projected.usage.costUsd, projected.usage.costIsFloor)}`,
  );
  lines.push(
    `- Model calls: ${projected.usage.modelCalls} · tokens: ${projected.usage.totalTokens}`,
  );
  lines.push("");

  // The decision first, because it is what the reader came for. Everything
  // below it is the evidence it was made on.
  lines.push("## Decision");
  lines.push("");

  if (projected.decision === null) {
    lines.push("No decision has been recorded for this mission yet.");
  } else {
    const chosen = comparison.attempts.find(
      (attempt) => attempt.runId === projected.decision?.runId,
    );

    const named = chosen?.label ?? projected.decision.runId;

    lines.push(
      projected.decision.kind === "adopt"
        ? projected.decision.target === "baseline"
          ? // Said as what it is. This used to fall through to "further
            // exploration requested", which is the opposite claim: that
            // nothing had been settled.
            `**Kept the current work** (${named}) — it was already in the working tree, so nothing needed to be written.`
          : projected.decision.outcome.applied === true
            ? `**Adopted** ${named} — applied to the working tree.`
            : `**Adopted** ${named} — recorded, not applied.`
        : projected.decision.kind === "revision"
          ? `**Revision requested** on ${named}. Nothing was written.`
          : "**Further exploration requested.** Nothing was written or discarded.",
    );

    if (projected.decision.outcome.applied === false) {
      lines.push("");
      // Selection and application stay distinct here too. A conflict means the
      // judgement stands and the write did not happen.
      lines.push(`> ${projected.decision.outcome.reason}`);

      for (const conflict of projected.decision.outcome.conflicts) {
        lines.push(`> - \`${conflict.path}\`: ${conflict.reason}`);
      }
    }

    if (projected.decision.decidedBy !== "") {
      lines.push("");
      lines.push(`Decided by \`${projected.decision.decidedBy}\`.`);
    }

    if (projected.decision.rationale !== null) {
      lines.push("");
      lines.push("**Why:**");
      lines.push("");
      lines.push(`> ${projected.decision.rationale.replace(/\n/g, "\n> ")}`);
    }

    // What was turned down, by name, in the artefact that outlives the screen.
    // A receipt that named only the winner reads as though it were the only
    // candidate — which is exactly the claim the comparison exists to refuse.
    const rejected = projected.decision.alternatives
      .map(
        (runId) =>
          comparison.attempts.find((attempt) => attempt.runId === runId)?.label ??
          runId,
      )
      .filter((label) => label !== named);

    if (rejected.length > 0) {
      lines.push("");
      lines.push(
        `Considered and not chosen: ${rejected.map((label) => `*${label}*`).join(", ")}. Their evidence is below.`,
      );
    }
  }

  lines.push("");
  lines.push("## Approaches");

  if (comparison.attempts.length === 0) {
    lines.push("");
    lines.push("Nothing has run in this mission yet.");
  }

  for (const attempt of comparison.attempts) {
    lines.push("");
    lines.push(
      `### ${attempt.label}${attempt.baseline ? " (the work this branched from)" : ""}`,
    );
    lines.push("");
    lines.push(`- ${verdict(attempt.green, attempt.testsRun, attempt.testsPassed)}`);
    lines.push(
      `- ${attempt.filesChanged.length} file(s) changed · +${attempt.additions} −${attempt.deletions}`,
    );

    if (attempt.failure !== null) {
      lines.push(`- Failed: ${attempt.failure}`);
    }

    for (const file of attempt.filesChanged) {
      lines.push(
        `  - \`${file.path}\` +${file.additions} −${file.deletions}${
          comparison.contestedPaths.includes(file.path)
            ? " *(changed by more than one approach)*"
            : ""
        }`,
      );
    }

    if (attempt.interventions.length > 0) {
      lines.push("");
      lines.push("What a person did during this approach:");

      for (const intervention of attempt.interventions) {
        lines.push(
          `- ${
            intervention.kind === "direction"
              ? "Steered"
              : intervention.kind === "denied"
                ? "Refused"
                : "Approved"
          }: ${intervention.detail}`,
        );
      }
    }

    // Last, and labelled, exactly as on the screen. It is the approach's own
    // account of itself, and it reads as authoritative because it is confident
    // prose next to numbers somebody actually measured.
    if (attempt.summary !== null) {
      lines.push("");
      lines.push(
        attempt.green === null
          ? `> **Unverified claim (this approach ran no tests):** ${attempt.summary}`
          : `> The approach's own summary: ${attempt.summary}`,
      );
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Generated by Novus from this mission's event log. Nothing here is the agent's word for it except where marked as a claim.",
  );
  lines.push("");

  return lines.join("\n");
};
