import { useCallback, useState } from "react";

import { authorization } from "./access.ts";
import { readError } from "./http.ts";
import {
  InviteResponseSchema,
  type InviteResponse,
  type SessionSummary,
} from "@novus/contracts/protocol";

export type InviteRole = "editor" | "reviewer" | "viewer";

export type SessionActions = {
  error: string | null;
  ask: (goal: string, modelId?: string | null) => Promise<void>;
  /** Mints a token for a new participant. Null on failure — `error` says why. */
  invite: (name: string, role: InviteRole) => Promise<InviteResponse | null>;
  /** Recorded for the running turn to fold in, not applied immediately. */
  direct: (goal: string) => Promise<void>;
  /**
   * Requests that a run stop. Recorded immediately; the run itself appends
   * `run.cancelled` once it actually stops, at its next turn boundary.
   */
  cancel: (runId: string) => Promise<void>;
  /**
   * Requests that a run suspend. Recorded immediately, same as cancel; the
   * run itself appends `run.paused` once it actually stops, at the same turn
   * boundary. Unlike cancel, this run can be picked back up with `resume`.
   */
  pause: (runId: string) => Promise<void>;
  /** Continues a run this session previously paused. */
  resume: (runId: string) => Promise<void>;
  /** Moves execution authority to another participant in this session. */
  handoff: (toParticipantId: string) => Promise<void>;
};

/**
 * The actions one open session (one tab) can take.
 *
 * Split out of what used to be `useSession` so that hook could stop owning
 * "the" session — the app now holds several at once, one per tab, and each
 * tab's `<SessionTab>` calls this with the fixed `SessionSummary` it was
 * opened with. `session` never changes identity for the life of a tab, so
 * every action below closes over `session.id` rather than re-reading state.
 */
export const useSessionActions = (
  endpoint: string,
  session: SessionSummary,
): SessionActions => {
  const [error, setError] = useState<string | null>(null);
  const sessionId = session.id;

  const ask = useCallback(
    async (goal: string, modelId?: string | null) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify(
            modelId ? { goal, model: { provider: "anthropic", model: modelId } } : { goal },
          ),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, sessionId],
  );

  const invite = useCallback(
    async (name: string, role: InviteRole): Promise<InviteResponse | null> => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/invite`,
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
    [endpoint, sessionId],
  );

  const direct = useCallback(
    async (goal: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/direction`,
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
    [endpoint, sessionId],
  );

  const cancel = useCallback(
    async (runId: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/cancel`,
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
    [endpoint, sessionId],
  );

  const pause = useCallback(
    async (runId: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/pause`,
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
    [endpoint, sessionId],
  );

  const resume = useCallback(
    async (runId: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/resume`,
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
    [endpoint, sessionId],
  );

  const handoff = useCallback(
    async (toParticipantId: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/handoff`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify({ toParticipantId }),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, sessionId],
  );

  return { error, ask, invite, direct, cancel, pause, resume, handoff };
};
