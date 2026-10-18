import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

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
  readonly jobId: string | null;
}

export type BulkMutation =
  | {
      readonly action: 'index' | 'create' | 'update';
      readonly id: string;
      readonly fields: Record<string, FieldValue>;
    }
  | {
      readonly action: 'delete';
      readonly id: string;
    };

export interface MutationOptions {
  readonly enqueueJob?: boolean;
  readonly maxPendingJobs?: number;
}

export class QueueSaturatedError extends Error {
  public constructor() {
    super('The indexing queue is at capacity');
    this.name = 'QueueSaturatedError';
  }
}

export class CreateConflictError extends Error {
  public constructor(indexName: string, documentId: string) {
    super(`Document "${documentId}" already exists in index "${indexName}"`);
    this.name = 'CreateConflictError';
  }
}

export class UpdateMissingError extends Error {
  public constructor(indexName: string, documentId: string) {
    super(`Document "${documentId}" is missing or deleted in index "${indexName}"`);
    this.name = 'UpdateMissingError';
  }
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
    jobId: null,
  };
}

export class DocumentRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public upsert(
    indexName: string,
    document: SearchDocument,
    options: MutationOptions = {},
  ): StoredSourceDocument {
    return this.mutateBatch(
      indexName,
      [{ action: 'index', id: document.id, fields: document.fields }],
      options,
    )[0] as StoredSourceDocument;
  }

  public delete(
    indexName: string,
    documentId: string,
    options: MutationOptions = {},
  ): StoredSourceDocument {
    return this.mutateBatch(
      indexName,
      [{ action: 'delete', id: documentId }],
      options,
    )[0] as StoredSourceDocument;
  }

  public mutateBatch(
    indexName: string,
    mutations: readonly BulkMutation[],
    options: MutationOptions = {},
  ): StoredSourceDocument[] {
    const enqueueJob = options.enqueueJob === true;
    const storedDocuments: StoredSourceDocument[] = [];

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (
        enqueueJob &&
        this.countOutstandingJobs(indexName) + mutations.length >
          (options.maxPendingJobs ?? Number.MAX_SAFE_INTEGER)
      ) {
        throw new QueueSaturatedError();
      }

      for (const mutation of mutations) {
        const existing = this.getRow(indexName, mutation.id);
        const now = new Date().toISOString();
        let fields: Record<string, FieldValue>;
        let deleted = false;

        switch (mutation.action) {
          case 'create':
            if (existing !== undefined) {
              throw new CreateConflictError(indexName, mutation.id);
            }
            fields = mutation.fields;
            break;
          case 'update':
            if (existing === undefined || existing.deleted === 1) {
              throw new UpdateMissingError(indexName, mutation.id);
            }
            fields = { ...this.fieldsFromRow(existing), ...mutation.fields };
            break;
          case 'index':
            fields = mutation.fields;
            break;
          case 'delete':
            fields = {};
            deleted = true;
            break;
        }

        const version = (existing?.version ?? 0) + 1;
        const createdAt = existing?.created_at ?? now;
        const jobId = enqueueJob ? randomUUID() : null;
        this.database
          .prepare(
            `INSERT INTO documents (index_name, document_id, version, body_json, deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(index_name, document_id) DO UPDATE SET
               version = excluded.version,
               body_json = excluded.body_json,
               deleted = excluded.deleted,
               updated_at = excluded.updated_at`,
          )
          .run(
            indexName,
            mutation.id,
            version,
            deleted ? null : JSON.stringify({ fields }),
            deleted ? 1 : 0,
            createdAt,
            now,
          );
        if (jobId !== null) {
          this.insertJob(
            jobId,
            indexName,
            mutation.id,
            version,
            deleted ? 'delete' : 'upsert',
            now,
          );
        }
        storedDocuments.push({
          id: mutation.id,
          fields,
          version,
          deleted,
          createdAt,
          updatedAt: now,
          jobId,
        });
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return storedDocuments;
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

  private fieldsFromRow(row: DocumentRow): Record<string, FieldValue> {
    return row.body_json === null
      ? {}
      : (JSON.parse(row.body_json) as { fields: Record<string, FieldValue> }).fields;
  }

  private countOutstandingJobs(indexName: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM indexing_jobs
         WHERE index_name = ? AND status IN ('pending', 'processing')`,
      )
      .get(indexName) as unknown as { count: number };
    return row.count;
  }

  private insertJob(
    jobId: string,
    indexName: string,
    documentId: string,
    documentVersion: number,
    operation: 'upsert' | 'delete',
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO indexing_jobs
         (job_id, index_name, document_id, document_version, operation, status, attempts, available_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(jobId, indexName, documentId, documentVersion, operation, now, now);
  }
}
