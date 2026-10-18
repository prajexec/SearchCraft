import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import {
  createSnapshotArchive,
  readSnapshotArchive,
  restoreSnapshotArchive,
  type SnapshotArchive,
} from '../../src/storage/snapshots';
import { initializeDatabase } from '../../src/storage/sqlite';

function createSourceFixture(): {
  readonly temporaryDirectory: string;
  readonly database: ReturnType<typeof initializeDatabase>;
} {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-snapshots-test-'));
  const config = loadConfig({ SEARCHCRAFT_DATA_DIR: temporaryDirectory });
  const database = initializeDatabase(config.dbPath);
  const manager = new IndexManager(database.connection, config);
  manager.load();
  assert.ok(
    manager.createIndex('products', {
      searchableFields: { title: { boost: 1 } },
      storedFields: ['title'],
    }),
  );
  assert.ok(
    manager.upsertDocument('products', {
      id: 'one',
      fields: { title: 'snapshot payload' },
    }),
  );
  return { temporaryDirectory, database };
}

function writeArchive(path: string, archive: SnapshotArchive): void {
  writeFileSync(path, gzipSync(Buffer.from(`${JSON.stringify(archive)}\n`, 'utf8')));
}

test('snapshot creation and reading round-trip active manifests and segments', () => {
  const fixture = createSourceFixture();
  const archivePath = join(fixture.temporaryDirectory, 'snapshots', 'products.snapshot.gz');

  try {
    const metadata = createSnapshotArchive(
      fixture.database.connection,
      fixture.temporaryDirectory,
      archivePath,
    );
    const archive = readSnapshotArchive(archivePath);

    assert.equal(metadata.magic, 'SEARCHCRAFT_SNAPSHOT');
    assert.equal(metadata.formatVersion, 1);
    assert.equal(metadata.indexCount, 1);
    assert.equal(metadata.fileCount, 2);
    assert.equal(archive.magic, 'SEARCHCRAFT_SNAPSHOT');
    assert.equal(archive.formatVersion, 1);
    assert.equal(
      Buffer.from(archive.database, 'base64').subarray(0, 16).toString(),
      'SQLite format 3\u0000',
    );
    assert.deepEqual(
      archive.files.map((file) => file.path),
      ['indexes/products/manifest.json', 'indexes/products/generations/segment-2.json'],
    );
    assert.equal(
      JSON.parse(Buffer.from(archive.files[1]!.data, 'base64').toString('utf8')).indexName,
      'products',
    );
  } finally {
    fixture.database.connection.close();
    rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
  }
});

test('snapshot reader rejects corrupt archives and unsafe or duplicate paths', () => {
  const fixture = createSourceFixture();
  const archivePath = join(fixture.temporaryDirectory, 'snapshot.gz');

  try {
    createSnapshotArchive(fixture.database.connection, fixture.temporaryDirectory, archivePath);
    const archive = readSnapshotArchive(archivePath);

    const corruptPath = join(fixture.temporaryDirectory, 'corrupt.gz');
    writeArchive(corruptPath, { ...archive, magic: 'WRONG_MAGIC' as 'SEARCHCRAFT_SNAPSHOT' });
    assert.throws(() => readSnapshotArchive(corruptPath), /magic is invalid/);

    const unsafePath = join(fixture.temporaryDirectory, 'unsafe.gz');
    writeArchive(unsafePath, {
      ...archive,
      files: archive.files.map((file, index) =>
        index === 0 ? { ...file, path: 'indexes/../manifest.json' } : file,
      ),
    });
    assert.throws(() => readSnapshotArchive(unsafePath), /unsafe relative path/);

    const duplicatePath = join(fixture.temporaryDirectory, 'duplicate.gz');
    writeArchive(duplicatePath, {
      ...archive,
      files: [...archive.files, archive.files[0]!],
    });
    assert.throws(() => readSnapshotArchive(duplicatePath), /duplicate path/);
  } finally {
    fixture.database.connection.close();
    rmSync(fixture.temporaryDirectory, { recursive: true, force: true });
  }
});

test('snapshot restore replaces active indexes, removes SQLite sidecars, and opens the restored database', () => {
  const source = createSourceFixture();
  const targetDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-snapshot-target-'));
  const archivePath = join(source.temporaryDirectory, 'snapshot.gz');
  const targetDatabasePath = join(targetDirectory, 'nested', 'restored.sqlite');

  try {
    writeFileSync(join(targetDirectory, 'keep.txt'), 'unrelated target data', 'utf8');
    mkdirSync(join(targetDirectory, 'nested'), { recursive: true });
    writeFileSync(`${targetDatabasePath}-wal`, 'stale wal', 'utf8');
    writeFileSync(`${targetDatabasePath}-shm`, 'stale shm', 'utf8');
    createSnapshotArchive(source.database.connection, source.temporaryDirectory, archivePath);

    const metadata = restoreSnapshotArchive(archivePath, targetDirectory, targetDatabasePath);
    assert.equal(metadata.indexCount, 1);
    assert.equal(existsSync(join(targetDirectory, 'keep.txt')), true);
    assert.equal(existsSync(join(targetDirectory, 'indexes', 'products', 'manifest.json')), true);
    assert.equal(existsSync(`${targetDatabasePath}-wal`), false);
    assert.equal(existsSync(`${targetDatabasePath}-shm`), false);

    const restoredDatabase = new DatabaseSync(targetDatabasePath, { readOnly: true });
    try {
      const row = restoredDatabase
        .prepare('SELECT COUNT(*) AS count FROM documents WHERE index_name = ?')
        .get('products') as { count: number };
      assert.equal(row.count, 1);
    } finally {
      restoredDatabase.close();
    }
  } finally {
    source.database.connection.close();
    rmSync(source.temporaryDirectory, { recursive: true, force: true });
    rmSync(targetDirectory, { recursive: true, force: true });
  }
});

test('snapshot restore rejects a corrupt gzip archive before changing the target', () => {
  const targetDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-snapshot-invalid-target-'));
  const archivePath = join(targetDirectory, 'invalid.gz');
  writeFileSync(archivePath, Buffer.from('{"magic":"bad"}', 'utf8'));

  try {
    assert.throws(
      () =>
        restoreSnapshotArchive(
          archivePath,
          join(targetDirectory, 'data'),
          join(targetDirectory, 'db.sqlite'),
        ),
      /Invalid snapshot archive/,
    );
  } finally {
    rmSync(targetDirectory, { recursive: true, force: true });
  }
});
