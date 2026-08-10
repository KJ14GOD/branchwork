import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * A picture is **kept on this machine** under `userData`, because the version
 * that fetched it on every launch showed initials for the first beat of every
 * session — a flicker in the corner of the window, every time. The disk copy
 * answers immediately and a refresh runs behind it, so a changed picture
 * lands on the next launch and no launch ever waits.
 */

const SIZE = 128;
const TIMEOUT_MS = 6000;
/** A picture, not a payload: anything larger is not one, and is refused. */
const MAX_BYTES = 1_024 * 1_024;

const memory = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** GitHub logins are ASCII letters, digits and hyphens, and nothing else. */
function usable(login: string): boolean {
  return /^[A-Za-z0-9-]{1,39}$/.test(login);
}

function cacheFile(key: string): string | null {
  try {
    const dir = join(app.getPath("userData"), "avatars");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${key}.txt`);
  } catch {
    return null;
  }
}

function readDisk(key: string): string | null {
  const file = cacheFile(key);
  if (!file) return null;
  try {
    const text = readFileSync(file, "utf8");
    return text.startsWith("data:image/") ? text : null;
  } catch {
    return null;
  }
}

function writeDisk(key: string, value: string): void {
  const file = cacheFile(key);
  if (!file) return;
  try {
    writeFileSync(file, value, "utf8");
  } catch {
    /* a cache that cannot be written is still a working product */
  }
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

function fetchOnce(login: string, key: string): Promise<string | null> {
  const running = inFlight.get(key);
  if (running) return running;
  const attempt = download(login).then((result) => {
    inFlight.delete(key);
    if (result) {
      memory.set(key, result);
      writeDisk(key, result);
      return result;
    }
    // A miss never discards a picture already held: offline is not "no face".
    if (!memory.get(key)) memory.set(key, null);
    return memory.get(key) ?? null;
  });
  inFlight.set(key, attempt);
  return attempt;
}

/**
 * The picture for this login, from memory or this machine's own copy when
 * either has it — and only then from GitHub. A cached answer returns without
 * awaiting the network, and refreshes behind the caller.
 */
export async function avatarFor(login: string): Promise<string | null> {
  if (!usable(login)) return null;
  const key = login.toLowerCase();

  if (!memory.has(key)) {
    const stored = readDisk(key);
    if (stored) memory.set(key, stored);
  }

  const known = memory.get(key);
  if (known !== undefined) {
    if (known !== null) void fetchOnce(login, key);
    return known;
  }
  return fetchOnce(login, key);
}

/** For tests: forget everything observed so far in this process. */
export function resetAvatarCache(): void {
  memory.clear();
  inFlight.clear();
}
