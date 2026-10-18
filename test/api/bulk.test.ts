import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test, { type TestContext } from 'node:test';

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import { manifestPath, readManifest } from '../../src/indexing/segment';
import { Logger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';
import { JobRepository } from '../../src/storage/jobs';
import { initializeDatabase } from '../../src/storage/sqlite';
import { IndexWorker } from '../../src/workers/index-worker';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP address'));
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

interface BulkFixture {
  readonly temporaryDirectory: string;
  readonly manager: IndexManager;
  readonly jobs: JobRepository;
  readonly metrics: Metrics;
  readonly server: Server;
  readonly worker: IndexWorker;
  readonly port: number;
}

async function createFixture(
  t: TestContext,
  options: {
    readonly asynchronousIndexing?: boolean;
    readonly maxPendingJobs?: string;
    readonly maxBulkBatchSize?: string;
  } = {},
): Promise<BulkFixture> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-bulk-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
    ...(options.maxPendingJobs === undefined
      ? {}
      : { SEARCHCRAFT_MAX_PENDING_JOBS: options.maxPendingJobs }),
    ...(options.maxBulkBatchSize === undefined
      ? {}
      : { SEARCHCRAFT_MAX_BULK_BATCH_SIZE: options.maxBulkBatchSize }),
  });
  const database = initializeDatabase(config.dbPath);
  const manager = new IndexManager(database.connection, config);
  manager.load();
  assert.ok(
    manager.createIndex('products', {
      searchableFields: { title: { boost: 1 }, description: { boost: 1 } },
      storedFields: ['title', 'description'],
    }),
  );
  const jobs = new JobRepository(database.connection);
  const logger = new Logger('error');
  const metrics = new Metrics();
  const worker = new IndexWorker(manager, jobs, logger, config, metrics);
  const server = createApp({
    config,
    database: database.connection,
    logger,
    metrics,
    indexManager: manager,
    asynchronousIndexing: options.asynchronousIndexing ?? true,
  });
  const port = await listen(server);
  t.after(async () => {
    await worker.stop();
    if (server.listening) {
      await close(server);
    }
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  return { temporaryDirectory, manager, jobs, metrics, server, worker, port };
}

async function postBulk(fixture: BulkFixture, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${fixture.port}/v1/indexes/products/documents/_bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  });
}

