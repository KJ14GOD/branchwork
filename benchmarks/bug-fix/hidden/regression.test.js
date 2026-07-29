/**
 * The hidden regression test.
 *
 * This file is never inside the fixture and is never named by the fixture's own
 * `test` script. The runner copies it into the scratch repository *after* the
 * agent has finished, so the agent cannot read it, cannot run it, and cannot
 * shape a change around it.
 *
 * It exists because "make the failing test pass" is trivially satisfiable by
 * deleting the assertion or special-casing the numbers the visible test uses.
 * Every case below therefore either uses different numbers than the visible
 * suite, or checks a property the visible suite only implies — so a fix that is
 * really a workaround shows up here as a failure.
 *
 * It imports through the public path on purpose. The goal handed to the agent
 * states that the module path and the exported API are fixed, so an import
 * error here is a real failure and not an unfair one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TokenBucket } from "../src/rate-limiter.js";

const fakeClock = () => {
  let millis = 0;

  return {
    now: () => millis,
    advance: (ms) => {
      millis += ms;
    },
  };
};

test("hidden: frequent polling accumulates at the configured rate", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 100,
    refill: 7,
    intervalMs: 250,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(100), true);
  assert.equal(bucket.available(), 0);

  // Different shape from the visible test: this one reads the balance rather
  // than spending it, at a different poll rate, with a different refill.
  for (let poll = 0; poll < 250; poll += 1) {
    clock.advance(10);
    bucket.available();
  }

  // 2500ms is ten whole 250ms intervals at seven tokens each.
  assert.equal(bucket.available(), 70);
});

test("hidden: refill stays discrete after the fix", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 50,
    refill: 4,
    intervalMs: 400,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(50), true);
  clock.advance(1000);

  // Two and a half intervals. Two are earned; the half is not.
  assert.equal(bucket.available(), 8);
});

test("hidden: an incomplete interval credits nothing, and then credits once", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 5,
    refill: 1,
    intervalMs: 1000,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(5), true);

  clock.advance(999);
  assert.equal(bucket.available(), 0);

  // The millisecond that completes the interval pays exactly one interval, not
  // two — carrying the remainder must not double-credit it.
  clock.advance(1);
  assert.equal(bucket.available(), 1);

  clock.advance(999);
  assert.equal(bucket.available(), 1);
});

test("hidden: the burst ceiling survives polling", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 4,
    refill: 4,
    intervalMs: 100,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(4), true);

  for (let poll = 0; poll < 1000; poll += 1) {
    clock.advance(10);
    assert.ok(
      bucket.available() <= 4,
      `balance rose above burst on poll ${poll}`,
    );
  }
});

test("hidden: a spend larger than the balance changes nothing", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 6,
    refill: 2,
    intervalMs: 500,
    now: clock.now,
  });

  assert.equal(bucket.tryRemove(2), true);
  assert.equal(bucket.tryRemove(9), false);
  assert.equal(bucket.available(), 4);
  assert.equal(bucket.tryRemove(4), true);
  assert.equal(bucket.available(), 0);
});

test("hidden: a fresh bucket starts full and time standing still earns nothing", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    burst: 9,
    refill: 3,
    intervalMs: 100,
    now: clock.now,
  });

  assert.equal(bucket.available(), 9);
  assert.equal(bucket.tryRemove(9), true);
  assert.equal(bucket.available(), 0);
  assert.equal(bucket.tryRemove(1), false);
});
