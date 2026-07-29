/**
 * What each operator means against one record.
 *
 * Keyed by operator id, never by spelling — renaming a spelling is a display
 * change and must not be able to change what a saved search matches.
 *
 * Comparisons other than `greaterThan` are made on the string form of the
 * field, so a record whose `priority` is the number 2 satisfies `priority = 2`.
 */

export const PREDICATES = {
  equals: (value, operand) => String(value) === operand,
  notEquals: (value, operand) => String(value) !== operand,
  greaterThan: (value, operand) => Number(value) > Number(operand),
  contains: (value, operand) => String(value).includes(operand),
};

export const matches = (clause, record) => {
  const predicate = PREDICATES[clause.operator];

  if (typeof predicate !== "function") {
    throw new Error(
      `no predicate is registered for operator "${clause.operator}"`,
    );
  }

  return predicate(record?.[clause.field], clause.operand);
};
