# retention

An append-only event log with a retention policy and a daily rollup. Timestamps
are epoch milliseconds and days are UTC. Nothing here reads the wall clock: the
clock is passed in, so callers and tests drive time explicitly.

## The parts

| File | What it is |
| --- | --- |
| `src/window.js` | `entriesBetween`, the one range selector everything else asks time questions through. Plus `DAY_MS` and `startOfDay`. |
| `src/rollup.js` | `dailyCounts`, how many entries landed on each of N consecutive days. Feeds the activity chart. |
| `src/purge.js` | `keptByRetention` and `droppedByRetention`, the retention policy. The only code here that decides an entry is gone. |
| `src/log.js` | `RetentionLog`, the object an application holds: append, compact, read. |

## The range contract

`entriesBetween(entries, fromMs, toMs)` is **inclusive of both bounds**. An
entry stamped exactly `fromMs` is in the range, and so is one stamped exactly
`toMs`. Every caller in this package was written against that, and at least one
of them needs the closed upper bound to be correct rather than merely
convenient.

## Retention

An entry is kept while its age is at most the retention window: at a compaction
running at `now`, an entry stamped `now - retentionMs` is still inside the
window and an entry one millisecond older is not. Compaction usually runs right
after an append, in the same tick, so the newest entry in the log is routinely
stamped exactly `now`.

Retention deletes data and nothing puts it back. An entry dropped a millisecond
early is not a rounding difference; it is a record of something that happened
which the system can no longer show anyone.

## Days

A day is the half-open span from its midnight up to but not including the next
midnight, so an entry stamped exactly midnight belongs to the day that is
starting and not to the day that just ended. Every entry belongs to exactly one
day, and the rollup over a span of days should therefore count each entry once.

## The reported problem

The activity chart shows a total larger than the number of entries in the log.
Entries stamped exactly midnight appear on both sides of the boundary.
