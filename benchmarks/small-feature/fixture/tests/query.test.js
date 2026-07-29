import assert from "node:assert/strict";
import test from "node:test";

import { compile, select } from "../src/query.js";

const RECORDS = [
  { id: 1, state: "open", amount: 40, title: "needs review" },
  { id: 2, state: "blocked", amount: 250, title: "waiting on legal" },
  { id: 3, state: "closed", amount: 900, title: "shipped" },
  { id: 4, state: "open", amount: 250, title: "needs review" },
];

const ids = (records) => records.map((record) => record.id);

test("clauses narrow, one after another", () => {
  assert.deepEqual(ids(select(RECORDS, "state = open")), [1, 4]);
  assert.deepEqual(ids(select(RECORDS, "state = open and amount > 100")), [4]);
});

test("a query explains itself in the order it was written", () => {
  assert.equal(
    compile("state = open and amount > 100").explain(),
    "state is open, and amount is above 100",
  );
});

// --- membership ---------------------------------------------------------

test("a membership clause filters and explains alongside the others", () => {
  const query = compile("state in open|blocked and amount > 100");

  assert.deepEqual(ids(RECORDS.filter((record) => query.test(record))), [2, 4]);
  assert.equal(
    query.explain(),
    "state is one of open or blocked, and amount is above 100",
  );
});
