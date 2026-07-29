import assert from "node:assert/strict";
import test from "node:test";

import { droppedByRetention, keptByRetention } from "../src/purge.js";

const HOUR = 60 * 60 * 1000;

const at = (...stamps) => stamps.map((stamp) => ({ at: stamp, message: `#${stamp}` }));

test("entries older than the window are not kept", () => {
  const entries = at(1 * HOUR, 5 * HOUR, 9 * HOUR);

  assert.deepEqual(
    keptByRetention(entries, 10 * HOUR, 6 * HOUR),
    at(5 * HOUR, 9 * HOUR),
  );
});

test("what is dropped is exactly what is not kept", () => {
  const entries = at(1 * HOUR, 5 * HOUR, 9 * HOUR);

  assert.deepEqual(droppedByRetention(entries, 10 * HOUR, 6 * HOUR), at(1 * HOUR));
});

test("a window wider than the log keeps all of it", () => {
  const entries = at(1 * HOUR, 5 * HOUR, 9 * HOUR);

  assert.deepEqual(keptByRetention(entries, 10 * HOUR, 90 * HOUR), entries);
  assert.deepEqual(droppedByRetention(entries, 10 * HOUR, 90 * HOUR), []);
});

test("an empty log survives compaction", () => {
  assert.deepEqual(keptByRetention([], 10 * HOUR, 6 * HOUR), []);
  assert.deepEqual(droppedByRetention([], 10 * HOUR, 6 * HOUR), []);
});
