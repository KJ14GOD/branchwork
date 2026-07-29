import assert from "node:assert/strict";
import test from "node:test";

import { TokenBucket } from "../src/rate-limiter.js";

/** A clock the test moves by hand, so nothing here depends on wall time. */
const fakeClock = () => {
  let millis = 0;

  return {
    now: () => millis,
    advance: (ms) => {
      millis += ms;
    },
  };
};

test("a bucket starts full", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 3,
    refill: 1,
    intervalMs: 1000,
    now: clock.now,
  });

  assert.equal(bucket.available(), 3);
});

test("refill is credited in whole intervals, never in fractions", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 10,
    refill: 2,
    intervalMs: 1000,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(10), true);
  clock.advance(1900);

  // One whole interval has completed. The remaining 900ms is owed, not earned.
  assert.equal(bucket.available(), 2);
});

test("an idle bucket never rises above its burst", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 10,
    refill: 2,
    intervalMs: 1000,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(10), true);
  clock.advance(1000 * 1000);

  assert.equal(bucket.available(), 10);
});

test("tryRemove is all or nothing", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 3,
    refill: 1,
    intervalMs: 1000,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(5), false);
  assert.equal(bucket.available(), 3);
});

test("a caller that polls faster than the interval still earns its full rate", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 3,
    refill: 1,
    intervalMs: 1000,
    now: clock.now,
  });

  // Drain the bucket, then behave like a client that retries every 100ms.
  assert.equal(bucket.tryRemove(3), true);
  assert.equal(bucket.available(), 0);

  let granted = 0;

  for (let poll = 0; poll < 100; poll += 1) {
    clock.advance(100);

    if (bucket.tryRemove(1)) {
      granted += 1;
    }
  }

  // Ten seconds passed at one token per second, so ten requests should have
  // been let through. Polling more often must not earn less.
  assert.equal(granted, 10);
});
