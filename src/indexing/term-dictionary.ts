export const TERM_DICTIONARY_BLOCK_SIZE = 16;

export interface TermDictionaryBlock {
  readonly firstTerm: string;
  readonly lastTerm: string;
  readonly commonPrefix: string;
  readonly offset: number;
  readonly length: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareTerms(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sharedPrefix(left: string, right: string): string {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  let length = 0;
  while (
    length < leftCharacters.length &&
    length < rightCharacters.length &&
    leftCharacters[length] === rightCharacters[length]
  ) {
    length += 1;
  }
  return leftCharacters.slice(0, length).join('');
}

function validateSortedTerms(sortedTerms: readonly string[]): void {
  if (!Array.isArray(sortedTerms)) {
    throw new TypeError('sortedTerms must be an array');
  }

  let previous: string | undefined;
  for (const [index, term] of sortedTerms.entries()) {
    if (typeof term !== 'string') {
      throw new TypeError(`term at index ${index} must be a string`);
    }
    if (previous !== undefined && compareTerms(previous, term) >= 0) {
      throw new Error('terms must be sorted in strictly increasing order');
    }
    previous = term;
  }
}

export function validateTermDictionaryBlocks(blocks: readonly TermDictionaryBlock[]): void {
  if (!Array.isArray(blocks)) {
    throw new TypeError('blocks must be an array');
  }

  let previous:
    | {
        readonly firstTerm: string;
        readonly lastTerm: string;
        readonly offset: number;
        readonly length: number;
      }
    | undefined;
  let expectedOffset = 0;

  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block)) {
      throw new TypeError(`block at index ${index} must be an object`);
    }

    const firstTerm = block.firstTerm;
    const lastTerm = block.lastTerm;
    const commonPrefix = block.commonPrefix;
    const offset = block.offset;
    const length = block.length;
    if (
      typeof firstTerm !== 'string' ||
      typeof lastTerm !== 'string' ||
      typeof commonPrefix !== 'string'
    ) {
      throw new TypeError(`block at index ${index} has invalid term metadata`);
    }
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > TERM_DICTIONARY_BLOCK_SIZE ||
      offset > Number.MAX_SAFE_INTEGER - length
    ) {
      throw new TypeError(`block at index ${index} has invalid offset or length`);
    }
    if (offset !== expectedOffset) {
      throw new Error('blocks must have contiguous offsets starting at zero');
    }
    if (compareTerms(firstTerm, lastTerm) > 0) {
      throw new Error(`block at index ${index} has an invalid term range`);
    }
    if (length === 1 && firstTerm !== lastTerm) {
      throw new Error(`block at index ${index} has an invalid single-term range`);
    }
    if (commonPrefix !== sharedPrefix(firstTerm, lastTerm)) {
      throw new Error(`block at index ${index} has an invalid common prefix`);
    }
    if (
      previous !== undefined &&
      (compareTerms(previous.lastTerm, firstTerm) >= 0 ||
        offset < previous.offset + previous.length)
    ) {
      throw new Error('blocks must be ordered without overlapping term ranges or offsets');
    }

    previous = { firstTerm, lastTerm, offset, length };
    expectedOffset = offset + length;
  }
}

function blockFromTerms(terms: readonly string[], offset: number): TermDictionaryBlock {
  const firstTerm = terms[0];
  const lastTerm = terms[terms.length - 1];
  if (firstTerm === undefined || lastTerm === undefined) {
    throw new Error('cannot create a dictionary block from no terms');
  }

  let commonPrefix = firstTerm;
  for (const term of terms.slice(1)) {
    commonPrefix = sharedPrefix(commonPrefix, term);
  }
  return { firstTerm, lastTerm, commonPrefix, offset, length: terms.length };
}

export function buildTermDictionaryBlocks(
  sortedTerms: readonly string[],
): readonly TermDictionaryBlock[] {
  validateSortedTerms(sortedTerms);

  const blocks: TermDictionaryBlock[] = [];
  for (let offset = 0; offset < sortedTerms.length; offset += TERM_DICTIONARY_BLOCK_SIZE) {
    blocks.push(
      blockFromTerms(sortedTerms.slice(offset, offset + TERM_DICTIONARY_BLOCK_SIZE), offset),
    );
  }
  return blocks;
}

export function findTermBlock(
  blocks: readonly TermDictionaryBlock[],
  term: string,
): TermDictionaryBlock | undefined {
  if (typeof term !== 'string') {
    throw new TypeError('term must be a string');
  }
  validateTermDictionaryBlocks(blocks);

  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = blocks[middle];
    if (block === undefined) {
      throw new Error('term dictionary blocks are malformed');
    }
    if (compareTerms(term, block.firstTerm) < 0) {
      high = middle - 1;
    } else if (compareTerms(term, block.lastTerm) > 0) {
      low = middle + 1;
    } else {
      return block;
    }
  }
  return undefined;
}
