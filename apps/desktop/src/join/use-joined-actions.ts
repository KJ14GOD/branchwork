import { useCallback, useMemo, useState } from "react";

import {
  answerHandoff,
  offerControl,
  requestControl,
  steerRun,
  submitDirection,
  type HandoffAnswer,
  type JoinedResult,
  type JoinedTarget,
} from "./joined-api.ts";

/**
 * The actions a joined window can take, authenticated as the *joiner*.
 *
 * Deliberately parallel to `use-session-actions.ts` but not the same hook:
 * that one signs with the host's own token from the preload bridge, and a
 * joined window must never hold that credential — its whole authority is the
 * invite token it was opened with. The worker decides per capability what
 * this token may do; these calls simply carry it, and a 403 surfaces as the
 * error text rather than being assumed impossible.
 *
 * The wire itself lives in `joined-api.ts`. This is the React skin over it:
 * one error string, and a refresh the caller hangs off every control action
 * so the panel redraws on the answer rather than up to a poll later.
 */
export type JoinedActions = {
  error: string | null;
  direct: (goal: string) => Promise<boolean>;
  cancel: (runId: string) => Promise<void>;
  pause: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
  /** Asking is not taking. The controller answers it whenever they next look. */
  requestControl: (reason?: string) => Promise<void>;
  /** Only meaningful for a joiner who holds control — the worker checks. */
  offerControl: (toParticipantId: string) => Promise<void>;
  answerHandoff: (offerEventId: string, answer: HandoffAnswer) => Promise<void>;
};

export const useJoinedActions = (
  endpoint: string | null,
  sessionId: string | null,
  token: string | null,
  /** Called after anything that can have moved authority. */
  onAuthorityChanged?: () => void,
): JoinedActions => {
  const [error, setError] = useState<string | null>(null);

  const target = useMemo<JoinedTarget | null>(
    () =>
      endpoint && sessionId && token ? { endpoint, sessionId, token } : null,
    [endpoint, sessionId, token],
  );

  const attempt = useCallback(
    async (call: (target: JoinedTarget) => Promise<JoinedResult>) => {
      if (!target) {
        // A relay join, structurally. The transport carries the log outbound
        // and has no way to send anything back.
        setError("This connection is watch-only, so there is nothing to send to.");

        return false;
      }

      const result = await call(target);

      setError(result.ok ? null : result.error);

      return result.ok;
    },
    [target],
  );

  const direct = useCallback(
    (goal: string) => attempt((into) => submitDirection(into, goal)),
    [attempt],
  );

  const steer = useCallback(
    async (action: "cancel" | "pause" | "resume", runId: string) => {
      await attempt((into) => steerRun(into, action, runId));
    },
    [attempt],
  );

  const cancel = useCallback(
    (runId: string) => steer("cancel", runId),
    [steer],
  );

  const pause = useCallback((runId: string) => steer("pause", runId), [steer]);

  const resume = useCallback(
    (runId: string) => steer("resume", runId),
    [steer],
  );

  const ask = useCallback(
    async (reason?: string) => {
      await attempt((into) => requestControl(into, reason));
      // Even a refused request is worth re-reading after: if it was refused
      // because control already moved, the panel is now wrong about more than
      // this one button.
      onAuthorityChanged?.();
    },
    [attempt, onAuthorityChanged],
  );

  const offer = useCallback(
    async (toParticipantId: string) => {
      await attempt((into) => offerControl(into, toParticipantId));
      onAuthorityChanged?.();
    },
    [attempt, onAuthorityChanged],
  );

  const answer = useCallback(
    async (offerEventId: string, verb: HandoffAnswer) => {
      await attempt((into) => answerHandoff(into, offerEventId, verb));
      onAuthorityChanged?.();
    },
    [attempt, onAuthorityChanged],
  );

  return {
    error,
    direct,
    cancel,
    pause,
    resume,
    requestControl: ask,
    offerControl: offer,
    answerHandoff: answer,
  };
};
