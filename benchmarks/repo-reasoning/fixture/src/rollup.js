/**
 * The activity chart's numbers.
 *
 * A day runs from its midnight up to but not including the next one, so an
 * entry stamped exactly midnight belongs to the day beginning at that instant.
 */

import { DAY_MS, entriesBetween, startOfDay } from "./window.js";

/**
 * How many entries landed on each of `days` consecutive days, starting with the
 * day containing `fromMs`.
 *
 * Returns one row per day, oldest first, each `{ day, count }` where `day` is
 * that day's midnight.
 */
export const dailyCounts = (entries, fromMs, days) => {
  const firstDay = startOfDay(fromMs);
  const rows = [];

  for (let offset = 0; offset < days; offset += 1) {
    const dayStart = firstDay + offset * DAY_MS;

    rows.push({
      day: dayStart,
      count: entriesBetween(entries, dayStart, dayStart + DAY_MS).length,
    });
  }

  return rows;
};

/** The total the chart prints under the bars. */
export const totalCounted = (entries, fromMs, days) =>
  dailyCounts(entries, fromMs, days).reduce((sum, row) => sum + row.count, 0);
