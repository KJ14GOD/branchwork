import { useEffect, useState } from "react";

import type { Participant } from "@novus/contracts";
import { fetchMembership } from "@novus/session-client";

/**
 * Who this window is in the joined session, according to the worker.
 *
 * Polled rather than fetched once because the answer moves: a handoff is a
 * role change, and a joined window whose owner just handed it control must
 * start showing the controls it now holds (and vice versa) without a reload.
 * Null while unknown — the UI treats unknown as the weakest role and shows
 * watch-only, which is the safe direction to be wrong in.
 *
 * Only meaningful against a worker. A relay join has no membership to ask
 * about: the relay authorises reading one session's log and nothing else.
 */
const POLL_MS = 4_000;

export const useMembership = (
  endpoint: string | null,
  sessionId: string | null,
  token: string | null,
): Participant | null => {
  const [participant, setParticipant] = useState<Participant | null>(null);

  useEffect(() => {
    if (!endpoint || !sessionId || !token) {
      setParticipant(null);

      return;
    }

    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      const report = await fetchMembership(
        endpoint,
        sessionId,
        token,
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      if (report.kind === "ok") {
        setParticipant(report.participant);
      } else if (report.kind === "refused" || report.kind === "absent") {
        // A revoked token or a session this worker does not know: whatever
        // role we thought we had, we no longer provably have it.
        setParticipant(null);
      }
      // "unreachable" keeps the last known answer — the connection status the
      // timeline already shows owns reporting that.
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [endpoint, sessionId, token]);

  return participant;
};
