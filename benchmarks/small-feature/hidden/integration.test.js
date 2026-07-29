/**
 * The hidden integration test.
 *
 * It is never inside the fixture and is never named by the fixture's `test`
 * script. The runner copies it in after the agent has stopped, so the agent
 * cannot read it, run it, or shape a change around it.
 *
 * The visible suite checks the three registries one file at a time, which is
 * how a half-finished change can look finished: a lexer that produces one
 * operand shape, a predicate that expects another, and a sentence written
 * against a third are each plausible on their own. Everything below therefore
 * crosses at least two of the three files in a single assertion, and uses
 * option counts and spacing the visible suite never uses.
 *
 * It imports through the same public paths the fixture's README documents,
 * because the goal handed to the agent states those paths are fixed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { matches, PREDICATES } from "../src/evaluate.js";
import { describeClause, DESCRIPTIONS } from "../src/explain.js";
import { OPERATORS, tokenize } from "../src/tokenize.js";
import { compile, select } from "../src/query.js";

const RECORDS = [
  { id: 1, state: "open", owner: "ada", priority: 1 },
  { id: 2, state: "blocked", owner: "grace", priority: 3 },
  { id: 3, state: "closed", owner: "ada", priority: 2 },
  { id: 4, state: "in review", owner: "lin", priority: 3 },
];

const ids = (records) => records.map((record) => record.id);

test("hidden: three options, filtered and explained from one parse", () => {
  const query = compile("state in open|blocked|closed");

  assert.deepEqual(ids(RECORDS.filter((record) => query.test(record))), [1, 2, 3]);
  assert.equal(query.explain(), "state is one of open, blocked, or closed");
});

test("hidden: one option behaves like an equality, and reads like one", () => {
  const query = compile("owner in grace");

  assert.deepEqual(ids(RECORDS.filter((record) => query.test(record))), [2]);
  assert.equal(query.explain(), "owner is one of grace");
});

test("hidden: space around the bars is not part of an option", () => {
  // The lexer trims. If it did not, the predicate would be comparing against
  // " blocked" and the explanation would print it — so this fails on the read
  // side and the write side at once, which is the point of asserting both.
  const query = compile("state in open | blocked | closed ");

  assert.deepEqual(ids(RECORDS.filter((record) => query.test(record))), [1, 2, 3]);
  assert.equal(query.explain(), "state is one of open, blocked, or closed");
});

test("hidden: the operand the lexer produces is the operand the other two take", () => {
  // Deliberately not through query.js: a membership operator special-cased in
  // the glue would satisfy every test above and fail here.
  const [clause] = tokenize("state in in review|closed");

  assert.ok(clause, "the lexer returned no clause");
  assert.equal(clause.operator, "isOneOf");
  assert.equal(matches(clause, { state: "in review" }), true);
  assert.equal(matches(clause, { state: "open" }), false);
  assert.equal(describeClause(clause), "state is one of in review or closed");
});

test("hidden: membership composes with the operators that were already here", () => {
  const query = compile("state in open|blocked|in review and priority > 2");

  assert.deepEqual(ids(RECORDS.filter((record) => query.test(record))), [2, 4]);
  assert.equal(
    query.explain(),
    "state is one of open, blocked, or in review, and priority is above 2",
  );
});

test("hidden: options are compared on the string form, as every other operator is", () => {
  assert.deepEqual(ids(select(RECORDS, "priority in 1|3")), [1, 2, 4]);
});

test("hidden: an empty option is rejected however it is spelled", () => {
  assert.throws(() => tokenize("state in open||closed"), /empty option/);
  assert.throws(() => tokenize("state in open | | closed"), /empty option/);
  assert.throws(() => tokenize("state in"), /empty option|needs a value/);
});

test("hidden: every declared operator is implemented and describable", () => {
  for (const operator of OPERATORS) {
    assert.equal(
      typeof PREDICATES[operator.id],
      "function",
      `operator "${operator.spelling}" has no predicate`,
    );
    assert.equal(
      typeof DESCRIPTIONS[operator.id],
      "function",
      `operator "${operator.spelling}" has no description`,
    );
  }

  assert.ok(
    OPERATORS.some(
      (operator) => operator.spelling === "in" && operator.id === "isOneOf",
    ),
    "membership is not in the operator table",
  );
});

test("hidden: the operators that were already here still work", () => {
  assert.deepEqual(ids(select(RECORDS, "owner = ada")), [1, 3]);
  assert.deepEqual(ids(select(RECORDS, "owner != ada and priority > 2")), [2, 4]);
  assert.equal(
    compile("state ~ view").explain(),
    "state contains view",
  );
});
