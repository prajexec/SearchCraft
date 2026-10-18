import { TextDecoder } from 'node:util';

import { parseSearchDocument, validateDocumentId, type FieldValue } from '../indexes/index-config';
import type { BulkMutation } from '../storage/documents';

export class BulkRequestError extends Error {
  public constructor(
    public readonly code: 'invalid_bulk' | 'bulk_body_too_large' | 'bulk_batch_too_large',
    message: string,
    public readonly statusCode: 400 | 413,
    public readonly line?: number,
  ) {
    super(message);
    this.name = 'BulkRequestError';
  }
}

interface BulkActionMetadata {
  readonly action: 'index' | 'create' | 'update' | 'delete';
  readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineError(message: string, line: number): BulkRequestError {
  return new BulkRequestError('invalid_bulk', `${message} (line ${line})`, 400, line);
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  if (line.length === 0) {
    throw lineError('Bulk NDJSON lines must not be empty', lineNumber);
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw lineError('Bulk NDJSON contains invalid JSON', lineNumber);
  }
}

function parseAction(value: unknown, lineNumber: number): BulkActionMetadata {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw lineError('Each bulk action line must contain exactly one action', lineNumber);
  }
  const [actionValue] = Object.keys(value);
  if (
    actionValue !== 'index' &&
    actionValue !== 'create' &&
    actionValue !== 'update' &&
    actionValue !== 'delete'
  ) {
    throw lineError(`Unsupported bulk action "${actionValue ?? ''}"`, lineNumber);
  }
  const metadata = value[actionValue];
  if (!isRecord(metadata)) {
    throw lineError(`Bulk action "${actionValue}" metadata must be an object`, lineNumber);
  }
  const rawId = metadata._id ?? metadata.id;
  if (typeof rawId !== 'string') {
    throw lineError(`Bulk action "${actionValue}" requires an _id`, lineNumber);
  }
  try {
    validateDocumentId(rawId);
  } catch (error) {
    throw lineError(
      error instanceof Error ? error.message : 'Bulk document ID is invalid',
      lineNumber,
    );
  }
  return { action: actionValue, id: rawId };
}

function parseUpdateFields(
  value: unknown,
  id: string,
  lineNumber: number,
): Record<string, FieldValue> {
  if (!isRecord(value)) {
    throw lineError('Bulk update source must be an object', lineNumber);
  }
  const candidate = 'doc' in value ? value.doc : value;
  if (!isRecord(candidate)) {
    throw lineError('Bulk update source doc must be an object', lineNumber);
  }
  const source = 'fields' in candidate ? candidate : { fields: candidate };
  try {
    return parseSearchDocument(source, id).fields;
  } catch (error) {
    throw lineError(
      error instanceof Error ? error.message : 'Bulk update source is invalid',
      lineNumber,
    );
  }
}

function parseSource(value: unknown, id: string, lineNumber: number): Record<string, FieldValue> {
  try {
    return parseSearchDocument(value, id).fields;
  } catch (error) {
    throw lineError(error instanceof Error ? error.message : 'Bulk source is invalid', lineNumber);
  }
}

type BulkChunk = Uint8Array | string;

export async function parseBulkNdjson(
  chunks: AsyncIterable<BulkChunk>,
  maxBodyBytes: number,
  maxBatchSize: number,
): Promise<readonly BulkMutation[]> {
  const decoder = new TextDecoder();
  const mutations: BulkMutation[] = [];
  let lineBuffer = '';
  let totalBytes = 0;
  let lineNumber = 0;
  let pendingAction: BulkActionMetadata | undefined;

  const consumeLine = (rawLine: string): void => {
    lineNumber += 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const parsed = parseJsonLine(line, lineNumber);
    if (pendingAction !== undefined) {
      const action = pendingAction;
      pendingAction = undefined;
      const fields =
        action.action === 'update'
          ? parseUpdateFields(parsed, action.id, lineNumber)
          : parseSource(parsed, action.id, lineNumber);
      mutations.push({ action: action.action, id: action.id, fields });
      return;
    }

    const action = parseAction(parsed, lineNumber);
    if (mutations.length >= maxBatchSize) {
      throw new BulkRequestError(
        'bulk_batch_too_large',
        `Bulk batch exceeds the configured maximum of ${maxBatchSize} operations`,
        413,
        lineNumber,
      );
    }
    if (action.action === 'delete') {
      mutations.push({ action: 'delete', id: action.id });
      return;
    }
    pendingAction = action;
  };

  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
    totalBytes += bytes;
    if (totalBytes > maxBodyBytes) {
      throw new BulkRequestError(
        'bulk_body_too_large',
        'The bulk request body exceeds the configured limit',
        413,
      );
    }
    lineBuffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      consumeLine(line);
      newlineIndex = lineBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(lineBuffer, 'utf8') > maxBodyBytes) {
      throw new BulkRequestError(
        'bulk_body_too_large',
        'A bulk NDJSON line exceeds the configured body limit',
        413,
      );
    }
  }

  lineBuffer += decoder.decode();
  if (lineBuffer.length > 0) {
    consumeLine(lineBuffer);
  }
  if (pendingAction !== undefined) {
    throw lineError(
      `Bulk action "${pendingAction.action}" is missing its source line`,
      lineNumber + 1,
    );
  }
  if (mutations.length === 0) {
    throw new BulkRequestError('invalid_bulk', 'The bulk request contains no operations', 400);
  }
  return mutations;
}
