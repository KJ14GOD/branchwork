/**
 * A person's own GitHub picture, fetched here rather than in the renderer
 * (D-105).
 *
 * Everyone in a mission signed in with GitHub, so `login` is all the address
 * an avatar needs: `https://github.com/{login}.png` is GitHub's own public
 * redirect to that account's image. The fetch happens in the main process and
 * the renderer receives a `data:` URI, so the window's content policy stays
 * `img-src 'self' data:` — no page in this product reaches the network on its
 * own, and one picture is not the reason to start.
 *
 * Nothing is stored. The cache below lives as long as the process does, and a
 * login that has no picture — offline, deleted account, anything — is
 * remembered as null so the same miss is not asked for on every render.
 */

const SIZE = 128;
const TIMEOUT_MS = 6000;
/** A picture, not a payload: anything larger is not one, and is refused. */
const MAX_BYTES = 1_024 * 1_024;

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** GitHub logins are ASCII letters, digits and hyphens, and nothing else. */
function usable(login: string): boolean {
  return /^[A-Za-z0-9-]{1,39}$/.test(login);
}

async function download(login: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://github.com/${login}.png?size=${SIZE}`, {
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "image/png";
    if (!type.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function avatarFor(login: string): Promise<string | null> {
  const key = login.toLowerCase();
  if (!usable(login)) return null;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const running = inFlight.get(key);
  if (running) return running;
  const attempt = download(login).then((result) => {
    cache.set(key, result);
    inFlight.delete(key);
    return result;
  });
  inFlight.set(key, attempt);
  return attempt;
}

/** For tests: forget everything observed so far. */
export function resetAvatarCache(): void {
  cache.clear();
  inFlight.clear();
}
