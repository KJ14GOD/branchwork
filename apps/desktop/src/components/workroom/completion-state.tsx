import { useState } from "react";

import type { MissionCompletion } from "../../mission-completion.ts";

/**
 * A mission somebody declared over.
 *
 * The product had no ending that was not a decision. A mission with one
 * workstream and nothing to choose between had to invent a comparison in order
 * to close, which is the fake-decision-as-only-exit shape `mission.completed`
 * was added to remove — so this screen states an outcome and refuses to dress
 * it as a verdict on the work.
 *
 * Three facts, in this order, because that is the order they outrank each other
 * in: what the team decided the work was worth, what the evidence actually said
 * at that moment, and what it touched. The second is frozen onto the event
 * rather than recomputed here — re-deriving it would read the repository as it
 * stands now, and a mission closed unverified would quietly start claiming it
 * was verified the next time anybody ran the suite for an unrelated reason.
 *
 * Completion is not verification. An abandoned mission whose tests were green
 * and a resolved mission that nothing ever checked are both ordinary, and this
 * screen has to be able to say either without the outcome tinting the evidence.
 */

const VERIFICATION: Record<
  MissionCompletion["verification"],
  { className: string; glyph: string | null; text: string }
> = {
  verified: {
    className: "finished__proof finished__proof--pass",
    glyph: "✓",
    text: "Checks ran against these changes and passed",
  },
  failing: {
    className: "finished__proof finished__proof--fail",
    glyph: "✕",
    text: "Checks ran against these changes and did not pass",
  },
  // No glyph, and neither colour. An absence of evidence is not a result, and
  // a tick or a cross here would both be claims nobody measured.
  unverified: {
    className: "finished__proof finished__proof--unknown",
    glyph: null,
    text: "Nothing verified these changes before the mission was closed",
  },
};

const when = (iso: string): string => {
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

export const CompletionState = ({
  completion,
  who,
  onReopen,
}: {
  completion: MissionCompletion;
  /** The person who called it, named rather than identified by id. */
  who: string;
  onReopen: (reason: string) => void;
}) => {
  const proof = VERIFICATION[completion.verification];
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  // The same floor the route enforces, checked here so the button is simply
  // not available yet rather than available and then refused.
  const reasonReady = reason.trim().length >= 12;

  return (
    <div className="finished">
      <h2 className="finished__title">
        {completion.outcome === "resolved"
          ? "This mission is resolved"
          : "This mission was abandoned"}
      </h2>

      {/* The team's own words, at reading weight. Not a caption on a status. */}
      <p className="finished__summary">{completion.summary}</p>

      <p className={proof.className}>
        {proof.glyph ? (
          <span className="finished__glyph" aria-hidden="true">
            {proof.glyph}
          </span>
        ) : null}
        {proof.text}
      </p>

      <p className="finished__meta">
        {completion.filesChanged} file
        {completion.filesChanged === 1 ? "" : "s"} changed · closed by {who} ·{" "}
        {when(completion.completedAt)}
      </p>

      {/*
        Deliberately a quiet button. Closing a mission is not a trapdoor and
        reopening it must always be available, but the dominant control on
        every Workroom screen is the composer's Send — a second filled button
        here would spend the one inversion this app has.
      */}
      {reopening ? (
        <form
          className="finished__reopen"
          onSubmit={(event) => {
            event.preventDefault();

            if (reasonReady) {
              onReopen(reason.trim());
            }
          }}
        >
          <label className="finished__label" htmlFor="reopen-reason">
            Why is this not finished after all?
          </label>
          <textarea
            id="reopen-reason"
            className="finished__reason"
            value={reason}
            rows={2}
            autoFocus
            placeholder="The fix regressed the refund path."
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="finished__actions">
            {/*
              A plain button, not `--primary`. The composer's Send is the one
              inversion on every Workroom screen, and a second filled control
              here would spend the mechanism that makes it unmistakable — the
              same reason the recovery state's button is quiet.
            */}
            <button className="button" type="submit" disabled={!reasonReady}>
              Reopen mission
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                setReopening(false);
                setReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="button"
          type="button"
          onClick={() => setReopening(true)}
        >
          Reopen mission
        </button>
      )}
    </div>
  );
};
