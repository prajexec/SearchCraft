import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config';
import { IndexManager } from '../../src/indexes/index-manager';
import { initializeDatabase } from '../../src/storage/sqlite';
import { JobRepository } from '../../src/storage/jobs';

test('job claims, orphan recovery, terminal failure, and retry are explicit state transitions', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-jobs-test-'));
  const config = loadConfig({ SEARCHCRAFT_DATA_DIR: temporaryDirectory });
  const database = initializeDatabase(config.dbPath);

  try {
    const manager = new IndexManager(database.connection, config);
    manager.load();
    manager.createIndex('products', { searchableFields: { title: { boost: 1 } } });
    const stored = manager.upsertSourceDocument(
      'products',
      { id: 'one', fields: { title: 'job' } },
      10,
    );
    assert.ok(stored?.jobId);

    const jobs = new JobRepository(database.connection);
    const claimed = jobs.claimNext(new Date(), 30_000);
    assert.equal(claimed?.status, 'processing');
    assert.equal(claimed?.attempts, 1);
    assert.equal(jobs.recoverProcessingJobs(), 1);
    const reclaimed = jobs.claimNext(new Date(), 30_000);
    assert.equal(reclaimed?.status, 'processing');
    assert.equal(reclaimed?.attempts, 2);

    const failed = jobs.fail(reclaimed?.jobId ?? '', 'test failure', 2);
    assert.equal(failed?.status, 'failed');
    assert.equal(jobs.retry('products', reclaimed?.jobId ?? '')?.status, 'pending');
  } finally {
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
