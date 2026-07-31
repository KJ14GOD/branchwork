import { useCallback, useState } from "react";

import { readError } from "../http.ts";

/**
 * The actions a joined window can take, authenticated as the *joiner*.
 *
 * Deliberately parallel to `use-session-actions.ts` but not the same hook:
 * that one signs with the host's own token from the preload bridge, and a
 * joined window must never hold that credential — its whole authority is the
 * invite token it was opened with. The worker decides per capability what
 * this token may do; these calls simply carry it, and a 403 surfaces as the
 * error text rather than being assumed impossible.
 */
export type JoinedActions = {
  error: string | null;
  direct: (goal: string) => Promise<boolean>;
  cancel: (runId: string) => Promise<void>;
  pause: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
};

export const useJoinedActions = (
  endpoint: string | null,
  sessionId: string | null,
  token: string | null,
): JoinedActions => {
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    async (path: string, body: unknown): Promise<boolean> => {
      if (!endpoint || !sessionId || !token) {
        setError("This connection is watch-only, so there is nothing to send to.");

        return false;
      }

      try {
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/${path}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          setError(await readError(response));

          return false;
        }

        setError(null);

        return true;
      } catch {
        setError(`Could not reach the host at ${endpoint}.`);

        return false;
      }
    },
    [endpoint, sessionId, token],
  );

  const direct = useCallback(
    (goal: string) => post("direction", { goal }),
    [post],
  );

  const cancel = useCallback(
    async (runId: string) => {
      await post("cancel", { runId });
    },
    [post],
  );

  const pause = useCallback(
    async (runId: string) => {
      await post("pause", { runId });
    },
    [post],
  );

  const resume = useCallback(
    async (runId: string) => {
      await post("resume", { runId });
    },
    [post],
  );

  return { error, direct, cancel, pause, resume };
};
