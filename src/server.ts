import { createApp } from './app';
import { loadConfig } from './config';
import { IndexManager } from './indexes/index-manager';
import { Logger } from './observability/logger';
import { Metrics } from './observability/metrics';
import { initializeDatabase } from './storage/sqlite';
import { JobRepository } from './storage/jobs';
import { IndexWorker } from './workers/index-worker';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const database = initializeDatabase(config.dbPath);
const metrics = new Metrics();
const indexManager = new IndexManager(database.connection, config);
indexManager.load();
const worker = new IndexWorker(
  indexManager,
  new JobRepository(database.connection),
  logger,
  config,
  metrics,
);
const server = createApp({
  config,
  database: database.connection,
  logger,
  metrics,
  indexManager,
  asynchronousIndexing: true,
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  server.close((error) => {
    if (error !== undefined) {
      logger.error('shutdown_failed', { error });
      process.exitCode = 1;
    }
    void worker.stop().then(() => {
      database.connection.close();
      logger.info('shutdown_complete');
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  worker.start();
  logger.info('server_started', {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    appliedMigrations: database.appliedMigrations,
  });
});
