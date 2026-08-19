import type { ReactNode } from "react";
import type { Capability } from "@novus/contracts";

/**
 * A privileged action rendered from the viewer's server-computed capabilities
 * (AGENTS.md rule 13, DESIGN.md prohibited pattern 20). This component never
 * grants anything: the same verb is enforced again on the server, and every
 * button here is a way to ask.
 *
 * Denial is informative, never mysterious (DESIGN.md#transient-states): the
 * action stays visible but disabled, with a tooltip naming the capability and
 * who holds it.
 */
export function GatedAction({
  capability,
  capabilities,
  denialReason,
  holderLogin,
  onClick,
  children,
  variant = "secondary",
  busy,
  hint,
  disabled,
  disabledReason,
  label,
  testid
}: {
  capability: Capability;
  capabilities: Capability[];
  /** Names the capability in plain words: "Only the controller can apply direction." */
  denialReason: string;
  /** Who has it, when someone does — "Maya has the baton." */
  holderLogin?: string | null;
  onClick: () => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "text" | "icon";
  busy?: boolean;
  /** A standing tooltip while the action is permitted — where a control needs
   *  its words at the point of use (the capture warning's home, D-161). */
  hint?: string;
  /** A state reason to be unavailable, beyond the capability — disabled with
   *  its own words, in the same informative-never-mysterious spirit. */
  disabled?: boolean;
  disabledReason?: string;
  /** The accessible name, when the children are markup rather than one string
   *  — a screen reader must hear the command, not "[object Object]". */
  label?: string;
  testid?: string;
}) {
  const permitted = capabilities.includes(capability);
  const tooltip = !permitted
    ? holderLogin
      ? `${denialReason} ${holderLogin} has the baton.`
      : denialReason
    : disabled
      ? disabledReason
      : hint;
  const name = typeof children === "string" ? children : label;

  return (
    <button
      className={variant === "icon" ? "icon-button" : `btn btn-${variant}`}
      onClick={onClick}
      disabled={!permitted || busy || disabled}
      title={tooltip}
      aria-label={tooltip ? (name ? `${name} — ${tooltip}` : tooltip) : name}
      data-testid={testid}
      data-capability={capability}
      data-permitted={permitted ? "true" : "false"}
    >
      {children}
    </button>
  );
}
