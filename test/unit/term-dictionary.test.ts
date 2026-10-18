import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTermDictionaryBlocks,
  findTermBlock,
  TERM_DICTIONARY_BLOCK_SIZE,
  type TermDictionaryBlock,
} from '../../src/indexing/term-dictionary';

function termsWithPrefix(prefix: string): string[] {
  return Array.from(
    { length: TERM_DICTIONARY_BLOCK_SIZE },
    (_, index) => `${prefix}${String(index).padStart(2, '0')}`,
  );
}

test('term dictionary blocks preserve boundaries, offsets, lengths, and shared prefixes', () => {
  const terms = [...termsWithPrefix('app'), ...termsWithPrefix('ban')];
  const blocks = buildTermDictionaryBlocks(terms);

  assert.deepEqual(blocks, [
    {
      firstTerm: 'app00',
      lastTerm: 'app15',
      commonPrefix: 'app',
      offset: 0,
      length: TERM_DICTIONARY_BLOCK_SIZE,
    },
    {
      firstTerm: 'ban00',
      lastTerm: 'ban15',
      commonPrefix: 'ban',
      offset: TERM_DICTIONARY_BLOCK_SIZE,
      length: TERM_DICTIONARY_BLOCK_SIZE,
    },
  ]);
});

test('term dictionary lookup uses binary block ranges and excludes gaps', () => {
  const blocks = buildTermDictionaryBlocks([...termsWithPrefix('app'), ...termsWithPrefix('ban')]);

  assert.equal(findTermBlock(blocks, 'app00'), blocks[0]);
  assert.equal(findTermBlock(blocks, 'app08'), blocks[0]);
  assert.equal(findTermBlock(blocks, 'app15'), blocks[0]);
  assert.equal(findTermBlock(blocks, 'ban00'), blocks[1]);
  assert.equal(findTermBlock(blocks, 'ban15'), blocks[1]);
  assert.equal(findTermBlock(blocks, 'app99'), undefined);
  assert.equal(findTermBlock(blocks, 'aaa'), undefined);
  assert.equal(findTermBlock(blocks, 'zzz'), undefined);
  assert.equal(findTermBlock([], 'term'), undefined);
});

test('term dictionary construction rejects unsorted and duplicate terms', () => {
  assert.throws(() => buildTermDictionaryBlocks(['b', 'a']), /sorted/);
  assert.throws(() => buildTermDictionaryBlocks(['a', 'a']), /sorted/);
});

test('term dictionary lookup rejects unsorted or invalid blocks', () => {
  const first: TermDictionaryBlock = {
    firstTerm: 'a',
    lastTerm: 'a',
    commonPrefix: 'a',
    offset: 0,
    length: 1,
  };
  const second: TermDictionaryBlock = {
    firstTerm: 'b',
    lastTerm: 'b',
    commonPrefix: 'b',
    offset: 1,
    length: 1,
  };

  assert.throws(() => findTermBlock([second, first], 'a'), /ordered|contiguous/);
  assert.throws(() => findTermBlock([{ ...first, commonPrefix: '' }], 'a'), /common prefix/);
  assert.throws(
    () => findTermBlock([{ ...first, length: TERM_DICTIONARY_BLOCK_SIZE + 1 }], 'a'),
    /offset or length/,
  );
  assert.throws(() => findTermBlock([{ ...first, offset: 1 }], 'a'), /contiguous offsets/);
});
