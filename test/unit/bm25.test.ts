import test from 'node:test';
import assert from 'node:assert/strict';

import { bm25Score } from '../../src/query/bm25';

test('BM25 returns the standard hand-calculable score', () => {
  const score = bm25Score({
    termFrequency: 2,
    documentFrequency: 3,
    documentCount: 10,
    documentLength: 100,
    averageDocumentLength: 100,
    k1: 1.2,
    b: 0.75,
  });
  const idf = Math.log(1 + (10 - 3 + 0.5) / (3 + 0.5));
  const expected = idf * ((2 * (1.2 + 1)) / (2 + 1.2));
  assert.ok(Math.abs(score - expected) < 0.000000001);
});

test('BM25 rewards higher term frequency and does not score invalid inputs', () => {
  const base = {
    documentFrequency: 1,
    documentCount: 10,
    documentLength: 10,
    averageDocumentLength: 10,
    k1: 1.2,
    b: 0.75,
  };
  assert.ok(bm25Score({ ...base, termFrequency: 2 }) > bm25Score({ ...base, termFrequency: 1 }));
  assert.equal(bm25Score({ ...base, termFrequency: 0 }), 0);
});
