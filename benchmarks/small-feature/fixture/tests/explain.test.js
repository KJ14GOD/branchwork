import assert from "node:assert/strict";
import test from "node:test";

import { describeClause } from "../src/explain.js";

const clause = (field, operator, operand) => ({ field, operator, operand });

test("each scalar operator has its own sentence", () => {
  assert.equal(describeClause(clause("state", "equals", "open")), "state is open");
  assert.equal(
    describeClause(clause("state", "notEquals", "open")),
    "state is not open",
  );
  assert.equal(
    describeClause(clause("amount", "greaterThan", "100")),
    "amount is above 100",
  );
  assert.equal(
    describeClause(clause("title", "contains", "review")),
    "title contains review",
  );
});

test("an operator with no description is an error, not a blank line", () => {
  assert.throws(
    () => describeClause(clause("state", "somethingElse", "open")),
    /no description is registered/,
  );
});

// --- membership ---------------------------------------------------------

test("two options read as a choice between them", () => {
  assert.equal(
    describeClause(clause("state", "isOneOf", ["open", "blocked"])),
    "state is one of open or blocked",
  );
});
