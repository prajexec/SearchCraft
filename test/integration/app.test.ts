import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { Logger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';
import { initializeDatabase } from '../../src/storage/sqlite';

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

test('operational endpoints report health, readiness, metrics, and OpenAPI', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
  });
  const database = initializeDatabase(config.dbPath);
  const server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
  });

  try {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/health`, {
      headers: { 'x-request-id': 'integration-test-1' },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-request-id'), 'integration-test-1');
    assert.deepEqual(await health.json(), {
      status: 'ok',
      service: 'searchcraft',
      uptimeSeconds: 0,
    });

    const readiness = await fetch(`${baseUrl}/ready`);
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { status: 'ready', storage: 'available' });

    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    const metricsBody = (await metrics.json()) as {
      counters: Record<string, number>;
    };
    assert.equal(metricsBody.counters.http_requests_total, 3);

    const prometheus = await fetch(`${baseUrl}/metrics/prometheus`);
    assert.equal(prometheus.status, 200);
    assert.match(await prometheus.text(), /http_requests_total 4/);

    const openapi = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(openapi.status, 200);
    const openapiBody = (await openapi.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    assert.equal(openapiBody.openapi, '3.1.0');
    assert.ok('/health' in openapiBody.paths);

    const missing = await fetch(`${baseUrl}/not-found`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: 'route_not_found', message: 'The requested route does not exist' },
    });
  } finally {
    await close(server);
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('database migrations are safe to run more than once', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-migration-test-'));
  const dbPath = join(temporaryDirectory, 'searchcraft.sqlite');

  try {
    const first = initializeDatabase(dbPath);
    first.connection.close();
    const second = initializeDatabase(dbPath);
    assert.deepEqual(second.appliedMigrations, ['001_initial']);
    const migrationCount = second.connection
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
      .get() as {
      count: number;
    };
    assert.equal(migrationCount.count, 1);
    second.connection.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
