import { useCallback, useEffect, useRef, useState } from "react";

import { withToken } from "./access.ts";
import { SessionEventSchema, type SessionEvent } from "@novus/contracts";

export type ConnectionStatus = "connecting" | "live" | "error";

export type SessionStream = {
  events: SessionEvent[];
  status: ConnectionStatus;
  reconnect: () => void;
};

/**
 * Subscribes to the worker's ordered event log.
 *
 * Events are validated against the shared contract before entering React
 * state, and de-duplicated by sequence so a reconnect that replays an
 * already-seen event cannot corrupt the timeline.
 */
export const useSessionEvents = (
  endpoint: string,
  sessionId: string | null,
): SessionStream => {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(new Set<number>());
  const streamed = useRef<string | null>(null);

  const reconnect = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    // Only a different session starts a new timeline. A manual reconnect
    // re-runs this effect too, and must not discard what we already have.
    if (streamed.current !== sessionId) {
      streamed.current = sessionId;
      seen.current = new Set();
      setEvents([]);
    }

    const url = new URL(`${endpoint}/events`);
    url.searchParams.set("session", sessionId);

    // EventSource cannot set a header, so the token rides in the query. That
    // makes opening the stream asynchronous, and the effect can be torn down
    // before it exists — `closed` is what stops a stream nobody is listening to
    // from being left open behind us.
    let source: EventSource | null = null;
    let closed = false;

    setStatus("connecting");

    const listen = (stream: EventSource): void => {
      stream.addEventListener("open", () => {
        setStatus("live");
      });

      stream.addEventListener("message", (message) => {
        const parsed = SessionEventSchema.safeParse(
          JSON.parse((message as MessageEvent<string>).data),
        );

        if (!parsed.success) {
          console.error("Discarded an event that failed validation", parsed.error);
          return;
        }

        const event = parsed.data;

        if (seen.current.has(event.sequence)) {
          return;
        }

        seen.current.add(event.sequence);
        setStatus("live");
        setEvents((current) =>
          [...current, event].sort(
            (first, second) => first.sequence - second.sequence,
          ),
        );
      });

      stream.addEventListener("error", () => {
        // EventSource retries on its own and resends Last-Event-ID; surface the
        // gap rather than tearing the stream down.
        setStatus("error");
      });
    };

    void withToken(url.toString()).then((authorized) => {
      if (closed) {
        return;
      }

      source = new EventSource(authorized);
      listen(source);
    });

    return () => {
      closed = true;
      source?.close();
    };
  }, [endpoint, sessionId, attempt]);

  return { events, status, reconnect };
};
