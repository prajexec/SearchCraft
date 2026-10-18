import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import { manifestPath, readManifest } from '../../src/indexing/segment';
import { Logger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';
import { initializeDatabase } from '../../src/storage/sqlite';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Reindex test server did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test('online reindex builds a target generation and atomically swaps the active manifest', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-reindex-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
    SEARCHCRAFT_SEGMENT_COMPACTION_THRESHOLD: '1000',
  });
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
    manager.upsertDocument('products', { id: 'one', fields: { title: 'oldonly generation' } }),
  );
  const directory = join(temporaryDirectory, 'indexes', 'products');
  const before = readManifest(manifestPath(directory), 'products');
  assert.ok(before?.formatVersion === 2);
  const oldSegment = before.activeSegments[0];
  assert.ok(oldSegment);
  assert.ok(
    manager.upsertSourceDocument(
      'products',
      { id: 'two', fields: { title: 'newonly generation' } },
      config.maxPendingJobs,
    ),
  );
  const server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
    indexManager: manager,
    asynchronousIndexing: true,
  });

  try {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const start = await fetch(`${baseUrl}/v1/indexes/products/documents/_reindex`, {
      method: 'POST',
    });
    assert.equal(start.status, 202);
    const started = (await start.json()) as {
      jobId: string;
      state: string;
      targetGeneration: number;
    };
    assert.match(started.jobId, /^[a-f0-9-]{36}$/);
    assert.ok(
      started.state === 'pending' || started.state === 'running' || started.state === 'completed',
    );

    let status:
      { state: string; targetGeneration: number; sourceDocumentCount: number } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(
        `${baseUrl}/v1/indexes/products/documents/_reindex/${started.jobId}`,
      );
      assert.equal(response.status, 200);
      const current = (await response.json()) as {
        state: string;
        targetGeneration: number;
        sourceDocumentCount: number;
      };
      status = current;
      if (current.state === 'completed' || current.state === 'failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(status?.state, 'completed');
    assert.equal(status?.sourceDocumentCount, 2);
    assert.ok((status?.targetGeneration ?? 0) > before.activeGeneration);

    const after = readManifest(manifestPath(directory), 'products');
    assert.ok(after?.formatVersion === 2);
    assert.equal(after.activeGeneration, status?.targetGeneration);
    assert.equal(after.activeSegments.length, 1, JSON.stringify(after));
    assert.notEqual(after.activeSegments[0], oldSegment);
    assert.equal(existsSync(join(directory, oldSegment)), false);
    assert.equal(manager.search('products', 'oldonly', 10, undefined)?.page.totalHits, 1);
    assert.equal(manager.search('products', 'newonly', 10, undefined)?.page.totalHits, 1);
    assert.equal(manager.getIndex('products')?.activeGeneration, after.activeGeneration);
  } finally {
    await close(server);
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
