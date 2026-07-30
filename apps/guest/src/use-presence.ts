import { useEffect, useState } from "react";

import { PresenceResponseSchema, type PresenceEntry } from "@novus/contracts/protocol";

import { resolveEndpoint } from "./endpoint.ts";

/**
 * Who has this session open right now, mirroring the desktop's own
 * `use-presence.ts`.
 *
 * Only meaningful when the guest talks to the worker directly. A relay watch
 * token authorises reading one session's event log and nothing else — it was
 * never given a way to ask the worker who else is connected, so a guest
 * joined through `?relay=` gets no presence rather than a wrong one.
 */

export type { PresenceEntry };

const POLL_MS = 4_000;

export const usePresence = (
  endpoint: string,
  sessionId: string | null,
  token: string | null,
  relay: string | null,
): PresenceEntry[] => {
  const [participants, setParticipants] = useState<PresenceEntry[]>([]);

  useEffect(() => {
    if (!sessionId || relay !== null) {
      setParticipants([]);

      return;
    }

    const address = resolveEndpoint(endpoint);

    if (address.kind === "refused") {
      return;
    }

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${address.endpoint}/sessions/${encodeURIComponent(sessionId)}/presence`,
          { headers: token ? { authorization: `Bearer ${token}` } : {} },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setParticipants([]);

          return;
        }

        const parsed = PresenceResponseSchema.safeParse(await response.json());

        if (!cancelled && parsed.success) {
          setParticipants(parsed.data.participants);
        }
      } catch {
        // The connection status the guest already shows covers an unreachable
        // worker; presence just stays whatever it last was.
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [endpoint, sessionId, token, relay]);

  return participants;
};
