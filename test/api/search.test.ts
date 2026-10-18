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
import { DocumentRepository } from '../../src/storage/documents';
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

async function jsonRequest(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

test('index, document, search, delete, pagination, and restart recovery work together', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-search-test-'));
  const config = loadConfig({
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
  });
  const database = initializeDatabase(config.dbPath);
  let databaseClosed = false;
  const indexManager = new IndexManager(database.connection, config);
  indexManager.load();
  const server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
    indexManager,
  });

  try {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const create = await jsonRequest(`${baseUrl}/v1/indexes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'products',
        config: {
          searchableFields: { title: { boost: 2 }, description: { boost: 1 } },
          storedFields: ['title', 'description'],
          filterableFields: ['category', 'price'],
        },
      }),
    });
    assert.equal(create.status, 201);

    for (const [id, fields] of [
      [
        'one',
        {
          title: 'MacBook Air',
          description: 'Lightweight laptop with excellent battery life',
          category: 'laptop',
          price: 799,
        },
      ],
      [
        'two',
        {
          title: 'Laptop stand',
          description: 'Adjustable desk accessory',
          category: 'accessory',
          price: 99,
        },
      ],
      [
        'three',
        {
          title: 'Battery charger',
          description: 'Portable power accessory',
          category: 'power',
          price: 49,
        },
      ],
    ] as const) {
      const response = await jsonRequest(`${baseUrl}/v1/indexes/products/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { searchVisible: boolean; version: number };
      assert.equal(body.searchVisible, true);
      assert.equal(body.version, 1);
    }

    const firstPageResponse = await fetch(`${baseUrl}/v1/indexes/products/search?q=laptop&limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = (await firstPageResponse.json()) as {
      hits: Array<{ id: string }>;
      nextCursor: string | null;
      totalHits: number;
      indexVersion: number;
    };
    assert.equal(firstPage.totalHits, 2);
    assert.equal(firstPage.hits.length, 1);
    assert.ok(firstPage.nextCursor !== null);
    assert.ok(firstPage.indexVersion >= 4);

    const phraseResponse = await fetch(
      `${baseUrl}/v1/indexes/products/search?q=MacBook%20Air&phrase=true`,
    );
    assert.equal(phraseResponse.status, 200);
    const phraseBody = (await phraseResponse.json()) as {
      hits: Array<{ id: string }>;
      totalHits: number;
    };
    assert.equal(phraseBody.totalHits, 1);
    assert.deepEqual(
      phraseBody.hits.map((hit) => hit.id),
      ['one'],
    );

    const invalidPhrase = await fetch(
      `${baseUrl}/v1/indexes/products/search?q=MacBook%20Air&slop=1`,
    );
    assert.equal(invalidPhrase.status, 400);

    const filteredResponse = await fetch(
      `${baseUrl}/v1/indexes/products/search?q=laptop&filter=${encodeURIComponent(JSON.stringify({ category: 'laptop', price: { gte: 500 } }))}`,
    );
    assert.equal(filteredResponse.status, 200);
    const filteredBody = (await filteredResponse.json()) as {
      hits: Array<{ id: string }>;
      totalHits: number;
    };
    assert.equal(filteredBody.totalHits, 1);
    assert.deepEqual(
      filteredBody.hits.map((hit) => hit.id),
      ['one'],
    );

    const invalidFilterResponse = await fetch(
      `${baseUrl}/v1/indexes/products/search?q=laptop&filter=${encodeURIComponent(JSON.stringify({ secret: true }))}`,
    );
    assert.equal(invalidFilterResponse.status, 400);
    assert.equal((await invalidFilterResponse.json()).error.code, 'invalid_filter');

    const queryWithoutTerms = await fetch(`${baseUrl}/v1/indexes/products/search?q=%21%21%21`);
    assert.equal(queryWithoutTerms.status, 400);

    const secondPageResponse = await fetch(
      `${baseUrl}/v1/indexes/products/search?q=laptop&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = (await secondPageResponse.json()) as { hits: Array<{ id: string }> };
    assert.equal(secondPage.hits.length, 1);
    assert.notEqual(secondPage.hits[0]?.id, firstPage.hits[0]?.id);

    const document = await fetch(`${baseUrl}/v1/indexes/products/documents/one`);
    assert.equal(document.status, 200);
    assert.equal((await document.json()).version, 1);

    const deleted = await jsonRequest(`${baseUrl}/v1/indexes/products/documents/one`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await fetch(`${baseUrl}/v1/indexes/products/search?q=laptop`);
    const afterDeleteBody = (await afterDelete.json()) as {
      hits: Array<{ id: string }>;
      totalHits: number;
    };
    assert.equal(afterDeleteBody.totalHits, 1);
    assert.equal(
      afterDeleteBody.hits.some((hit) => hit.id === 'one'),
      false,
    );

    await close(server);
    database.connection.close();
    databaseClosed = true;

    // Simulate a crash after SQLite commits a newer source version but before
    // the filesystem manifest is published. Restart must reject the stale
    // snapshot and rebuild from the durable source document.
    const staleSnapshotDatabase = initializeDatabase(config.dbPath);
    new DocumentRepository(staleSnapshotDatabase.connection).upsert('products', {
      id: 'two',
      fields: { title: 'Laptop stand', description: 'Updated crash recovery document' },
    });
    staleSnapshotDatabase.connection.close();

    const restartedDatabase = initializeDatabase(config.dbPath);
    const restartedManager = new IndexManager(restartedDatabase.connection, config);
    restartedManager.load();
    const restartedServer = createApp({
      config,
      database: restartedDatabase.connection,
      logger: new Logger('error'),
      metrics: new Metrics(),
      indexManager: restartedManager,
    });
    try {
      const restartedPort = await listen(restartedServer);
      const restartedSearch = await fetch(
        `http://127.0.0.1:${restartedPort}/v1/indexes/products/search?q=battery`,
      );
      assert.equal(restartedSearch.status, 200);
      const restartedBody = (await restartedSearch.json()) as { hits: Array<{ id: string }> };
      assert.deepEqual(
        restartedBody.hits.map((hit) => hit.id),
        ['three'],
      );

      const rebuiltSearch = await fetch(
        `http://127.0.0.1:${restartedPort}/v1/indexes/products/search?q=recovery`,
      );
      assert.equal(rebuiltSearch.status, 200);
      const rebuiltBody = (await rebuiltSearch.json()) as { hits: Array<{ id: string }> };
      assert.deepEqual(
        rebuiltBody.hits.map((hit) => hit.id),
        ['two'],
      );
    } finally {
      await close(restartedServer);
      restartedDatabase.connection.close();
    }
  } finally {
    if (!databaseClosed) {
      database.connection.close();
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
