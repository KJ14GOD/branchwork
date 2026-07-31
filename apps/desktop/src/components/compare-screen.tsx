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
/**
 * A short name for an approach, from the thing that makes it different.
 *
 * Asking for a label *and* a goal made a person invent an identifier before
 * they had thought about the work, and the label they invented was almost
 * always a worse restatement of the goal they were about to type. The
 * differentiating instruction is the only thing genuinely required, so the
 * name is derived from it and stays editable afterward.
 */
const labelFor = (differentiator: string): string => {
  const words = differentiator
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 2 &&
        !["the", "and", "for", "with", "that", "this", "try", "use"].includes(
          word,
        ),
    )
    .slice(0, 3);

  return words.length > 0 ? words.join("-") : "approach";
};

export const CompareScreen = ({
  state,
  repositoryState,
  onClose,
}: {
  state: ComparisonState;
  repositoryState: RepositoryState;
  onClose: () => void;
}) => {
  const [intent, setIntent] = useState("");
  const [forking, setForking] = useState(false);

  const count = state.comparison?.attempts.length ?? 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const differentiator = intent.trim();

    if (differentiator === "") {
      return;
    }

    setForking(true);

    try {
      await state.fork(labelFor(differentiator), differentiator);
      setIntent("");
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="compare-screen">
      <header className="compare-screen__bar">
        <div className="compare-screen__heading">
          <span className="compare-screen__title">Approaches</span>
          <span className="compare-screen__subtitle">
            {count === 0
              ? "Every approach starts from the same recorded checkpoint and runs in its own worktree, so they cannot disturb each other."
              : `${count} approach${count === 1 ? "" : "es"} · choose one on the evidence, not the summary`}
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
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder="What should this approach do differently? — e.g. preserve backward compatibility"
        />
        <button
          className="button button--primary"
          type="submit"
          disabled={forking || intent.trim() === ""}
        >
          {forking ? "Starting…" : "Try another approach"}
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
                    {state.choosing ? "Choosing…" : "Choose this approach"}
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
