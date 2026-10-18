import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config';

test('loadConfig applies safe defaults and resolves the data directory', () => {
  const config = loadConfig({
    HOME: '/tmp',
    PATH: '/usr/bin',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.maxBodyBytes, 1_048_576);
  assert.equal(config.maxBulkBatchSize, 1_000);
  assert.match(config.dataDir, /SearchCraft[\\/]data$/i);
  assert.match(config.dbPath, /searchcraft\.sqlite$/);
});

test('loadConfig rejects invalid numeric limits', () => {
  assert.throws(
    () => loadConfig({ SEARCHCRAFT_PORT: '0' }),
    /SEARCHCRAFT_PORT must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ SEARCHCRAFT_MAX_QUERY_LENGTH: 'not-a-number' }),
    /SEARCHCRAFT_MAX_QUERY_LENGTH must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ SEARCHCRAFT_MAX_BULK_BATCH_SIZE: '0' }),
    /SEARCHCRAFT_MAX_BULK_BATCH_SIZE must be a positive integer/,
  );
});

test('loadConfig accepts an absolute database path and log level', () => {
  const config = loadConfig({
    SEARCHCRAFT_DB_PATH: '/tmp/searchcraft-test.sqlite',
    SEARCHCRAFT_LOG_LEVEL: 'debug',
  });

  assert.equal(config.dbPath, '/tmp/searchcraft-test.sqlite');
  assert.equal(config.logLevel, 'debug');
});
