import { useCallback, useEffect, useState } from "react";

import { ComparisonSchema, type Comparison } from "@novus/contracts/protocol";

import { authorization } from "./access.ts";

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
  /** Which attempt the host settled on, for this window's benefit. */
  chosen: string | null;
  choose: (runId: string) => void;
};

const readError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string };

    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

export const useComparison = (
  endpoint: string,
  sessionId: string | null,
): ComparisonState => {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

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

  const choose = useCallback((runId: string) => {
    // Local to this window, deliberately. V1 says the merge is always a human
    // decision and applying a patch is a separate, permissioned step — so
    // choosing here records what the host settled on and does not reach into
    // anybody's repository on its own.
    setChosen(runId);
  }, []);

  return { comparison, loading, error, refresh, fork, chosen, choose };
};
