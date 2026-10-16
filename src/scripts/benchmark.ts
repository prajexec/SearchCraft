import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Server } from 'node:http';

import { createApp } from '../app';
import { loadConfig } from '../config';
import { Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { initializeDatabase } from '../storage/sqlite';

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
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

async function main(): Promise<void> {
  const iterations = Number(process.env.SEARCHCRAFT_BENCHMARK_ITERATIONS ?? 200);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error('SEARCHCRAFT_BENCHMARK_ITERATIONS must be a positive integer');
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'searchcraft-benchmark-'));
  const config = loadConfig({
    ...process.env,
    SEARCHCRAFT_DATA_DIR: temporaryDirectory,
    SEARCHCRAFT_LOG_LEVEL: 'error',
  });
  const database = initializeDatabase(config.dbPath);
  const server = createApp({
    config,
    database: database.connection,
    logger: new Logger('error'),
    metrics: new Metrics(),
  });

  try {
    const port = await listen(server);
    const durations: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) {
        throw new Error(`Benchmark request failed with status ${response.status}`);
      }
      await response.arrayBuffer();
      durations.push(performance.now() - startedAt);
    }

    process.stdout.write(
      `${JSON.stringify({
        benchmark: 'health_endpoint_baseline',
        iterations,
        p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
        p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
        p99Ms: Number(percentile(durations, 0.99).toFixed(3)),
      })}\n`,
    );
  } finally {
    await close(server);
    database.connection.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
