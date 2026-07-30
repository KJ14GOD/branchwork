import { useEffect, useMemo, useState } from "react";

import type { SessionEvent } from "@novus/contracts";

import { bridge } from "./bridge.ts";
import { CommandOverlay, type Command } from "./components/command-overlay.tsx";
import { EventRow } from "./components/host-event-row.tsx";
import { CompareScreen } from "./components/compare-screen.tsx";
import { InvitePanel } from "./components/invite-panel.tsx";
import { OpenRepository } from "./components/open-repository.tsx";
import { useComparison } from "./use-comparison.ts";
import { useSession } from "./use-session.ts";
import { useSessionEvents } from "./use-session-events.ts";

const FALLBACK_ENDPOINT =
  import.meta.env.VITE_NOVUS_ENDPOINT ?? "http://127.0.0.1:4319";

type Filter = "all" | "tools" | "patches";

const isPatchEvent = (
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "tool.completed" }> =>
  event.type === "tool.completed" &&
  event.payload.result.name === "propose_patch";

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

export const App = () => {
  // Inside the Electron shell the main process owns the worker and tells us
  // where it is listening; in a browser we fall back to the default port.
  const [endpoint, setEndpoint] = useState(FALLBACK_ENDPOINT);

  useEffect(() => {
    void bridge()
      ?.workerUrl()
      .then(setEndpoint);
  }, []);

  const {
    session,
    capabilities,
    remembered,
    opening,
    error: sessionError,
    open,
    ask,
    invite,
    direct,
    cancel,
    close,
  } = useSession(endpoint);
  // A separate screen rather than a panel: comparing is a different question
  // from following, and forcing them into one view makes both worse.
  const [comparing, setComparing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [directionText, setDirectionText] = useState("");
  const comparison = useComparison(endpoint, session?.id ?? null);
  const { events, status, reconnect } = useSessionEvents(
    endpoint,
    session?.id ?? null,
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [raw, setRaw] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);

  const run = events.find((event) => event.type === "run.started");
  const completed = events.findLast((event) => event.type === "run.completed");
  const failed = events.findLast((event) => event.type === "run.failed");
  const cancelled = events.findLast((event) => event.type === "run.cancelled");

  const toolCalls = useMemo(
    () => events.filter((event) => event.type === "tool.requested"),
    [events],
  );
  const patches = useMemo(() => events.filter(isPatchEvent), [events]);

  const totals = useMemo(
    () =>
      patches.reduce(
        (accumulator, event) => {
          const { output } = event.payload.result as Extract<
            SessionEvent,
            { type: "tool.completed" }
          >["payload"]["result"] & { name: "propose_patch" };

          return {
            additions: accumulator.additions + output.additions,
            deletions: accumulator.deletions + output.deletions,
          };
        },
        { additions: 0, deletions: 0 },
      ),
    [patches],
  );

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

  const jumpTo = (sequence: number) => {
    setHighlighted(sequence);
    document
      .getElementById(`event-${sequence}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "/" && !typing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
  const runStatus = cancelling
    ? "cancelling"
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

  if (!session) {
    return (
      <div className="shell">
        <header className="titlebar">
          <span className="titlebar__mark">Novus</span>
        </header>
        <OpenRepository
          onOpen={open}
          opening={opening}
          error={sessionError}
          capabilities={capabilities}
          remembered={remembered}
        />
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="titlebar__mark">Novus</span>
        <div className="titlebar__meta">
          <button
            className="titlebar__repo"
            type="button"
            onClick={close}
            title="Close this repository"
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
            <span>
              {run.payload.run.model.provider}/{run.payload.run.model.model}
            </span>
          ) : null}
          <span>{runStatus}</span>
        </div>
        <span className="titlebar__spacer" />
        <button
          className="titlebar__repo"
          type="button"
          onClick={() => setInviting(true)}
          title="Invite a teammate into this session"
        >
          invite
        </button>
        <button
          className="titlebar__repo"
          type="button"
          onClick={() => setComparing((value) => !value)}
          title="Fork this run and compare attempts"
        >
          {comparing ? "timeline" : "attempts"}
        </button>
        <span className={`status status--${status === "live" ? "live" : status === "error" ? "error" : "idle"}`}>
          <span className="status__dot" />
          {status}
        </span>
        <span className="titlebar__hint">
          <kbd>/</kbd> ask
        </span>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="rail__section">
            <div className="rail__label">Goal</div>
            <div className="rail__goal">
              {run?.type === "run.started"
                ? run.payload.run.goal
                : "Waiting for a run"}
            </div>
          </div>

          {busy ? (
            <div className="rail__section">
              <div className="rail__label">Direction</div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();

                  if (directionText.trim()) {
                    void direct(directionText.trim());
                    setDirectionText("");
                  }
                }}
              >
                <input
                  className="open__input"
                  value={directionText}
                  onChange={(event) => setDirectionText(event.target.value)}
                  placeholder="Steer the running turn"
                  spellCheck={false}
                />
              </form>
              {lastStarted?.type === "run.started" ? (
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
                <span style={{ color: "var(--add)" }}>+{totals.additions}</span>{" "}
                <span style={{ color: "var(--del)" }}>−{totals.deletions}</span>
              </span>
            </div>
            <div className="stat">
              <span>elapsed</span>
              <span className="stat__value">{formatElapsed(events)}</span>
            </div>
          </div>

          {toolCalls.length > 0 ? (
            <div>
              <div className="rail__label" style={{ padding: "0 14px 8px" }}>
                Tool calls
              </div>
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

        {comparing ? (
          <main className="timeline">
            <CompareScreen
              state={comparison}
              repositoryState={session.repositoryState}
              onClose={() => setComparing(false)}
            />
          </main>
        ) : (
          <main className="timeline">
            {visible.length === 0 ? (
              <div className="timeline__empty">
                {status === "error" ? (
                  `No connection to ${endpoint}.`
                ) : (
                  <>
                    Press <kbd>/</kbd> and type a question to start.
                  </>
                )}
              </div>
            ) : (
              visible.map((event) => (
                <EventRow
                  key={event.eventId}
                  event={event}
                  raw={raw}
                  highlighted={highlighted === event.sequence}
                />
              ))
            )}
          </main>
        )}
      </div>

      {paletteOpen ? (
        <CommandOverlay
          commands={commands}
          onAsk={(goal) => {
            void ask(goal);
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
