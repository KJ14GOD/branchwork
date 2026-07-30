import { useState } from "react";

import type { RepositoryState } from "@novus/contracts/protocol";
import { CompareView } from "@novus/ui";

import type { ComparisonState } from "../use-comparison.ts";

/**
 * The host's side of comparing two attempts — the decision surface.
 *
 * `CompareView` draws the evidence and is shared with the guest. Everything
 * here is the part that acts — starting a fork, and settling on one attempt —
 * which is why it lives in the desktop app. A guest importing the view gets
 * the same columns and no buttons, so read-only is a property of what it can
 * reach rather than a rule somebody has to remember not to break.
 *
 * Restyled this pass rather than restructured: it is titled like the screen it
 * is (branch, compare, merge is the product thesis), the fork form is the one
 * bordered container on it, and the evidence scrolls under a pinned header
 * instead of the whole screen scrolling as one.
 */
export const CompareScreen = ({
  state,
  repositoryState,
  onClose,
}: {
  state: ComparisonState;
  repositoryState: RepositoryState;
  onClose: () => void;
}) => {
  const [label, setLabel] = useState("");
  const [goal, setGoal] = useState("");
  const [forking, setForking] = useState(false);

  const count = state.comparison?.attempts.length ?? 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (label.trim() === "" || goal.trim() === "") {
      return;
    }

    setForking(true);

    try {
      await state.fork(label.trim(), goal.trim());
      setLabel("");
      setGoal("");
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="compare-screen">
      <header className="compare-screen__bar">
        <div className="compare-screen__heading">
          <span className="compare-screen__title">Attempts</span>
          <span className="compare-screen__subtitle">
            {count === 0
              ? "Fork this session to run a competing approach in its own worktree."
              : `${count} attempt${count === 1 ? "" : "s"} · choose one on the evidence, not the summary`}
          </span>
        </div>
        <span className="titlebar__spacer" />
        <button
          className="button"
          type="button"
          onClick={state.refresh}
          disabled={state.loading}
        >
          {state.loading ? "Reading…" : "Refresh"}
        </button>
        <button className="button" type="button" onClick={onClose}>
          Back to timeline
        </button>
      </header>

      <form className="compare-screen__fork" onSubmit={submit}>
        <input
          className="open__input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label — how you will tell this attempt apart"
          spellCheck={false}
        />
        <input
          className="open__input"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="What this attempt should try"
        />
        <button
          className="button button--primary"
          type="submit"
          disabled={forking}
        >
          {forking ? "Forking…" : "Fork an attempt"}
        </button>
      </form>

      {repositoryState !== "ready" ? (
        // Concrete, because the remedy is two commands and Novus deliberately
        // does not run them for you: `git add -A` in a repository without a
        // .gitignore commits whatever is lying around, and a tool that refuses
        // to read .env has no business committing one.
        <div className="open__error">
          {repositoryState === "absent"
            ? "This directory is not a Git repository. A fork is a Git worktree cut from a commit, so forking needs one."
            : "This repository has no commits yet, so there is no base to fork from."}
          {" "}
          Run <code>git init &amp;&amp; git add -A &amp;&amp; git commit -m "initial"</code> in it
          — check what <code>git add -A</code> would stage first, since Novus will
          not commit on your behalf.
        </div>
      ) : null}

      {state.error ? <div className="open__error">{state.error}</div> : null}

      <div className="compare-screen__scroll">
        {state.comparison ? (
          <CompareView
            comparison={state.comparison}
            footers={Object.fromEntries(
              state.comparison.attempts.map((attempt) => [
                attempt.runId,
                state.decision?.runId === attempt.runId ? (
                  <span className="compare__chosen">
                    {state.decision.outcome.applied ? "Chosen · applied" : "Chosen"}
                  </span>
                ) : (
                  <button
                    className="button"
                    type="button"
                    disabled={state.choosing}
                    onClick={() => state.choose(attempt.runId)}
                  >
                    {state.choosing ? "Choosing…" : "Choose this attempt"}
                  </button>
                ),
              ]),
            )}
          />
        ) : null}

        {state.decision ? (
          // Says exactly what the apply step did, since choosing and applying
          // are the same permissioned action here and a screen that implied
          // one without the other would be claiming an authority it does not
          // have.
          <p
            className={
              state.decision.outcome.applied
                ? "compare-screen__note"
                : "compare-screen__note compare-screen__note--error"
            }
          >
            {state.decision.outcome.applied ? (
              <>
                Applied to the working tree:{" "}
                {state.decision.outcome.files.join(", ") || "no files"}.
              </>
            ) : (
              <>
                Recorded, but not applied — {state.decision.outcome.reason}
                {state.decision.outcome.conflicts.length > 0 ? (
                  <ul className="compare-screen__conflicts">
                    {state.decision.outcome.conflicts.map((conflict) => (
                      <li key={conflict.path}>
                        <code>{conflict.path}</code>: {conflict.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
};
