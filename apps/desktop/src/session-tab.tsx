import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionEvent } from "@novus/contracts";
import type { SessionSummary } from "@novus/contracts/protocol";

import { bridge } from "./bridge.ts";
import { AskBar } from "./components/ask-bar.tsx";
import { FileTree, FileViewer } from "./components/browse-panel.tsx";
import { CommandOverlay, type Command } from "./components/command-overlay.tsx";
import { CompareScreen } from "./components/compare-screen.tsx";
import { FileChangesPanel } from "./components/file-changes-panel.tsx";
import { InvitePanel } from "./components/invite-panel.tsx";
import { TerminalPanel } from "./components/terminal-panel.tsx";
import { groupKeyFor, TimelineView } from "./components/timeline-view.tsx";
import { useComparison } from "./use-comparison.ts";
import { useFileChanges } from "./use-file-changes.ts";
import { useFileTree } from "./use-file-tree.ts";
import { usePresence } from "./use-presence.ts";
import { useSessionActions } from "./use-session-actions.ts";
import { useSessionEvents } from "./use-session-events.ts";
import type { Theme } from "./use-theme.ts";

type Filter = "all" | "tools" | "patches";
/** Which of the body's three mutually exclusive views is showing. */
type ViewMode = "timeline" | "compare" | "browse";

const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_HEIGHT = 640;
const DEFAULT_TERMINAL_HEIGHT = 260;

/** What the tab strip in `App` needs to know about a tab it is not rendering. */
export type TabStatus = {
  runStatus: string;
  additions: number;
  deletions: number;
};

const isPatchEvent = (
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "tool.completed" }> =>
  event.type === "tool.completed" &&
  event.payload.result.name === "propose_patch";

const isAppliedPatchEvent = (event: SessionEvent): boolean =>
  event.type === "tool.completed" && event.payload.result.name === "apply_patch";

