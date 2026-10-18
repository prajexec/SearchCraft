import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePositions, encodePositions } from '../../src/indexing/compression';

test('VByte positions round-trip empty lists, zero, and multi-byte gaps', () => {
  assert.equal(encodePositions([]), '');
  assert.deepEqual(decodePositions('', 0), []);

  const positions = [0, 127, 128, 1000];
  const encoded = encodePositions(positions);
  assert.deepEqual(decodePositions(encoded, positions.length), positions);
  assert.equal(encodePositions([0, 127, 128]), 'AYABAg==');
  assert.deepEqual(decodePositions('AYABAg==', 3), [0, 127, 128]);
});

test('VByte encoding supports the largest safe position', () => {
  const position = Number.MAX_SAFE_INTEGER;
  const encoded = encodePositions([position]);
  assert.deepEqual(decodePositions(encoded, 1), [position]);
});

for (const [name, positions] of [
  ['negative positions', [-1]],
  ['non-safe positions', [Number.MAX_SAFE_INTEGER + 1]],
  ['non-increasing positions', [2, 2]],
  ['decreasing positions', [3, 2]],
] as const) {
  test(`VByte encoding rejects ${name}`, () => {
    assert.throws(() => encodePositions(positions), /position|increasing|safe integer/);
  });
}

for (const [name, encoded, expectedCount] of [
  ['invalid base64', 'not-base64', 1],
  ['truncated VByte data', 'gQ==', 1],
  ['non-canonical VByte data', 'gAA=', 1],
  ['negative decoded position', 'AA==', 1],
  ['non-increasing decoded positions', 'AQE=', 2],
  ['incorrect decoded count', 'AQ==', 2],
  ['non-canonical base64 padding bits', 'AB==', 1],
] as const) {
  test(`VByte decoding rejects ${name}`, () => {
    assert.throws(() => decodePositions(encoded, expectedCount));
  });
}

test('VByte decoding validates the requested count and count argument', () => {
  assert.throws(() => decodePositions('', 1), /incorrect number/);
  assert.throws(() => decodePositions('AQ==', 0), /incorrect number/);
  assert.throws(() => decodePositions('', -1), /expectedCount/);
  assert.throws(() => decodePositions('', 0.5), /expectedCount/);
});
