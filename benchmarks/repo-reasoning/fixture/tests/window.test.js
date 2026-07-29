import assert from "node:assert/strict";
import test from "node:test";

import { DAY_MS, entriesBetween, startOfDay } from "../src/window.js";

const at = (...stamps) => stamps.map((stamp) => ({ at: stamp, message: `#${stamp}` }));

test("entries before the range are left out", () => {
  assert.deepEqual(entriesBetween(at(10, 20, 30), 20, 40), at(20, 30));
});

test("the lower bound is inclusive", () => {
  assert.deepEqual(entriesBetween(at(100), 100, 200), at(100));
});

test("entries past the range are left out", () => {
  assert.deepEqual(entriesBetween(at(100, 201, 500), 100, 200), at(100));
});

test("the given order is preserved and the input is not touched", () => {
  const entries = at(30, 10, 20);
  const selected = entriesBetween(entries, 0, 100);

  assert.deepEqual(selected, at(30, 10, 20));
  assert.notEqual(selected, entries);
  assert.equal(entries.length, 3);
});

test("an empty log selects nothing", () => {
  assert.deepEqual(entriesBetween([], 0, DAY_MS), []);
});

test("startOfDay truncates to the midnight at or before a stamp", () => {
  assert.equal(startOfDay(0), 0);
  assert.equal(startOfDay(DAY_MS - 1), 0);
  assert.equal(startOfDay(DAY_MS), DAY_MS);
  assert.equal(startOfDay(DAY_MS + 60_000), DAY_MS);
});
