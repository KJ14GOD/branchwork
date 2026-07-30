import { useEffect, useState } from "react";

import {
  SessionFilesResponseSchema,
  type SessionFilesResponse,
} from "@novus/contracts/protocol";

import { authorization } from "./access.ts";
import { readError } from "./http.ts";

/**
 * What changed in this session's working tree — the desktop equivalent of
 * Conductor's right-hand changed-files list.
 *
 * Sourced from `GET /sessions/:id/files`, which is the worker's own
 * `RunProjection.filesChanged` (the same numbers the compare screen and
 * receipts already use), not a second computation kept in the renderer. Not
 * polled on a timer: it refetches when `version` changes, and the caller is
 * expected to pass a value that only changes when a patch was actually
 * applied — `SessionTab` derives it from the event stream it already holds.
 */

export type FileChangesState = SessionFilesResponse & {
  /** Null until the first answer, same convention `useComparison` uses. */
  loading: boolean;
  error: string | null;
};

const EMPTY: SessionFilesResponse = { files: [], additions: 0, deletions: 0 };

export const useFileChanges = (
  endpoint: string,
  sessionId: string | null,
  version: number,
): FileChangesState => {
  const [data, setData] = useState<SessionFilesResponse>(EMPTY);
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
        const response = await fetch(
          `${endpoint}/sessions/${encodeURIComponent(sessionId)}/files`,
          { headers: await authorization() },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setError(await readError(response));
          return;
        }

        const parsed = SessionFilesResponseSchema.safeParse(
          await response.json(),
        );

        if (!parsed.success) {
          setError("The worker sent a file list this build cannot read.");
          return;
        }

        setError(null);
        setData(parsed.data);
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
  }, [endpoint, sessionId, version]);

  return { ...data, loading, error };
};
