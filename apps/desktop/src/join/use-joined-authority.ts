import { useCallback, useEffect, useState } from "react";

import type { Authority } from "@novus/contracts/protocol";

import { readAuthority } from "./joined-api.ts";

/**
 * The authority state of a joined session, read as the joiner.
 *
 * The same fold, the same cadence and the same reasoning as the hosting
 * window's `use-authority.ts` — this exists beside it rather than inside it
 * because the credential differs: that hook signs with the host's own token
 * from the preload bridge, and a joined window must never hold it.
 *
 * Polled rather than folded from the event stream this window already
 * receives. Two folds of one lifecycle is how a timeline and a baton come to
 * disagree, and when they disagree it is the baton that is wrong and the
 * person acting on it who pays. Polling also makes the standing-fact rule true
 * for free: a window that just opened learns that somebody requested control
 * an hour ago without replaying anything.
 *
 * A relay join gets `NOBODY` and never polls. The relay carries one session's
 * event log outbound and authorises nothing else — there is no authority
 * endpoint on that transport to ask, and inventing an answer would be the one
 * failure this whole hook exists to prevent.
 */

export type JoinedAuthority = Authority & {
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

export const useJoinedAuthority = (
  endpoint: string | null,
  sessionId: string | null,
  token: string | null,
  relay: string | null,
): JoinedAuthority => {
  const [authority, setAuthority] = useState<Authority>(NOBODY);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!endpoint || !sessionId || !token || relay !== null) {
      setAuthority(NOBODY);

      return;
    }

    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      const next = await readAuthority(
        { endpoint, sessionId, token },
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      // Null covers a refusal, a worker with no participant registry, and an
      // unreachable host alike. Showing nobody in control is the safe
      // direction to be wrong in: it offers no action it cannot justify.
      setAuthority(next ?? NOBODY);
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [endpoint, sessionId, token, relay, nonce]);

  return { ...authority, refresh };
};
