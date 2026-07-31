import { ParticipantSchema, type Participant } from "@novus/contracts";
import {
  SessionSummarySchema,
  type SessionSummary,
} from "@novus/contracts/protocol";

import { resolveEndpoint } from "./endpoint.ts";

/**
 * The reads a watching client is allowed to make.
 *
 * Reading the session index is how a client tells "the worker is down" apart
 * from "that session id is wrong" — two situations that look identical on an
 * empty timeline. Reading `/me` is how a joined desktop window learns which
 * role its token actually carries, instead of guessing from the link.
 * Nothing here posts, and nothing here may: acting on a session is the
 * joined window's own affair, gated by the worker per capability.
 */
export type SessionListing =
  | { kind: "ok"; sessions: SessionSummary[] }
  /** The worker is up but exposes no session index, so ids cannot be checked. */
  | { kind: "unlisted" }
  | { kind: "unreachable"; detail: string }
  /** The address was never contacted. See `resolveEndpoint`. */
  | { kind: "refused"; reason: string };

/**
 * A guest's credential, taken from the invite link.
 *
 * The worker refuses an unauthenticated caller, so a guest without a token gets
 * a 401 rather than an empty list — which is the honest outcome: they were sent
 * a link that did not include one, or a stale one.
 */
export const fetchSessions = async (
  endpoint: string,
  signal: AbortSignal,
  token?: string,
): Promise<SessionListing> => {
  // Checked here rather than at the caller because this is the only fetch the
  // guest makes, and a rule enforced at the boundary cannot be forgotten by
  // the next caller.
  const address = resolveEndpoint(endpoint);

  if (address.kind === "refused") {
    return { kind: "refused", reason: address.reason };
  }

  let response: Response;

  try {
    response = await fetch(`${address.endpoint}/sessions`, {
      signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch (cause) {
    return { kind: "unreachable", detail: (cause as Error).message };
  }

  // A worker started without a session registry answers 404 here. It can still
  // stream events, so this is a narrower blindness than being offline.
  if (response.status === 401) {
    return {
      kind: "refused",
      reason:
        "This worker requires an invite token. The link you followed did not carry one, or it is no longer valid.",
    };
  }

  if (response.status === 404) {
    return { kind: "unlisted" };
  }

  if (!response.ok) {
    return { kind: "unreachable", detail: `HTTP ${response.status}` };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    return { kind: "unreachable", detail: (cause as Error).message };
  }

  const listed = (body as { sessions?: unknown }).sessions;

  if (!Array.isArray(listed)) {
    return { kind: "unreachable", detail: "The session list was malformed." };
  }

  // Validated one at a time so a single unrecognised session does not hide the
  // rest of them from the guest.
  const sessions = listed.flatMap((item) => {
    const parsed = SessionSummarySchema.safeParse(item);

    return parsed.success ? [parsed.data] : [];
  });

  return { kind: "ok", sessions };
};

/**
 * Who this token is, according to the worker.
 *
 * The invite link carries a credential and nothing about the person it was
 * minted for, so a joined window has no honest way to know its own role
 * without asking — and the role can change under it, because a handoff is a
 * role change. `absent` covers both a worker with no participant registry
 * (single-player, nobody was ever invited) and a session it does not know.
 */
export type MembershipReport =
  | { kind: "ok"; participant: Participant }
  | { kind: "absent" }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; detail: string };

export const fetchMembership = async (
  endpoint: string,
  sessionId: string,
  token: string,
  signal: AbortSignal,
): Promise<MembershipReport> => {
  const address = resolveEndpoint(endpoint);

  if (address.kind === "refused") {
    return { kind: "refused", reason: address.reason };
  }

  let response: Response;

  try {
    response = await fetch(
      `${address.endpoint}/sessions/${encodeURIComponent(sessionId)}/me`,
      { signal, headers: { authorization: `Bearer ${token}` } },
    );
  } catch (cause) {
    return { kind: "unreachable", detail: (cause as Error).message };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: "refused",
      reason: "This invite token is no longer accepted by the worker.",
    };
  }

  if (response.status === 404) {
    return { kind: "absent" };
  }

  if (!response.ok) {
    return { kind: "unreachable", detail: `HTTP ${response.status}` };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    return { kind: "unreachable", detail: (cause as Error).message };
  }

  // The envelope is hand-shaped and the payload is the schema, the same split
  // `fetchSessions` above already uses for `{ sessions }`.
  const parsed = ParticipantSchema.safeParse(
    (body as { participant?: unknown }).participant,
  );

  if (!parsed.success) {
    return { kind: "unreachable", detail: "The membership answer was malformed." };
  }

  return { kind: "ok", participant: parsed.data };
};
