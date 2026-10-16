import type { DatabaseSync } from 'node:sqlite';

import type { FieldValue, SearchDocument } from '../indexes/index-config';

interface DocumentRow {
  readonly index_name: string;
  readonly document_id: string;
  readonly version: number;
  readonly body_json: string | null;
  readonly deleted: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface StoredSourceDocument extends SearchDocument {
  readonly version: number;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toDocument(row: DocumentRow): StoredSourceDocument {
  return {
    id: row.document_id,
    fields:
      row.body_json === null
        ? {}
        : (JSON.parse(row.body_json) as { fields: Record<string, FieldValue> }).fields,
    version: row.version,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DocumentRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(indexName: string, document: SearchDocument): StoredSourceDocument {
    const existing = this.getRow(indexName, document.id);
    const now = new Date().toISOString();
    const version = (existing?.version ?? 0) + 1;
    const bodyJson = JSON.stringify({ fields: document.fields });

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO documents (index_name, document_id, version, body_json, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(index_name, document_id) DO UPDATE SET
             version = excluded.version,
             body_json = excluded.body_json,
             deleted = 0,
             updated_at = excluded.updated_at`,
        )
        .run(indexName, document.id, version, bodyJson, existing?.created_at ?? now, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id: document.id,
      fields: document.fields,
      version,
      deleted: false,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  public delete(indexName: string, documentId: string): StoredSourceDocument {
    const existing = this.getRow(indexName, documentId);
    const now = new Date().toISOString();
    const version = (existing?.version ?? 0) + 1;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO documents (index_name, document_id, version, body_json, deleted, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 1, ?, ?)
           ON CONFLICT(index_name, document_id) DO UPDATE SET
             version = excluded.version,
             body_json = NULL,
             deleted = 1,
             updated_at = excluded.updated_at`,
        )
        .run(indexName, documentId, version, existing?.created_at ?? now, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      id: documentId,
      fields: {},
      version,
      deleted: true,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  public get(indexName: string, documentId: string): StoredSourceDocument | undefined {
    const row = this.getRow(indexName, documentId);
    return row === undefined ? undefined : toDocument(row);
  }

  public listActive(indexName: string): readonly StoredSourceDocument[] {
    const rows = this.database
      .prepare(
        `SELECT index_name, document_id, version, body_json, deleted, created_at, updated_at
         FROM documents WHERE index_name = ? AND deleted = 0 ORDER BY document_id`,
      )
      .all(indexName) as unknown as DocumentRow[];
    return rows.map(toDocument);
  }

  private getRow(indexName: string, documentId: string): DocumentRow | undefined {
    return this.database
      .prepare(
        `SELECT index_name, document_id, version, body_json, deleted, created_at, updated_at
         FROM documents WHERE index_name = ? AND document_id = ?`,
      )
      .get(indexName, documentId) as unknown as DocumentRow | undefined;
  }
}
