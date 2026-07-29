import assert from "node:assert/strict";
import test from "node:test";

import { OPERATORS, tokenize } from "../src/tokenize.js";

test("a clause is a field, an operator, and everything after it", () => {
  assert.deepEqual(tokenize("state = open"), [
    { field: "state", operator: "equals", operand: "open" },
  ]);
});

test("an operand may contain spaces", () => {
  assert.deepEqual(tokenize("title ~ needs review"), [
    { field: "title", operator: "contains", operand: "needs review" },
  ]);
});

test("clauses are cut on ' and '", () => {
  assert.deepEqual(tokenize("state != closed and amount > 100"), [
    { field: "state", operator: "notEquals", operand: "closed" },
    { field: "amount", operator: "greaterThan", operand: "100" },
  ]);
});

test("an unknown operator is rejected with its spelling", () => {
  assert.throws(() => tokenize("state ?? open"), /"\?\?" is not an operator/);
});

test("a clause with no value is rejected", () => {
  assert.throws(() => tokenize("state ="), /needs a value/);
});

// --- membership ---------------------------------------------------------

test("'in' is a declared operator whose operand is a list", () => {
  const operator = OPERATORS.find((candidate) => candidate.spelling === "in");

  assert.ok(operator, "no operator is spelled 'in'");
  assert.equal(operator.id, "isOneOf");
  assert.equal(operator.operand, "list");
});

test("'in' reads its operand as the options between the bars", () => {
  assert.deepEqual(tokenize("state in open|closed"), [
    { field: "state", operator: "isOneOf", operand: ["open", "closed"] },
  ]);
});

test("an option list with an empty option is rejected", () => {
  assert.throws(() => tokenize("state in open||closed"), /empty option/);
});
