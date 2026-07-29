import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EventRow } from "./components/guest-event-row.tsx";
import { JoinSession } from "./components/join-session.tsx";
import { describeConnection, summarise } from "./timeline.ts";
import { useGuestSession, useWorkerSessions } from "./use-guest-session.ts";

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

  const { events, connection, session, retry } = useGuestSession(
    endpoint,
    sessionId,
  );
  const listing = useWorkerSessions(endpoint, sessionId === null);

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
          <span className="titlebar__guest">guest · read-only</span>
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
            retrying in {countdown}s{attempt}
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
        <span className="titlebar__guest">guest · read-only</span>
        <div className="titlebar__meta">
          <button
            className="titlebar__repo"
            type="button"
            onClick={() => setSessionId(null)}
            title="Stop watching this session"
          >
            {session ? session.repositoryPath : sessionId}
          </button>
          {summary.model ? <span>{summary.model}</span> : null}
          <span>{summary.runStatus}</span>
        </div>
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
              {summary.goal ?? "No run has started in this session."}
            </div>
          </div>

          <div className="rail__section">
            <div className="rail__label">Run</div>
            <div className="stat">
              <span>events</span>
              <span className="stat__value">{summary.events}</span>
            </div>
            <div className="stat">
              <span>tool calls</span>
              <span className="stat__value">{summary.toolCalls.length}</span>
            </div>
            <div className="stat">
              <span>patches</span>
              <span className="stat__value">{summary.patches.length}</span>
            </div>
            <div className="stat">
              <span>lines</span>
              <span className="stat__value">
                <span style={{ color: "var(--add)" }}>+{summary.additions}</span>{" "}
                <span style={{ color: "var(--del)" }}>−{summary.deletions}</span>
              </span>
            </div>
            <div className="stat">
              <span>elapsed</span>
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
