import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { InvertedIndex } from '../../src/indexing/inverted-index';
import {
  createManifest,
  manifestPath,
  readManifest,
  readSegment,
  SegmentReader,
  writeManifestAtomic,
  writeSegmentFileAtomic,
  type SegmentSnapshot,
} from '../../src/indexing/segment';

function segmentFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'searchcraft-segment-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const index = new InvertedIndex('products', {
    searchableFields: { title: { boost: 1 } },
    storedFields: ['title'],
    maxTokenLength: 64,
  });
  index.upsert({ id: 'one', fields: { title: 'Durable laptop' } }, 2);
  const written = writeSegmentFileAtomic(directory, index.toSnapshot(3));
  const manifest = writeManifestAtomic(directory, createManifest('products', 3, [written.file]));
  return { directory, written, manifest, path: join(directory, written.file) };
}

test('checksummed segments and manifests round-trip into an active reader', (t) => {
  const { directory, written, manifest, path } = segmentFixture(t);
  assert.equal(written.snapshot.formatVersion, 2);
  assert.match(written.snapshot.checksum ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(readSegment(path, 'products'), written.snapshot);
  assert.deepEqual(readManifest(manifestPath(directory), 'products'), manifest);
  assert.deepEqual(SegmentReader.open(directory, 'products', manifest)?.result(), {
    snapshots: [written.snapshot],
    files: [written.file],
  });
  assert.equal(readSegment(path, 'another-index'), undefined);
  assert.equal(readManifest(manifestPath(directory), 'another-index'), undefined);
});

const corruptSnapshots: ReadonlyArray<{
  readonly name: string;
  readonly tamper: (snapshot: SegmentSnapshot) => unknown;
}> = [
  {
    name: 'a tampered document payload',
    tamper: (snapshot) => ({
      ...snapshot,
      documents: snapshot.documents.map((document) => ({
        ...document,
        fields: { title: 'Forged laptop' },
      })),
    }),
  },
  {
    name: 'tampered posting positions',
    tamper: (snapshot) => ({
      ...snapshot,
      terms: snapshot.terms.map((term) => ({
        ...term,
        postings: term.postings.map((posting) => ({ ...posting, positions: [99] })),
      })),
    }),
  },
  { name: 'a wrong checksum', tamper: (snapshot) => ({ ...snapshot, checksum: '0'.repeat(64) }) },
  { name: 'a missing checksum', tamper: (snapshot) => ({ ...snapshot, checksum: undefined }) },
];

for (const { name, tamper } of corruptSnapshots) {
  test(`segment validation rejects ${name} and refuses the active reader`, (t) => {
    const { directory, written, manifest, path } = segmentFixture(t);
    writeFileSync(path, JSON.stringify(tamper(written.snapshot)), 'utf8');
    assert.equal(readSegment(path, 'products'), undefined);
    assert.equal(SegmentReader.open(directory, 'products', manifest), undefined);
  });
}

test('manifest validation rejects tampered payloads and missing or incorrect checksums', (t) => {
  const { directory, manifest } = segmentFixture(t);
  for (const corrupted of [
    { ...manifest, activeGeneration: manifest.activeGeneration + 1 },
    { ...manifest, activeSegments: ['generations/segment-999.json'] },
    { ...manifest, checksum: '0'.repeat(64) },
    { ...manifest, checksum: undefined },
  ]) {
    writeFileSync(manifestPath(directory), JSON.stringify(corrupted), 'utf8');
    assert.equal(readManifest(manifestPath(directory), 'products'), undefined);
  }
});

for (const file of [
  '../outside.json',
  'generations/../outside.json',
  'generations/./segment-3.json',
  '/generations/segment-3.json',
  'generations\\segment-3.json',
  'C:/generations/segment-3.json',
  'segment-3.json',
  '',
]) {
  test(`manifest and reader reject unsafe segment path ${JSON.stringify(file)}`, (t) => {
    const { directory } = segmentFixture(t);
    // Sign the unsafe path so this exercises path validation, not checksum rejection.
    const manifest = createManifest('products', 3, [file]);
    writeFileSync(manifestPath(directory), JSON.stringify(manifest), 'utf8');
    assert.equal(readManifest(manifestPath(directory), 'products'), undefined);
    assert.equal(SegmentReader.open(directory, 'products', manifest), undefined);

    writeFileSync(
      manifestPath(directory),
      JSON.stringify({
        magic: 'SEARCHCRAFT_MANIFEST',
        formatVersion: 1,
        indexName: 'products',
        activeGeneration: 3,
        segmentFile: file,
      }),
      'utf8',
    );
    assert.equal(readManifest(manifestPath(directory), 'products'), undefined);
  });
}

test('manifest validation rejects duplicate active segment paths even with a valid checksum', (t) => {
  const { directory, written } = segmentFixture(t);
  const manifest = createManifest('products', 3, [written.file, written.file]);
  writeFileSync(manifestPath(directory), JSON.stringify(manifest), 'utf8');
  assert.equal(readManifest(manifestPath(directory), 'products'), undefined);
});

test('segment readers reject missing files and malformed JSON without throwing', (t) => {
  const { directory, manifest, path } = segmentFixture(t);
  assert.equal(readSegment(join(directory, 'missing.json'), 'products'), undefined);
  assert.equal(readManifest(join(directory, 'missing.json'), 'products'), undefined);
  writeFileSync(path, '{not valid JSON', 'utf8');
  assert.equal(readSegment(path, 'products'), undefined);
  assert.equal(SegmentReader.open(directory, 'products', manifest), undefined);
  writeFileSync(manifestPath(directory), 'null', 'utf8');
  assert.equal(readManifest(manifestPath(directory), 'products'), undefined);
});
