/**
 * Condition evaluator for show_if / include_if / when clauses.
 *
 * Conditions live in the data files, so this has to stay generic: no question
 * ids, no SKUs, no stage names appear here. Everything is resolved against a
 * flat context of answered values.
 *
 * Combinators: { all: [...] } { any: [...] } { not: {...} }
 * Predicates:  equals not_equals in not_in gt gte lt lte answered contains
 */

const PREDICATES = {
  equals: (actual, expected) => normalize(actual) === normalize(expected),
  not_equals: (actual, expected) => normalize(actual) !== normalize(expected),
  in: (actual, expected) =>
    Array.isArray(expected) &&
    (Array.isArray(actual)
      ? actual.some((v) => expected.map(normalize).includes(normalize(v)))
      : expected.map(normalize).includes(normalize(actual))),
  not_in: (actual, expected) => !PREDICATES.in(actual, expected),
  contains: (actual, expected) =>
    Array.isArray(actual) && actual.map(normalize).includes(normalize(expected)),
  gt: (actual, expected) => isNum(actual) && Number(actual) > Number(expected),
  gte: (actual, expected) => isNum(actual) && Number(actual) >= Number(expected),
  lt: (actual, expected) => isNum(actual) && Number(actual) < Number(expected),
  lte: (actual, expected) => isNum(actual) && Number(actual) <= Number(expected),
  answered: (actual, expected) => hasValue(actual) === (expected !== false),
};

function normalize(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
}

export function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * @param {object|undefined} condition  condition node from a data file
 * @param {object} context              flat map of questionId -> answered value
 * @returns {boolean}                   true when absent (no condition = always show)
 */
export function evaluate(condition, context) {
  if (!condition) return true;

  if (Array.isArray(condition.all)) {
    return condition.all.every((c) => evaluate(c, context));
  }
  if (Array.isArray(condition.any)) {
    return condition.any.some((c) => evaluate(c, context));
  }
  if (condition.not) {
    return !evaluate(condition.not, context);
  }

  if (!condition.field) {
    throw new Error(`Condition has no field and no combinator: ${JSON.stringify(condition)}`);
  }

  const actual = context[condition.field];
  const applied = Object.keys(PREDICATES).filter((p) => p in condition);

  if (applied.length === 0) {
    throw new Error(`Condition on "${condition.field}" has no recognised predicate: ${JSON.stringify(condition)}`);
  }

  return applied.every((p) => PREDICATES[p](actual, condition[p]));
}

/** Collects every field id a condition tree depends on - used for dependency ordering. */
export function dependencies(condition, acc = new Set()) {
  if (!condition) return acc;
  for (const key of ['all', 'any']) {
    if (Array.isArray(condition[key])) condition[key].forEach((c) => dependencies(c, acc));
  }
  if (condition.not) dependencies(condition.not, acc);
  if (condition.field) acc.add(condition.field);
  return acc;
}
