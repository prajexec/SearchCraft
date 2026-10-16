export interface Migration {
  readonly id: string;
  readonly description: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '001_initial',
    description: 'Create SearchCraft metadata, document, and durable job tables',
    sql: `
      CREATE TABLE IF NOT EXISTS indexes (
        name TEXT PRIMARY KEY NOT NULL,
        config_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        active_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        index_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        body_json TEXT,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (index_name, document_id),
        FOREIGN KEY (index_name) REFERENCES indexes(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS indexing_jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        index_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_version INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (index_name) REFERENCES indexes(name) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS indexing_jobs_ready_idx
        ON indexing_jobs (index_name, status, available_at, created_at);

      CREATE INDEX IF NOT EXISTS indexing_jobs_status_idx
        ON indexing_jobs (index_name, status, created_at);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  },
];
