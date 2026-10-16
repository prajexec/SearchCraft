import { loadConfig } from '../config';
import { initializeDatabase } from './sqlite';

const config = loadConfig();
const database = initializeDatabase(config.dbPath);

process.stdout.write(
  `${JSON.stringify({ database: config.dbPath, appliedMigrations: database.appliedMigrations })}\n`,
);
database.connection.close();
