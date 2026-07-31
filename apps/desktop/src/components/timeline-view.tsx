import { useMemo } from "react";

import type { SessionEvent } from "@novus/contracts";

import { EventRow } from "./host-event-row.tsx";

/**
 * How the timeline groups mechanical events so it reads like an agent
 * explaining itself rather than a flat technical log — the thing every tool
 * researched for this (Zed's agent panel most explicitly) does the same way:
 * the model's own words never collapse, tool activity does, and it collapses
 * by kind rather than by flattening a run into one undifferentiated list.
 *
 * "Mechanical" is every event a tool call produces on its way through the
 * approval boundary. Everything else — the run starting or ending, direction
 * arriving, a checkpoint, a decision, and (since the harness stopped
 * discarding it) the model's own narration attached to tool.requested — is
 * narrative and never grouped.
 */
const MECHANICAL: ReadonlySet<SessionEvent["type"]> = new Set([
  "tool.requested",
  "tool.approval_requested",
  "tool.approved",
  "tool.denied",
  "tool.completed",
  "tool.failed",
]);

export type TimelineGroup = { kind: "group"; key: number; events: SessionEvent[] };
export type TimelineItem = { kind: "event"; event: SessionEvent } | TimelineGroup;

/**
 * Runs of consecutive mechanical events become one group; everything else
 * passes through unchanged. A group's key is its first event's sequence —
 * stable across re-renders and unique, since sequence numbers never repeat
 * within a session.
 */
/**
 * Every `session.created` after the first, dropped.
 *
 * Opening a session appends one, and so does every resume — that is what
 * makes a session findable again, so the log is right to carry them all. The
 * timeline is not: reopening a session four times drew four identical rows
 * above the actual work, saying nothing the header does not already say. The
 * events stay in the log, in raw payloads, and in replay; only the repeats
 * stop being drawn.
 */
const withoutRepeatedOpens = (
  events: readonly SessionEvent[],
): SessionEvent[] => {
  let seenOpen = false;

  return events.filter((event) => {
    if (event.type !== "session.created") {
      return true;
    }

    if (seenOpen) {
      return false;
    }

    seenOpen = true;

    return true;
  });
};

export const buildTimelineItems = (events: readonly SessionEvent[]): TimelineItem[] => {
  const items: TimelineItem[] = [];
  let current: SessionEvent[] = [];

  const flush = () => {
    if (current.length > 0) {
      items.push({ kind: "group", key: current[0]!.sequence, events: current });
      current = [];
    }
  };

  for (const event of events) {
    if (MECHANICAL.has(event.type)) {
      current.push(event);
    } else {
      flush();
      items.push({ kind: "event", event });
    }
  }

  flush();

  return items;
};

