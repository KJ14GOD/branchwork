import assert from "node:assert/strict";
import test from "node:test";

import { dailyCounts, totalCounted } from "../src/rollup.js";
import { DAY_MS } from "../src/window.js";

const HOUR = 60 * 60 * 1000;

const at = (...stamps) => stamps.map((stamp) => ({ at: stamp, message: `#${stamp}` }));

test("entries are counted on the day they landed on", () => {
  const entries = at(2 * HOUR, 9 * HOUR, DAY_MS + 3 * HOUR);

  assert.deepEqual(dailyCounts(entries, 0, 2), [
    { day: 0, count: 2 },
    { day: DAY_MS, count: 1 },
  ]);
});

test("a day with nothing on it is a zero, not a missing row", () => {
  const entries = at(2 * HOUR, 2 * DAY_MS + 2 * HOUR);

  assert.deepEqual(dailyCounts(entries, 0, 3), [
    { day: 0, count: 1 },
    { day: DAY_MS, count: 0 },
    { day: 2 * DAY_MS, count: 1 },
  ]);
});

test("the span starts at the midnight of the day it is given, not at the stamp", () => {
  const entries = at(2 * HOUR, 9 * HOUR);

  assert.deepEqual(dailyCounts(entries, 7 * HOUR, 1), [{ day: 0, count: 2 }]);
});

test("an entry stamped exactly midnight belongs to the day that is starting", () => {
  const entries = at(9 * HOUR, DAY_MS, DAY_MS + 9 * HOUR);

  assert.deepEqual(dailyCounts(entries, 0, 2), [
    { day: 0, count: 1 },
    { day: DAY_MS, count: 2 },
  ]);
});

test("the chart's total is the number of entries, not more", () => {
  const entries = at(9 * HOUR, DAY_MS, 2 * DAY_MS, 2 * DAY_MS + 9 * HOUR);

  assert.equal(totalCounted(entries, 0, 3), entries.length);
});
