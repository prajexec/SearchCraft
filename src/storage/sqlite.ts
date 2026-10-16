import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrations } from './migrations/001_initial';

interface AppliedMigration {
  readonly id: string;
}

export interface DatabaseHandle {
  readonly connection: DatabaseSync;
  readonly appliedMigrations: readonly string[];
}

export function initializeDatabase(dbPath: string): DatabaseHandle {
  mkdirSync(dirname(dbPath), { recursive: true });
  const connection = new DatabaseSync(dbPath);
  connection.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = connection
      .prepare('SELECT id FROM schema_migrations ORDER BY id')
      .all() as unknown as AppliedMigration[];
    const applied = new Set(appliedRows.map((row) => row.id));
    const appliedNow: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        continue;
      }

      connection.exec('BEGIN IMMEDIATE');
      try {
        connection.exec(migration.sql);
        connection
          .prepare('INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)')
          .run(migration.id, migration.description, new Date().toISOString());
        connection.exec('COMMIT');
        appliedNow.push(migration.id);
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    }

    return {
      connection,
      appliedMigrations: [...applied, ...appliedNow],
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
