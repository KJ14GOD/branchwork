import { useEffect, useRef, useState } from "react";
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
 * The baton (DESIGN.md signature element 1): one small solid --accent squircle
 * beside the controller's name, everywhere the controller appears. It moves in
 * one 240ms motion when control actually transfers — never on first paint,
 * because nothing animates unprompted (DESIGN.md#motion).
 */
export function Baton({ holderUserId, animate }: { holderUserId: string; animate?: boolean }) {
  const previous = useRef<string | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (previous.current !== null && previous.current !== holderUserId) {
      setMoving(true);
      const timer = setTimeout(() => setMoving(false), 240);
      previous.current = holderUserId;
      return () => clearTimeout(timer);
    }
    previous.current = holderUserId;
    return undefined;
  }, [holderUserId]);

  return (
    <span
      className={moving || animate ? "baton baton-moving" : "baton"}
      title="Holds the baton"
      role="img"
      aria-label="Holds the baton"
      data-testid="baton"
    />
  );
}

/**
 * The room header's only aggregate view of presence (DESIGN.md signature
 * element 4): up to five marks, then an overflow count. Everyone else appears
 * where they acted, inline in the trace.
 */
export function ParticipantStack({
  participants,
  attention
}: {
  participants: Participant[];
  /** A quiet --warn dot while a control request is open. */
  attention?: boolean;
}) {
  const shown = participants.slice(0, 5);
  const overflow = participants.length - shown.length;
  const holder = participants.find((participant) => participant.isController)?.userId ?? null;

  // The baton moves between two different mark instances here, so the stack —
  // not the mark — is what notices the transfer and plays the 240ms motion.
  const previousHolder = useRef<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  useEffect(() => {
    if (previousHolder.current !== null && previousHolder.current !== holder) {
      setTransferring(true);
      const timer = setTimeout(() => setTransferring(false), 240);
      previousHolder.current = holder;
      return () => clearTimeout(timer);
    }
    previousHolder.current = holder;
    return undefined;
  }, [holder]);

  return (
    <span className="participant-stack" data-testid="participant-stack">
      {attention && <span className="status-dot warn" title="Someone is asking for control" />}
      {shown.map((participant) => (
        <span
          key={participant.userId}
          className="stack-item"
          title={`${participant.name ?? participant.login} · ${roleLabel(participant.role)}${
            participant.isController ? " · holds the baton" : ""
          }`}
        >
          <HumanMark login={participant.login} name={participant.name} />
          {participant.isController && (
            <Baton holderUserId={participant.userId} animate={transferring} />
          )}
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
