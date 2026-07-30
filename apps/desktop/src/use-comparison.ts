import { useCallback, useEffect, useState } from "react";

import {
  ComparisonSchema,
  type Comparison,
  type DecisionSummary,
} from "@novus/contracts/protocol";

import { authorization } from "./access.ts";
import { readError } from "./http.ts";

/**
 * The attempts, and the two things a host does with them.
 *
 * Kept apart from `useSession` because forking and choosing are the host's
 * decisions and the guest has no business holding either — the split is what
 * keeps "read-only" a property of what the guest can import rather than a rule
 * somebody has to remember.
 *
 * Validated on arrival like anything else crossing the boundary. This is the
 * one screen a decision is made from, so a field that arrived unchecked would
 * be a decision made on a guess.
 */

export type ComparisonState = {
  comparison: Comparison | null;
  /** Null until the first answer: asking and "no attempts yet" are different. */
  loading: boolean;
  error: string | null;
  refresh: () => void;
  fork: (label: string, goal: string) => Promise<void>;
  /**
   * The most recent choice, whether from this window or read back from the
   * log. Not local UI state: choosing appends `decision.recorded`, and a
   * refresh (or a second window) has to agree with what actually happened,
   * not with whichever tab last clicked the button.
   */
  decision: DecisionSummary | null;
  choosing: boolean;
  choose: (runId: string) => Promise<void>;
};

export const useComparison = (
  endpoint: string,
  sessionId: string | null,
): ComparisonState => {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);
  // What this window's own POST answered, kept only until the next fetch of
  // /compare confirms it — an overlay on the server's own account, not a
  // replacement for it, so a decision recorded elsewhere still wins on reload.
  const [justChose, setJustChose] = useState<DecisionSummary | null>(null);

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  // Keyed on sessionId alone, deliberately not on every refresh: choosing
  // triggers its own refresh, and clearing the overlay there would erase the
  // immediate feedback in the same tick it was set, before the fetch below
  // has a chance to confirm it from the log.
  useEffect(() => {
    setJustChose(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setComparison(null);

      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/compare`,
          { headers: await authorization() },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setError(await readError(response));

          return;
        }

        const parsed = ComparisonSchema.safeParse(await response.json());

        if (!parsed.success) {
          // Refused rather than rendered. A malformed comparison drawn as if it
          // were sound is a decision made on something nobody validated.
          setError("The worker sent a comparison this build cannot read.");

          return;
        }

        setError(null);
        setComparison(parsed.data);
      } catch (cause) {
        if (!cancelled) {
          setError(`Cannot reach the worker at ${endpoint}.`);
          console.error(cause);
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
  }, [endpoint, sessionId, attempt]);

  const fork = useCallback(
    async (label: string, goal: string) => {
      if (!sessionId) {
        return;
      }

      setError(null);

      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/fork`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(await authorization()),
            },
            body: JSON.stringify({ label, goal }),
          },
        );

        if (!response.ok) {
          setError(await readError(response));

          return;
        }

        refresh();
      } catch (cause) {
        setError(`Cannot reach the worker at ${endpoint}.`);
        console.error(cause);
      }
    },
    [endpoint, sessionId, refresh],
  );

  const choose = useCallback(
    async (runId: string) => {
      if (!sessionId) {
        return;
      }

      setError(null);
      setChoosing(true);

      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/decision`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(await authorization()),
            },
            body: JSON.stringify({ runId }),
          },
        );

        if (!response.ok) {
          setError(await readError(response));

          return;
        }

        const body = (await response.json()) as {
          decision: DecisionSummary;
        };

        setJustChose(body.decision);
        refresh();
      } catch (cause) {
        setError(`Cannot reach the worker at ${endpoint}.`);
        console.error(cause);
      } finally {
        setChoosing(false);
      }
    },
    [endpoint, sessionId, refresh],
  );

  return {
    comparison,
    loading,
    error,
    refresh,
    fork,
    decision: justChose ?? comparison?.decision ?? null,
    choosing,
    choose,
  };
};
