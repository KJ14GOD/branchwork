/**
 * The English under the search box.
 *
 * One entry per operator id, taking the field name and the already-parsed
 * operand and returning a sentence fragment. This is what a human reads to
 * check that the query they typed is the query they meant, so it describes the
 * operand as it was understood, not as it was spelled.
 */

export const DESCRIPTIONS = {
  equals: (field, operand) => `${field} is ${operand}`,
  notEquals: (field, operand) => `${field} is not ${operand}`,
  greaterThan: (field, operand) => `${field} is above ${operand}`,
  contains: (field, operand) => `${field} contains ${operand}`,
};

export const describeClause = (clause) => {
  const describe = DESCRIPTIONS[clause.operator];

  if (typeof describe !== "function") {
    throw new Error(
      `no description is registered for operator "${clause.operator}"`,
    );
  }

  return describe(clause.field, clause.operand);
};
