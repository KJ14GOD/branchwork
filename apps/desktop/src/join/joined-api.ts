import type { MissionOutcome } from "@novus/contracts";
import {
  AuthorityResponseSchema,
  ComparisonSchema,
  SessionFilesResponseSchema,
  type Authority,
  type Comparison,
  type SessionFilesResponse,
} from "@novus/contracts/protocol";

import { readError } from "../http.ts";

/**
 * Every call a joined window makes, as plain functions.
 *
 * Separated from the hooks that drive them for one reason: a hook can only be
 * exercised by a renderer, and the thing worth pinning here is not when React
 * re-renders — it is that the *wire* is right. These functions run against a
 * real worker in `joined-api.test.ts`, so "the named recipient can accept" is
 * proven against the route that decides it rather than against a mock that
 * agrees with whatever this file happens to send.
 *
 * All of them authenticate as the *joiner*. A joined window never holds the
 * host's own token — its whole standing is the invite it was opened with, and
 * the worker re-decides per capability on every request. A 403 here is an
 * expected outcome to report, not an impossibility.
 */

export type JoinedTarget = {
  endpoint: string;
  sessionId: string;
  token: string;
};

/** Refused and unreachable both land here; the caller shows `error` either way. */
export type JoinedResult = { ok: true } | { ok: false; error: string };

export type HandoffAnswer = "accept" | "decline" | "withdraw";

const send = async (
  target: JoinedTarget,
  path: string,
  body: unknown,
): Promise<JoinedResult> => {
  const { endpoint, sessionId, token } = target;

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
      return { ok: false, error: await readError(response) };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: `Could not reach the host at ${endpoint}.` };
  }
};

export const submitDirection = (
  target: JoinedTarget,
  goal: string,
): Promise<JoinedResult> => send(target, "direction", { goal });

export const steerRun = (
  target: JoinedTarget,
  action: "cancel" | "pause" | "resume",
  runId: string,
): Promise<JoinedResult> => send(target, action, { runId });

/**
 * Asking is not taking.
 *
 * The route needs only `watch`, so any participant may ask — and nothing about
 * a 202 here says control moved. It records a standing fact the controller can
 * answer whenever they next look, which is why the reason is worth carrying.
 */
export const requestControl = (
  target: JoinedTarget,
  reason?: string,
): Promise<JoinedResult> =>
  send(target, "control/request", reason ? { reason } : {});

export const offerControl = (
  target: JoinedTarget,
  toParticipantId: string,
): Promise<JoinedResult> => send(target, "handoff", { toParticipantId });

/**
 * The offer's id travels with the answer, not just the verb.
 *
 * A window that has gone stale — the offer withdrawn and another made in its
 * place — is refused rather than settling one it never showed anybody.
 */
export const answerHandoff = (
  target: JoinedTarget,
  offerEventId: string,
  answer: HandoffAnswer,
): Promise<JoinedResult> =>
  send(target, `handoff/${answer}`, { offerEventId });

/**
 * Declaring the mission over, and taking that back.
 *
 * The judgement travels; the evidence does not. `verification` and
 * `filesChanged` are computed by the worker from the session's own projection
 * and frozen onto the event, so there is deliberately nothing here for a
 * joined window to state about what was proven — a client that could say
 * "verified" could finish a mission green having run nothing.
 */
export const completeMission = (
  target: JoinedTarget,
  outcome: MissionOutcome,
  summary: string,
): Promise<JoinedResult> =>
  send(target, "complete", { outcome, summary });

export const reopenMission = (
  target: JoinedTarget,
  reason: string,
): Promise<JoinedResult> => send(target, "reopen", { reason });

/**
 * One validated GET, for the reads that are evidence rather than authority.
 *
 * Same judgement `readAuthority` makes and for the same reason: this is an
 * overlay on a session that works without it, so a refusal or an unreachable
 * host sets it empty rather than raising an error over the timeline. Null
 * means "nothing to show", never "there are no changes" — the caller draws
 * the panel only when it has something.
 */
const read = async <T>(
  target: JoinedTarget,
  path: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  signal?: AbortSignal,
): Promise<T | null> => {
  const { endpoint, sessionId, token } = target;

  try {
    const response = await fetch(
      `${endpoint}/sessions/${encodeURIComponent(sessionId)}/${path}`,
      {
        ...(signal ? { signal } : {}),
        headers: { authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      return null;
    }

    const parsed = parse(await response.json());

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** What this mission changed: the worker's own projection, not a second tally. */
export const readFiles = (
  target: JoinedTarget,
  signal?: AbortSignal,
): Promise<SessionFilesResponse | null> =>
  read(
    target,
    "files",
    (value) => SessionFilesResponseSchema.safeParse(value),
    signal,
  );

/**
 * The approaches and what each of them proved.
 *
 * The same read the host's compare screen makes. A joined window renders no
 * decision surface — choosing between attempts is owner-only and stays
 * host-side — but the test counts on it are the only session-wide statement of
 * what was actually verified, and a teammate asked to agree a mission is
 * finished needs exactly that.
 */
export const readComparison = (
  target: JoinedTarget,
  signal?: AbortSignal,
): Promise<Comparison | null> =>
  read(target, "compare", (value) => ComparisonSchema.safeParse(value), signal);

/**
 * Who holds control, who is asking, and what direction is waiting.
 *
 * Validated against the shared schema rather than trusted: this is the one
 * link between the worker's fold and what a joined window draws, and an
 * unvalidated read of it fails as a panel that is silently blank instead of a
 * request that visibly did not parse. Null means "no answer to show" — a
 * worker with no participant registry 404s here by design, and the single-user
 * path is not an error worth putting a banner over a run for.
 */
export const readAuthority = async (
  target: JoinedTarget,
  signal?: AbortSignal,
): Promise<Authority | null> => {
  const { endpoint, sessionId, token } = target;

  try {
    const response = await fetch(
      `${endpoint}/sessions/${encodeURIComponent(sessionId)}/authority`,
      {
        ...(signal ? { signal } : {}),
        headers: { authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      return null;
    }

    const parsed = AuthorityResponseSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : null;
  } catch {
    // The event stream's own status already reports an unreachable worker.
    return null;
  }
};
