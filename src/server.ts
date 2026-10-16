import { createApp } from './app';
import { loadConfig } from './config';
import { Logger } from './observability/logger';
import { Metrics } from './observability/metrics';
import { initializeDatabase } from './storage/sqlite';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const database = initializeDatabase(config.dbPath);
const metrics = new Metrics();
const server = createApp({ config, database: database.connection, logger, metrics });

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
    database.connection.close();
    logger.info('shutdown_complete');
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  logger.info('server_started', {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    appliedMigrations: database.appliedMigrations,
  });
});
