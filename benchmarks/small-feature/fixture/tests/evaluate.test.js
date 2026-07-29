import assert from "node:assert/strict";
import test from "node:test";

import { matches, PREDICATES } from "../src/evaluate.js";

const clause = (field, operator, operand) => ({ field, operator, operand });

test("equals compares the string form of the field", () => {
  assert.equal(matches(clause("priority", "equals", "2"), { priority: 2 }), true);
  assert.equal(matches(clause("priority", "equals", "3"), { priority: 2 }), false);
});

test("greaterThan compares numerically", () => {
  assert.equal(matches(clause("amount", "greaterThan", "100"), { amount: 101 }), true);
  assert.equal(matches(clause("amount", "greaterThan", "100"), { amount: 100 }), false);
});

test("contains is a substring test", () => {
  assert.equal(
    matches(clause("title", "contains", "needs"), { title: "needs review" }),
    true,
  );
});

test("an operator with no predicate is an error, not a silent false", () => {
  assert.throws(
    () => matches(clause("state", "somethingElse", "open"), { state: "open" }),
    /no predicate is registered/,
  );
});

// --- membership ---------------------------------------------------------

test("isOneOf matches when the field is any of the options", () => {
  const membership = clause("state", "isOneOf", ["open", "blocked"]);

  assert.equal(matches(membership, { state: "open" }), true);
  assert.equal(matches(membership, { state: "blocked" }), true);
  assert.equal(matches(membership, { state: "closed" }), false);
});

test("isOneOf compares on the string form, like equals does", () => {
  assert.equal(
    PREDICATES.isOneOf(2, ["1", "2"]),
    true,
    "a numeric field should satisfy a textual option",
  );
});
