/**
 * The glue, and the only file that knows all three registries exist.
 *
 * It deliberately knows nothing about any individual operator. Adding one here
 * would mean an operator could work in a filter and be missing from the
 * explanation, or the reverse, and nothing would say so until a user saw it.
 */

import { matches, PREDICATES } from "./evaluate.js";
import { describeClause, DESCRIPTIONS } from "./explain.js";
import { OPERATORS, tokenize } from "./tokenize.js";

/**
 * Every declared operator must be implemented and describable.
 *
 * Checked at compile time and named in the error, because a half-registered
 * operator otherwise surfaces as `undefined is not a function` inside a filter
 * over somebody's records, a long way from the table that is actually wrong.
 */
const assertRegistriesAgree = () => {
  for (const operator of OPERATORS) {
    if (typeof PREDICATES[operator.id] !== "function") {
      throw new Error(
        `operator "${operator.spelling}" is declared in tokenize.js but has no predicate in evaluate.js`,
      );
    }

    if (typeof DESCRIPTIONS[operator.id] !== "function") {
      throw new Error(
        `operator "${operator.spelling}" is declared in tokenize.js but has no description in explain.js`,
      );
    }
  }
};

export const compile = (source) => {
  assertRegistriesAgree();

  const clauses = tokenize(source);

  return {
    clauses,
    test: (record) => clauses.every((clause) => matches(clause, record)),
    explain: () => clauses.map(describeClause).join(", and "),
  };
};

export const select = (records, source) => {
  const query = compile(source);

  return records.filter((record) => query.test(record));
};
