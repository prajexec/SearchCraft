import test from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '../../src/indexing/inverted-index';
import type { IndexConfig } from '../../src/indexes/index-config';

const config: IndexConfig = {
  searchableFields: {
    title: { boost: 2 },
    description: { boost: 1 },
  },
  storedFields: ['title', 'description'],
  maxTokenLength: 64,
};

test('inverted index ranks matching documents and round-trips through a segment snapshot', () => {
  const index = new InvertedIndex('products', config);
  index.upsert(
    { id: 'one', fields: { title: 'MacBook Air', description: 'Portable computer' } },
    1,
  );
  index.upsert({ id: 'two', fields: { title: 'Laptop stand', description: 'Desk accessory' } }, 1);

  const page = index.search('macbook', 10, undefined);
  assert.equal(page.totalHits, 1);
  assert.equal(page.hits[0]?.id, 'one');
  assert.ok((page.hits[0]?.score ?? 0) > 0);

  const restored = InvertedIndex.fromSnapshot('products', config, index.toSnapshot(4));
  const restoredPage = restored.search('macbook', 10, undefined);
  assert.deepEqual(restoredPage.hits, page.hits);
});

test('updating and removing a document removes stale postings', () => {
  const index = new InvertedIndex('products', config);
  index.upsert({ id: 'one', fields: { title: 'old term', description: 'body' } }, 1);
  index.upsert({ id: 'one', fields: { title: 'new term', description: 'body' } }, 2);
  assert.equal(index.search('old', 10, undefined).totalHits, 0);
  assert.equal(index.search('new', 10, undefined).totalHits, 1);
  index.remove('one');
  assert.equal(index.search('new', 10, undefined).totalHits, 0);
});
