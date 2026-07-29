import assert from "node:assert/strict";
import test from "node:test";

import { RetentionLog } from "../src/log.js";

const fakeClock = () => {
  let millis = 0;

  return {
    now: () => millis,
    advance: (ms) => {
      millis += ms;
    },
  };
};

test("appended entries are stamped with the injected clock", () => {
  const clock = fakeClock();
  const log = new RetentionLog({ retentionMs: 10_000, now: clock.now });

  log.append("first");
  clock.advance(250);
  log.append("second");

  assert.deepEqual(log.all(), [
    { at: 0, message: "first" },
    { at: 250, message: "second" },
  ]);
});

test("compaction later on drops what has aged out and keeps the rest", () => {
  const clock = fakeClock();
  const log = new RetentionLog({ retentionMs: 4_500, now: clock.now });

  log.append("oldest");
  clock.advance(1_000);
  log.append("middle");
  clock.advance(1_000);
  log.append("newest");
  clock.advance(3_000);

  assert.equal(log.compact(), 2);
  assert.deepEqual(
    log.all().map((entry) => entry.message),
    ["middle", "newest"],
  );
});

test("a retention window must be a positive integer", () => {
  assert.throws(() => new RetentionLog({ retentionMs: 0 }), TypeError);
});
