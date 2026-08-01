import type { Person, Workstream } from "../../workstreams.ts";
import { workstreamStatus } from "../../workstreams.ts";

/**
 * Who is in the room, and what each of them is doing.
 *
 * This replaces a rail that led with a five-stage lifecycle ladder and a
 * column of counters. Brief, Decision and Receipt do not need permanent
 * vertical navigation — they are states a mission passes through, and the
 * header already says which one it is in. What earns permanent space is the
 * thing the product is actually about: several agents and several people
 * working one change, and which of them is stuck.
 *
 * Each workstream carries an identity colour. It says *whose work this is* and
 * nothing else — the colours are equally saturated and none of them is green,
 * because a colour that read as a verdict would be ranking the approaches on
 * the one surface that must not.
 */

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";

export const WorkstreamRow = ({
  stream,
  selected,
  onSelect,
}: {
  stream: Workstream;
  selected: boolean;
  onSelect: () => void;
}) => (
  <button
    className={selected ? "wsrow wsrow--selected" : "wsrow"}
    type="button"
    onClick={onSelect}
    style={{ ["--ws" as string]: `var(${stream.signal})` }}
    aria-pressed={selected}
  >
    <span className="wsrow__mark" aria-hidden="true" />
    <span className="wsrow__avatar" aria-hidden="true">
      {initials(stream.name)}
    </span>
    <span className="wsrow__body">
      <span className="wsrow__name">{stream.name}</span>
      <span className="wsrow__model">{stream.model}</span>
      <span className="wsrow__assignment">{stream.assignment}</span>
      <span className={`wsrow__state wsrow__state--${stream.state}`}>
        {/*
          A dot and a word. State is never carried by colour alone — the word
          is the accessible answer and the dot is the glanceable one.
        */}
        <span className="wsrow__dot" aria-hidden="true" />
        {workstreamStatus(stream)}
      </span>
    </span>
  </button>
);

export const PersonRow = ({ person }: { person: Person }) => (
  <div className="wsrow wsrow--person">
    <span className="wsrow__mark" aria-hidden="true" />
    <span className="wsrow__avatar wsrow__avatar--human" aria-hidden="true">
      {initials(person.name)}
    </span>
    <span className="wsrow__body">
      <span className="wsrow__name">{person.name}</span>
      <span className="wsrow__model">
        {person.role[0]!.toUpperCase() + person.role.slice(1)}
      </span>
      {person.inControl ? (
        <span className="wsrow__state wsrow__state--control">
          <span className="wsrow__dot" aria-hidden="true" />
          In control
        </span>
      ) : person.connected ? null : (
        <span className="wsrow__state">Not connected</span>
      )}
    </span>
  </div>
);

export const WorkstreamRail = ({
  workstreams,
  people,
  selected,
  onSelect,
  onAdd,
}: {
  workstreams: readonly Workstream[];
  people: readonly Person[];
  selected: string | null;
  onSelect: (runId: string) => void;
  onAdd: () => void;
}) => (
  <aside className="rail rail--workroom">
    <div className="rail__scroll">
      <h2 className="rail__eyebrow">Workroom</h2>

      {workstreams.map((stream) => (
        <WorkstreamRow
          key={stream.runId}
          stream={stream}
          selected={selected === stream.runId}
          onSelect={() => onSelect(stream.runId)}
        />
      ))}

      {/*
        People sit with the agents rather than in a section of their own. In a
        room where an agent and a teammate are both participants that can hold
        control and receive direction, separating them into two lists asks the
        reader to merge them again.
      */}
      {people.map((person) => (
        <PersonRow key={person.id} person={person} />
      ))}
    </div>

    <button className="rail__add" type="button" onClick={onAdd}>
      <span className="rail__add-glyph" aria-hidden="true">
        +
      </span>
      Add workstream
    </button>
  </aside>
);
