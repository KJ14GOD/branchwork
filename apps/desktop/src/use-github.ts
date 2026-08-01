import { useEffect, useState } from "react";

import { GithubStatusSchema, type GithubStatus } from "@novus/contracts/protocol";

import { authorization } from "./access.ts";

/**
 * What GitHub says about this repository's branch.
 *
 * Polled slowly and deliberately. Checks take minutes, not seconds, and every
 * poll is a subprocess and a network round trip on the host's machine — so
 * this refreshes about as often as a person would glance at it, not as often
 * as the event stream moves.
 *
 * Not connected is a normal answer rather than an error. Most repositories
 * Novus opens will have no GitHub remote at all.
 */

const POLL_MS = 60_000;

export const useGithub = (
  endpoint: string,
  sessionId: string | null,
): GithubStatus | null => {
  const [status, setStatus] = useState<GithubStatus | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);

      return;
    }

    let cancelled = false;

    const read = async () => {
      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/github`,
          { headers: await authorization() },
        );

        if (cancelled || !response.ok) {
          return;
        }

        const parsed = GithubStatusSchema.safeParse(await response.json());

        // Dropped rather than rendered when it does not validate. A check
        // verdict is evidence somebody may adopt an approach on, and a shape
        // nobody validated is a verdict nobody checked.
        if (parsed.success) {
          setStatus(parsed.data);
        }
      } catch {
        // Offline, or the worker went away. The panel keeps whatever it last
        // knew rather than flashing an error at somebody mid-review.
      }
    };

    void read();
    const timer = setInterval(() => void read(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [endpoint, sessionId]);

  return status;
};
