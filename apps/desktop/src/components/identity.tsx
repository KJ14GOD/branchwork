import { siClaudecode } from "simple-icons";
import type { Participant } from "@novus/contracts";
import { initials } from "../format";

/**
 * Identity marks (DESIGN.md#identity-marks): humans are circles, harnesses are
 * rounded squares. The distinction is the whole point — at a glance, you can
 * tell a person from a machine without reading a word.
 */

export function ClaudeGlyph({ className = "harness-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Claude Code">
      <path d={siClaudecode.path} />
    </svg>
  );
}

export function HumanMark({
  login,
  name,
  large
}: {
  login: string;
  name?: string | null;
  large?: boolean;
}) {
  return (
    <span
      className={large ? "mark mark-human mark-lg" : "mark mark-human"}
      title={name ?? login}
      aria-hidden="true"
      data-testid="human-mark"
    >
      {initials(name ?? login)}
    </span>
  );
}

export function HarnessMark({ large }: { large?: boolean }) {
  return (
    <span
      className={large ? "mark mark-harness mark-lg" : "mark mark-harness"}
      title="Claude Code"
      data-testid="harness-mark"
    >
      <ClaudeGlyph />
    </span>
  );
}


/**
 * The room header's only aggregate view of presence (DESIGN.md signature
 * element 4): up to five marks, then an overflow count. Everyone else appears
 * where they acted, inline in the trace.
 */
export function ParticipantStack({ participants }: { participants: Participant[] }) {
  const shown = participants.slice(0, 5);
  const overflow = participants.length - shown.length;

  return (
    <span className="stack" data-testid="participant-stack">
      {shown.map((participant) => (
        <span
          key={participant.userId}
          className="stack-item"
          title={`${participant.name ?? participant.login} · ${roleLabel(participant.role)}${
            participant.isController ? " · holds the baton" : ""
          }`}
        >
          <HumanMark login={participant.login} name={participant.name} />
        </span>
      ))}
      {overflow > 0 && (
        <span className="stack-overflow" title={`${overflow} more`}>
          +{overflow}
        </span>
      )}
    </span>
  );
}

export function roleLabel(role: Participant["role"]): string {
  switch (role) {
    case "mission_admin":
      return "Mission Admin";
    case "operator":
      return "Operator";
    case "contributor":
      return "Contributor";
    case "viewer":
      return "Viewer";
  }
}
