import { resolveEndpoint, resolveRelay } from "./endpoint.ts";

/**
 * What a pasted invite means, decided in one place.
 *
 * An invite is a URL a host handed to a teammate — the same URL the browser
 * guest opens directly. The desktop app's join screen accepts that URL pasted
 * into a field instead of typed into an address bar, so both clients must
 * agree on what it carries: `token` always, then either `relay` (read the
 * session from a relay, which is what lets a teammate be on another machine)
 * or `session` plus an optional `endpoint` (read it from the host's worker
 * over loopback).
 *
 * The refusals here are the same ones `resolveEndpoint` and `resolveRelay`
 * make at connect time, applied *before* anything is contacted — a crafted
 * invite should fail while it is still a string in a text field, with a reason
 * a person can read. Parsing does not relax either rule: a desktop client is
 * not a browser, but a plaintext relay off this machine is exactly as
 * readable and rewritable either way.
 */

export type ParsedInvite =
  /** Read the session from the host's worker, over loopback. */
  | { kind: "worker"; endpoint: string; sessionId: string; token: string }
  /** Read the session from a relay; the token names which session. */
  | { kind: "relay"; relay: string; token: string };

export type InviteCheck =
  | { kind: "ok"; invite: ParsedInvite }
  /** Nothing was contacted. `reason` is written to be read on screen. */
  | { kind: "refused"; reason: string };

export const parseInvite = (
  raw: string,
  /**
   * Where the worker lives when the invite names a session but no endpoint.
   * The guest defaults this from its own URL; the desktop passes the standard
   * worker address. Still checked by `resolveEndpoint` like anything else.
   */
  fallbackEndpoint: string,
): InviteCheck => {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return {
      kind: "refused",
      reason: "Paste the invite link the host gave you.",
    };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return {
      kind: "refused",
      reason: `“${trimmed}” is not a link. An invite is the full URL the host copied out of Novus.`,
    };
  }

  const token = url.searchParams.get("token");

  if (!token) {
    return {
      kind: "refused",
      reason:
        "This link carries no token, so the host would refuse it. Ask for a fresh invite — the token is minted with the link and shown exactly once.",
    };
  }

  const relay = url.searchParams.get("relay");

  if (relay !== null) {
    // Checked before the session id, same as the guest's own connect path: a
    // relay serves whichever session its token authorises, so a relay invite
    // does not carry one.
    const address = resolveRelay(relay);

    if (address.kind === "refused") {
      return { kind: "refused", reason: address.reason };
    }

    return { kind: "ok", invite: { kind: "relay", relay: address.endpoint, token } };
  }

  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return {
      kind: "refused",
      reason:
        "This link names no session and no relay, so there is nothing to join. An invite carries ?session= or ?relay=.",
    };
  }

  const address = resolveEndpoint(url.searchParams.get("endpoint") ?? fallbackEndpoint);

  if (address.kind === "refused") {
    return { kind: "refused", reason: address.reason };
  }

  return {
    kind: "ok",
    invite: { kind: "worker", endpoint: address.endpoint, sessionId, token },
  };
};
