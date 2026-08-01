import { useState } from "react";

import { Modal } from "../modal.tsx";

/**
 * Declaring a mission over.
 *
 * Two fields, and the second one is the point. A mission that ends with no
 * sentence is a row in a list nobody can read three weeks later, which is why
 * both this form and the route hold the summary to the same floor a decision's
 * rationale is held to.
 *
 * What this form deliberately does NOT collect is the verification. The route
 * computes that from the log and freezes it onto the event, so nobody can
 * declare their own work verified on the way out — the whole reason the field
 * exists is that "we finished" and "it was proven" are different claims, and
 * this is exactly the screen where somebody would be tempted to merge them.
 * The panel below states what the evidence currently says, so the person
 * finishing sees what is about to be recorded about their mission.
 */

export type FinishMissionProps = {
  /** What the log says right now, shown so the ending is not a surprise. */
  verification: "verified" | "failing" | "unverified";
  filesChanged: number;
  onFinish: (
    outcome: "resolved" | "abandoned",
    summary: string,
  ) => Promise<boolean>;
  onClose: () => void;
};

const EVIDENCE: Record<
  FinishMissionProps["verification"],
  { text: string; className: string }
> = {
  verified: {
    text: "Checks ran after the last change and passed.",
    className: "finish__evidence finish__evidence--pass",
  },
  failing: {
    text: "Checks ran and something is failing.",
    className: "finish__evidence finish__evidence--fail",
  },
  unverified: {
    text: "Nothing has verified these changes.",
    className: "finish__evidence finish__evidence--unknown",
  },
};

export const FinishMission = ({
  verification,
  filesChanged,
  onFinish,
  onClose,
}: FinishMissionProps) => {
  const [outcome, setOutcome] = useState<"resolved" | "abandoned">("resolved");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const ready = summary.trim().length >= 12 && !saving;
  const evidence = EVIDENCE[verification];

  return (
    <Modal
      title="Finish this mission"
      onClose={onClose}
      footer={
        <>
          <button className="button button--quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="submit"
            form="finish-mission"
            disabled={!ready}
          >
            {saving ? "Finishing…" : "Finish mission"}
          </button>
        </>
      }
    >
      <form
        id="finish-mission"
        onSubmit={(event) => {
          event.preventDefault();

          if (!ready) {
            return;
          }

          setSaving(true);
          void onFinish(outcome, summary.trim()).then((ok) => {
            setSaving(false);

            if (ok) {
              onClose();
            }
            // On failure the form stays open with what was typed still in it.
            // The error surfaces on the session's own error line; retyping a
            // paragraph because a request 409'd is the kind of small cruelty
            // this app keeps removing.
          });
        }}
      >
        {/*
          Said before the fields, not after. Somebody about to write "shipped
          the fix" should see that nothing verified it while they are still
          deciding what to type.
        */}
        <p className={evidence.className}>{evidence.text}</p>
        <p className="finish__meta">
          {filesChanged} file{filesChanged === 1 ? "" : "s"} changed. This is
          recorded on the mission and does not change afterwards.
        </p>

        <fieldset className="finish__outcome">
          <legend className="finish__label">How did it end?</legend>
          {/*
            Two buttons rather than a dropdown: there are exactly two answers
            and neither is a default worth hiding. Abandoning is not a failure
            state — it is a decision, and a form that made it the awkward
            option would push people into calling dead work resolved.
          */}
          {(["resolved", "abandoned"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={
                outcome === value
                  ? "segment segment--active"
                  : "segment"
              }
              aria-pressed={outcome === value}
              onClick={() => setOutcome(value)}
            >
              {value === "resolved" ? "Resolved" : "Abandoned"}
            </button>
          ))}
        </fieldset>

        <label className="finish__label" htmlFor="finish-summary">
          What happened?
        </label>
        <textarea
          id="finish-summary"
          className="finish__summary"
          value={summary}
          rows={3}
          autoFocus
          placeholder={
            outcome === "resolved"
              ? "The checkout test passes again after the tax rounding fix."
              : "The rounding approach cannot work; starting again from the parser."
          }
          onChange={(event) => setSummary(event.target.value)}
        />
        <p className="finish__hint">
          {summary.trim().length >= 12
            ? "This is what the mission will be remembered by."
            : "A sentence somebody who was not here can read."}
        </p>
      </form>
    </Modal>
  );
};
