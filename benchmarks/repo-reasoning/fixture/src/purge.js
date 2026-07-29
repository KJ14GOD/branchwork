/**
 * The retention policy: which entries a compaction keeps, and which it drops.
 *
 * Both ends of the range are load-bearing here, and the upper one is the half
 * that surprises people. The window is [now - retentionMs, now]. The lower
 * bound is closed because an entry whose age is exactly the retention window is
 * still inside it. The upper bound is closed because `now` is inside the
 * window — the newest entry in a log is routinely stamped exactly `now`, since
 * compaction runs in the same tick as the append that triggered it, and an
 * entry written this millisecond is the last thing that should be deleted.
 *
 * This is the only code in the package that decides an entry is gone, and
 * nothing puts one back. An off-by-one instant at either end is a lost record,
 * not a rounding difference.
 */

import { entriesBetween } from "./window.js";

/** The entries a compaction at `nowMs` keeps. */
export const keptByRetention = (entries, nowMs, retentionMs) =>
  entriesBetween(entries, nowMs - retentionMs, nowMs);

/** The entries a compaction at `nowMs` throws away. */
export const droppedByRetention = (entries, nowMs, retentionMs) => {
  const kept = new Set(keptByRetention(entries, nowMs, retentionMs));

  return entries.filter((entry) => !kept.has(entry));
};
