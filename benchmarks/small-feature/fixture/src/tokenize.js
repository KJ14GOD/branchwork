/**
 * The operator table, and the lexer that reads a query against it.
 *
 * `OPERATORS` is the only place a spelling is written down. Nothing else in the
 * package matches on `"="` or `">"`; everything downstream keys off the `id`.
 *
 * `operand` says what shape the operand text becomes before a predicate sees
 * it. It lives in the table rather than being guessed from the text because
 * `2024-01-01` and `a|b` are both just strings, and only the operator knows
 * which of them is one value and which of them is several.
 */

export const OPERATORS = [
  { id: "equals", spelling: "=", operand: "scalar" },
  { id: "notEquals", spelling: "!=", operand: "scalar" },
  { id: "greaterThan", spelling: ">", operand: "scalar" },
  { id: "contains", spelling: "~", operand: "scalar" },
];

/** Clauses are cut on this, so no operand may contain it. */
export const CLAUSE_SEPARATOR = " and ";

export const operatorBySpelling = (spelling) =>
  OPERATORS.find((operator) => operator.spelling === spelling) ?? null;

export const operatorById = (id) =>
  OPERATORS.find((operator) => operator.id === id) ?? null;

/**
 * Turn the operand text of one clause into the value its predicate receives.
 *
 * Throws rather than returning something empty: a query the user typed wrong
 * should be rejected at compile time with the reason, not silently matched
 * against nothing.
 */
export const parseOperand = (operator, text) => {
  if (operator.operand === "scalar") {
    if (text.length === 0) {
      throw new SyntaxError(`"${operator.spelling}" needs a value after it`);
    }

    return text;
  }

  throw new SyntaxError(
    `operator "${operator.spelling}" declares operand kind "${operator.operand}", which the lexer does not know how to read`,
  );
};

const parseClause = (text) => {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const field = words[0];
  const spelling = words[1];

  if (field === undefined || spelling === undefined) {
    throw new SyntaxError(
      `"${text}" is not a clause — expected <field> <operator> <value>`,
    );
  }

  const operator = operatorBySpelling(spelling);

  if (operator === null) {
    throw new SyntaxError(`"${spelling}" is not an operator this language has`);
  }

  return {
    field,
    operator: operator.id,
    operand: parseOperand(operator, words.slice(2).join(" ")),
  };
};

/** Read a whole query into clauses, left to right. */
export const tokenize = (source) => {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new SyntaxError("a query needs at least one clause");
  }

  return source
    .split(CLAUSE_SEPARATOR)
    .map((clause) => parseClause(clause.trim()));
};
