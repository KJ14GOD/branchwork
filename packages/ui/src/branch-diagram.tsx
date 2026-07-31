import type { Comparison } from "@novus/contracts/protocol";

/**
 * The shape of the work: one checkpoint, the approaches taken from it, and the
 * single decision they converge into.
 *
 * The cards below already carry every fact this draws. What they cannot show is
 * the *structure* — that every approach started from the same recorded point,
 * which is the thing that makes comparing them fair at all. Without it a
 * reviewer has to take on faith that two sets of changes are answering the same
 * question from the same place.
 *
 * Draws no verdict. Approaches appear in the order the comparison gives them —
 * baseline first because it is the work already in flight, then creation order
 * — and nothing about a branch's position, weight or colour says it is
 * preferred. The convergence node states what is *required*, never what is
 * recommended.
 *
 * Readable without the lines: every node and branch carries its own text, so
 * losing the stylesheet costs the picture and not the information.
 */

const stateOf = (attempt: Comparison["attempts"][number]): string => {
  if (attempt.status === "running") {
    return "Working";
  }

  if (attempt.status === "failed") {
    return "Failed";
  }

  if (attempt.status === "cancelled") {
    return "Cancelled";
  }

  // Completion is not verification, in the diagram as everywhere else.
  return attempt.green === null ? "Done · unverified" : "Done";
};

/**
 * What the approaches converge into, in the reader's terms.
 *
 * Deliberately says what is being waited on rather than what to click. A
 * canvas that read "Choose one" while an approach was still writing files
 * would be asking somebody to decide on evidence that is still moving.
 */
const convergence = (comparison: Comparison): { label: string; pending: boolean } => {
  const alternatives = comparison.attempts.filter((attempt) => !attempt.baseline);

  if (comparison.decision !== null) {
    const { decision } = comparison;

    return {
      label:
        decision.kind === "revision"
          ? "Revision requested"
          : decision.kind === "exploration"
            ? "Still exploring"
            : decision.outcome.applied
              ? "Adopted · applied"
              : "Adopted · not applied",
      pending: false,
    };
  }

  if (alternatives.length === 0) {
    return { label: "No alternative yet", pending: false };
  }

  return alternatives.some(
    (attempt) => attempt.status === "running" || attempt.status === "paused",
  )
    ? { label: "Waiting for approaches to finish", pending: false }
    : { label: "Decision required", pending: true };
};

export const BranchDiagram = ({ comparison }: { comparison: Comparison }) => {
  const { attempts } = comparison;

  if (attempts.length === 0) {
    return null;
  }

  const settled = convergence(comparison);
  const only = attempts.length === 1;

  const connectors = attempts.map((attempt, index) => (
    <span
      className={[
        "branch__connector",
        only ? "branch__connector--only" : "",
        index === 0 ? "branch__connector--first" : "",
        index === attempts.length - 1 ? "branch__connector--last" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      key={attempt.runId}
    />
  ));

  return (
    <div className="branch">
      <div className="branch__node">
        <span className="branch__node-label">Shared checkpoint</span>
        <span className="branch__node-note">
          Every approach starts here, so their differences are their own
        </span>
      </div>

      {/*
        The checkpoint's own stem down to the rail. Separate from the columns
        on purpose: relying on a column to sit at the centre works for three
        approaches and leaves the checkpoint floating for two.
      */}
      <span className="branch__stem" aria-hidden="true" />

      <div
        className="branch__connectors"
        style={{ gridTemplateColumns: `repeat(${attempts.length}, 1fr)` }}
        aria-hidden="true"
      >
        {connectors}
      </div>

      <ol
        className="branch__row"
        style={{ gridTemplateColumns: `repeat(${attempts.length}, 1fr)` }}
      >
        {attempts.map((attempt) => (
          <li
            className={
              attempt.baseline ? "branch__path branch__path--baseline" : "branch__path"
            }
            key={attempt.runId}
          >
            <span className="branch__name">{attempt.label}</span>
            <span className="branch__origin">
              {attempt.baseline ? "Current work" : "Alternative"}
            </span>
            <span className="branch__state">{stateOf(attempt)}</span>
          </li>
        ))}
      </ol>

      <div
        className="branch__connectors branch__connectors--up"
        style={{ gridTemplateColumns: `repeat(${attempts.length}, 1fr)` }}
        aria-hidden="true"
      >
        {connectors}
      </div>

      <span className="branch__stem" aria-hidden="true" />

      <div
        className={
          settled.pending ? "branch__node branch__node--pending" : "branch__node"
        }
      >
        <span className="branch__node-label">{settled.label}</span>
      </div>
    </div>
  );
};