/** Which group (by key) a sequence number lives in, or null outside any group. */
export const groupKeyFor = (
  events: readonly SessionEvent[],
  sequence: number,
): number | null => {
  for (const item of buildTimelineItems(events)) {
    if (item.kind === "group" && item.events.some((event) => event.sequence === sequence)) {
      return item.key;
    }
  }

  return null;
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What a run of tool calls actually amounted to, in a person's words.
 *
 * This line used to read `read_file ×3, apply_patch` — the contract's
 * vocabulary, printed verbatim. It is accurate and it tells you nothing: tool
 * names are how the harness talks to itself, and reading a mission's history
 * in them means reconstructing the story from the machinery every time.
 *
 * STEERING asks for the default view to tell the mission story and for the
 * machinery to live under Technical details, which is exactly what the fold
 * below now is. Nothing is hidden — every call is one click away, and the
 * expanded view is unchanged.
 *
 * Deliberately says what happened rather than whether it went well. "Ran the
 * tests" is a milestone; "tests passed" is a verdict, and verdicts belong in
 * the evidence panel where they can be qualified.
 */
const summariseGroup = (events: readonly SessionEvent[]): string => {
  const counts = new Map<string, number>();
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();
  let denied = 0;
  let failed = 0;

  for (const event of events) {
    if (event.type === "tool.requested") {
      const { name, input } = event.payload.call;
      counts.set(name, (counts.get(name) ?? 0) + 1);

      if (name === "read_file") {
        readPaths.add(input.path);
      }

      if (
        name === "propose_patch" ||
        name === "propose_new_file" ||
        name === "propose_deletion"
      ) {
        writePaths.add(input.path);
      }
    } else if (event.type === "tool.denied") {
      denied += 1;
    } else if (event.type === "tool.failed") {
      failed += 1;
    }
  }

  const used = (...names: string[]): number =>
    names.reduce((total, name) => total + (counts.get(name) ?? 0), 0);

  const parts: string[] = [];
  const searched = used("search_repository", "list_directory", "git_status", "git_diff", "git_branches");

  if (readPaths.size > 0 || searched > 0) {
    // Files, not calls. Reading one file four times is one file's worth of
    // understanding, and counting the calls made a stuck agent look busy.
    parts.push(
      readPaths.size > 0
        ? `Read ${plural(readPaths.size, "file")}`
        : "Searched the repository",
    );
  }

  if (writePaths.size > 0) {
    parts.push(`Proposed changes to ${plural(writePaths.size, "file")}`);
  }

  const applied = used("apply_patch");

  if (applied > 0) {
    parts.push(`Applied ${plural(applied, "change")}`);
  }

  if (used("run_tests") > 0) {
    parts.push("Ran the tests");
  }

  if (used("run_build") > 0) {
    parts.push("Built the project");
  }

  if (used("run_diagnostics") > 0) {
    parts.push("Checked diagnostics");
  }

  if (used("run_command") > 0) {
    parts.push(`Ran ${plural(used("run_command"), "command")}`);
  }

  if (used("dev_server") > 0) {
    parts.push("Started a dev server");
  }

  // Both stay last and stay plain. A refusal is a fact about what a person
  // decided, not an error the timeline should apologise for.
  if (denied > 0) {
    parts.push(`${denied} refused`);
  }

  if (failed > 0) {
    parts.push(`${plural(failed, "call")} failed`);
  }

  return parts.length > 0 ? parts.join(" · ") : "Worked on the repository";
};

const ToolGroupRow = ({
  group,
  open,
  onToggle,
  raw,
  highlighted,
}: {
  group: TimelineGroup;
  open: boolean;
  onToggle: () => void;
  raw: boolean;
  highlighted: number | null;
}) => {
  const requestCount = group.events.filter((event) => event.type === "tool.requested").length;
  const hasFailure = group.events.some(
    (event) => event.type === "tool.failed" || event.type === "tool.denied",
  );

  // Only shown while collapsed: expanded, each tool.requested with text
  // renders its own copy inline (see packages/ui's EventRow), and showing it
  // twice would be exactly the clutter this grouping exists to remove.
  const prose = open
    ? []
    : group.events
        .filter(
          (event): event is Extract<SessionEvent, { type: "tool.requested" }> =>
            event.type === "tool.requested" && Boolean(event.payload.text),
        )
        .map((event) => event.payload.text);

  return (
    <div className="tool-group">
      {prose.map((text, index) => (
        <p className="event__prose" key={`${group.key}-${index}`}>
          {text}
        </p>
      ))}
      <button
        type="button"
        className={`tool-group__head${hasFailure ? " tool-group__head--warn" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="tool-group__chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-group__summary">{summariseGroup(group.events)}</span>
        {/*
          Named, so the fold says what is behind it rather than leaving a
          count of calls as the headline. The call total moves in here with
          the rest of the machinery: it is implementation telemetry, and as a
          headline it invited reading more calls as more work done.
        */}
        <span className="tool-group__detail">
          Technical details · {requestCount}
        </span>
      </button>
      {open ? (
        <div className="tool-group__body">
          {group.events.map((event) => (
            <EventRow
              key={event.eventId}
              event={event}
              raw={raw}
              highlighted={highlighted === event.sequence}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const TimelineView = ({
  events,
  busy,
  raw,
  highlighted,
  groupOverrides,
  onToggleGroup,
  group = true,
}: {
  events: readonly SessionEvent[];
  /** Whether the run is currently in flight — decides which group defaults open. */
  busy: boolean;
  raw: boolean;
  highlighted: number | null;
  /** Explicit open/closed state per group key, once a person has touched it. */
  groupOverrides: Map<number, boolean>;
  onToggleGroup: (key: number, currentlyOpen: boolean) => void;
  /**
   * Off for a filtered view (tools-only, patches-only). Every event in
   * either of those filters is itself "mechanical" by this file's own
   * definition, so grouping them would collapse the whole filtered list into
   * one disclosure with nothing showing — exactly the failure mode the
   * filter exists to avoid. Grouping is what makes the *unfiltered* timeline
   * read as a narrated turn instead of a flat log; a filter has already done
   * the reading-aid job a different way; the two don't compose.
   */
  group?: boolean;
}) => {
  const items = useMemo(() => {
    const visible = withoutRepeatedOpens(events);

    return group
      ? buildTimelineItems(visible)
      : visible.map((event) => ({ kind: "event" as const, event }));
  }, [events, group]);

  return (
    <>
      {items.map((item, index) => {
        if (item.kind === "event") {
          return (
            <EventRow
              key={item.event.eventId}
              event={item.event}
              raw={raw}
              highlighted={highlighted === item.event.sequence}
            />
          );
        }

        // The most recent group stays expanded live, the way Zed's agent
        // panel keeps the in-flight turn open and collapses it the moment
        // the turn ends — every earlier group defaults closed regardless.
        const isLast = index === items.length - 1;
        const defaultOpen = isLast && busy;
        const open = groupOverrides.has(item.key) ? groupOverrides.get(item.key)! : defaultOpen;

        return (
          <ToolGroupRow
            key={item.key}
            group={item}
            open={open}
            onToggle={() => onToggleGroup(item.key, open)}
            raw={raw}
            highlighted={highlighted}
          />
        );
      })}
    </>
  );
};
