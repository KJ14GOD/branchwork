import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  describeConnection,
  summarise,
  useGuestSession,
  usePresence,
  useWorkerSessions,
} from "@novus/session-client";

import { EventRow } from "./components/guest-event-row.tsx";
import { JoinSession } from "./components/join-session.tsx";

const DEFAULT_ENDPOINT =
  import.meta.env.VITE_NOVUS_ENDPOINT ?? "http://127.0.0.1:4319";

/**
 * The address bar is the invite link.
 *
 * A guest is handed a URL, so the session and the worker it lives on belong in
 * the URL — that way the link a host pastes into a chat is the same link the
 * guest's browser can reload, bookmark, and hand to someone else.
 */
const readParam = (name: string): string | null =>
  new URLSearchParams(window.location.search).get(name);

/** The last path segment, which is the part a person calls the repository. */
const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * Sentence case for a machine-shaped word.
 *
 * Statuses arrive lowercase because that is how the contract spells them.
 * Rendering the contract's spelling verbatim is what made this chrome read as
 * affected — the desktop was fixed for it and the guest was not.
 */
const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

const writeParams = (endpoint: string, sessionId: string | null): void => {
  const params = new URLSearchParams();

  if (sessionId) {
    params.set("session", sessionId);
  }

  if (endpoint !== DEFAULT_ENDPOINT) {
    params.set("endpoint", endpoint);
  }

  const query = params.toString();

  window.history.replaceState(
    null,
    "",
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
};

/** Re-renders while a retry is pending so its countdown actually counts. */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 500);

    return () => {
      clearInterval(interval);
    };
  }, [active]);

  return now;
};

