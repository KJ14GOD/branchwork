import {
  ControlPanel,
  PendingDirection,
  type ControlProps,
} from "../control-panel.tsx";
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

/**
 * Pause, resume and cancel, while something is actually running.
 *
 * Kept from the shell this replaces rather than dropped with it. A controller
 * who cannot stop a run they can see is not a controller, and burying the only
 * way to halt a mission in a command palette would be exactly the "hidden, not
 * restrained" failure the composer's own history records.
 */
export type RunControl = {
  paused: boolean;
  pausing: boolean;
  cancelling: boolean;
  onPause: () => void;
  onCancel: () => void;
};

/**
 * What the mission has cost and how long it has been going.
 *
 * Telemetry: read, never acted on, and pinned to the foot of the rail for that
 * reason. Spend earns its place — it was computed on every model call, stored on
 * every receipt, and shown nowhere, so the person whose money it is had to read
 * a log line to find out. Counts of events, tool calls and patches did not earn
 * theirs and are not here; they are the "passive tool-call counts in the prime
 * part of the rail" STEERING refuses, and the raw log still has them.
 */
export type RailMeter = {
  spend: string;
  spendTitle: string;
  elapsed: string;
};

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
      {/*
        Which program, then which model. The rail said only the model, so a
        workstream running real Claude Code and one running Novus's own loop
        against a Claude model looked the same — while differing in who
        enforces permissions and whose account pays.
      */}
      <span className="wsrow__harness">{stream.harness}</span>
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
  control,
  runControl,
  meter,
}: {
  workstreams: readonly Workstream[];
  people: readonly Person[];
  selected: string | null;
  onSelect: (runId: string) => void;
  onAdd: () => void;
  runControl?: RunControl | undefined;
  meter: RailMeter;
  /**
   * The authority lifecycle, on the screen a host actually looks at.
   *
   * It used to render only in a shell reachable by switching views, so an
   * incoming handoff offer showed a banner reading "Waiting on you" with
   * nothing on screen to accept, decline or request with. Nothing about the
   * component changed — every affordance is still rendered only for the
   * participant who may take it, and it still renders nothing at all in a
   * session with one person in it.
   */
  control: ControlProps;
}) => (
  <aside className="rail rail--workroom">
    <div className="rail__scroll">
      <h2 className="rail__eyebrow">Workroom</h2>

      {/*
        Above the room, because "who may act" is the thing a person needs
        before "who is here", and because an offer expecting an answer must not
        sit below a scroll. Absent — not empty — whenever there is nothing to
        negotiate, which is most missions.
      */}
      <ControlPanel {...control} />

      <PendingDirection pending={control.authority.pendingDirection} />

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

      {/*
        Only while something is running. Two quiet buttons, never a primary
        one: stopping a run is a correction, and the dominant control on this
        screen belongs to whatever the mission is actually waiting for.
      */}
      {runControl ? (
        <div className="rail__section rail__section--run">
          <div className="eyebrow">Run control</div>
          <div className="rail__buttons">
            <button
              className="button"
              type="button"
              disabled={runControl.pausing}
              onClick={runControl.onPause}
              title={
                runControl.paused
                  ? "Continue this run where it left off"
                  : "Suspend this run at its next safe boundary, to resume later"
              }
            >
              {runControl.pausing
                ? "Pausing…"
                : runControl.paused
                  ? "Resume"
                  : "Pause"}
            </button>
            <button
              className="button"
              type="button"
              disabled={runControl.cancelling}
              onClick={runControl.onCancel}
              title="Stop this run at its next safe boundary"
            >
              {runControl.cancelling ? "Stopping…" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
    </div>

    <div className="rail__meter">
      <span className="rail__meter-item" title={meter.spendTitle}>
        {meter.spend}
      </span>
      <span className="rail__meter-item" title="Since this mission opened">
        {meter.elapsed}
      </span>
    </div>

    <button className="rail__add" type="button" onClick={onAdd}>
      <span className="rail__add-glyph" aria-hidden="true">
        +
      </span>
      Add workstream
    </button>
  </aside>
);
