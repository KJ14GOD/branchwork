import { useCallback, useEffect, useState } from "react";

import { authorization } from "./access.ts";
import {
  HostCapabilitiesSchema,
  InviteResponseSchema,
  SessionHistorySchema,
  type InviteResponse,
  type RememberedSession,
  SessionSummarySchema,
  type HostCapabilities,
  type SessionSummary,
} from "@novus/contracts/protocol";

export type InviteRole = "editor" | "reviewer" | "viewer";

export type SessionState = {
  session: SessionSummary | null;
  opening: boolean;
  error: string | null;
  open: (
    repositoryPath: string,
    allowWrites: boolean,
    allowCommands: boolean,
    /** A session id from the log, to bring its timeline back with it. */
    resume?: string,
  ) => Promise<void>;
  /** Sessions the log remembers, for the Open screen. */
  remembered: RememberedSession[];
  /** What the host permits, or null until the worker has answered. */
  capabilities: HostCapabilities | null;
  ask: (goal: string) => Promise<void>;
  /** Mints a token for a new participant. Null on failure — `error` says why. */
  invite: (name: string, role: InviteRole) => Promise<InviteResponse | null>;
  /** Recorded for the running turn to fold in, not applied immediately. */
  direct: (goal: string) => Promise<void>;
  /**
   * Requests that a run stop. Recorded immediately; the run itself appends
   * `run.cancelled` once it actually stops, at its next turn boundary.
   */
  cancel: (runId: string) => Promise<void>;
  close: () => void;
};

const readError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string };

    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

/**
 * Owns the worker session: choosing a repository and submitting turns.
 *
 * Progress is never returned here — it arrives on the event stream, so the
 * timeline stays the single source of truth for what happened.
 */
export const useSession = (endpoint: string): SessionState => {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(
    null,
  );
  const [remembered, setRemembered] = useState<RememberedSession[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Asked once, alongside /health. A list of previous sessions is the only way
  // back to work done before the last restart.
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
  }, [endpoint, session]);

  const open = useCallback(
    async (
      repositoryPath: string,
      allowWrites: boolean,
      allowCommands: boolean,
      resume?: string,
    ) => {
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
          return;
        }

        setSession(SessionSummarySchema.parse(await response.json()));
      } catch (cause) {
        setError(
          `Cannot reach the worker at ${endpoint}. Start it with pnpm --filter @novus/worker start.`,
        );
        console.error(cause);
      } finally {
        setOpening(false);
      }
    },
    [endpoint],
  );

  const ask = useCallback(
    async (goal: string) => {
      if (!session) {
        return;
      }

      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(session.id)}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify({ goal }),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, session],
  );

  const invite = useCallback(
    async (name: string, role: InviteRole): Promise<InviteResponse | null> => {
      if (!session) {
        return null;
      }

      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(session.id)}/invite`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify({ name, role }),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
        return null;
      }

      return InviteResponseSchema.parse(await response.json());
    },
    [endpoint, session],
  );

  const direct = useCallback(
    async (goal: string) => {
      if (!session) {
        return;
      }

      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(session.id)}/direction`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify({ goal }),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, session],
  );

  const cancel = useCallback(
    async (runId: string) => {
      if (!session) {
        return;
      }

      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(session.id)}/cancel`,
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
      }
    },
    [endpoint, session],
  );

  const close = useCallback(() => {
    setSession(null);
    setError(null);
  }, []);

  return {
    session,
    capabilities,
    remembered,
    opening,
    error,
    open,
    ask,
    invite,
    direct,
    cancel,
    close,
  };
};
