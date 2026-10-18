import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Server } from 'node:http';

import { createApp } from '../app';
import { loadConfig } from '../config';
import { IndexManager } from '../indexes/index-manager';
import { Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { initializeDatabase } from '../storage/sqlite';

const BENCHMARK_NAME = 'searchcraft_phase_7';
const BENCHMARK_VERSION = 1;
const DATASET_SEED = 'phase-7-deterministic-v1';
const INDEX_NAME = 'benchmark';
const DEFAULT_DOCUMENTS = 10_000;
const DEFAULT_BATCH_SIZES = [100, 500, 1_000];
const DEFAULT_QUERIES = 100;
const SEARCH_LIMIT = 10;
const NO_COMPACTION_THRESHOLD = Number.MAX_SAFE_INTEGER;
const QUERY_TEMPLATES = [
  'searchcraft benchmark',
  'deterministic document',
  'category searchcraft',
  'workload document',
] as const;
const INDEX_CONFIG = {
  searchableFields: {
    title: { boost: 2 },
    body: { boost: 1 },
    category: { boost: 1 },
  },
  storedFields: ['title', 'body', 'category'],
  maxTokenLength: 128,
  maxQueryTerms: 32,
} as const;

interface BenchmarkSettings {
  readonly documents: number;
  readonly batchSizes: readonly number[];
  readonly queries: number;
}

interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly json: unknown;
}

interface IndexingResult {
  readonly batchSize: number;
  readonly batches: number;
  readonly documents: number;
  readonly durationMs: number;
  readonly documentsPerSecond: number;
}

interface SearchLatencyResult {
  readonly queries: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseBatchSizes(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_BATCH_SIZES;
  }

  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    throw new Error(
      'SEARCHCRAFT_BENCHMARK_BATCH_SIZES must be a comma-separated list of positive integers',
    );
  }

  const batchSizes = parts.map((part) =>
    parsePositiveInteger('SEARCHCRAFT_BENCHMARK_BATCH_SIZES entries', part, 1),
  );
  if (new Set(batchSizes).size !== batchSizes.length) {
    throw new Error('SEARCHCRAFT_BENCHMARK_BATCH_SIZES must not contain duplicates');
  }
  return batchSizes;
}

