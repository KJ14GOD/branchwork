import { useState } from "react";

import type { DecisionKind, RepositoryState } from "@novus/contracts/protocol";
import { CompareView } from "@novus/ui";

import { authorization } from "../access.ts";

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
  endpoint,
  sessionId,
  onClose,
}: {
  state: ComparisonState;
  repositoryState: RepositoryState;
  /** Where the worker is, for the receipt export. */
  endpoint: string;
  sessionId: string | null;
  onClose: () => void;
}) => {
  const [intent, setIntent] = useState("");
  const [forking, setForking] = useState(false);
  // Which decision is being written, if any. Held here rather than per-card so
  // that two half-written rationales cannot exist at once — a decision is one
  // act, and the form is the moment of making it.
  const [deciding, setDeciding] = useState<{
    runId: string;
    kind: DecisionKind;
  } | null>(null);
  const [rationale, setRationale] = useState("");

  const [exporting, setExporting] = useState(false);

  const decidingAttempt = state.comparison?.attempts.find(
    (attempt) => attempt.runId === deciding?.runId,
  );

  /**
   * Saves the mission's receipt as Markdown.
   *
   * Fetched rather than assembled here: the worker derives it from the same
   * projection the screens read, so the file and the screen cannot drift. Sent
   * through a blob and an anchor rather than a new IPC channel — the renderer
   * already has the bytes, and adding a filesystem capability to the preload
   * bridge for a download would widen a boundary that exists to be narrow.
   */
  const exportReceipt = async () => {
    if (!sessionId) {
      return;
    }

    setExporting(true);

    try {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/receipt`,
        { headers: await authorization() },
      );

      if (!response.ok) {
        return;
      }

      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `novus-${sessionId.slice(0, 8)}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };
  // The floor the contract sets. Enforced here too, because the boundary
  // refusing a decision is a 400 the person cannot act on, while a disabled
  // button next to the box they are typing in is an answer they can.
  const rationaleReady = rationale.trim().length >= 12;

  const count = state.comparison?.attempts.length ?? 0;
  // One approach is the current work with nothing beside it yet — a real state
  // with something on the screen, not the empty screen it used to be.
  const alternatives = count === 0 ? 0 : count - 1;

  const attempts = state.comparison?.attempts ?? [];
  const alternativeList = attempts.filter((attempt) => !attempt.baseline);
  const firstAlternative = alternativeList[0];
  const settled = alternativeList.every(
    (attempt) => attempt.status !== "running" && attempt.status !== "paused",
  );
  /**
   * Whether there is anything here a person could actually decide between.
   *
   * This screen compares *competing implementations* — approach A keeps the
   * existing auth system, approach B replaces it, and only one gets adopted.
   * That is a real and important surface, and it is also a rare one. It is not
   * the same thing as several workstreams doing complementary work, which is
   * combined rather than chosen between.
   *
   * When every approach changed nothing and ran nothing, none of that applies.
   * There is no engineering decision, because nothing was produced to decide
   * about — and rendering a checkpoint graph, two approach cards, a decision
   * workflow and a receipt action over an empty set asks somebody to judge
   * work that does not exist. Seen on a real mission where both approaches
   * failed to touch a file and the screen still said "Decision required".
   */
  const produced = attempts.some(
    (attempt) => attempt.filesChanged.length > 0 || attempt.testsRun > 0,
  );

  /** A decision is genuinely waiting when alternatives exist and none is moving. */
  const awaiting =
    state.decision === null &&
    alternativeList.length > 0 &&
    settled &&
    produced;

  /**
   * Nothing was produced, and every approach has stopped. Not a decision — a
   * recovery.
   */
  const barren =
    state.decision === null && alternativeList.length > 0 && settled && !produced;

  /**
   * What this screen is, said in two lines.
   *
   * The reader should get "two approaches ran, neither is verified, I have to
   * decide" without reading a card. Verification leads the detail because it
   * is the thing most likely to be assumed and least likely to be true — an
   * approach that finished having tested nothing is the state every other
   * surface renders as success.
   */
  /**
   * Counted over every approach on the screen, baseline included.
   *
   * These used to count only the alternatives, which produced a headline
   * reading "1 approaches ran" directly beside a spine reading "2 approaches"
   * and two cards — the screen's most important sentence disagreeing with the
   * screen. The baseline has a card, carries evidence, and "Keep the current
   * work" is a real decision about it, so it is an approach here.
   */
  const unverified = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.green === null,
  ).length;
  const failed = attempts.filter(
    (attempt) => attempt.status === "failed",
  ).length;
  const ran = attempts.length;
  // Said once. Every branch below had its own singular/plural expression and
  // two of them did not have one at all.
  const approachCount = ran === 1 ? "One approach" : `${ran} approaches`;

  const headline = barren
    ? {
        state: "Nothing to compare",
        detail:
          "Neither approach produced a usable result. Revise the instruction and try again, or go back to the mission.",
      }
    : awaiting
    ? {
        state: "Decision required",
        detail:
          failed === ran && failed > 0
            ? `${ran === 1 ? "The approach" : `All ${ran} approaches`} failed. Read why, then decide what happens next.`
            : unverified === ran
              ? `${approachCount} finished without running any tests. Nothing here is verified.`
              : unverified > 0
                ? `${approachCount} ran · ${unverified} of them verified nothing.`
                : `${approachCount} ran. Compare the evidence, not the summaries.`,
      }
    : state.decision !== null
      ? {
          state:
            state.decision.kind === "revision"
              ? "Revision requested"
              : state.decision.kind === "exploration"
                ? "Still exploring"
                : state.decision.target === "baseline"
                  ? "Kept the current work"
                  : "Decision recorded",
          detail:
            state.decision.outcome.applied === true
              ? "Applied to the working tree."
              : state.decision.outcome.applied === "unnecessary"
                ? "Already in the working tree. Nothing needed writing."
                : "Recorded. Nothing was written.",
        }
      : alternativeList.some((attempt) => attempt.status === "running")
        ? {
            state: "Approaches running",
            detail: "Nothing to decide until they finish.",
          }
        : count === 0
          ? {
              state: "Nothing has run yet",
              detail:
                "Ask for something in the composer below, then branch it to compare approaches.",
            }
          : {
              state: "One approach",
              detail:
                "The current work, with no alternative beside it yet. Another one starts from the same recorded checkpoint.",
            };

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
      {/*
        The state of the decision, in the first thing the eye reaches.
        Everything that is not the decision — refreshing, exporting, starting
        another approach — is a utility and reads like one. There is one
        dominant action on this screen at a time.
      */}
      <header
        className={
          awaiting
            ? "decision-head decision-head--awaiting"
            : "decision-head"
        }
      >
        <div className="decision-head__main">
          <span className="decision-head__state">{headline.state}</span>
          <span className="decision-head__detail">{headline.detail}</span>
        </div>


        <div className="decision-head__utilities">
          <button
            className="button button--quiet"
            type="button"
            onClick={state.refresh}
            disabled={state.loading}
          >
            {state.loading ? "Reading…" : "Refresh"}
          </button>
          {/*
            The evidence outlives the window. Everything on this screen used to
            vanish with the tab, leaving a diff in somebody's tree with no
            record of what it was chosen over or why.
          */}
          <button
            className="button button--quiet"
            type="button"
            disabled={exporting || count === 0}
            onClick={() => void exportReceipt()}
          >
            {exporting ? "Exporting…" : "Export receipt"}
          </button>
        </div>
      </header>

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
        {/*
          Nothing was produced, so nothing below it is worth drawing: a
          checkpoint graph over two empty approaches, a decision workflow with
          no evidence, and a receipt action for work that did not happen. What
          a person needs here is the short list of ways forward.
        */}
        {barren ? (
          <div className="recovery">
            <h2 className="recovery__title">
              Neither approach produced a usable result
            </h2>
            <p className="recovery__lede">
              No files changed and no tests ran, so there is no engineering
              decision to make here yet.
            </p>
            <div className="recovery__ways">
              <button className="button button--primary" type="button" onClick={onClose}>
                Back to the mission
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  onClose();
                }}
              >
                Revise the instruction
              </button>
            </div>
          </div>
        ) : state.comparison ? (
          <CompareView
            comparison={state.comparison}
            footers={Object.fromEntries(
              state.comparison.attempts.map((attempt) => [
                attempt.runId,
                state.decision?.runId === attempt.runId ? (
                  <span className="compare__chosen">
                    {state.decision.outcome.applied === true
                      ? "Adopted · applied"
                      : state.decision.kind === "revision"
                        ? "Revision requested"
                        : state.decision.kind === "exploration"
                          ? "Exploring further"
                          : state.decision.outcome.applied === "unnecessary"
                            ? "Kept · already in the tree"
                            : "Adopted · not applied"}
                  </span>
                ) : attempt.baseline ? (
                  // A button, and the same button the alternatives get. This
                  // said "keeping it needs no decision", which was true of the
                  // plumbing — /decision resolved every run through the
                  // worktree manager and the baseline has no worktree — and
                  // false of the product. Deciding the current work is the
                  // right answer is a decision somebody makes, and a mission
                  // whose history cannot say who made it or why has lost the
                  // only part worth keeping. Nothing is written when it is
                  // taken; the work is already here.
                  // Absent while the run it would settle is still going.
                  // Recording "keep the current work" on a run that has not
                  // finished settles a comparison against evidence that is
                  // still moving, and the spine then reads "Receipt complete"
                  // for a run mid-flight — a claim the screen cannot support.
                  attempt.status === "running" || attempt.status === "paused" ? (
                    <span className="compare__foot-note">
                      Still working. There is nothing settled to keep yet.
                    </span>
                  ) : (
                    <button
                      className="button"
                      type="button"
                      disabled={state.choosing}
                      onClick={() => setDeciding({ runId: attempt.runId, kind: "adopt" })}
                    >
                      Keep the current work
                    </button>
                  )
                ) : (
                  <button
                    className="button"
                    type="button"
                    disabled={state.choosing}
                    onClick={() => setDeciding({ runId: attempt.runId, kind: "adopt" })}
                  >
                    Adopt this approach
                  </button>
                ),
              ]),
            )}
          />
        ) : null}

        {deciding ? (
          <form
            className="decision"
            onSubmit={(event) => {
              event.preventDefault();

              if (!rationaleReady) {
                return;
              }

              void state
                .choose(deciding.runId, deciding.kind, rationale.trim())
                .then(() => {
                  setDeciding(null);
                  setRationale("");
                });
            }}
          >
            <div className="decision__head">
              <span className="decision__title">
                {deciding.kind === "adopt"
                  ? decidingAttempt?.baseline
                    ? "Keep the current work"
                    : `Adopt ${decidingAttempt?.label ?? "this approach"}`
                  : deciding.kind === "revision"
                    ? `Request a revision of ${decidingAttempt?.label ?? "this approach"}`
                    : "Keep exploring"}
              </span>
              <span className="decision__note">
                {deciding.kind === "adopt"
                  ? decidingAttempt?.baseline
                    ? // Said plainly rather than dressed up as an apply. The
                      // files are already here; what this records is that a
                      // person looked at the alternatives and chose not to
                      // take one.
                      "Nothing is written — this work is already in the working tree. The alternatives stay on the record as considered and not chosen."
                    : "Its changes are written into the working tree. The other approaches stay on the record."
                  : deciding.kind === "revision"
                    ? "Nothing is written. Your reasoning is the feedback, and it stays on the record."
                    : "Nothing is written and nothing is discarded. This records that neither was enough yet."}
              </span>
            </div>

            {/*
              Required, and the reason is not bureaucracy. The evidence above
              is gone the moment the tab closes; a sentence about why it was
              enough is the only part a teammate can read three weeks later.
            */}
            <textarea
              className="decision__rationale"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              rows={3}
              autoFocus
              placeholder="Why this, what evidence mattered, what risk you are accepting, what is still unresolved"
              aria-label="Why you decided this"
            />

            <div className="decision__actions">
              <span className="decision__count">
                {rationaleReady
                  ? "Recorded in the log, the receipt, and every joined view."
                  : "A sentence, at least — this is the part that outlives the tab."}
              </span>
              <button
                className="button"
                type="button"
                onClick={() => {
                  setDeciding(null);
                  setRationale("");
                }}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={state.choosing || !rationaleReady}
              >
                {state.choosing ? "Recording…" : "Record decision"}
              </button>
            </div>
          </form>
        ) : state.comparison && state.comparison.attempts.length > 1 ? (
          // The two ways a review ends that are not "one of these wins". Both
          // are decisions, both are recorded, and neither writes anything —
          // without them the honest answer is taken outside the product, which
          // is exactly where it stops being reviewable.
          <div className="decision__alternatives">
            <span className="decision__alternatives-label">
              Neither?
            </span>
            <button
              className="button button--quiet"
              type="button"
              onClick={() =>
                setDeciding({
                  runId:
                    state.comparison?.attempts.find((attempt) => !attempt.baseline)
                      ?.runId ?? "",
                  kind: "revision",
                })
              }
            >
              Request a revision
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={() =>
                setDeciding({
                  runId:
                    state.comparison?.attempts.find((attempt) => !attempt.baseline)
                      ?.runId ?? "",
                  kind: "exploration",
                })
              }
            >
              Keep exploring
            </button>
          </div>
        ) : null}


        {state.decision ? (
          // Says exactly what the apply step did, since choosing and applying
          // are the same permissioned action here and a screen that implied
          // one without the other would be claiming an authority it does not
          // have.
          <p
            className={
              // `applied: false` keeps the tone it had — a write that was
              // owed and did not happen. `"unnecessary"` joins `true` on the
              // quiet side: no write was owed, so there is nothing to flag.
              state.decision.outcome.applied === false
                ? "compare-screen__note compare-screen__note--error"
                : "compare-screen__note"
            }
          >
            {state.decision.outcome.applied === true ? (
              <>
                Decision recorded and applied:{" "}
                {state.decision.outcome.files.join(", ") || "no files"}.
              </>
            ) : state.decision.outcome.applied === "unnecessary" ? (
              // Neither an apply nor a refusal. Nothing was written because
              // nothing was owed, and the note says which.
              <>Decision recorded. {state.decision.outcome.reason}</>
            ) : state.decision.kind === "revision" ? (
              <>Revision requested. Nothing was written.</>
            ) : state.decision.kind === "exploration" ? (
              <>Further exploration requested. Nothing was written or discarded.</>
            ) : (
              <>
                {/*
                  Selection and application stay distinct. A conflict means the
                  decision stands and the write did not happen — calling that a
                  failed decision would tell somebody their judgement was wrong
                  when only the mechanics were.
                */}
                {state.decision.outcome.conflicts.length > 0
                  ? "Decision recorded, application blocked by conflicts — "
                  : "Decision recorded, awaiting application — "}
                {state.decision.outcome.reason}
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
