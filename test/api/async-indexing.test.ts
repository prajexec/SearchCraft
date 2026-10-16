import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import { Logger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';
import { initializeDatabase } from '../../src/storage/sqlite';
import { JobRepository } from '../../src/storage/jobs';
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

async function requestJson(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function waitForCompleted(
  baseUrl: string,
  jobId: string,
): Promise<{ status: string; attempts: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/indexes/products/jobs/${jobId}`);
    assert.equal(response.status, 200);
    const job = (await response.json()) as { status: string; attempts: number };
    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

test('async writes are durable, bounded, observable, and recover after restart', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-async-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
    SEARCHCRAFT_MAX_PENDING_JOBS: '1',
    SEARCHCRAFT_WORKER_POLL_INTERVAL_MS: '5',
  });
  let database = initializeDatabase(config.dbPath);
  let manager = new IndexManager(database.connection, config);
  manager.load();
  let worker = new IndexWorker(
    manager,
    new JobRepository(database.connection),
    new Logger('error'),
    config,
  );
  let server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
    indexManager: manager,
    asynchronousIndexing: true,
  });
  let databaseClosed = false;

  try {
    let port = await listen(server);
    let baseUrl = `http://127.0.0.1:${port}`;
    const create = await requestJson(`${baseUrl}/v1/indexes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'products',
        config: { searchableFields: { title: { boost: 1 } }, storedFields: ['title'] },
      }),
    });
    assert.equal(create.status, 201);

    const firstWrite = await requestJson(`${baseUrl}/v1/indexes/products/documents/one`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { title: 'Durable queue document' } }),
    });
    assert.equal(firstWrite.status, 202);
    const firstBody = (await firstWrite.json()) as { jobId: string; searchVisible: boolean };
    assert.match(firstBody.jobId, /^[a-f0-9-]{36}$/);
    assert.equal(firstBody.searchVisible, false);
    const beforeVisibility = await fetch(`${baseUrl}/v1/indexes/products/documents/one`);
    assert.equal((await beforeVisibility.json()).searchVisible, false);

    const saturatedWrite = await requestJson(`${baseUrl}/v1/indexes/products/documents/two`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { title: 'Rejected while queue is full' } }),
    });
    assert.equal(saturatedWrite.status, 429);
    assert.equal(saturatedWrite.headers.get('retry-after'), '1');

    worker.start();
    const firstJob = await waitForCompleted(baseUrl, firstBody.jobId);
    assert.equal(firstJob.status, 'completed');
    const afterVisibility = await fetch(`${baseUrl}/v1/indexes/products/documents/one`);
    assert.equal((await afterVisibility.json()).searchVisible, true);
    const firstSearch = await fetch(`${baseUrl}/v1/indexes/products/search?q=durable`);
    assert.deepEqual(
      (await firstSearch.json()).hits.map((hit: { id: string }) => hit.id),
      ['one'],
    );

    await worker.stop();
    await close(server);
    database.connection.close();
    databaseClosed = true;

    // Leave a durable pending job behind and simulate a process restart.
    const pendingDatabase = initializeDatabase(config.dbPath);
    const pendingManager = new IndexManager(pendingDatabase.connection, config);
    pendingManager.load();
    const pendingApp = createApp({
      config,
      database: pendingDatabase.connection,
      logger: new Logger('error'),
      metrics: new Metrics(),
      indexManager: pendingManager,
      asynchronousIndexing: true,
    });
    const pendingPort = await listen(pendingApp);
    const pendingBaseUrl = `http://127.0.0.1:${pendingPort}`;
    const pendingWrite = await requestJson(`${pendingBaseUrl}/v1/indexes/products/documents/two`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { title: 'Restart recovery document' } }),
    });
    assert.equal(pendingWrite.status, 202);
    const pendingBody = (await pendingWrite.json()) as { jobId: string };
    await close(pendingApp);
    pendingDatabase.connection.close();

    database = initializeDatabase(config.dbPath);
    databaseClosed = false;
    manager = new IndexManager(database.connection, config);
    manager.load();
    worker = new IndexWorker(
      manager,
      new JobRepository(database.connection),
      new Logger('error'),
      config,
    );
    server = createApp({
      config,
      database: database.connection,
      logger: new Logger('error'),
      metrics: new Metrics(),
      indexManager: manager,
      asynchronousIndexing: true,
    });
    port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
    worker.start();
    const recoveredJob = await waitForCompleted(baseUrl, pendingBody.jobId);
    assert.equal(recoveredJob.status, 'completed');
    const recoveredSearch = await fetch(`${baseUrl}/v1/indexes/products/search?q=recovery`);
    assert.deepEqual(
      (await recoveredSearch.json()).hits.map((hit: { id: string }) => hit.id),
      ['two'],
    );
  } finally {
    await worker.stop();
    if (server.listening) {
      await close(server);
    }
    if (!databaseClosed) {
      database.connection.close();
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('document mutation and its job are committed together', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-job-transaction-test-'));
  const config = loadConfig({ SEARCHCRAFT_DATA_DIR: temporaryDirectory });
  const database = initializeDatabase(config.dbPath);
  const manager = new IndexManager(database.connection, config);
  manager.load();

  try {
    assert.ok(
      manager.createIndex('products', {
        searchableFields: { title: { boost: 1 } },
      }),
    );
    const stored = manager.upsertSourceDocument(
      'products',
      { id: 'one', fields: { title: 'transaction' } },
      10,
    );
    assert.ok(stored?.jobId);
    assert.equal(manager.getJob('products', stored?.jobId ?? '')?.documentVersion, 1);
    assert.equal(manager.getDocument('products', 'one')?.version, 1);
  } finally {
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
