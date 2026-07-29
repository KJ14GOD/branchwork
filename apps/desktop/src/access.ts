import { bridge } from "./bridge.ts";

/**
 * The credential the renderer needs to reach its own worker.
 *
 * It arrives through the preload bridge and is never put in the page URL or the
 * DOM, because the renderer is a browser and anything in either is readable by
 * anything that ends up running there. Held in a module variable rather than
 * storage for the same reason: it should not outlive the window.
 *
 * Absent outside Electron — a browser opening the desktop UI directly has no
 * bridge, gets no token, and is refused by the worker. That is the intended
 * outcome, not a gap: the desktop client is a host-side surface, and the guest
 * is the thing designed to be opened from a link.
 */
let cached: Promise<string | null> | null = null;

export const accessToken = (): Promise<string | null> => {
  cached ??= (async () => {
    const host = bridge();

    if (!host) {
      return null;
    }

    try {
      return await host.accessToken();
    } catch {
      return null;
    }
  })();

  return cached;
};

/** Authorization header for a fetch, empty when there is no token to send. */
export const authorization = async (): Promise<Record<string, string>> => {
  const token = await accessToken();

  return token ? { authorization: `Bearer ${token}` } : {};
};

/**
 * A URL carrying the token as a query parameter.
 *
 * Only for EventSource, which cannot set a header. Every other call uses the
 * header form.
 */
export const withToken = async (url: string): Promise<string> => {
  const token = await accessToken();

  if (!token) {
    return url;
  }

  const parsed = new URL(url);
  parsed.searchParams.set("token", token);

  return parsed.toString();
};
