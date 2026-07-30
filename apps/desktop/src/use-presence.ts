import { useEffect, useState } from "react";

import { PresenceResponseSchema, type PresenceEntry } from "@novus/contracts/protocol";

import { authorization } from "./access.ts";

/**
 * Who has this session open right now, distinct from who was ever invited.
 *
 * There is no push channel for this — presence is deliberately not a
 * `SessionEvent`, because a flaky connection dropping and reconnecting every
 * few seconds would spam the permanent log with noise nobody wants replayed.
 * So this polls `/presence`, the same shape `/compare` already polls on its
 * own schedule for the same kind of reason.
 */

export type { PresenceEntry };

export type PresenceState = {
  participants: PresenceEntry[];
};

const POLL_MS = 4_000;

export const usePresence = (
  endpoint: string,
  sessionId: string | null,
): PresenceState => {
  const [participants, setParticipants] = useState<PresenceEntry[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setParticipants([]);

      return;
    }

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/presence`,
          { headers: await authorization() },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          // A worker with no participants registry configured 404s here by
          // design — single-player mode has nobody to show presence for, and
          // that is not an error state worth surfacing.
          setParticipants([]);

          return;
        }

        const parsed = PresenceResponseSchema.safeParse(await response.json());

        if (!cancelled && parsed.success) {
          setParticipants(parsed.data.participants);
        }
      } catch {
        // Presence is an overlay on top of a session that works without it.
        // An unreachable worker is already reported by the event stream's own
        // status; this fails quietly rather than duplicating that.
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [endpoint, sessionId]);

  return { participants };
};
