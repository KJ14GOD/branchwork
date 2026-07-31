import type { MissionPhase } from "../mission-phase.ts";

/**
 * Where the mission stands, as a ladder.
 *
 * STEERING asks for this to become a recognisable signature of the product,
 * and the argument for it is simple: the rail counted what had happened —
 * events, tool calls, patches — and never said where the work stood or what it
 * was waiting for. A person opening a tab is asking the second question.
 *
 * The glyph carries the status rather than colour alone, so the ladder is
 * still readable to someone who cannot separate the greens from the ambers,
 * and still readable in a screenshot that has lost its stylesheet.
 */

const GLYPH: Record<MissionPhase["status"], string> = {
  complete: "✓",
  active: "●",
  "needs-attention": "!",
  blocked: "✕",
  "not-started": "○",
};

export const DecisionSpine = ({
  phases,
  onOpenApproaches,
}: {
  phases: readonly MissionPhase[];
  /** Only the two phases a person can act on from here are clickable. */
  onOpenApproaches: () => void;
}) => (
  <ol className="spine">
    {phases.map((phase) => {
      const actionable =
        (phase.key === "approaches" || phase.key === "decision") &&
        phase.status !== "not-started";

      const body = (
        <>
          <span className={`spine__glyph spine__glyph--${phase.status}`}>
            {GLYPH[phase.status]}
          </span>
          <span className="spine__label">{phase.label}</span>
          {phase.detail ? (
            <span className="spine__detail">{phase.detail}</span>
          ) : null}
        </>
      );

      return (
        <li className={`spine__step spine__step--${phase.status}`} key={phase.key}>
          {actionable ? (
            <button className="spine__action" type="button" onClick={onOpenApproaches}>
              {body}
            </button>
          ) : (
            // Not a disabled button. A phase that has not started is not a
            // control being withheld, it is a step the mission has not reached.
            <span className="spine__static">{body}</span>
          )}
        </li>
      );
    })}
  </ol>
);
