import { useEffect, useState } from "react";

import {
  SessionUsageResponseSchema,
  type SessionUsageResponse,
} from "@novus/contracts/protocol";

import { authorization } from "./access.ts";
import { readError } from "./http.ts";

/**
 * What this session has spent so far.
 *
 * Sourced from `GET /sessions/:id/usage`, which folds the receipts in the
 * session's own log — not a second summation kept in the renderer, the same
 * rule `useFileChanges` follows. That matters more here than it does there:
 * the worker's in-memory budget counters die with the process, so a resumed
 * session's spend restarted at zero, and a number the renderer computed from
 * a partial event stream would reintroduce exactly that lie from the other
 * side.
 *
 * Refetched, not polled. A receipt is the only thing that can change the
 * answer, and `SessionTab` already counts those in the stream it holds, so
 * `version` changes exactly when there is something new to ask about.
 */
export type SessionUsageState = SessionUsageResponse & {
  loading: boolean;
  error: string | null;
};

const EMPTY: SessionUsageResponse = {
  session: {
    costUsd: null,
    costIsFloor: false,
    totalTokens: 0,
    modelCalls: 0,
    runs: 0,
    unpricedRuns: 0,
  },
  runs: [],
};

export const useSessionUsage = (
  endpoint: string,
  sessionId: string | null,
  version: number,
): SessionUsageState => {
  const [data, setData] = useState<SessionUsageResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setData(EMPTY);
      return;
    }

    let cancelled = false;

    setLoading(true);

    void (async () => {
      try {
        const response = await fetch(`${endpoint}/sessions/${sessionId}/usage`, {
          headers: { ...(await authorization()) },
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const parsed = SessionUsageResponseSchema.parse(await response.json());

        if (!cancelled) {
          setData(parsed);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          // The previous answer is kept rather than blanked. Spend that
          // scrolls to zero because one fetch failed is worse than spend that
          // is briefly stale — it reads as "you have spent nothing".
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [endpoint, sessionId, version]);

  return { ...data, loading, error };
};
