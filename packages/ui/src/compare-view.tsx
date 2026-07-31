import type {
  AttemptComparison,
  Comparison,
} from "@novus/contracts/protocol";

/**
 * Two attempts, shown so a person can choose between them.
 *
 * Renders and does not act. Selecting a winner is a decision with authority
 * behind it — only the owner may make it, and V1 says the merge is always a
 * human's — so the button that does it lives in the desktop app, and this takes
 * whatever the host wants to put in each column's footer. The guest imports the
 * same component and passes nothing, which is how it stays read-only by
 * construction rather than by remembering to leave something out.
 *
 * Nothing here ranks the attempts. The comparison carries no score on purpose
 * and this draws them in the order it was given, at equal weight, because the
 * moment one column looks like the recommended one the screen has started
 * making the choice.
 */

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the tests actually said, in words that do not overstate.
 *
 * `green === null` means the attempt ran none. A tick there would tell somebody
 * an unverified attempt was verified, which is the one thing this screen must
 * never do — it is the screen a decision is made from.
 */
/**
 * What an approach is doing, in a person's words rather than the runtime's.
 *
 * STEERING.md is explicit that "Idle" is not a product state — it describes a
 * process and answers none of the three questions a state has to: what is
 * happening, does anyone need to act, what is next. It also rules out the
 * tool-call total that used to sit beside these facts: tool calls are
 * implementation telemetry, and presenting them as a headline fact invited
 * reading an approach as "more calls, more work done", which is not true and
 * is not a reason to choose one.
 */
const approachState = (attempt: AttemptComparison): string => {
  if (attempt.status === "running") {
    return "Working";
  }

  if (attempt.status === "failed") {
    return "Failed";
  }

  if (attempt.status === "cancelled") {
    return "Cancelled";
  }

  // Completed. Completion is not verification — an approach that ran no tests
  // is finished and unproven, and saying only "Completed" would let the
  // reader supply the wrong second half of that sentence themselves.
  return attempt.green === null ? "Done · unverified" : "Done";
};

const Verdict = ({ attempt }: { attempt: AttemptComparison }) => {
  if (attempt.testsRun === 0) {
    return (
      <span className="compare__verdict compare__verdict--unknown">
        Tests not run
      </span>
    );
  }

  if (attempt.green === true) {
    return (
      <span className="compare__verdict compare__verdict--pass">
        {plural(attempt.testsRun, "test run")} passed
      </span>
    );
  }

  return (
    <span className="compare__verdict compare__verdict--fail">
      {attempt.testsPassed} of {plural(attempt.testsRun, "test run")} passed
    </span>
  );
};

const Attempt = ({
  attempt,
  contested,
  footer,
}: {
  attempt: AttemptComparison;
  contested: readonly string[];
  /** Supplied by the host; absent for a guest, which cannot decide anything. */
  footer?: React.ReactNode;
}) => (
  <section
    className={
      attempt.baseline
        ? "compare__attempt compare__attempt--baseline"
        : "compare__attempt"
    }
  >
    <header className="compare__head">
      <span className="compare__label">{attempt.label}</span>
      {attempt.baseline ? (
        // Named, not decorated. This says which execution the alternatives
        // branched from — it is not a badge for the leading candidate, and it
        // must not read as one, so it gets the same weight as the status
        // beside it rather than a colour of its own.
        <span className="compare__origin">Current work</span>
      ) : null}
      <span className="compare__status">{approachState(attempt)}</span>
    </header>

    <div className="compare__facts">
      <Verdict attempt={attempt} />
      <span className="compare__fact">
        {plural(attempt.filesChanged.length, "file")} changed
      </span>
      <span className="compare__fact">
        <span className="patch__count patch__count--add">+{attempt.additions}</span>{" "}
        <span className="patch__count patch__count--del">−{attempt.deletions}</span>
      </span>
    </div>

    {attempt.failure ? (
      // Why an attempt failed is evidence, not an error to hide. A reviewer who
      // asked for two attempts and sees one column empty learns nothing.
      <p className="compare__failure">{attempt.failure}</p>
    ) : attempt.summary ? (
      <p className="compare__summary">{attempt.summary}</p>
    ) : null}

    {attempt.filesChanged.length > 0 ? (
      <ul className="compare__files">
        {attempt.filesChanged.map((file) => (
          <li
            className={
              contested.includes(file.path)
                ? "compare__file compare__file--contested"
                : "compare__file"
            }
            key={file.path}
          >
            <span className="compare__path">{file.path}</span>
            <span className="patch__count patch__count--add">+{file.additions}</span>
            <span className="patch__count patch__count--del">−{file.deletions}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="compare__empty">Changed nothing.</p>
    )}

    {footer ? <footer className="compare__foot">{footer}</footer> : null}
  </section>
);

export const CompareView = ({
  comparison,
  /** One footer per attempt, keyed by run id. The host's decision controls. */
  footers,
}: {
  comparison: Comparison;
  footers?: Record<string, React.ReactNode>;
}) => {
  if (comparison.attempts.length === 0) {
    // Only reachable before any run has started. Once there is work in flight
    // it is the baseline and appears here, so this no longer stands in for the
    // far more common "nothing forked yet" — which is a comparison of one, not
    // an empty screen.
    return (
      <div className="compare compare--empty">
        <p className="compare__empty">Nothing has run in this session yet.</p>
      </div>
    );
  }

  return (
    <div className="compare">
      {comparison.contestedPaths.length > 0 ? (
        // First, because it is the question. Approaches that changed different
        // files are not really competing; the ones that changed the same file
        // are what somebody actually has to choose between.
        <div className="compare__contested">
          <span className="compare__contested-label">
            Changed by more than one approach
          </span>
          {comparison.contestedPaths.map((path) => (
            <span className="compare__path" key={path}>
              {path}
            </span>
          ))}
        </div>
      ) : comparison.attempts.length > 1 ? (
        <div className="compare__contested">
          <span className="compare__contested-label">
            These approaches changed different files — they are not competing
            for the same lines.
          </span>
        </div>
      ) : null}

      <div className="compare__columns">
        {comparison.attempts.map((attempt) => (
          <Attempt
            attempt={attempt}
            contested={comparison.contestedPaths}
            footer={footers?.[attempt.runId]}
            key={attempt.runId}
          />
        ))}
      </div>
    </div>
  );
};
