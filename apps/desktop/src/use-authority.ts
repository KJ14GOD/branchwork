import { useCallback, useEffect, useState } from "react";

import { AuthorityResponseSchema, type Authority } from "@novus/contracts/protocol";

import { authorization } from "./access.ts";

/**
 * Who holds control, who is asking for it, and what direction is waiting.
 *
 * Polled rather than folded from the event stream, and that is the whole point.
 * This window already receives every event and could compute all of it locally,
 * the way it computes run status — but the worker folds the same log to decide
 * who may act, and two folds of one lifecycle is how a timeline and a baton
 * come to disagree. When they disagree it is the baton that is wrong and the
 * person acting on it who pays, so there is one fold and it is the server's.
 *
 * Polling also makes the standing-fact rule true for free: a window that just
 * opened asks once and learns that somebody requested control an hour ago,
 * without replaying anything.
 */

export type { Authority };

export type AuthorityState = Authority & {
  /** Re-reads immediately, for right after acting rather than up to a poll later. */
  refresh: () => void;
};

const POLL_MS = 3_000;

const NOBODY: Authority = {
  you: null,
  controlHeldBy: null,
  controlOffer: null,
  controlRequests: [],
  pendingDirection: [],
  executingRunIds: [],
};

export const useAuthority = (
  endpoint: string,
  sessionId: string | null,
): AuthorityState => {
  const [authority, setAuthority] = useState<Authority>(NOBODY);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setAuthority(NOBODY);

      return;
    }

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/authority`,
          { headers: await authorization() },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          // A worker with no session by this name, or none configured with a
          // participant registry. Same judgement `usePresence` makes: an
          // overlay on a session that works without it does not get to raise
          // an error banner over the run.
          setAuthority(NOBODY);

          return;
        }

        const parsed = AuthorityResponseSchema.safeParse(await response.json());

        if (!cancelled && parsed.success) {
          setAuthority(parsed.data);
        }
      } catch {
        // The event stream's own status already reports an unreachable worker.
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [endpoint, sessionId, nonce]);

  return { ...authority, refresh };
};
