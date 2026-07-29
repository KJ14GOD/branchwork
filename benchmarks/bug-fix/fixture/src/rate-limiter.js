/**
 * A token bucket that refills in whole intervals.
 *
 * The contract this module promises, in four sentences:
 *
 * 1. A bucket holds at most `burst` tokens and starts full.
 * 2. Every whole `intervalMs` that passes credits `refill` more tokens, and the
 *    total is capped at `burst`.
 * 3. Refill is deliberately discrete rather than continuous. After 1.9
 *    intervals exactly one interval has been earned; the remaining 0.9 is still
 *    owed and is credited when it completes, not before.
 * 4. `tryRemove(n)` either succeeds and spends exactly n tokens, or fails and
 *    spends nothing.
 *
 * The clock is injected so callers — and tests — can drive time explicitly.
 * Nothing in here sleeps or schedules.
 */

const positiveInteger = (name, value) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return value;
};

export class TokenBucket {
  constructor(options = {}) {
    this.burst = positiveInteger("burst", options.burst);
    this.refill = positiveInteger("refill", options.refill);
    this.intervalMs = positiveInteger("intervalMs", options.intervalMs);
    this.now =
      typeof options.now === "function" ? options.now : () => Date.now();

    this.tokens = this.burst;
    this.lastRefillAt = this.now();
  }

  /**
   * Credit the whole intervals that have completed since the last credit.
   *
   * Called at the top of every public read or spend, so a caller never observes
   * a stale balance.
   */
  settle() {
    const elapsed = this.now() - this.lastRefillAt;

    if (elapsed <= 0) {
      return;
    }

    const earned = Math.floor(elapsed / this.intervalMs);

    this.tokens = Math.min(this.burst, this.tokens + earned * this.refill);
    this.lastRefillAt = this.now();
  }

  /** Tokens available right now. */
  available() {
    this.settle();

    return this.tokens;
  }

  /** Spend `count` tokens if the bucket holds that many. All or nothing. */
  tryRemove(count = 1) {
    positiveInteger("count", count);
    this.settle();

    if (this.tokens < count) {
      return false;
    }

    this.tokens -= count;

    return true;
  }
}
