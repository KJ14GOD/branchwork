/** Shared presentation helpers — no domain truth lives here. */

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * A mission's goal derived from its first chat message (D-032 no-form flow):
 * the first 80 characters, truncated at a word boundary, one line.
 */
export function deriveGoal(message: string): string {
  const oneLine = message.trim().replace(/\s+/g, " ");
  if (oneLine.length <= 80) return oneLine;
  const cut = oneLine.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/** Rail and tab labels truncate; the room header always carries the whole
 *  title, so the tab is free to be short (DESIGN.md#layout). */
export function truncateLabel(text: string, max = 28): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Two-character identity-mark initials from a display name or login. */
export function initials(value: string): string {
  const words = value.trim().split(/[\s_\-./]+/).filter(Boolean);
  const first = words[0];
  if (!first) return "?";
  const second = words[1];
  if (second) return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase();
  return first.slice(0, 2).toUpperCase();
}

/** Wall-clock time for "last heard at 03:42" — never a relative guess. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "1 file" / "3 files" — counts are text in rows, never stat tiles. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** Elapsed time between two ISO timestamps, as a compact duration. */
export function duration(fromIso: string, toIso: string): string | null {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
