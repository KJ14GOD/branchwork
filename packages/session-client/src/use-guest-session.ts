import { useCallback, useEffect, useRef, useState } from "react";

import { SessionEventSchema, type SessionEvent } from "@novus/contracts";
import type { SessionSummary } from "@novus/contracts/protocol";

import { resolveEndpoint } from "./endpoint.ts";
import { watchRelay } from "./relay-client.ts";
import {
  mergeEvent,
  resumeSequence,
  retryDelayMs,
  type GuestConnection,
} from "./timeline.ts";
import { fetchSessions, type SessionListing } from "./worker-api.ts";

export type GuestSession = {
  events: SessionEvent[];
  connection: GuestConnection;
  /** The session being watched, when the worker could describe it. */
  session: SessionSummary | null;
  /** Everything the worker is hosting, for the join screen. */
  known: SessionSummary[];
  /** Retry now instead of waiting out the backoff. */
  retry: () => void;
};

/**
 * Watches one session's ordered event log, read-only.
 *
 * Two rules shape this. First, every reconnect re-verifies the session before
 * reopening the stream, so a host that quit becomes a visible "unreachable"
 * rather than a stream that quietly stops producing events. Second, resumption
 * is by sequence: the guest asks for everything after the last event it holds,
 * and de-duplicates on arrival, so a reconnect can neither lose an event nor
 * show one twice.
 *
 * "Guest" here means the watching side of a session, whichever window it is
 * in: the browser guest was the first caller, and the desktop app's join
 * mode is the second. Acting on the session — direction, steering — is
 * layered on top by the caller; this hook only ever reads.
 */
