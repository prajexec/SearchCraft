import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../../src/indexing/tokenizer';

test('tokenizer normalizes case, Unicode compatibility forms, punctuation, and positions', () => {
  assert.deepEqual(tokenize('Café M1 — portátil!', 32), [
    { term: 'café', position: 0 },
    { term: 'm1', position: 1 },
    { term: 'portátil', position: 2 },
  ]);
  assert.deepEqual(tokenize('ＡＰＩ v2', 32), [
    { term: 'api', position: 0 },
    { term: 'v2', position: 1 },
  ]);
});

test('tokenizer skips oversized tokens without producing unsafe terms', () => {
  assert.deepEqual(tokenize('ok verylongtoken final', 5), [
    { term: 'ok', position: 0 },
    { term: 'final', position: 2 },
  ]);
});
