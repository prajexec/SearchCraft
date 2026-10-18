import assert from 'node:assert/strict';
import test from 'node:test';

import { BulkRequestError, parseBulkNdjson } from '../../src/http/bulk';

async function* chunks(
  values: readonly (string | Uint8Array)[],
): AsyncIterable<string | Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

test('streaming bulk parser handles split UTF-8 NDJSON actions and update documents', async () => {
  const body = [
    '{"index":{"_id":"one"}}\r\n',
    '{"fields":{"title":"Café"}}\n{"update":{"_id":"one"}}\n',
    '{"doc":{"fields":{"description":"Updated"}}}\n{"delete":{"_id":"two"}}',
  ];
  const encoded = Buffer.from(body.join(''));
  const mutations = await parseBulkNdjson(
    chunks(Array.from(encoded, (byte) => new Uint8Array([byte]))),
    1024,
    10,
  );

  assert.deepEqual(mutations, [
    { action: 'index', id: 'one', fields: { title: 'Café' } },
    { action: 'update', id: 'one', fields: { description: 'Updated' } },
    { action: 'delete', id: 'two' },
  ]);
});

test('streaming bulk parser enforces body and operation limits', async () => {
  await assert.rejects(
    parseBulkNdjson(chunks(['{"delete":{"_id":"one"}}\n']), 10, 10),
    (error: unknown) =>
      error instanceof BulkRequestError &&
      error.code === 'bulk_body_too_large' &&
      error.statusCode === 413,
  );
  await assert.rejects(
    parseBulkNdjson(chunks(['{"delete":{"_id":"one"}}\n{"delete":{"_id":"two"}}\n']), 1024, 1),
    (error: unknown) =>
      error instanceof BulkRequestError &&
      error.code === 'bulk_batch_too_large' &&
      error.statusCode === 413 &&
      error.line === 2,
  );
});

test('streaming bulk parser rejects malformed actions, missing sources, and empty batches', async () => {
  await assert.rejects(
    parseBulkNdjson(chunks(['{"index":{"_id":"one"}}\n']), 1024, 10),
    /missing its source line/,
  );
  await assert.rejects(
    parseBulkNdjson(chunks(['{"unknown":{"_id":"one"}}\n']), 1024, 10),
    /Unsupported bulk action/,
  );
  await assert.rejects(parseBulkNdjson(chunks([]), 1024, 10), /contains no operations/);
  await assert.rejects(
    parseBulkNdjson(chunks(['{"delete":{"_id":"bad id"}}\n']), 1024, 10),
    /Document ID must start/,
  );
});
