import { useState } from "react";

import type { RepositoryState } from "@novus/contracts/protocol";
import { CompareView } from "@novus/ui";

import type { ComparisonState } from "../use-comparison.ts";

/**
 * The host's side of comparing two attempts.
 *
 * `CompareView` draws the evidence and is shared with the guest. Everything
 * here is the part that acts — starting a fork, and settling on one attempt —
 * which is why it lives in the desktop app. A guest importing the view gets the
 * same columns and no buttons, so read-only is a property of what it can reach
 * rather than a rule somebody has to remember not to break.
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
        <span className="compare-screen__title">Attempts</span>
        <span className="titlebar__spacer" />
        <button
          className="open__browse"
          type="button"
          onClick={state.refresh}
          disabled={state.loading}
        >
          {state.loading ? "Reading…" : "Refresh"}
        </button>
        <button className="open__browse" type="button" onClick={onClose}>
          Back to the timeline
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
        <button className="open__submit" type="submit" disabled={forking}>
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

      {state.comparison ? (
        <CompareView
          comparison={state.comparison}
          footers={Object.fromEntries(
            state.comparison.attempts.map((attempt) => [
              attempt.runId,
              state.chosen === attempt.runId ? (
                <span className="compare__chosen">Chosen</span>
              ) : (
                <button
                  className="open__browse"
                  type="button"
                  onClick={() => state.choose(attempt.runId)}
                >
                  Choose this attempt
                </button>
              ),
            ]),
          )}
        />
      ) : null}

      {state.chosen ? (
        // Says what choosing did and did not do. V1 makes applying a patch a
        // separate permissioned step, so a screen that implied the merge had
        // happened would be claiming an authority it does not have.
        <p className="compare-screen__note">
          Recorded for this window. Nothing has been merged — applying a
          selected attempt is a separate step, and it needs approval.
        </p>
      ) : null}
    </div>
  );
};
