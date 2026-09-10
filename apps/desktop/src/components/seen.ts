/**
 * What this person has already looked at (D-252): the moment they last had a
 * mission or a chat on screen, kept on this machine, so a row can carry the
 * one mark that means "something finished here since you looked" and drop
 * it the moment they look. Nothing here is product state — another person
 * on the same mission has their own — which is why it lives beside the
 * working set in localStorage rather than on the wire.
 */

const STORAGE_KEY = "novus-seen";

type SeenMap = Record<string, string>;

function load(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function save(map: SeenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* a browser that refuses storage leaves every row unmarked, never broken */
  }
}

/** When this person last looked at the thing, ISO-8601, or null if never. */
export function seenAt(id: string): string | null {
  return load()[id] ?? null;
}

/** Records a look, keeping the later of what was known and what is now. */
export function markSeen(id: string, at: string): void {
  const map = load();
  const known = map[id];
  if (known && known >= at) return;
  map[id] = at;
  save(map);
}

/** Whether something finished after the person last looked: the mark. */
export function unseenSince(id: string, finishedAt: string | null): boolean {
  if (finishedAt === null) return false;
  const known = seenAt(id);
  return known === null || known < finishedAt;
}

/** Forgets everything — for a signed-out machine, and for tests. */
export function forgetSeen(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to forget */
  }
}
