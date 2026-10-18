import test from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '../../src/indexing/inverted-index';
import type { IndexConfig, SearchDocument } from '../../src/indexes/index-config';

const config: IndexConfig = {
  searchableFields: {
    title: { boost: 2 },
    description: { boost: 1 },
  },
  storedFields: ['title', 'description'],
  maxTokenLength: 64,
  filterableFields: ['category', 'price'],
};

test('inverted index ranks matching documents and round-trips through a segment snapshot', () => {
  const index = new InvertedIndex('products', config);
  index.upsert(
    {
      id: 'one',
      fields: {
        title: 'MacBook Air',
        description: 'Portable computer',
        category: 'laptop',
        price: 799,
      },
    },
    1,
  );
  index.upsert(
    {
      id: 'two',
      fields: {
        title: 'Laptop stand',
        description: 'Desk accessory',
        category: 'accessory',
        price: 99,
      },
    },
    1,
  );

  const page = index.search('macbook', 10, undefined);
  assert.equal(page.totalHits, 1);
  assert.equal(page.hits[0]?.id, 'one');
  assert.ok((page.hits[0]?.score ?? 0) > 0);
  assert.equal(index.search('portable', 10, undefined, { category: 'accessory' }).totalHits, 0);

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

function documentSegment(document: SearchDocument, version: number, generation: number) {
  const index = new InvertedIndex('products', config);
  index.upsert(document, version);
  return index.toDeltaSnapshot(generation, document.id);
}

function tombstoneSegment(documentId: string, version: number, generation: number) {
  const index = new InvertedIndex('products', config);
  index.remove(documentId, version);
  return index.toDeltaSnapshot(generation, documentId);
}

test('multi-segment resolution selects the highest document version, not the last segment', () => {
  const newest = documentSegment({ id: 'one', fields: { title: 'current laptop' } }, 3, 3);
  const oldest = documentSegment({ id: 'one', fields: { title: 'obsolete computer' } }, 1, 1);
  const stale = documentSegment({ id: 'one', fields: { title: 'stale notebook' } }, 2, 4);

  for (const segments of [
    [oldest, newest, stale],
    [newest, stale, oldest],
  ]) {
    const index = InvertedIndex.fromSegments('products', config, segments);
    assert.equal(index.documentVersion('one'), 3);
    assert.equal(index.search('obsolete stale', 10, undefined).totalHits, 0);
    const page = index.search('current', 10, undefined);
    assert.equal(page.totalHits, 1);
    assert.deepEqual(page.hits[0]?.document.fields, { title: 'current laptop' });
    assert.deepEqual(
      index.toSnapshot(5).documents.map((document) => document.version),
      [3],
    );
  }
});

test('winning tombstones suppress older postings while a newer version can recreate a document', () => {
  const original = documentSegment({ id: 'one', fields: { title: 'original laptop' } }, 1, 1);
  const tombstone = tombstoneSegment('one', 2, 2);
  assert.deepEqual(tombstone.documents, [
    { id: 'one', version: 2, deleted: true, fields: {}, fieldLengths: {} },
  ]);
  assert.deepEqual(tombstone.terms, []);

  const deleted = InvertedIndex.fromSegments('products', config, [tombstone, original]);
  assert.equal(deleted.documentVersion('one'), 2);
  assert.equal(deleted.isDocumentDeleted('one'), true);
  assert.equal(deleted.search('laptop', 10, undefined).totalHits, 0);
  assert.deepEqual(deleted.toSnapshot(3).documents, []);
  assert.deepEqual(deleted.toSnapshot(3).terms, []);

  const recreated = documentSegment({ id: 'one', fields: { title: 'recreated laptop' } }, 3, 3);
  const restored = InvertedIndex.fromSegments('products', config, [recreated, original, tombstone]);
  assert.equal(restored.documentVersion('one'), 3);
  assert.equal(restored.isDocumentDeleted('one'), false);
  assert.equal(restored.search('original', 10, undefined).totalHits, 0);
  assert.equal(restored.search('recreated', 10, undefined).totalHits, 1);
});

test('global BM25 statistics exclude deleted and superseded documents across segments', () => {
  const segments = [
    documentSegment(
      { id: 'changed', fields: { title: 'shared obsolete obsolete obsolete' } },
      1,
      1,
    ),
    documentSegment(
      { id: 'deleted', fields: { title: 'shared deleted deleted deleted deleted' } },
      1,
      2,
    ),
    documentSegment(
      { id: 'live', fields: { title: 'shared shared durable', category: 'kept' } },
      1,
      3,
    ),
    documentSegment({ id: 'changed', fields: { title: 'fresh', category: 'other' } }, 2, 4),
    tombstoneSegment('deleted', 2, 5),
  ];
  const index = InvertedIndex.fromSegments('products', config, segments);

  // The resolved corpus has N=2, df(shared)=1, and average title length=(3+1)/2=2.
  // The old versions would incorrectly inflate each of these statistics.
  const inverseDocumentFrequency = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
  const expectedScore =
    inverseDocumentFrequency * ((2 * (1.2 + 1)) / (2 + 1.2 * (1 - 0.75 + 0.75 * (3 / 2)))) * 2;
  const page = index.search('shared', 10, undefined);
  assert.equal(page.totalHits, 1);
  assert.equal(page.hits[0]?.id, 'live');
  assert.ok(Math.abs((page.hits[0]?.score ?? 0) - expectedScore) < 1e-12);

  assert.deepEqual(index.search('shared', 10, undefined, { category: 'kept' }), page);
  assert.equal(index.search('shared', 10, undefined, { category: 'other' }).totalHits, 0);
  assert.equal(index.search('obsolete deleted', 10, undefined).totalHits, 0);
  assert.deepEqual(
    index.toSnapshot(6).documents.map((document) => document.id),
    ['changed', 'live'],
  );

  const reference = new InvertedIndex('products', config);
  reference.upsert({ id: 'live', fields: { title: 'shared shared durable', category: 'kept' } }, 1);
  reference.upsert({ id: 'changed', fields: { title: 'fresh', category: 'other' } }, 2);
  assert.deepEqual(
    index.search('shared fresh', 10, undefined),
    reference.search('shared fresh', 10, undefined),
  );
});

test('phrase search uses token positions for exact order and bounded slop', () => {
  const index = new InvertedIndex('products', config);
  index.upsert({ id: 'exact', fields: { title: 'quick brown fox' } }, 1);
  index.upsert({ id: 'sloppy', fields: { title: 'quick agile brown fox' } }, 1);
  index.upsert({ id: 'reversed', fields: { title: 'brown quick fox' } }, 1);
  index.upsert(
    { id: 'other-field', fields: { title: 'unrelated', description: 'quick brown' } },
    1,
  );

  const exact = index.search('quick brown', 10, undefined, {}, { phrase: true });
  assert.deepEqual(exact.hits.map((hit) => hit.id).sort(), ['exact', 'other-field']);
  assert.equal(index.search('quick brown', 10, undefined, {}, { phrase: true }).totalHits, 2);
  assert.equal(
    index.search('quick brown', 10, undefined, {}, { phrase: true, slop: 1 }).totalHits,
    3,
  );
  assert.equal(index.search('brown quick', 10, undefined, {}, { phrase: true }).totalHits, 1);
  assert.equal(index.search('quick brown', 10, undefined).totalHits, 4);
});
