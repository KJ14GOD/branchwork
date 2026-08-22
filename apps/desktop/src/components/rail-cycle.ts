/**
 * Walking the rail's projects (D-212, as the owner corrected it): the next or
 * previous key in rail order, wrapping at the ends. With nothing listed there
 * is nowhere to go; with no current key the first press lands on an end,
 * because the rail is a ring and the ring has a first bead. Pure, so the rule
 * is tested without a window.
 */
export function cycleKey(keys: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  const count = keys.length;
  const next = at === -1 ? (direction === 1 ? 0 : count - 1) : (at + direction + count) % count;
  return keys[next] ?? null;
}
