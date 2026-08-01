import { useState } from "react";

import type { RepositoryState } from "@novus/contracts/protocol";

/**
 * A repository is open and nobody has asked for anything yet.
 *
 * This screen used to render the entire application against no data: a
 * five-stage lifecycle with nothing in it, an explanation of Approaches for a
 * mission with none, Control and Participants for a room with one person,
 * Required checks with nothing to check, Changed files with nothing changed,
 * and a composer the size of a panel. Somebody opening a repository met every
 * region Novus has before doing anything, and the honest read of that screen
 * was "this is complicated" rather than "ask it something".
 *
 * So there is one question on it. Everything a person needs to answer that
 * question is within the composer; everything else — teammates, more agents —
 * is named as available later rather than shown as an empty region now.
 */
export const EmptyMission = ({
  repository,
  branch,
  repositoryState,
  allowWrites,
  busy,
  error,
  onStart,
  onInvite,
}: {
  repository: string;
  branch: string | null;
  repositoryState: RepositoryState;
  /**
   * Stated, not offered. Permission is fixed when the repository is opened —
   * the worker's approval gate reads the session, not the turn — so a checkbox
   * here would be a control that changes nothing, which is worse than no
   * control at all.
   */
  allowWrites: boolean;
  busy: boolean;
  /**
   * Why the last attempt to start did not start.
   *
   * Shown here rather than only in the window's footer strip. A mission that
   * fails to begin leaves this screen exactly as it was — same question, same
   * text still in the field — so a message forty lines below the button reads
   * as "nothing happened" rather than as "this failed, and here is why".
   */
  error: string | null;
  onStart: (goal: string) => void;
  onInvite: () => void;
}) => {
  const [goal, setGoal] = useState("");
  const ready = goal.trim().length > 0 && !busy;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (ready) {
      onStart(goal.trim());
    }
  };

  return (
    <div className="start">
      <div className="start__canvas">
        <h1 className="start__question">What are we building?</h1>
        <p className="start__lede">
          Describe the outcome. Novus will organise the work and keep the
          evidence together.
        </p>

        {/*
          Repository, branch and readiness on one quiet line. They answer
          "where am I" without becoming the headline — the old header led with
          a filesystem path, so five missions in one repository opened
          identically.
        */}
        <div className="start__where">
          <span className="start__repo">{repository}</span>
          {branch ? (
            <>
              <span className="start__dot" aria-hidden="true" />
              <span className="start__branch">{branch}</span>
            </>
          ) : null}
          <span className="start__dot" aria-hidden="true" />
          <span
            className={
              repositoryState === "ready"
                ? "start__ready"
                : "start__ready start__ready--warn"
            }
          >
            <span className="start__ready-dot" aria-hidden="true" />
            {repositoryState === "ready"
              ? "Ready"
              : repositoryState === "absent"
                ? "Not a Git repository"
                : "No commits yet"}
          </span>
        </div>

        <form className="start__composer" onSubmit={submit}>
          <textarea
            className="start__input"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Migrate authentication from session cookies to scoped tokens…"
            rows={3}
            autoFocus
            aria-label="Describe the mission"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
          />

          <div className="start__controls">
            {/*
              One fact about what the agent may do, and nothing else. Model
              routing, redaction, ports and budgets are all real and none of
              them belong in front of somebody who has not described the work
              yet — they are a keystroke away in the palette.
            */}
            <span className="start__control start__control--static">
              {allowWrites ? "Can write to the repository" : "Read-only"}
            </span>

            <span className="start__spacer" />

            <button
              className="button button--primary button--large"
              type="submit"
              disabled={!ready}
            >
              {busy ? "Starting…" : "Start mission"}
            </button>
          </div>
        </form>

        {error ? (
          <p className="start__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="start__later">
          {/*
            Named, not rendered. A room for several people and several agents
            is the point of the product, and an empty Participants panel says
            that worse than one sentence does.
          */}
          <button className="start__quiet" type="button" onClick={onInvite}>
            Invite a teammate
          </button>
          <span className="start__quiet start__quiet--static">
            Add another agent once the mission is running
          </span>
        </div>
      </div>
    </div>
  );
};
