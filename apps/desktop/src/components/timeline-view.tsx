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

const summariseGroup = (events: readonly SessionEvent[]): string => {
  const counts = new Map<string, number>();
  let denied = 0;
  let failed = 0;

  for (const event of events) {
    if (event.type === "tool.requested") {
      counts.set(event.payload.call.name, (counts.get(event.payload.call.name) ?? 0) + 1);
    } else if (event.type === "tool.denied") {
      denied += 1;
    } else if (event.type === "tool.failed") {
      failed += 1;
    }
  }

  const parts = [...counts.entries()].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name,
  );

  if (denied > 0) {
    parts.push(`${denied} denied`);
  }

  if (failed > 0) {
    parts.push(`${failed} failed`);
  }

  return parts.length > 0 ? parts.join(", ") : "tool activity";
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
        <span className="tool-group__count">{requestCount}</span>
        <span className="tool-group__summary">{summariseGroup(group.events)}</span>
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
