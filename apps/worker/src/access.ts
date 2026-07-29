import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who is allowed to talk to the worker.
 *
 * The worker holds the repository, the provider key, and the ability to run
 * commands. It listens on loopback, which is often mistaken for a boundary — it
 * is not one. Every page open in the user's browser can reach 127.0.0.1, and
 * the server was answering all of them: `Access-Control-Allow-Origin: *` with no
 * credential meant any site could POST a turn and start an agent run against
 * whatever repository happened to be open. Nothing had to be clicked.
 *
 * So a token, and an origin rule, and they answer different questions. The
 * token answers "may this caller act", and is what an invite link will
 * eventually carry. The origin rule answers "may this page even ask", which
 * matters because a browser attaches no token but will happily send a request
 * on a hostile page's behalf.
 */

const TOKEN_BYTES = 32;

export const mintAccessToken = (): string =>
  randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * Compared in constant time.
 *
 * A token check that returns early on the first wrong byte tells an attacker
 * how much of a guess was right, and this endpoint can be probed as fast as the
 * loopback interface allows.
 */
export const tokensMatch = (expected: string, offered: string): boolean => {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so pad the comparison to a fixed width instead of branching on it.
  const width = Math.max(a.length, b.length, 1);
  const left = Buffer.alloc(width);
  const right = Buffer.alloc(width);

  a.copy(left);
  b.copy(right);

  return timingSafeEqual(left, right) && a.length === b.length;
};

/**
 * The token a request offered, if any.
 *
 * A header is the right place for a credential, but EventSource cannot set one,
 * and the event stream is exactly what a guest needs. So the query parameter is
 * accepted too — deliberately, with the cost understood: a URL carrying a token
 * ends up in shell history and in the address bar. That is the same trade every
 * invite link makes, and it is why the token is per-run rather than durable.
 */
export const offeredToken = (
  authorization: string | undefined,
  url: URL,
): string | null => {
  const header = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  return header ?? url.searchParams.get("token");
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether a browser origin may talk to the worker at all.
 *
 * Reflecting the caller's own origin rather than `*` is what lets the response
 * carry credentials, and refusing anything that is not loopback keeps a page on
 * the open internet from using the user's browser as a way in. A request with
 * no Origin header is not from a page — curl, the Electron main process, a test
 * — and is judged on its token alone.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);

    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOOPBACK_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
};