async function waitForJobs(fixture: BulkFixture, jobIds: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      jobIds.every((jobId) => {
        const status = fixture.manager.getJob('products', jobId)?.status;
        return status === 'completed' || status === 'failed';
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Bulk jobs did not reach terminal states');
}

test('bulk NDJSON atomically stores actions and worker publishes one multi-document segment', async (t) => {
  const fixture = await createFixture(t);
  const response = await postBulk(
    fixture,
    [
      '{"index":{"_id":"one"}}',
      '{"fields":{"title":"First bulk document"}}',
      '{"create":{"_id":"two"}}',
      '{"fields":{"title":"Second bulk document"}}',
      '{"update":{"_id":"one"}}',
      '{"doc":{"fields":{"description":"Updated in bulk"}}}',
      '{"delete":{"_id":"two"}}',
    ].join('\n') + '\n',
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    errors: boolean;
    items: Array<Record<string, { _id: string; version: number; jobId: string; deleted: boolean }>>;
  };
  assert.equal(body.errors, false);
  assert.equal(body.items.length, 4);
  assert.deepEqual(
    body.items.map((item) => Object.keys(item)[0]),
    ['index', 'create', 'update', 'delete'],
  );
  const jobIds = body.items.map((item) => Object.values(item)[0]?.jobId ?? '');
  assert.ok(jobIds.every((jobId) => /^[a-f0-9-]{36}$/.test(jobId)));
  assert.equal(fixture.jobs.count('products').pending, 4);

  fixture.worker.start();
  await waitForJobs(fixture, jobIds);
  assert.ok(
    jobIds.every((jobId) => fixture.manager.getJob('products', jobId)?.status === 'completed'),
  );
  assert.deepEqual(fixture.manager.getDocument('products', 'one')?.fields, {
    title: 'First bulk document',
    description: 'Updated in bulk',
  });
  assert.equal(fixture.manager.getDocument('products', 'one')?.version, 2);
  assert.equal(fixture.manager.getDocument('products', 'two')?.deleted, true);
  assert.equal(fixture.manager.search('products', 'bulk', 10, undefined)?.page.totalHits, 1);
  assert.equal(fixture.manager.search('products', 'second', 10, undefined)?.page.totalHits, 0);

  const manifest = readManifest(
    manifestPath(join(fixture.temporaryDirectory, 'indexes', 'products')),
    'products',
  );
  assert.ok(manifest?.formatVersion === 2);
  assert.equal(manifest.activeSegments.length, 1);

  const metrics = fixture.metrics.snapshot();
  assert.equal(metrics.counters.bulk_requests_total, 1);
  assert.equal(metrics.counters.bulk_documents_total, 4);
  assert.equal(metrics.histograms.bulk_request_duration_ms?.count, 1);
  const prometheus = await fetch(`http://127.0.0.1:${fixture.port}/metrics/prometheus`);
  const prometheusBody = await prometheus.text();
  assert.match(prometheusBody, /bulk_requests_total 1/);
  assert.match(prometheusBody, /bulk_request_duration_ms_count 1/);
  const openapi = await fetch(`http://127.0.0.1:${fixture.port}/openapi.json`);
  assert.equal(openapi.status, 200);
  assert.ok('/v1/indexes/{index}/documents/_bulk' in (await openapi.json()).paths);
});

test('bulk queue admission is atomic and bounded request failures do not write documents', async (t) => {
  const fixture = await createFixture(t, { maxPendingJobs: '2' });
  const response = await postBulk(
    fixture,
    '{"index":{"_id":"one"}}\n{"fields":{"title":"one"}}\n' +
      '{"index":{"_id":"two"}}\n{"fields":{"title":"two"}}\n' +
      '{"index":{"_id":"three"}}\n{"fields":{"title":"three"}}\n',
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(fixture.manager.getDocument('products', 'one'), undefined);
  assert.equal(fixture.jobs.count('products').pending, 0);

  const invalid = await postBulk(fixture, '{"index":{"_id":"one"}}\n{"fields":{}}\n');
  assert.equal(invalid.status, 400);
  assert.equal(fixture.manager.getDocument('products', 'one'), undefined);
});

test('bulk create conflicts and missing updates roll back the complete batch', async (t) => {
  const fixture = await createFixture(t);
  const initial = await postBulk(
    fixture,
    '{"create":{"_id":"one"}}\n{"fields":{"title":"Existing"}}\n',
  );
  assert.equal(initial.status, 202);

  const conflict = await postBulk(
    fixture,
    '{"create":{"_id":"one"}}\n{"fields":{"title":"Conflict"}}\n' +
      '{"index":{"_id":"two"}}\n{"fields":{"title":"Should roll back"}}\n',
  );
  assert.equal(conflict.status, 409);
  assert.equal(fixture.manager.getDocument('products', 'one')?.version, 1);
  assert.equal(fixture.manager.getDocument('products', 'two'), undefined);

  const missingUpdate = await postBulk(
    fixture,
    '{"update":{"_id":"missing"}}\n{"doc":{"fields":{"title":"Missing"}}}\n' +
      '{"index":{"_id":"three"}}\n{"fields":{"title":"Should also roll back"}}\n',
  );
  assert.equal(missingUpdate.status, 409);
  assert.equal(fixture.manager.getDocument('products', 'three'), undefined);
});

test('bulk batch-size limits and synchronous bulk publication are supported', async (t) => {
  const bounded = await createFixture(t, { maxBulkBatchSize: '1' });
  const tooLarge = await postBulk(bounded, '{"delete":{"_id":"one"}}\n{"delete":{"_id":"two"}}\n');
  assert.equal(tooLarge.status, 413);

  const synchronous = await createFixture(t, { asynchronousIndexing: false });
  const response = await postBulk(
    synchronous,
    '{"index":{"_id":"one"}}\n{"fields":{"title":"Synchronous bulk"}}\n',
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    items: Array<Record<string, { searchVisible: boolean; jobId: string | null }>>;
  };
  assert.equal(Object.values(body.items[0] ?? {})[0]?.searchVisible, true);
  assert.equal(Object.values(body.items[0] ?? {})[0]?.jobId, null);
  assert.equal(
    synchronous.manager.search('products', 'synchronous', 10, undefined)?.page.totalHits,
    1,
  );
  assert.equal(
    existsSync(join(synchronous.temporaryDirectory, 'indexes', 'products', 'manifest.json')),
    true,
  );
});
