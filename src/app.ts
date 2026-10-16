import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

import type { Config } from './config';
import { AppError, errorPayload } from './http/errors';
import { openapiDocument } from './http/openapi';
import type { Logger } from './observability/logger';
import type { Metrics } from './observability/metrics';

export interface AppDependencies {
  readonly config: Config;
  readonly database: DatabaseSync;
  readonly logger: Logger;
  readonly metrics: Metrics;
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
    // Foundation routes do not consume request bodies. Drain them so a client
    // cannot leave an active socket carrying unread data.
    request.resume();

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

    throw new AppError(404, 'route_not_found', 'The requested route does not exist');
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    if (!(error instanceof AppError)) {
      dependencies.logger.error('request_failed', {
        error,
        requestId,
        route: routeName(request, url),
      });
    }
    if (!response.writableEnded) {
      sendJson(response, statusCode, errorPayload(error));
    }
  } finally {
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
