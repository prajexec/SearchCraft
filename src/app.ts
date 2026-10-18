import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

import type { Config } from './config';
import { BulkRequestError, parseBulkNdjson } from './http/bulk';
import { AppError, errorPayload } from './http/errors';
import { openapiDocument } from './http/openapi';
import type { IndexManager } from './indexes/index-manager';
import { QueryLimitError } from './indexing/inverted-index';
import {
  parseSearchDocument,
  ValidationError,
  validateDocumentId,
  validateIndexName,
} from './indexes/index-config';
import type { Logger } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { FilterValidationError, parseFilters, type SearchFilters } from './query/filters';
import {
  CreateConflictError,
  QueueSaturatedError,
  UpdateMissingError,
  type BulkMutation,
  type StoredSourceDocument,
} from './storage/documents';

export interface AppDependencies {
  readonly config: Config;
  readonly database: DatabaseSync;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly indexManager?: IndexManager;
  readonly asynchronousIndexing?: boolean;
}

function requestIdFrom(request: IncomingMessage): string {
  const header = request.headers['x-request-id'];
  if (typeof header === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(header)) {
    return header;
  }
  return randomUUID();
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(serialized);
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://searchcraft.local');
}

function assertRequestLimits(request: IncomingMessage, url: URL, config: Config): void {
  if (url.search.length > config.maxQueryLength) {
    throw new AppError(414, 'query_too_long', 'The query string exceeds the configured limit');
  }

  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new AppError(400, 'invalid_content_length', 'The Content-Length header is invalid');
    }
    if (parsedLength > config.maxBodyBytes) {
      throw new AppError(
        413,
        'request_body_too_large',
        'The request body exceeds the configured limit',
      );
    }
  }
}

function ensureMethod(request: IncomingMessage, expectedMethod: string): void {
  if (request.method !== expectedMethod) {
    throw new AppError(
      405,
      'method_not_allowed',
      `Only ${expectedMethod} is supported for this route`,
    );
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, 'invalid_path_parameter', 'A path parameter is not valid URL encoding');
  }
}

function requireIndexManager(dependencies: AppDependencies): IndexManager {
  if (dependencies.indexManager === undefined) {
    throw new AppError(503, 'index_service_unavailable', 'The index service is not initialized');
  }
  return dependencies.indexManager;
}

function requireIndexName(value: string): string {
  const name = decodePathSegment(value);
  try {
    validateIndexName(name);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new AppError(400, 'invalid_index_name', error.message);
    }
    throw error;
  }
  return name;
}

