import { dirname, isAbsolute, join, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly maxBodyBytes: number;
  readonly maxQueryLength: number;
  readonly maxBulkBatchSize: number;
  readonly maxPendingJobs: number;
  readonly workerPollIntervalMs: number;
  readonly jobLeaseMs: number;
  readonly maxJobAttempts: number;
  readonly maxJobHistory: number;
  readonly logLevel: LogLevel;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  dataDir: join(process.cwd(), 'data'),
  maxBodyBytes: 1_048_576,
  maxQueryLength: 1_000,
  maxBulkBatchSize: 1_000,
  maxPendingJobs: 10_000,
  workerPollIntervalMs: 50,
  jobLeaseMs: 30_000,
  maxJobAttempts: 5,
  maxJobHistory: 10_000,
  logLevel: 'info' as LogLevel,
};

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === '') {
    return DEFAULTS.logLevel;
  }

  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }

  throw new Error('SEARCHCRAFT_LOG_LEVEL must be one of debug, info, warn, or error');
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(environment.SEARCHCRAFT_DATA_DIR ?? DEFAULTS.dataDir);
  const configuredDbPath = environment.SEARCHCRAFT_DB_PATH ?? join(dataDir, 'searchcraft.sqlite');
  const dbPath = isAbsolute(configuredDbPath)
    ? configuredDbPath
    : resolve(process.cwd(), configuredDbPath);

  // Resolve here so every module uses the same path policy and no route can
  // accidentally construct a path from an untrusted index name.
  void dirname(dbPath);

  return {
    host: environment.SEARCHCRAFT_HOST ?? DEFAULTS.host,
    port: parsePositiveInteger('SEARCHCRAFT_PORT', environment.SEARCHCRAFT_PORT, DEFAULTS.port),
    dataDir,
    dbPath,
    maxBodyBytes: parsePositiveInteger(
      'SEARCHCRAFT_MAX_BODY_BYTES',
      environment.SEARCHCRAFT_MAX_BODY_BYTES,
      DEFAULTS.maxBodyBytes,
    ),
    maxQueryLength: parsePositiveInteger(
      'SEARCHCRAFT_MAX_QUERY_LENGTH',
      environment.SEARCHCRAFT_MAX_QUERY_LENGTH,
      DEFAULTS.maxQueryLength,
    ),
    maxBulkBatchSize: parsePositiveInteger(
      'SEARCHCRAFT_MAX_BULK_BATCH_SIZE',
      environment.SEARCHCRAFT_MAX_BULK_BATCH_SIZE,
      DEFAULTS.maxBulkBatchSize,
    ),
    maxPendingJobs: parsePositiveInteger(
      'SEARCHCRAFT_MAX_PENDING_JOBS',
      environment.SEARCHCRAFT_MAX_PENDING_JOBS,
      DEFAULTS.maxPendingJobs,
    ),
    workerPollIntervalMs: parsePositiveInteger(
      'SEARCHCRAFT_WORKER_POLL_INTERVAL_MS',
      environment.SEARCHCRAFT_WORKER_POLL_INTERVAL_MS,
      DEFAULTS.workerPollIntervalMs,
    ),
    jobLeaseMs: parsePositiveInteger(
      'SEARCHCRAFT_JOB_LEASE_MS',
      environment.SEARCHCRAFT_JOB_LEASE_MS,
      DEFAULTS.jobLeaseMs,
    ),
    maxJobAttempts: parsePositiveInteger(
      'SEARCHCRAFT_MAX_JOB_ATTEMPTS',
      environment.SEARCHCRAFT_MAX_JOB_ATTEMPTS,
      DEFAULTS.maxJobAttempts,
    ),
    maxJobHistory: parsePositiveInteger(
      'SEARCHCRAFT_MAX_JOB_HISTORY',
      environment.SEARCHCRAFT_MAX_JOB_HISTORY,
      DEFAULTS.maxJobHistory,
    ),
    logLevel: parseLogLevel(environment.SEARCHCRAFT_LOG_LEVEL),
  };
}
