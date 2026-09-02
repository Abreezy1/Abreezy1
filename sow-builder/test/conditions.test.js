import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, dependencies } from '../server/conditions.js';

test('absent condition always passes', () => {
  assert.equal(evaluate(undefined, {}), true);
});

test('equals, in and not_in', () => {
  assert.equal(evaluate({ field: 'a', equals: 'yes' }, { a: 'yes' }), true);
  assert.equal(evaluate({ field: 'a', equals: 'yes' }, { a: 'no' }), false);
  assert.equal(evaluate({ field: 'a', in: ['x', 'y'] }, { a: 'y' }), true);
  assert.equal(evaluate({ field: 'a', not_in: ['x', 'y'] }, { a: 'z' }), true);
});

test('multiselect values match through in and contains', () => {
  assert.equal(evaluate({ field: 'a', in: ['x'] }, { a: ['q', 'x'] }), true);
  assert.equal(evaluate({ field: 'a', contains: 'x' }, { a: ['q', 'x'] }), true);
});

test('numeric predicates ignore unanswered values', () => {
  assert.equal(evaluate({ field: 'n', gt: 10 }, { n: 11 }), true);
  assert.equal(evaluate({ field: 'n', gt: 10 }, { n: 9 }), false);
  assert.equal(evaluate({ field: 'n', gt: 10 }, {}), false, 'missing value must not satisfy a comparison');
});

test('all / any / not combinators', () => {
  const ctx = { a: 'yes', n: 20 };
  assert.equal(evaluate({ all: [{ field: 'a', equals: 'yes' }, { field: 'n', gt: 10 }] }, ctx), true);
  assert.equal(evaluate({ all: [{ field: 'a', equals: 'no' }, { field: 'n', gt: 10 }] }, ctx), false);
  assert.equal(evaluate({ any: [{ field: 'a', equals: 'no' }, { field: 'n', gt: 10 }] }, ctx), true);
  assert.equal(evaluate({ not: { field: 'a', equals: 'no' } }, ctx), true);
});

test('answered predicate distinguishes empty from present', () => {
  assert.equal(evaluate({ field: 'a', answered: true }, { a: '' }), false);
  assert.equal(evaluate({ field: 'a', answered: true }, { a: 'x' }), true);
  assert.equal(evaluate({ field: 'a', answered: false }, {}), true);
});

test('malformed conditions fail loudly rather than silently passing', () => {
  assert.throws(() => evaluate({ field: 'a' }, {}), /no recognised predicate/);
  assert.throws(() => evaluate({ equals: 'x' }, {}), /no field/);
});

test('dependencies are collected from nested trees', () => {
  const deps = dependencies({ all: [{ field: 'a', equals: 1 }, { any: [{ field: 'b', gt: 2 }] }] });
  assert.deepEqual([...deps].sort(), ['a', 'b']);
});
