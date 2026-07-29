/**
 * The range selector. Every time question in this package goes through here.
 *
 * `entriesBetween` is inclusive of both bounds: an entry stamped exactly
 * `fromMs` is inside the range, and so is one stamped exactly `toMs`. That is
 * the contract README.md states and the contract the callers in this package
 * were written against. It is a published property of this function, not an
 * implementation detail of it — the callers are what to read before changing
 * it, because both of them pass bounds they chose knowing which end is closed.
 *
 * Days are UTC. `startOfDay` truncates to the midnight at or before a
 * timestamp, and `DAY_MS` is the length of a day; there is no DST here because
 * there is no local time here.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const startOfDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** The entries inside [fromMs, toMs], in the order they were given. */
export const entriesBetween = (entries, fromMs, toMs) =>
  entries.filter((entry) => entry.at >= fromMs && entry.at <= toMs);
