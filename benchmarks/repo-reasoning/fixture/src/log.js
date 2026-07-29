/**
 * The object an application holds.
 *
 * Append writes an entry stamped with the injected clock. Compaction is
 * separate and is normally called immediately after an append, in the same
 * tick, which is why the newest entry in the log is usually stamped exactly the
 * `nowMs` that compaction is handed.
 */

import { keptByRetention } from "./purge.js";
import { dailyCounts } from "./rollup.js";

export class RetentionLog {
  constructor({ retentionMs, now }) {
    if (!Number.isInteger(retentionMs) || retentionMs < 1) {
      throw new TypeError("retentionMs must be a positive integer");
    }

    this.retentionMs = retentionMs;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.entries = [];
  }

  append(message) {
    const entry = { at: this.now(), message };

    this.entries.push(entry);

    return entry;
  }

  /** Drop everything the retention policy no longer covers. */
  compact(nowMs = this.now()) {
    this.entries = keptByRetention(this.entries, nowMs, this.retentionMs);

    return this.entries.length;
  }

  all() {
    return [...this.entries];
  }

  activity(fromMs, days) {
    return dailyCounts(this.entries, fromMs, days);
  }
}
