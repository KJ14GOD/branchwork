/**
 * The one place that decides where a guest is allowed to point.
 *
 * The address bar is the invite link, which means the endpoint is attacker
 * input: anyone who can get a URL in front of someone can choose the host this
 * client talks to. Nothing local leaks and no script of theirs runs, but the
 * frames they send would be drawn inside a Novus-branded window under a
 * "read-only" badge, and the guest would keep beaconing to them. A fabricated
 * run that looks like the host's own is worth refusing on its own.
 *
 * Until a session service exists, a guest is a second browser on the machine
 * running the worker, so the honest rule is the narrow one: http or https, on
 * loopback, and nothing else. A refusal says which rule it broke — silently
 * substituting the default would hide a link that was crafted rather than
 * mistyped.
 */

export type EndpointCheck =
  /** Safe to hand to `fetch` and `EventSource`. Normalised to an origin. */
  | { kind: "ok"; endpoint: string }
  /** Not contacted at all. `reason` is written to be read on screen. */
  | { kind: "refused"; reason: string };

/**
 * `URL` normalises an IPv6 host to its bracketed form, so `[::1]` is the shape
 * that arrives here. Loopback is spelled out rather than pattern-matched: the
 * three names a host actually prints are the three a guest needs.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const LOOPBACK_LIST = "127.0.0.1, localhost, or [::1]";

export const resolveEndpoint = (raw: string): EndpointCheck => {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return {
      kind: "refused",
      reason: `No worker address was given. A Novus worker lives at one of ${LOOPBACK_LIST} — for example http://127.0.0.1:4319.`,
    };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    // The typo case, and the one that used to throw out of an unhandled
    // promise and leave the screen saying "locating" forever.
    return {
      kind: "refused",
      reason: `“${trimmed}” is not an address. A worker address includes its scheme and port, like http://127.0.0.1:4319.`,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      kind: "refused",
      reason: `A worker is reached over http or https, and “${trimmed}” uses ${url.protocol.replace(":", "")}.`,
    };
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      kind: "refused",
      reason: `${url.hostname} is not this machine. Novus runs the worker beside you, so a guest only connects to ${LOOPBACK_LIST}; anything else could draw its own events inside this window and pass them off as the host's.`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    // `http://127.0.0.1@evil.example` is the trick this closes, and a real
    // worker has no credentials to send anyway.
    return {
      kind: "refused",
      reason: `A worker address carries no username or password, and “${trimmed}” does.`,
    };
  }

  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    // Dropping the extra silently would be a small lie, and the guest appends
    // its own paths to whatever it is given.
    return {
      kind: "refused",
      reason: `A worker address is an origin with nothing after it, and “${trimmed}” has a path.`,
    };
  }

  return { kind: "ok", endpoint: url.origin };
};

/**
 * Where a guest may reach a relay, which is a different question.
 *
 * The rule above exists because the worker is a loopback service: an address
 * that is not loopback is not a worker, so refusing it costs nothing. A relay
 * is the opposite — the entire point is that it sits somewhere both the host
 * and a teammate can reach, so the loopback rule would refuse every real one.
 *
 * The concern does not go away with it. An invite link still chooses the host
 * this client talks to, and a fabricated session drawn under a Novus badge is
 * still worth refusing. What replaces the loopback rule is transport security:
 * anything not on this machine must be `wss://`, so an invite cannot quietly
 * point a teammate at a plaintext socket that anyone on the path can read or
 * rewrite. Plain `ws://` stays legal for loopback, because that is a developer
 * running the relay locally and there is no path to be on.
 */
export const resolveRelay = (raw: string): EndpointCheck => {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return {
      kind: "refused",
      reason: "No relay address was given. An invite link carries one.",
    };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return {
      kind: "refused",
      reason: `"${trimmed}" is not a URL, so there is nothing to connect to.`,
    };
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return {
      kind: "refused",
      reason: `A relay speaks WebSocket, and "${trimmed}" is ${url.protocol.replace(":", "")}.`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    // `wss://relay.example@evil.example` resolves to evil.example. The part
    // before the @ is not the host, and it is written to look like one.
    return {
      kind: "refused",
      reason: `"${trimmed}" hides its real host behind credentials, which is how a link is made to look like somewhere it is not.`,
    };
  }

  if (url.protocol === "ws:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      kind: "refused",
      reason: `"${trimmed}" is an unencrypted connection to ${url.hostname}. A relay off this machine must be wss:// — anyone on the path can otherwise read the session or rewrite it.`,
    };
  }

  return { kind: "ok", endpoint: url.origin };
};
