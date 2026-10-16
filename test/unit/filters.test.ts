import test from 'node:test';
import assert from 'node:assert/strict';

import { FilterValidationError, matchesFilters, parseFilters } from '../../src/query/filters';

test('filters parse exact values and numeric ranges', () => {
  const filters = parseFilters(
    JSON.stringify({ category: 'laptops', price: { gte: 500, lt: 1_000 }, available: true }),
    ['category', 'price', 'available'],
  );
  assert.equal(
    matchesFilters(
      { category: 'laptops', price: 799, available: true, tags: ['portable'] },
      filters,
    ),
    true,
  );
  assert.equal(
    matchesFilters({ category: 'laptops', price: 1_000, available: true }, filters),
    false,
  );
});

test('filters support membership in string arrays and reject unsafe clauses', () => {
  const filters = parseFilters(JSON.stringify({ tags: 'portable' }), ['tags']);
  assert.equal(matchesFilters({ tags: ['portable', 'laptop'] }, filters), true);
  assert.throws(
    () => parseFilters(JSON.stringify({ secret: 'value' }), ['tags']),
    FilterValidationError,
  );
  assert.throws(
    () => parseFilters(JSON.stringify({ price: { contains: 2 } }), ['price']),
    FilterValidationError,
  );
  assert.throws(() => parseFilters('{', ['price']), FilterValidationError);
});