export const App = () => {
  // Held exactly as it was written, including when it is nonsense or points
  // somewhere a guest will not go. `resolveEndpoint` decides that, at the two
  // places that would otherwise act on it, and the refusal is shown with the
  // address that caused it — quietly swapping in the default would erase the
  // evidence that the link was crafted rather than mistyped.
  const [endpoint, setEndpoint] = useState(
    () => readParam("endpoint") ?? DEFAULT_ENDPOINT,
  );
  const [sessionId, setSessionId] = useState<string | null>(() =>
    readParam("session"),
  );
  // Read once. The invite link is where a guest's credential comes from, and
  // keeping it out of state means changing the session in the UI cannot lose it.
  const [token] = useState<string | null>(() => readParam("token"));
  // An invite that carries a relay is one a teammate elsewhere can use; without
  // it the guest is still a second window on the host's own machine.
  const [relay] = useState<string | null>(() => readParam("relay"));

  const { events, connection, session, retry } = useGuestSession(
    endpoint,
    sessionId,
    token,
    relay,
  );
  // Not asked when a relay is in play: the join screen exists to pick a session
  // from a worker, and a relay serves the one its token authorises.
  const listing = useWorkerSessions(
    endpoint,
    sessionId === null && relay === null,
    token,
  );
  const presence = usePresence(endpoint, sessionId, token, relay);

  useEffect(() => {
    writeParams(endpoint, sessionId);
  }, [endpoint, sessionId]);

  const [highlighted, setHighlighted] = useState<number | null>(null);
  const timeline = useRef<HTMLElement | null>(null);
  const following = useRef(true);

  // A guest has no controls, so the tail is the whole product: it should keep
  // up on its own. Scrolling back deliberately stops that until the reader
  // returns to the bottom.
  useLayoutEffect(() => {
    const element = timeline.current;

    if (element && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [events]);

  const retryAt = "retryAt" in connection ? connection.retryAt : null;
  const now = useNow(retryAt !== null);
  const countdown =
    retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));

  if (sessionId === null) {
    return (
      <div className="shell">
        <header className="titlebar">
          <span className="titlebar__mark">Novus</span>
          <span className="titlebar__guest">Guest · read-only</span>
        </header>
        <JoinSession
          endpoint={endpoint}
          listing={listing}
          onEndpoint={setEndpoint}
          onJoin={setSessionId}
        />
      </div>
    );
  }

  const report = describeConnection(connection, endpoint, sessionId);
  const summary = summarise(events);

  const jumpTo = (sequence: number) => {
    setHighlighted(sequence);
    following.current = false;
    document
      .getElementById(`event-${sequence}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const attempt =
    "attempt" in connection && connection.attempt > 1
      ? ` · attempt ${connection.attempt}`
      : "";

  const notice = (
    <div className={`notice notice--${report.tone}`}>
      <div>{report.emptyTimeline}</div>
      <div className="notice__row">
        {countdown !== null ? (
          <span className="notice__countdown">
            Retrying in {countdown}s{attempt}
          </span>
        ) : null}
        {connection.kind === "stopped" ? (
          // Retrying a refused address only refuses it again. Changing the
          // worker is the move, so that is the button offered.
          <button
            className="notice__retry"
            type="button"
            onClick={() => setSessionId(null)}
          >
            Choose another worker
          </button>
        ) : (
          <button className="notice__retry" type="button" onClick={retry}>
            Retry now
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="titlebar__mark">Novus</span>
        <span className="titlebar__guest">Guest · read-only</span>
        <div className="titlebar__meta">
          <span className="titlebar__goal" title={summary.goal ?? undefined}>
            {summary.goal ?? "Nothing has run yet"}
          </span>
          <button
            className="titlebar__repo"
            type="button"
            onClick={() => setSessionId(null)}
            title={
              session
                ? `${session.repositoryPath} — stop watching this mission`
                : "Stop watching this mission"
            }
          >
            {session ? basename(session.repositoryPath) : sessionId}
          </button>
          {summary.model ? <span>{summary.model}</span> : null}
          <span>{sentenceCase(summary.runStatus)}</span>
        </div>
        {presence.length > 0 ? (
          <div className="presence" title="Who has this mission open right now">
            {presence.map((participant) => (
              <span
                key={participant.id}
                className={`presence__item${participant.connected ? " presence__item--live" : ""}`}
                title={`${participant.name} · ${participant.role}${participant.connected ? " · watching now" : " · not connected"}`}
              >
                <span className="presence__dot" />
                {participant.name}
              </span>
            ))}
          </div>
        ) : null}
        <span className="titlebar__spacer" />
        <span className={`status status--${report.tone}`}>
          <span className="status__dot" />
          {report.label}
        </span>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="rail__section">
            <div className="rail__label">Goal</div>
            <div className="rail__goal">
              {summary.goal ?? "No run has started in this mission."}
            </div>
          </div>

          <div className="rail__section">
            <div className="rail__label">Run</div>
            <div className="stat">
              <span>Events</span>
              <span className="stat__value">{summary.events}</span>
            </div>
            <div className="stat">
              <span>Tool calls</span>
              <span className="stat__value">{summary.toolCalls.length}</span>
            </div>
            <div className="stat">
              <span>Patches</span>
              <span className="stat__value">{summary.patches.length}</span>
            </div>
            <div className="stat">
              <span>Lines</span>
              <span className="stat__value">
                <span style={{ color: "var(--add)" }}>+{summary.additions}</span>{" "}
                <span style={{ color: "var(--del)" }}>−{summary.deletions}</span>
              </span>
            </div>
            <div className="stat">
              <span>Elapsed</span>
              <span className="stat__value">{summary.elapsed}</span>
            </div>
          </div>

          {summary.toolCalls.length > 0 ? (
            <div>
              <div className="rail__label" style={{ padding: "0 14px 8px" }}>
                Tool calls
              </div>
              {summary.toolCalls.map((event) => (
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

        <main
          className="timeline"
          ref={timeline}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              120;
          }}
        >
          {events.length === 0 ? (
            <div className="timeline__vacant">
              <div className="notice__lead">{report.label}</div>
              {notice}
            </div>
          ) : (
            <>
              {report.tone === "live" ? null : notice}
              {events.map((event) => (
                <EventRow
                  key={event.eventId}
                  event={event}
                  highlighted={highlighted === event.sequence}
                />
              ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
};