function requireDocumentId(value: string): string {
  const id = decodePathSegment(value);
  try {
    validateDocumentId(id);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new AppError(400, 'invalid_document_id', error.message);
    }
    throw error;
  }
  return id;
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !contentType.toLowerCase().startsWith('application/json')
  ) {
    throw new AppError(
      415,
      'unsupported_media_type',
      'JSON request bodies must use application/json',
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maximumBytes) {
        request.resume();
        throw new AppError(
          413,
          'request_body_too_large',
          'The request body exceeds the configured limit',
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    request.resume();
    throw error;
  }

  if (chunks.length === 0) {
    throw new AppError(400, 'empty_request_body', 'A JSON request body is required');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AppError(400, 'invalid_json', 'The request body is not valid JSON');
  }
}

function parseLimit(value: string | null): number {
  if (value === null || value === '') {
    return 20;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
  }
  return limit;
}

function parsePhraseOptions(url: URL): { readonly phrase: boolean; readonly slop: number } {
  const phraseValue = url.searchParams.get('phrase');
  const slopValue = url.searchParams.get('slop');
  if (phraseValue !== null && phraseValue !== 'true' && phraseValue !== 'false') {
    throw new AppError(400, 'invalid_phrase', 'phrase must be true or false');
  }
  const phrase = phraseValue === 'true';
  if (slopValue !== null && !phrase) {
    throw new AppError(400, 'invalid_phrase', 'slop requires phrase=true');
  }
  if (slopValue === null || slopValue === '') {
    return { phrase, slop: 0 };
  }
  const slop = Number(slopValue);
  if (!Number.isSafeInteger(slop) || slop < 0 || slop > 100) {
    throw new AppError(400, 'invalid_phrase', 'slop must be an integer between 0 and 100');
  }
  return { phrase, slop };
}

function requireJobId(value: string): string {
  const jobId = decodePathSegment(value);
  if (!/^[a-f0-9-]{36}$/.test(jobId)) {
    throw new AppError(400, 'invalid_job_id', 'Job ID must be a UUID');
  }
  return jobId;
}

function routeName(request: IncomingMessage, url: URL): string {
  return `${request.method ?? 'UNKNOWN'} ${url.pathname}`;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AppDependencies,
): Promise<void> {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request);
  const url = requestPath(request);
  response.setHeader('x-request-id', requestId);
  dependencies.metrics.increment('http_requests_total');

  try {
    assertRequestLimits(request, url, dependencies.config);

    if (url.pathname === '/health') {
      ensureMethod(request, 'GET');
      sendJson(response, 200, {
        status: 'ok',
        service: 'searchcraft',
        uptimeSeconds: Math.floor(process.uptime()),
      });
      return;
    }

    if (url.pathname === '/ready') {
      ensureMethod(request, 'GET');
      try {
        dependencies.database.prepare('SELECT 1 AS value').get();
        sendJson(response, 200, { status: 'ready', storage: 'available' });
      } catch (error) {
        dependencies.logger.error('readiness_check_failed', { error, requestId });
        sendJson(response, 503, {
          error: { code: 'not_ready', message: 'Local storage is unavailable' },
        });
      }
      return;
    }

    if (url.pathname === '/metrics') {
      ensureMethod(request, 'GET');
      dependencies.metrics.setGauge('process_uptime_seconds', process.uptime());
      dependencies.metrics.setGauge('process_resident_memory_bytes', process.memoryUsage().rss);
      sendJson(response, 200, dependencies.metrics.snapshot());
      return;
    }

    if (url.pathname === '/metrics/prometheus') {
      ensureMethod(request, 'GET');
      dependencies.metrics.setGauge('process_uptime_seconds', process.uptime());
      dependencies.metrics.setGauge('process_resident_memory_bytes', process.memoryUsage().rss);
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(dependencies.metrics.toPrometheus());
      return;
    }

    if (url.pathname === '/openapi.json') {
      ensureMethod(request, 'GET');
      sendJson(response, 200, openapiDocument);
      return;
    }

    if (url.pathname === '/v1/indexes') {
      const indexManager = requireIndexManager(dependencies);
      if (request.method === 'GET') {
        sendJson(response, 200, { indexes: indexManager.listIndexes() });
        return;
      }
      if (request.method === 'POST') {
        const body = await readJsonBody(request, dependencies.config.maxBodyBytes);
        try {
          const name =
            typeof body === 'object' &&
            body !== null &&
            'name' in body &&
            typeof body.name === 'string'
              ? body.name
              : '';
          const rawConfig =
            typeof body === 'object' && body !== null && 'config' in body ? body.config : undefined;
          const index = indexManager.createIndex(name, rawConfig);
          if (index === undefined) {
            throw new AppError(409, 'index_already_exists', `Index "${name}" already exists`);
          }
          sendJson(response, 201, index);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new AppError(400, 'invalid_index_config', error.message);
          }
          throw error;
        }
        return;
      }
      throw new AppError(
        405,
        'method_not_allowed',
        'Only GET and POST are supported for this route',
      );
    }

    const indexMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)$/);
    if (indexMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(indexMatch[1] ?? '');
      const index = indexManager.getIndex(indexName);
      if (index === undefined) {
        throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
      }
      sendJson(response, 200, index);
      return;
    }

    const searchMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/search$/);
    if (searchMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(searchMatch[1] ?? '');
      const index = indexManager.getIndex(indexName);
      if (index === undefined) {
        throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
      }
      const query = url.searchParams.get('q') ?? '';
      if (query.trim().length === 0) {
        throw new AppError(400, 'missing_query', 'The q query parameter is required');
      }
      const limit = parseLimit(url.searchParams.get('limit'));
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const phraseOptions = parsePhraseOptions(url);
      let filters: SearchFilters;
      try {
        filters = parseFilters(
          url.searchParams.get('filter') ?? undefined,
          index.config.filterableFields ?? [],
        );
      } catch (error) {
        if (error instanceof FilterValidationError) {
          throw new AppError(400, 'invalid_filter', error.message);
        }
        throw error;
      }
      const startedSearchAt = performance.now();
      let result;
      try {
        result = indexManager.search(indexName, query, limit, cursor, filters, phraseOptions);
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_cursor') {
          throw new AppError(400, 'invalid_cursor', 'The cursor is not valid for this search');
        }
        if (error instanceof QueryLimitError) {
          throw new AppError(400, 'query_too_complex', error.message);
        }
        throw error;
      }
      // The index existence check above ensures this result is present.
      if (result === undefined) {
        throw new AppError(
          503,
          'index_service_unavailable',
          'The index service is not initialized',
        );
      }
      sendJson(response, 200, {
        hits: result.page.hits,
        totalHits: result.page.totalHits,
        totalHitsRelation: 'eq',
        nextCursor: result.page.nextCursor,
        indexVersion: result.indexVersion,
        tookMs: Number((performance.now() - startedSearchAt).toFixed(3)),
      });
      return;
    }

    const bulkMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/documents\/_bulk$/);
    if (bulkMatch !== null) {
      ensureMethod(request, 'POST');
      const bulkStartedAt = performance.now();
      dependencies.metrics.increment('bulk_requests_total');
      try {
        const indexManager = requireIndexManager(dependencies);
        const indexName = requireIndexName(bulkMatch[1] ?? '');
        const index = indexManager.getIndex(indexName);
        if (index === undefined) {
          throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
        }
        const contentType = request.headers['content-type'];
        if (
          typeof contentType !== 'string' ||
          !contentType.toLowerCase().startsWith('application/x-ndjson')
        ) {
          throw new AppError(
            415,
            'unsupported_media_type',
            'Bulk request bodies must use application/x-ndjson',
          );
        }

        const mutations = await parseBulkNdjson(
          request,
          dependencies.config.maxBodyBytes,
          dependencies.config.maxBulkBatchSize,
        );
        let stored: readonly StoredSourceDocument[];
        try {
          stored =
            indexManager.bulkMutate(indexName, mutations, {
              enqueueJob: dependencies.asynchronousIndexing === true,
              maxPendingJobs: dependencies.config.maxPendingJobs,
            }) ?? [];
        } catch (error) {
          if (error instanceof CreateConflictError) {
            throw new AppError(409, 'bulk_create_conflict', error.message);
          }
          if (error instanceof UpdateMissingError) {
            throw new AppError(409, 'bulk_update_missing', error.message);
          }
          throw error;
        }
        dependencies.metrics.increment('bulk_documents_total', stored.length);
        const statusCode = dependencies.asynchronousIndexing === true ? 202 : 200;
        const items = stored.map((document, index) => {
          const mutation = mutations[index] as BulkMutation;
          return {
            [mutation.action]: {
              _id: document.id,
              status: statusCode,
              version: document.version,
              jobId: document.jobId,
              deleted: document.deleted,
              searchVisible: dependencies.asynchronousIndexing !== true,
              ...(dependencies.asynchronousIndexing === true
                ? {}
                : { indexVersion: indexManager.getIndex(indexName)?.activeGeneration ?? null }),
            },
          };
        });
        sendJson(response, statusCode, {
          errors: false,
          items,
          tookMs: Number((performance.now() - bulkStartedAt).toFixed(3)),
        });
      } catch (error) {
        if (error instanceof BulkRequestError) {
          throw new AppError(
            error.statusCode,
            error.code,
            error.message,
            error.line === undefined ? undefined : { line: error.line },
          );
        }
        throw error;
      } finally {
        dependencies.metrics.observe('bulk_request_duration_ms', performance.now() - bulkStartedAt);
      }
      return;
    }

    const reindexStatusMatch = url.pathname.match(
      /^\/v1\/indexes\/([^/]+)\/documents\/_reindex\/([^/]+)$/,
    );
    if (reindexStatusMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(reindexStatusMatch[1] ?? '');
      const jobId = requireJobId(reindexStatusMatch[2] ?? '');
      const status = indexManager.getReindexStatus(indexName, jobId);
      if (status === undefined) {
        throw new AppError(404, 'reindex_not_found', `Reindex job "${jobId}" does not exist`);
      }
      sendJson(response, 200, status);
      return;
    }

    const reindexMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/documents\/_reindex$/);
    if (reindexMatch !== null) {
      ensureMethod(request, 'POST');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(reindexMatch[1] ?? '');
      const status = indexManager.startReindex(indexName);
      if (status === undefined) {
        throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
      }
      sendJson(response, 202, status);
      return;
    }

    const documentMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/documents\/([^/]+)$/);
    if (documentMatch !== null) {
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(documentMatch[1] ?? '');
      const documentId = requireDocumentId(documentMatch[2] ?? '');
      if (request.method === 'GET') {
        const document = indexManager.getDocument(indexName, documentId);
        if (document === undefined || document.deleted) {
          throw new AppError(404, 'document_not_found', `Document "${documentId}" does not exist`);
        }
        sendJson(response, 200, {
          id: document.id,
          version: document.version,
          fields: document.fields,
          searchVisible:
            dependencies.asynchronousIndexing !== true ||
            indexManager.isDocumentSearchVisible(indexName, document),
        });
        return;
      }
      if (request.method === 'PUT') {
        const body = await readJsonBody(request, dependencies.config.maxBodyBytes);
        try {
          const document = parseSearchDocument(body, documentId);
          const stored =
            dependencies.asynchronousIndexing === true
              ? indexManager.upsertSourceDocument(
                  indexName,
                  document,
                  dependencies.config.maxPendingJobs,
                )
              : indexManager.upsertDocument(indexName, document);
          if (stored === undefined) {
            throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
          }
          if (dependencies.asynchronousIndexing === true) {
            sendJson(response, 202, {
              id: stored.id,
              version: stored.version,
              jobId: stored.jobId,
              searchVisible: false,
            });
            return;
          }
          const index = indexManager.getIndex(indexName);
          sendJson(response, 200, {
            id: stored.id,
            version: stored.version,
            fields: stored.fields,
            searchVisible: true,
            indexVersion: index?.activeGeneration ?? null,
          });
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new AppError(400, 'invalid_document', error.message);
          }
          throw error;
        }
        return;
      }
      if (request.method === 'DELETE') {
        const deleted =
          dependencies.asynchronousIndexing === true
            ? indexManager.deleteSourceDocument(
                indexName,
                documentId,
                dependencies.config.maxPendingJobs,
              )
            : indexManager.deleteDocument(indexName, documentId);
        if (deleted === undefined) {
          throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
        }
        if (dependencies.asynchronousIndexing === true) {
          sendJson(response, 202, {
            id: deleted.id,
            version: deleted.version,
            jobId: deleted.jobId,
            deleted: true,
            searchVisible: false,
          });
          return;
        }
        const index = indexManager.getIndex(indexName);
        sendJson(response, 200, {
          id: deleted.id,
          version: deleted.version,
          deleted: true,
          searchVisible: true,
          indexVersion: index?.activeGeneration ?? null,
        });
        return;
      }
      throw new AppError(
        405,
        'method_not_allowed',
        'Only GET, PUT, and DELETE are supported for this route',
      );
    }

    const retryJobMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/jobs\/([^/]+)\/retry$/);
    if (retryJobMatch !== null) {
      ensureMethod(request, 'POST');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(retryJobMatch[1] ?? '');
      const jobId = requireJobId(retryJobMatch[2] ?? '');
      const currentJob = indexManager.getJob(indexName, jobId);
      if (currentJob === undefined) {
        throw new AppError(404, 'job_not_found', `Job "${jobId}" does not exist`);
      }
      if (currentJob.status !== 'failed') {
        throw new AppError(409, 'job_not_retryable', 'Only failed jobs can be retried');
      }
      const job = indexManager.retryJob(indexName, jobId);
      if (job === undefined) {
        throw new AppError(404, 'job_not_found', `Job "${jobId}" does not exist`);
      }
      sendJson(response, 202, job);
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/jobs\/([^/]+)$/);
    if (jobMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(jobMatch[1] ?? '');
      const jobId = requireJobId(jobMatch[2] ?? '');
      const job = indexManager.getJob(indexName, jobId);
      if (job === undefined) {
        throw new AppError(404, 'job_not_found', `Job "${jobId}" does not exist`);
      }
      sendJson(response, 200, job);
      return;
    }

    const jobsMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/jobs$/);
    if (jobsMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(jobsMatch[1] ?? '');
      const jobs = indexManager.listJobs(indexName, parseLimit(url.searchParams.get('limit')));
      if (jobs === undefined) {
        throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
      }
      sendJson(response, 200, { jobs });
      return;
    }

    const statusMatch = url.pathname.match(/^\/v1\/indexes\/([^/]+)\/status$/);
    if (statusMatch !== null) {
      ensureMethod(request, 'GET');
      const indexManager = requireIndexManager(dependencies);
      const indexName = requireIndexName(statusMatch[1] ?? '');
      const index = indexManager.getIndex(indexName);
      const jobCounts = indexManager.jobCounts(indexName);
      if (index === undefined || jobCounts === undefined) {
        throw new AppError(404, 'index_not_found', `Index "${indexName}" does not exist`);
      }
      sendJson(response, 200, {
        indexName,
        activeGeneration: index.activeGeneration,
        jobs: jobCounts,
        consistency: dependencies.asynchronousIndexing === true ? 'eventual' : 'synchronous',
      });
      return;
    }

    throw new AppError(404, 'route_not_found', 'The requested route does not exist');
  } catch (error) {
    if (error instanceof QueueSaturatedError) {
      response.setHeader('retry-after', '1');
    }
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : error instanceof QueueSaturatedError
          ? 429
          : 500;
    const safeError =
      error instanceof QueueSaturatedError
        ? new AppError(429, 'queue_saturated', 'The indexing queue is at capacity')
        : error;
    if (!(safeError instanceof AppError)) {
      dependencies.logger.error('request_failed', {
        error,
        requestId,
        route: routeName(request, url),
      });
    }
    if (!response.writableEnded) {
      sendJson(response, statusCode, errorPayload(safeError));
    }
  } finally {
    request.resume();
    const durationMs = performance.now() - startedAt;
    dependencies.metrics.observe('http_request_duration_ms', durationMs);
    dependencies.logger.info('http_request', {
      requestId,
      method: request.method ?? 'UNKNOWN',
      path: url.pathname,
      statusCode: response.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
    });
  }
}

export function createApp(dependencies: AppDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, dependencies);
  });
}
