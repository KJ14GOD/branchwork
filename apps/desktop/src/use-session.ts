import { useCallback, useEffect, useState } from "react";

import { authorization } from "./access.ts";
import { readError } from "./http.ts";
import {
  HostCapabilitiesSchema,
  SessionHistorySchema,
  type RememberedSession,
  SessionSummarySchema,
  type HostCapabilities,
  type SessionSummary,
} from "@novus/contracts/protocol";

export type OpenSessionState = {
  /** What the host permits, or null until the worker has answered. */
  capabilities: HostCapabilities | null;
  /** Sessions the log remembers, newest activity first — for the Open screen
   * and for the tab bar's "new tab" flow to offer the same list. */
  remembered: RememberedSession[];
  opening: boolean;
  error: string | null;
  /**
   * Opens or resumes a session and returns its summary. Returns null on
   * failure — `error` says why. Deliberately does not hold the result as
   * this hook's own state: the app can have several open at once now, one per
   * tab, and this hook only ever creates or finds one.
   */
  open: (
    repositoryPath: string,
    allowWrites: boolean,
    allowCommands: boolean,
    /** A session id from the log, to bring its timeline back with it. */
    resume?: string,
  ) => Promise<SessionSummary | null>;
};

/**
 * The worker's session catalog: what the host permits, and what the log
 * remembers. One instance for the whole app — capabilities and history are
 * not per-tab, they are what a tab is opened *from*.
 */
export const useSession = (endpoint: string): OpenSessionState => {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(
    null,
  );
  const [remembered, setRemembered] = useState<RememberedSession[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after every successful open, so a freshly created session shows up
  // in "carry on with" without waiting for anything else to change.
  const [historyTick, setHistoryTick] = useState(0);

  // Asked once, on the way in. A worker that is not up yet simply leaves this
  // null, and the controls stay off — the safe direction to fail.
  useEffect(() => {
    let cancelled = false;

    // /health needs no token — it is how a client learns the worker is up.
    void fetch(`${endpoint}/health`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled || body === null) {
          return;
        }

        const parsed = HostCapabilitiesSchema.safeParse(body);

        if (parsed.success) {
          setCapabilities(parsed.data);
        }
      })
      .catch(() => {
        // The open screen already reports an unreachable worker.
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  // Asked on the way in, and again after every session this app opens. A list
  // of previous sessions is the only way back to work done before the last
  // restart, or in a tab this window has not opened yet.
  useEffect(() => {
    let cancelled = false;

    void authorization()
      .then((headers) => fetch(`${endpoint}/sessions/history`, { headers }))
      .then(async (response) => {
        if (!response.ok || cancelled) {
          return;
        }

        const parsed = SessionHistorySchema.safeParse(await response.json());

        if (parsed.success) {
          setRemembered(parsed.data.sessions);
        }
      })
      .catch(() => {
        // The open screen already reports an unreachable worker.
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint, historyTick]);

  const open = useCallback(
    async (
      repositoryPath: string,
      allowWrites: boolean,
      allowCommands: boolean,
      resume?: string,
    ): Promise<SessionSummary | null> => {
      setOpening(true);
      setError(null);

      try {
        const response = await fetch(`${endpoint}/sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify({
            repositoryPath,
            allowWrites,
            allowCommands,
            ...(resume === undefined ? {} : { resume }),
          }),
        });

        if (!response.ok) {
          setError(await readError(response));
          return null;
        }

        const summary = SessionSummarySchema.parse(await response.json());
        setHistoryTick((value) => value + 1);
        return summary;
      } catch (cause) {
        setError(
          `Cannot reach the worker at ${endpoint}. Start it with pnpm --filter @novus/worker start.`,
        );
        console.error(cause);
        return null;
      } finally {
        setOpening(false);
      }
    },
    [endpoint],
  );

  return { capabilities, remembered, opening, error, open };
};
