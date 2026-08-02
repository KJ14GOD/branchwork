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

/** Workstream tab labels truncate at 32 characters. */
export function truncateLabel(text: string, max = 32): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
