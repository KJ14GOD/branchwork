import type { Person } from "../../workstreams.ts";

/**
 * What this mission is, how it is going, and who is here.
 *
 * The header this replaces led with the repository path in mono, put the
 * mission goal below it in the same weight as everything else, and carried the
 * lifecycle, the model, the permissions, the token count and the control pill
 * across one row. Five missions in one repository all opened looking identical,
 * because the strongest text on the screen was the one fact they shared.
 *
 * The goal is now the largest text on the screen and the only display-sized
 * type in the shell. Everything else on the row is context for it.
 */

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";

/**
 * Presence, compactly. Faces and one control fact — not a pill saying "You in
 * control" beside a separate avatar saying the same thing twice, which is what
 * the old header did.
 */
export const Presence = ({
  people,
  onInvite,
}: {
  people: readonly Person[];
  onInvite: () => void;
}) => {
  const holder = people.find((person) => person.inControl);

  return (
    <div className="presence">
      <div className="presence__faces">
        {people.slice(0, 4).map((person) => (
          <span
            className={
              person.inControl
                ? "presence__face presence__face--control"
                : person.connected
                  ? "presence__face"
                  : "presence__face presence__face--away"
            }
            key={person.id}
            title={`${person.name}${person.inControl ? " · in control" : ""}`}
          >
            {initials(person.name)}
          </span>
        ))}
        {people.length > 4 ? (
          <span className="presence__face presence__face--more">
            +{people.length - 4}
          </span>
        ) : null}
      </div>

      {holder ? (
        <span className="presence__holder">
          {holder.name === "You" ? "You have control" : `${holder.name} has control`}
        </span>
      ) : null}

      <button className="button button--quiet" type="button" onClick={onInvite}>
        Invite
      </button>
    </div>
  );
};

export const MissionHeader = ({
  goal,
  state,
  repository,
  branch,
  people,
  onInvite,
  action,
}: {
  goal: string;
  /** Human-readable, e.g. "Claude is working". Never a status enum. */
  state: string;
  repository: string;
  branch: string | null;
  people: readonly Person[];
  onInvite: () => void;
  /** The single primary action for this mission state, when there is one. */
  action?: { label: string; onClick: () => void } | undefined;
}) => (
  <header className="mission">
    <div className="mission__main">
      <h1 className="mission__goal" title={goal}>
        {goal}
      </h1>

      <p className="mission__where">
        {/*
          State in words first, because it is what changes. Repository and
          branch sit after it as the address, in mono because they are
          literals somebody may need to type somewhere else.
        */}
        <span className="mission__state">{state}</span>
        <span className="mission__dot" aria-hidden="true" />
        <code className="mission__repo">{repository}</code>
        {branch ? (
          <>
            <span className="mission__dot" aria-hidden="true" />
            <code className="mission__branch">{branch}</code>
          </>
        ) : null}
      </p>
    </div>

    <div className="mission__side">
      <Presence people={people} onInvite={onInvite} />
      {action ? (
        <button
          className="button button--primary"
          type="button"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  </header>
);
