import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import { manifestPath, readManifest, type SegmentManifest } from '../../src/indexing/segment';
import { initializeDatabase } from '../../src/storage/sqlite';

function indexFixture(t: TestContext, threshold = 100) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-segments-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_SEGMENT_COMPACTION_THRESHOLD: String(threshold),
  });
  let database = initializeDatabase(config.dbPath);
  t.after(async () => {
    // Drain any scheduled maintenance before closing SQLite or removing its files.
    await nextTurn();
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  const manager = new IndexManager(database.connection, config);
  manager.load();
  assert.ok(
    manager.createIndex('products', {
      searchableFields: { title: { boost: 1 } },
      storedFields: ['title'],
      filterableFields: ['category'],
    }),
  );
  const directory = join(temporaryDirectory, 'indexes', 'products');
  return {
    manager,
    directory,
    restart() {
      database.connection.close();
      database = initializeDatabase(config.dbPath);
      const restarted = new IndexManager(database.connection, config);
      restarted.load();
      return restarted;
    },
  };
}

function activeManifest(directory: string): SegmentManifest {
  const manifest = readManifest(manifestPath(directory), 'products');
  if (manifest === undefined || manifest.formatVersion !== 2) {
    throw new Error('Expected a version 2 manifest');
  }
  return manifest;
}

function seedVersionedDocuments(manager: IndexManager): void {
  assert.ok(
    manager.upsertDocument('products', { id: 'changed', fields: { title: 'obsolete shared' } }),
  );
  assert.ok(
    manager.upsertDocument('products', { id: 'deleted', fields: { title: 'deleted shared' } }),
  );
  assert.ok(
    manager.upsertDocument('products', {
      id: 'changed',
      fields: { title: 'current shared', category: 'kept' },
    }),
  );
  assert.ok(
    manager.upsertDocument('products', {
      id: 'live',
      fields: { title: 'shared', category: 'kept' },
    }),
  );
}

test('restart loads an immutable multi-segment view without rewriting it or resurrecting deletions', async (t) => {
  const fixture = indexFixture(t);
  seedVersionedDocuments(fixture.manager);
  assert.ok(fixture.manager.deleteDocument('products', 'deleted'));
  await nextTurn();
  const before = activeManifest(fixture.directory);
  assert.equal(before.activeSegments.length, 5);
  const contents = before.activeSegments.map((file) =>
    readFileSync(join(fixture.directory, file), 'utf8'),
  );
  const expected = fixture.manager.search('products', 'shared', 10, undefined);

  const restarted = fixture.restart();
  assert.deepEqual(activeManifest(fixture.directory), before);
  assert.deepEqual(restarted.search('products', 'shared', 10, undefined), expected);
  assert.equal(restarted.search('products', 'obsolete deleted', 10, undefined)?.page.totalHits, 0);
  assert.equal(restarted.getDocument('products', 'deleted')?.deleted, true);
  assert.equal(restarted.getDocument('products', 'changed')?.version, 2);
  assert.deepEqual(
    before.activeSegments.map((file) => readFileSync(join(fixture.directory, file), 'utf8')),
    contents,
  );
});

test('startup recovers from a corrupted segment payload and publishes a valid compacted view', (t) => {
  const fixture = indexFixture(t);
  assert.ok(
    fixture.manager.upsertDocument('products', {
      id: 'one',
      fields: { title: 'recoverable laptop' },
    }),
  );
  const before = activeManifest(fixture.directory);
  const segmentFile = before.activeSegments[0];
  assert.ok(segmentFile);
  const segmentPath = join(fixture.directory, segmentFile);
  const payload = JSON.parse(readFileSync(segmentPath, 'utf8')) as {
    documents: Array<{ fields: object }>;
  };
  payload.documents[0]!.fields = { title: 'tampered payload' };
  writeFileSync(segmentPath, JSON.stringify(payload), 'utf8');

  const recovered = fixture.restart();
  assert.deepEqual(
    recovered.search('products', 'recoverable', 10, undefined)?.page.hits.map((hit) => hit.id),
    ['one'],
  );
  const after = activeManifest(fixture.directory);
  assert.equal(after.activeSegments.length, 1);
  assert.notEqual(after.activeSegments[0], segmentFile);
  // Recovery leaves the invalid file available for diagnosis; it is not active.
  assert.equal(existsSync(segmentPath), true);
});

test('startup recovers from a corrupted manifest checksum and preserves the durable source view', (t) => {
  const fixture = indexFixture(t);
  assert.ok(
    fixture.manager.upsertDocument('products', {
      id: 'one',
      fields: { title: 'manifest recovery' },
    }),
  );
  const before = activeManifest(fixture.directory);
  const manifest = JSON.parse(readFileSync(manifestPath(fixture.directory), 'utf8')) as {
    checksum: string;
  };
  manifest.checksum = '0'.repeat(64);
  writeFileSync(manifestPath(fixture.directory), JSON.stringify(manifest), 'utf8');

  const recovered = fixture.restart();
  assert.deepEqual(
    recovered.search('products', 'recovery', 10, undefined)?.page.hits.map((hit) => hit.id),
    ['one'],
  );
  const after = activeManifest(fixture.directory);
  assert.equal(after.activeSegments.length, 1);
  assert.notEqual(after.activeSegments[0], before.activeSegments[0]);
  assert.equal(activeManifest(fixture.directory).checksum, after.checksum);
});

test('threshold compaction publishes one segment and unlinks every retired segment', async (t) => {
  const fixture = indexFixture(t, 3);
  assert.ok(fixture.manager.upsertDocument('products', { id: 'one', fields: { title: 'first' } }));
  assert.ok(fixture.manager.upsertDocument('products', { id: 'two', fields: { title: 'second' } }));
  const beforeCompaction = activeManifest(fixture.directory);
  assert.equal(beforeCompaction.activeSegments.length, 2);
  const retiredPaths = beforeCompaction.activeSegments.map((file) => join(fixture.directory, file));

  assert.ok(
    fixture.manager.upsertDocument('products', { id: 'one', fields: { title: 'updated' } }),
  );
  await nextTurn();

  const after = activeManifest(fixture.directory);
  assert.equal(after.activeSegments.length, 1);
  assert.ok(after.activeGeneration > beforeCompaction.activeGeneration);
  for (const retiredPath of retiredPaths) {
    assert.equal(existsSync(retiredPath), false);
  }
  assert.deepEqual(
    fixture.manager.search('products', 'updated', 10, undefined)?.page.hits.map((hit) => hit.id),
    ['one'],
  );
  assert.equal(fixture.manager.search('products', 'first', 10, undefined)?.page.totalHits, 0);
  assert.equal(fixture.manager.search('products', 'second', 10, undefined)?.page.totalHits, 1);
});