export const useGuestSession = (
  endpoint: string,
  sessionId: string | null,
  /** From the invite link. The worker refuses a guest without it. */
  token: string | null,
  /**
   * A relay, when the invite carries one.
   *
   * Present, the guest reads the session from there and never contacts the
   * worker — which is what lets a teammate be somewhere else. Absent, it talks
   * to the worker over loopback exactly as before, because a host watching
   * their own run should not need a relay standing up to do it.
   */
  relay: string | null = null,
): GuestSession => {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [connection, setConnection] = useState<GuestConnection>({
    kind: "idle",
  });
  const [known, setKnown] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Mirrors `events` for the effect's closure: a reconnect needs the newest
  // sequence, and re-running the effect on every event would tear the stream
  // down each time one arrived.
  const held = useRef<SessionEvent[]>([]);
  const streamed = useRef<string | null>(null);
  const failures = useRef(0);

  const retry = useCallback(() => {
    failures.current = 0;
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (relay !== null && token !== null) {
      // Checked before the session id, and that ordering is the whole point: a
      // relay serves whichever session its token authorises, so an invite does
      // not carry one and never could. Sitting below the `!sessionId` guard meant
      // every relay link bailed to the join screen without dialling anything.
      streamed.current = relay;
      setConnection({ kind: "connecting" });

      const connection = watchRelay(
        { relay, token, since: resumeSequence(held.current) },
        {
          onOpen: () => {
            failures.current = 0;
            setConnection({ kind: "live", blind: true });
          },
          onEvent: (event) => {
            held.current = mergeEvent(held.current, event);
            setEvents(held.current);
          },
          onRefused: (reason) => setConnection({ kind: "stopped", reason }),
          onClosed: (reason) =>
            setConnection((current) =>
              current.kind === "stopped" ? current : { kind: "stopped", reason },
            ),
        },
      );

      return () => connection.close();
    }

    if (!sessionId) {
      streamed.current = null;
      held.current = [];
      setEvents([]);
      setSession(null);
      setConnection({ kind: "idle" });

      return;
    }


    // Before anything else, because everything below assumes the address is
    // one a URL can be built from and one the guest is willing to talk to.
    // This used to be assumed, and `new URL("nonsense/events")` threw out of
    // the unawaited async block below — leaving the screen on "locating"
    // forever, which is the one shape of failure this client exists to avoid.
    const address = resolveEndpoint(endpoint);

    if (address.kind === "refused") {
      streamed.current = null;
      held.current = [];
      setEvents([]);
      setSession(null);
      setKnown([]);
      setConnection({ kind: "stopped", reason: address.reason });

      return;
    }

    // Only a different session starts a new timeline. A reconnect keeps what it
    // already has and asks for the rest.
    if (streamed.current !== sessionId) {
      streamed.current = sessionId;
      held.current = [];
      setEvents([]);
      setSession(null);
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const scheduleRetry = (
      build: (attemptNumber: number, retryAt: number) => GuestConnection,
    ) => {
      failures.current += 1;
      const delay = retryDelayMs(failures.current);
      setConnection(build(failures.current, Date.now() + delay));
      timer = setTimeout(() => {
        if (!cancelled) {
          setAttempt((value) => value + 1);
        }
      }, delay);
    };

    const open = (blind: boolean) => {
      const url = new URL(`${address.endpoint}/events`);
      url.searchParams.set("session", sessionId);
      url.searchParams.set("since", String(resumeSequence(held.current)));

      // EventSource cannot set a header, so the credential rides in the query.
      // It is already in this page's URL — that is how the guest was invited —
      // so nothing is exposed here that was not exposed by the link itself.
      if (token) {
        url.searchParams.set("token", token);
      }

      setConnection({ kind: "connecting" });
      source = new EventSource(url);

      source.addEventListener("open", () => {
        failures.current = 0;
        setConnection({ kind: "live", blind });
      });

      source.addEventListener("message", (message) => {
        let payload: unknown;

        try {
          payload = JSON.parse((message as MessageEvent<string>).data);
        } catch (cause) {
          console.error("Discarded an event that was not JSON", cause);
          return;
        }

        // The contract is the boundary in both directions. An event the guest
        // cannot validate is dropped rather than rendered as a half-known row.
        const parsed = SessionEventSchema.safeParse(payload);

        if (!parsed.success) {
          console.error("Discarded an event that failed validation", parsed.error);
          return;
        }

        held.current = mergeEvent(held.current, parsed.data);
        setEvents(held.current);
        setConnection({ kind: "live", blind });
      });

      source.addEventListener("error", () => {
        // EventSource retries on its own, but silently and forever — including
        // against a worker that is gone. Take the reconnect back so the guest
        // can re-check the session and say what it finds.
        source?.close();
        scheduleRetry((attemptNumber, retryAt) => ({
          kind: "dropped",
          attempt: attemptNumber,
          retryAt,
        }));
      });
    };

    const locate = async () => {
      setConnection((current) =>
        current.kind === "live" || current.kind === "connecting"
          ? current
          : { kind: "locating" },
      );

      const listing = await fetchSessions(address.endpoint, controller.signal, token ?? undefined);

      if (cancelled) {
        return;
      }

      if (listing.kind === "refused") {
        setKnown([]);
        setConnection({ kind: "stopped", reason: listing.reason });

        return;
      }

      if (listing.kind === "unreachable") {
        setKnown([]);
        scheduleRetry((attemptNumber, retryAt) => ({
          kind: "unreachable",
          detail: listing.detail,
          attempt: attemptNumber,
          retryAt,
        }));

        return;
      }

      if (listing.kind === "unlisted") {
        setKnown([]);
        open(true);

        return;
      }

      setKnown(listing.sessions);

      const match = listing.sessions.find((entry) => entry.id === sessionId);

      if (!match) {
        setSession(null);
        // Kept retrying rather than declared final: an invite link is often
        // opened before the host has created the session it points at.
        scheduleRetry((attemptNumber, retryAt) => ({
          kind: "absent",
          attempt: attemptNumber,
          retryAt,
        }));

        return;
      }

      setSession(match);
      open(false);
    };

    // A rejection here has nowhere to go — there is no caller to catch it and
    // no render that would show it — so an exception would simply stop the
    // sequence with the screen still saying "locating". Whatever it was, say so
    // rather than leaving a stall that reads like work in progress.
    void locate().catch((cause: unknown) => {
      if (cancelled) {
        return;
      }

      console.error("The guest failed while locating the session", cause);
      setConnection({
        kind: "stopped",
        reason: `The guest could not reach ${address.endpoint}: ${cause instanceof Error ? cause.message : String(cause)}.`,
      });
    });

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      source?.close();
    };
  }, [endpoint, sessionId, attempt, token, relay]);

  return { events, connection, session, known, retry };
};

/**
 * Polls the worker for the sessions it is hosting.
 *
 * Only used by the join screen, which must distinguish "this worker is hosting
 * nothing" from "this worker did not answer".
 */
export const useWorkerSessions = (
  endpoint: string,
  enabled: boolean,
  token: string | null,
): SessionListing | null => {
  // Null until the first answer: "asking" and "hosting nothing" are different
  // screens, and showing the second one first is a lie that lasts a frame.
  const [listing, setListing] = useState<SessionListing | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();

    const poll = async () => {
      const next = await fetchSessions(endpoint, controller.signal, token ?? undefined);

      if (!controller.signal.aborted) {
        setListing(next);
      }
    };

    void poll();
    // A guest usually arrives before the host has opened a repository, so the
    // list has to find its way onto the screen without being asked twice.
    const interval = setInterval(() => void poll(), 3_000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [endpoint, enabled]);

  return listing;
};
