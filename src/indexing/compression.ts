const MAX_SAFE_POSITION = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ENCODED_DELTA = MAX_SAFE_POSITION + 1n;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalid(message: string): never {
  throw new TypeError(message);
}

function encodeVByte(value: bigint, output: number[]): void {
  let remaining = value;
  while (remaining >= 128n) {
    output.push(Number(remaining % 128n) | 0x80);
    remaining /= 128n;
  }
  output.push(Number(remaining));
}

function decodeBase64(encoded: string): Buffer {
  if (encoded.length === 0) {
    return Buffer.alloc(0);
  }
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('encoded positions are not canonical base64');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new Error('encoded positions are not canonical base64');
  }
  return decoded;
}

function readVByte(
  bytes: Uint8Array,
  start: number,
): { readonly value: bigint; readonly next: number } {
  let index = start;
  let value = 0n;
  let multiplier = 1n;
  let byteCount = 0;

  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new Error('encoded positions are truncated');
    }
    const digit = byte & 0x7f;
    value += BigInt(digit) * multiplier;
    if (value > MAX_ENCODED_DELTA) {
      throw new Error('encoded positions exceed safe integer bounds');
    }

    index += 1;
    byteCount += 1;
    if ((byte & 0x80) === 0) {
      if (byteCount > 1 && digit === 0) {
        throw new Error('encoded positions contain a non-canonical VByte');
      }
      return { value, next: index };
    }
    multiplier *= 128n;
  }

  throw new Error('encoded positions are truncated');
}

/**
 * Encodes strictly increasing, non-negative token positions as VByte delta
 * gaps and returns their standard canonical base64 representation.
 */
export function encodePositions(positions: readonly number[]): string {
  if (!Array.isArray(positions)) {
    invalid('positions must be an array');
  }

  const bytes: number[] = [];
  let previous = 0n;
  for (const [index, position] of positions.entries()) {
    if (!Number.isSafeInteger(position) || position < 0) {
      invalid(`position at index ${index} must be a non-negative safe integer`);
    }
    if (index > 0 && BigInt(position) <= previous) {
      invalid('positions must be strictly increasing');
    }

    const delta = BigInt(position) - previous + 1n;
    encodeVByte(delta, bytes);
    previous = BigInt(position);
  }

  return Buffer.from(bytes).toString('base64');
}

/**
 * Decodes and validates a canonical VByte delta-gap position list.
 */
export function decodePositions(encoded: string, expectedCount: number): readonly number[] {
  if (typeof encoded !== 'string') {
    invalid('encoded positions must be a string');
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    invalid('expectedCount must be a non-negative safe integer');
  }

  const bytes = decodeBase64(encoded);
  const positions: number[] = [];
  let previous = 0n;
  let offset = 0;

  while (offset < bytes.length) {
    const decoded = readVByte(bytes, offset);
    offset = decoded.next;
    const position = previous + decoded.value - 1n;
    if (position < 0n || position > MAX_SAFE_POSITION) {
      throw new Error('encoded positions contain a position outside safe integer bounds');
    }
    if (positions.length > 0 && position <= previous) {
      throw new Error('encoded positions must be strictly increasing');
    }

    positions.push(Number(position));
    previous = position;
    if (positions.length > expectedCount) {
      throw new Error('encoded positions contain an incorrect number of positions');
    }
  }

  if (positions.length !== expectedCount) {
    throw new Error('encoded positions contain an incorrect number of positions');
  }
  return positions;
}