const formatElapsed = (events: SessionEvent[]): string => {
  const first = events.at(0);
  const last = events.at(-1);

  if (!first || !last) {
    return "—";
  }

  const ms =
    new Date(last.occurredAt).getTime() - new Date(first.occurredAt).getTime();

  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * One open session, rendered in full.
 *
 * This is almost all of what used to be `App` when Novus only ever held one
 * session at a time. It is now instantiated once per open tab — every tab
 * mounts one of these and keeps it mounted (hidden with `display: none`,
 * never unmounted) while another tab is active, so a background tab's event
 * stream, presence poll, and terminal keep running rather than being torn
 * down and rebuilt on every switch. `session` is fixed for the component's
 * whole life: it is the summary the tab was opened with, not state this
 * component manages.
 */
export const SessionTab = ({
  session,
  endpoint,
  active,
  theme,
  onStatus,
  onCloseTab,
}: {
  session: SessionSummary;
  endpoint: string;
  active: boolean;
  theme: Theme;
  /** Reports this tab's live status upward, for the tab strip's own chip. */
  onStatus: (status: TabStatus) => void;
  onCloseTab: () => void;
}) => {
  const { error: actionError, ask, invite, direct, cancel, pause, resume, handoff } =
    useSessionActions(endpoint, session);
  const host = bridge();
  const [mode, setMode] = useState<ViewMode>("timeline");
  const [inviting, setInviting] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
  const comparison = useComparison(endpoint, session.id);
  const presence = usePresence(endpoint, session.id);
  const { events, status, reconnect } = useSessionEvents(endpoint, session.id);
  const fileTree = useFileTree(mode === "browse" ? session.repositoryPath : null);
  const [filter, setFilter] = useState<Filter>("all");
  const [raw, setRaw] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // Which tool groups a person has explicitly opened or closed, keyed by the
  // group's first event's sequence — see timeline-view.tsx for why a group
  // needs this rather than owning its own open/closed state locally.
  const [groupOverrides, setGroupOverrides] = useState<Map<number, boolean>>(new Map());

  // Refetched only when another patch actually applied — not polled blind.
  const appliedPatchCount = useMemo(
    () => events.filter(isAppliedPatchEvent).length,
    [events],
  );
  const fileChanges = useFileChanges(endpoint, session.id, appliedPatchCount);

  const run = events.find((event) => event.type === "run.started");
  const completed = events.findLast((event) => event.type === "run.completed");
  const failed = events.findLast((event) => event.type === "run.failed");
  const cancelled = events.findLast((event) => event.type === "run.cancelled");

  const toolCalls = useMemo(
    () => events.filter((event) => event.type === "tool.requested"),
    [events],
  );
  const patches = useMemo(() => events.filter(isPatchEvent), [events]);

  const visible = useMemo(() => {
    if (filter === "tools") {
      return events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      );
    }

    if (filter === "patches") {
      return events.filter(isPatchEvent);
    }

    return events;
  }, [events, filter]);

  // True only for the moment nothing has actually happened yet — a fresh
  // session's log is never literally empty (session.created is appended the
  // instant it opens), so "no events at all" would never fire and the
  // timeline would show that one row forever: a lone sequence-0 session.created
  // card, which is exactly the "lone 0 ◇ glyph" this replaces with an actual
  // empty state. Once a run starts, session.created renders normally as part
  // of the real history.
  const trulyEmpty =
    filter === "all"
      ? events.length === 0 ||
        (events.length === 1 && events[0]?.type === "session.created")
      : visible.length === 0;

  const jumpTo = (sequence: number) => {
    setHighlighted(sequence);

    // Grouping is only ever rendered for the unfiltered timeline (see the
    // TimelineView call below), and only ever over `visible`, not the raw
    // event list — a key computed from `events` would be a key from a
    // grouping that was never actually rendered, and the override below
    // would set state for a group with no matching DOM node to expand.
    const key = filter === "all" ? groupKeyFor(visible, sequence) : null;

    if (key !== null) {
      setGroupOverrides((current) =>
        current.get(key) === true ? current : new Map(current).set(key, true),
      );
    }

    // Deferred one frame: if the target was inside a group that just opened
    // above, its row does not exist in the DOM until that render lands.
    requestAnimationFrame(() => {
      document
        .getElementById(`event-${sequence}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const toggleGroup = (key: number, currentlyOpen: boolean) => {
    setGroupOverrides((current) => new Map(current).set(key, !currentlyOpen));
  };

  const commands: Command[] = [
    {
      id: "filter-all",
      label: "Show all events",
      hint: `${events.length}`,
      run: () => setFilter("all"),
    },
    {
      id: "filter-tools",
      label: "Show tool activity only",
      hint: `${toolCalls.length}`,
      run: () => setFilter("tools"),
    },
    {
      id: "filter-patches",
      label: "Show proposed patches only",
      hint: `${patches.length}`,
      run: () => setFilter("patches"),
    },
    {
      id: "raw",
      label: raw ? "Hide raw event payloads" : "Show raw event payloads",
      run: () => setRaw((value) => !value),
    },
    {
      id: "reconnect",
      label: "Reconnect event stream",
      hint: status,
      run: reconnect,
    },
  ];

  const latestPatch = patches.at(-1);

  if (latestPatch) {
    const { output } = latestPatch.payload.result as Extract<
      SessionEvent,
      { type: "tool.completed" }
    >["payload"]["result"] & { name: "propose_patch" };

    commands.push(
      {
        id: "jump-patch",
        label: `Jump to latest patch · ${output.path}`,
        run: () => jumpTo(latestPatch.sequence),
      },
      {
        id: "copy-patch",
        label: "Copy latest patch diff",
        run: () => {
          void navigator.clipboard.writeText(output.diff);
        },
      },
    );
  }

  // The "/" shortcut only ever belongs to the tab you are looking at — a
  // background tab must not steal it, or intercept it a second time once two
  // tabs are both listening.
  useEffect(() => {
    if (!active) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA";

      if (event.key === "/" && !typing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  // A run is in flight when the newest run.started has no matching terminator.
  const lastStarted = events.findLast((event) => event.type === "run.started");
  const lastEnded = events.findLast(
    (event) =>
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled",
  );
  const busy = Boolean(
    lastStarted && (!lastEnded || lastEnded.sequence < lastStarted.sequence),
  );
  // A cancel that was requested but has not yet stopped the run still reads
  // as busy — the host asked, the run has not reached its next turn boundary
  // to honour it yet.
  const cancelling =
    busy &&
    events
      .filter((event) => event.type === "run.cancel_requested")
      .some(
        (event) =>
          lastStarted && event.sequence > lastStarted.sequence,
      );
  // Only the most recent of the three pause-related events for this run
  // decides — a run can be paused and resumed more than once, so "some event
  // exists" is not enough, the same rule AgentRunner.pauseRequested applies.
  const latestPauseEvent = events
    .filter(
      (event) =>
        (event.type === "run.pause_requested" ||
          event.type === "run.paused" ||
          event.type === "run.resumed") &&
        lastStarted &&
        event.sequence > lastStarted.sequence,
    )
    .at(-1);
  const pausing = busy && latestPauseEvent?.type === "run.pause_requested";
  const paused = busy && latestPauseEvent?.type === "run.paused";
  const runStatus = cancelling
    ? "cancelling"
    : pausing
      ? "pausing"
      : paused
        ? "paused"
        : busy
          ? "working"
          : cancelled
            ? "cancelled"
            : failed
              ? "failed"
              : completed
                ? "idle"
                : run
                  ? "running"
                  : "idle";

  // Reports up to the tab strip. Deliberately keyed on the computed values,
  // not on `onStatus`'s identity — that is a fresh closure every render of
  // `App`'s tab map, and depending on it would refire this for every tab on
  // every keystroke anywhere in the app.
  useEffect(() => {
    onStatus({
      runStatus,
      additions: fileChanges.additions,
      deletions: fileChanges.deletions,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus, fileChanges.additions, fileChanges.deletions]);

  const startTerminalResize = (event: React.MouseEvent) => {
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = terminalHeight;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;

      setTerminalHeight(
        Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, startHeight + delta)),
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="tab-content" style={{ display: active ? "grid" : "none" }}>
      <div className="session-bar">
        <div className="titlebar__meta">
          <button
            className="titlebar__repo"
            type="button"
            onClick={onCloseTab}
            title="Close this tab"
          >
            {session.repositoryPath}
          </button>
          {session.allowWrites ? (
            <span className="titlebar__writes">writes on</span>
          ) : null}
          {session.repositoryState !== "ready" ? (
            // Said at the top of the window, while there is still time to act on
            // it. This used to surface as a failure when you pressed Fork, which
            // is after the work rather than before it.
            <span className="titlebar__warn" title="Forking and diffs need a commit to work from">
              {session.repositoryState === "absent"
                ? "not a git repo"
                : "no commits yet"}
            </span>
          ) : null}
          {session.allowCommands ? (
            <span className="titlebar__writes">commands on</span>
          ) : null}
          {run?.type === "run.started" ? (
            <span className="titlebar__model">
              {run.payload.run.model.provider}/{run.payload.run.model.model}
            </span>
          ) : null}
          <span className="titlebar__phase">{runStatus}</span>
        </div>
        {presence.participants.length > 0 ? (
          <div className="presence" title="Who has this session open right now">
            {presence.participants.map((participant) => (
              <span
                key={participant.id}
                className={`presence__item${participant.connected ? " presence__item--live" : ""}`}
                title={`${participant.name} · ${participant.role}${participant.connected ? " · watching now" : " · not connected"}`}
              >
                <span className="presence__dot" />
                {participant.name}
                {participant.role !== "owner" ? (
                  <button
                    className="presence__handoff"
                    type="button"
                    onClick={() => void handoff(participant.id)}
                    title={`Hand off control to ${participant.name} — only the current owner can do this`}
                  >
                    hand off
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        <span className="titlebar__spacer" />
        <button
          className="titlebar__action"
          type="button"
          onClick={() => setInviting(true)}
          title="Invite a teammate into this session"
        >
          invite
        </button>
        <button
          className="titlebar__action"
          type="button"
          onClick={() => setMode((current) => (current === "compare" ? "timeline" : "compare"))}
          title="Fork this run and compare attempts"
        >
          {mode === "compare" ? "timeline" : "attempts"}
        </button>
        {host ? (
          <button
            className="titlebar__action"
            type="button"
            onClick={() => setMode((current) => (current === "browse" ? "timeline" : "browse"))}
            title="Browse this repository's files, read-only"
          >
            {mode === "browse" ? "timeline" : "browse"}
          </button>
        ) : null}
        <button
          className="titlebar__action"
          type="button"
          onClick={() => setTerminalOpen((value) => !value)}
          title="A real shell, opened in this repository — yours, not the agent's"
        >
          {terminalOpen ? "close terminal" : "terminal"}
        </button>
        <span className={`status status--${status === "live" ? "live" : status === "error" ? "error" : "idle"}`}>
          <span className="status__dot" />
          {status}
        </span>
        <span className="titlebar__hint">
          <kbd>/</kbd> commands
        </span>
      </div>

      <div
        className={
          mode === "compare"
            ? "body body--compare"
            : mode === "browse"
              ? "body body--browse"
              : "body"
        }
      >
        <aside className="rail">
          <div className="rail__section">
            <div className="rail__label">Goal</div>
            <div className="rail__goal">
              {run?.type === "run.started"
                ? run.payload.run.goal
                : "No goal yet — ask the agent something below to begin."}
            </div>
          </div>

          {busy ? (
            <div className="rail__section rail__section--direction">
              <div className="rail__label">Run control</div>
              {lastStarted?.type === "run.started" ? (
                <div className="rail__buttons">
                  <button
                    className="open__browse"
                    type="button"
                    disabled={pausing}
                    onClick={() => {
                      if (lastStarted.type === "run.started") {
                        if (paused) {
                          void resume(lastStarted.payload.run.id);
                        } else {
                          void pause(lastStarted.payload.run.id);
                        }
                      }
                    }}
                    title={
                      paused
                        ? "Continue this run where it left off"
                        : "Suspend this run at its next safe boundary, to resume later"
                    }
                  >
                    {pausing
                      ? "Pausing…"
                      : paused
                        ? "Resume run"
                        : "Pause run"}
                  </button>
                  <button
                    className="open__browse"
                    type="button"
                    disabled={cancelling}
                    onClick={() => {
                      if (lastStarted.type === "run.started") {
                        void cancel(lastStarted.payload.run.id);
                      }
                    }}
                    title="Stop this run at its next safe boundary"
                  >
                    {cancelling ? "Stopping…" : "Cancel run"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rail__section">
            <div className="rail__label">Run</div>
            <div className="stat">
              <span>events</span>
              <span className="stat__value">{events.length}</span>
            </div>
            <div className="stat">
              <span>tool calls</span>
              <span className="stat__value">{toolCalls.length}</span>
            </div>
            <div className="stat">
              <span>patches</span>
              <span className="stat__value">{patches.length}</span>
            </div>
            <div className="stat">
              <span>lines</span>
              <span className="stat__value">
                <span className="stat__add">+{fileChanges.additions}</span>{" "}
                <span className="stat__del">−{fileChanges.deletions}</span>
              </span>
            </div>
            <div className="stat">
              <span>elapsed</span>
              <span className="stat__value">{formatElapsed(events)}</span>
            </div>
          </div>

          {toolCalls.length > 0 ? (
            <div>
              <div className="rail__label rail__label--inset">Tool calls</div>
              {toolCalls.map((event) => (
                <button
                  key={event.eventId}
                  type="button"
                  className={`jump${highlighted === event.sequence ? " jump--active" : ""}`}
                  onClick={() => jumpTo(event.sequence)}
                >
                  <span className="jump__seq">{event.sequence}</span>
                  <span className="jump__name">
                    {event.type === "tool.requested"
                      ? event.payload.call.name
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </aside>

        {mode === "compare" ? (
          <main className="timeline timeline--compare">
            <CompareScreen
              state={comparison}
              repositoryState={session.repositoryState}
              onClose={() => setMode("timeline")}
            />
          </main>
        ) : mode === "browse" ? (
          <>
            <FileTree state={fileTree} />
            <FileViewer state={fileTree} />
          </>
        ) : (
          <>
            <main className="timeline-column">
              <div className="timeline">
                {trulyEmpty ? (
                  <div className="timeline__empty">
                    {status === "error" ? (
                      <p className="timeline__empty-title">
                        No connection to {endpoint}.
                      </p>
                    ) : (
                      <>
                        <p className="timeline__empty-title">Nothing has run yet.</p>
                        <p className="timeline__empty-hint">
                          Ask the agent something below to begin.
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <TimelineView
                    events={visible}
                    busy={busy}
                    raw={raw}
                    highlighted={highlighted}
                    groupOverrides={groupOverrides}
                    onToggleGroup={toggleGroup}
                    group={filter === "all"}
                  />
                )}
              </div>
              <AskBar busy={busy} onAsk={(goal) => void ask(goal)} onDirect={(goal) => void direct(goal)} />
            </main>
            <FileChangesPanel state={fileChanges} />
          </>
        )}
      </div>

      {actionError ? <div className="session-bar__error">{actionError}</div> : null}

      {terminalOpen ? (
        <div className="terminal-dock" style={{ height: terminalHeight }}>
          <div
            className="terminal-dock__resize"
            onMouseDown={startTerminalResize}
            title="Drag to resize"
          />
          <div className="terminal-dock__head">
            <span className="terminal-dock__prompt">›_</span>
            <span className="terminal-dock__label">{session.repositoryPath}</span>
            <button
              className="titlebar__action"
              type="button"
              onClick={() => setTerminalOpen(false)}
              title="Close this shell"
            >
              close
            </button>
          </div>
          <TerminalPanel cwd={session.repositoryPath} theme={theme} />
        </div>
      ) : null}

      {paletteOpen ? (
        <CommandOverlay
          commands={commands}
          onAsk={(goal) => {
            if (busy) {
              void direct(goal);
            } else {
              void ask(goal);
            }
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}

      {inviting ? (
        <InvitePanel onInvite={invite} onClose={() => setInviting(false)} />
      ) : null}
    </div>
  );
};
