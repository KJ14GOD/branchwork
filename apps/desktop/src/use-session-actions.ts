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
  /**
   * `choice` is the picker's *option*, not its id.
   *
   * Deliberately an object rather than a `string | null`. A `TurnModelId` is
   * a string too, so a call site that reached for `turnModel.selected` when it
   * meant `turnModel.option.modelId` typechecked perfectly and sent the
   * provider the literal word "auto" — the worker refused it, correctly, and
   * every mission on that screen simply failed to start. Taking the object
   * makes that mistake a compile error instead of a runtime one.
   */
  ask: (goal: string, choice?: { modelId: string | null } | null) => Promise<void>;
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
  /**
   * Offers execution authority to another participant. An offer, not a move —
   * control changes hands only once they accept, and then only at a safe
   * boundary if something is running.
   */
  handoff: (toParticipantId: string) => Promise<void>;
  /** Asks whoever holds control for it. Standing until answered or you leave. */
  requestControl: (reason?: string) => Promise<void>;
  /** Answers an offer made to you, or takes back one you made. */
  answerHandoff: (
    offerEventId: string,
    answer: "accept" | "decline" | "withdraw",
  ) => Promise<void>;
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
    async (goal: string, choice?: { modelId: string | null } | null) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify(
            choice?.modelId
              ? { goal, model: { provider: "anthropic", model: choice.modelId } }
              : // No model named is a request to let the worker's own router
                // decide, which is what "Auto" means. It must send no `model`
                // key at all — the turns route validates any model it is given
                // against the adapters that exist.
                { goal },
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

  const requestControl = useCallback(
    async (reason?: string) => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/control/request`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          body: JSON.stringify(reason ? { reason } : {}),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, sessionId],
  );

  const answerHandoff = useCallback(
    async (offerEventId: string, answer: "accept" | "decline" | "withdraw") => {
      const response = await fetch(
        `${endpoint}/sessions/${encodeURIComponent(sessionId)}/handoff/${answer}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authorization()),
          },
          // The offer's id, not just the verb. An answer sent from a screen
          // that has gone stale — the offer withdrawn and another made in its
          // place — is refused rather than settling one this window never
          // showed anybody.
          body: JSON.stringify({ offerEventId }),
        },
      );

      if (!response.ok) {
        setError(await readError(response));
      }
    },
    [endpoint, sessionId],
  );

  return {
    error,
    ask,
    invite,
    direct,
    cancel,
    pause,
    resume,
    handoff,
    requestControl,
    answerHandoff,
  };
};
