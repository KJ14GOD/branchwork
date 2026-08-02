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
  variant?: "primary" | "secondary" | "text";
  busy?: boolean;
  testid?: string;
}) {
  const permitted = capabilities.includes(capability);
  const tooltip = permitted
    ? undefined
    : holderLogin
      ? `${denialReason} ${holderLogin} has the baton.`
      : denialReason;

  return (
    <button
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={!permitted || busy}
      title={tooltip}
      aria-label={tooltip ? `${String(children)} — ${tooltip}` : undefined}
      data-testid={testid}
      data-capability={capability}
      data-permitted={permitted ? "true" : "false"}
    >
      {children}
    </button>
  );
}
