import { useState } from "react";

import type { SessionListing } from "../worker-api.ts";

/**
 * The way in.
 *
 * A guest normally arrives on a link that already names the session, so this
 * screen is what someone sees when the link was wrong, when the host has not
 * opened a repository yet, or when the worker is not running. Each of those
 * gets its own sentence — "nothing to show" is never allowed to be the answer
 * to three different questions.
 */
export const JoinSession = ({
  endpoint,
  listing,
  onEndpoint,
  onJoin,
}: {
  endpoint: string;
  listing: SessionListing | null;
  onEndpoint: (endpoint: string) => void;
  onJoin: (sessionId: string) => void;
}) => {
  const [sessionId, setSessionId] = useState("");
  const [endpointDraft, setEndpointDraft] = useState(endpoint);

  const status = () => {
    if (listing === null) {
      return <div className="join__note">Asking {endpoint} what it hosts…</div>;
    }

    if (listing.kind === "refused") {
      // Refused before the request, not after it: this endpoint was never
      // contacted, and the sentence has to say which rule it broke or the
      // reader has no way to tell a typo from a link someone built for them.
      return (
        <div className="join__error">
          Not connecting to {endpoint}. {listing.reason}
        </div>
      );
    }

    if (listing.kind === "unreachable") {
      return (
        <div className="join__error">
          No worker is answering at {endpoint} — {listing.detail}. A guest can
          only watch a session that a host is already running.
        </div>
      );
    }

    if (listing.kind === "unlisted") {
      return (
        <div className="join__note">
          This worker does not publish a session list, so an id cannot be
          checked before you join it.
        </div>
      );
    }

    if (listing.sessions.length === 0) {
      return (
        <div className="join__note">
          {endpoint} is running and hosting no sessions yet.
        </div>
      );
    }

    return (
      <ul className="join__list">
        {listing.sessions.map((session) => (
          <li key={session.id}>
            <button
              className="join__session"
              type="button"
              onClick={() => onJoin(session.id)}
            >
              <span className="join__id">{session.id.slice(0, 8)}</span>
              <span className="join__repo">{session.repositoryPath}</span>
              <span className="join__time">
                {new Date(session.createdAt).toLocaleTimeString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="open">
      <div className="open__panel">
        <div className="open__label">Watch a session</div>

        <form
          className="open__row"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = sessionId.trim();

            if (trimmed) {
              onJoin(trimmed);
            }
          }}
        >
          <input
            className="open__input"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="session id"
            spellCheck={false}
            autoFocus
          />
          <button
            className="open__browse"
            type="submit"
            disabled={sessionId.trim().length === 0}
          >
            Watch
          </button>
        </form>

        {status()}

        <div className="open__label">Worker</div>
        <form
          className="open__row"
          onSubmit={(event) => {
            event.preventDefault();
            onEndpoint(endpointDraft.trim());
          }}
        >
          <input
            className="open__input"
            value={endpointDraft}
            onChange={(event) => setEndpointDraft(event.target.value)}
            spellCheck={false}
          />
          <button
            className="open__browse"
            type="submit"
            disabled={endpointDraft.trim() === endpoint}
          >
            Use
          </button>
        </form>

        <div className="join__footnote">
          Read-only. A guest cannot start a run, direct one, or approve
          anything.
        </div>
      </div>
    </div>
  );
};