function loadBenchmarkSettings(environment: NodeJS.ProcessEnv): BenchmarkSettings {
  return {
    documents: parsePositiveInteger(
      'SEARCHCRAFT_BENCHMARK_DOCUMENTS',
      environment.SEARCHCRAFT_BENCHMARK_DOCUMENTS,
      DEFAULT_DOCUMENTS,
    ),
    batchSizes: parseBatchSizes(environment.SEARCHCRAFT_BENCHMARK_BATCH_SIZES),
    queries: parsePositiveInteger(
      'SEARCHCRAFT_BENCHMARK_QUERIES',
      environment.SEARCHCRAFT_BENCHMARK_QUERIES,
      DEFAULT_QUERIES,
    ),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Benchmark server did not expose a TCP address'));
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

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Benchmark ${description} response was not a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function requestJson(port: number, path: string, init: RequestInit): Promise<HttpResponse> {
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  } catch (error) {
    throw new Error(
      `Benchmark request ${method} ${path} could not be completed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Benchmark request ${method} ${path} returned non-2xx status ${response.status}: ${
        body || '<empty response>'
      }`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Benchmark request ${method} ${path} returned invalid JSON`);
  }

  return { status: response.status, body, json };
}

function makeDocuments(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `doc-${index.toString().padStart(8, '0')}`;
    const category = `category-${index % 4}`;
    const source = {
      fields: {
        title: `SearchCraft benchmark document ${id}`,
        body: `Deterministic BM25 workload for ${category} searchcraft document benchmark`,
        category,
      },
    };
    return `${JSON.stringify({ index: { _id: id } })}\n${JSON.stringify(source)}\n`;
  });
}

function totalBytes(values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

function validateBulkResponse(response: HttpResponse, expectedDocuments: number): void {
  if (response.status !== 200) {
    throw new Error(
      `Synchronous benchmark bulk request returned unexpected status ${response.status}`,
    );
  }
  const body = asRecord(response.json, 'bulk');
  if (body.errors !== false) {
    throw new Error(`Benchmark bulk request reported errors: ${response.body}`);
  }
  if (!Array.isArray(body.items) || body.items.length !== expectedDocuments) {
    throw new Error(
      `Benchmark bulk response contained ${Array.isArray(body.items) ? body.items.length : 0} items; expected ${expectedDocuments}`,
    );
  }
}

function validateSearchResponse(response: HttpResponse): void {
  if (response.status !== 200) {
    throw new Error(`Benchmark search request returned unexpected status ${response.status}`);
  }
  const body = asRecord(response.json, 'search');
  if (typeof body.totalHits !== 'number' || body.totalHits <= 0) {
    throw new Error(`Benchmark search query returned no hits: ${response.body}`);
  }
}

async function createIndex(port: number): Promise<void> {
  const response = await requestJson(port, '/v1/indexes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: INDEX_NAME, config: INDEX_CONFIG }),
  });
  if (response.status !== 201) {
    throw new Error(`Benchmark index creation returned unexpected status ${response.status}`);
  }
}

async function runSearch(port: number, queryCount: number): Promise<SearchLatencyResult> {
  const durations: number[] = [];
  for (let index = 0; index < queryCount; index += 1) {
    const query = QUERY_TEMPLATES[index % QUERY_TEMPLATES.length] as string;
    const queryString = new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT) }).toString();
    const startedAt = performance.now();
    const response = await requestJson(port, `/v1/indexes/${INDEX_NAME}/search?${queryString}`, {
      method: 'GET',
    });
    durations.push(performance.now() - startedAt);
    validateSearchResponse(response);
  }

  return {
    queries: queryCount,
    p50Ms: roundMilliseconds(percentile(durations, 0.5)),
    p95Ms: roundMilliseconds(percentile(durations, 0.95)),
    p99Ms: roundMilliseconds(percentile(durations, 0.99)),
  };
}

async function runBatchSize(
  temporaryRoot: string,
  documents: readonly string[],
  settings: BenchmarkSettings,
  batchSize: number,
  searchBatchSize: number,
  maxBodyBytes: number,
): Promise<{ readonly indexing: IndexingResult; readonly search?: SearchLatencyResult }> {
  const dataDirectory = join(temporaryRoot, `batch-${batchSize}`);
  const config = loadConfig({
    ...process.env,
    SEARCHCRAFT_DATA_DIR: dataDirectory,
    SEARCHCRAFT_DB_PATH: join(dataDirectory, 'searchcraft.sqlite'),
    SEARCHCRAFT_LOG_LEVEL: 'error',
    SEARCHCRAFT_MAX_BODY_BYTES: String(maxBodyBytes),
    SEARCHCRAFT_MAX_BULK_BATCH_SIZE: String(batchSize),
    SEARCHCRAFT_SEGMENT_COMPACTION_THRESHOLD: String(NO_COMPACTION_THRESHOLD),
  });
  const database = initializeDatabase(config.dbPath);
  const indexManager = new IndexManager(database.connection, config);
  indexManager.load();
  const server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
    indexManager,
    asynchronousIndexing: false,
  });

  try {
    const port = await listen(server);
    await createIndex(port);

    const durations: number[] = [];
    let batches = 0;
    for (let start = 0; start < documents.length; start += batchSize) {
      const end = Math.min(documents.length, start + batchSize);
      const body = documents.slice(start, end).join('');
      const startedAt = performance.now();
      const response = await requestJson(port, `/v1/indexes/${INDEX_NAME}/documents/_bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
      });
      durations.push(performance.now() - startedAt);
      validateBulkResponse(response, end - start);
      batches += 1;
    }

    const durationMs = durations.reduce((total, duration) => total + duration, 0);
    const indexing: IndexingResult = {
      batchSize,
      batches,
      documents: documents.length,
      durationMs: roundMilliseconds(durationMs),
      documentsPerSecond: Number(
        (documents.length / Math.max(durationMs / 1_000, 0.000001)).toFixed(3),
      ),
    };
    const search =
      batchSize === searchBatchSize ? await runSearch(port, settings.queries) : undefined;
    return { indexing, ...(search === undefined ? {} : { search }) };
  } finally {
    if (server.listening) {
      await close(server);
    }
    database.connection.close();
  }
}

async function main(): Promise<void> {
  const settings = loadBenchmarkSettings(process.env);
  const documents = makeDocuments(settings.documents);
  const maxBodyBytes = Math.max(1_048_576, totalBytes(documents));
  const searchBatchSize = Math.max(...settings.batchSizes);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'searchcraft-benchmark-'));

  try {
    const indexing: IndexingResult[] = [];
    let search: SearchLatencyResult | undefined;
    for (const batchSize of settings.batchSizes) {
      const result = await runBatchSize(
        temporaryRoot,
        documents,
        settings,
        batchSize,
        searchBatchSize,
        maxBodyBytes,
      );
      indexing.push(result.indexing);
      if (result.search !== undefined) {
        search = result.search;
      }
    }

    if (search === undefined) {
      throw new Error('Benchmark did not produce search latency measurements');
    }

    process.stdout.write(
      `${JSON.stringify({
        benchmark: BENCHMARK_NAME,
        version: BENCHMARK_VERSION,
        nodeVersion: process.version,
        workload: {
          seed: DATASET_SEED,
          documents: settings.documents,
          batchSizes: settings.batchSizes,
          queries: settings.queries,
          searchBatchSize,
          searchLimit: SEARCH_LIMIT,
          indexingMode: 'synchronous',
          segmentCompactionThreshold: NO_COMPACTION_THRESHOLD,
          warmupQueries: 0,
        },
        indexing,
        searchLatencyMs: search,
      })}\n`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
