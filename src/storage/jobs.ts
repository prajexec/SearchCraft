import type { DatabaseSync } from 'node:sqlite';

export type JobOperation = 'upsert' | 'delete';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IndexingJob {
  readonly jobId: string;
  readonly indexName: string;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly operation: JobOperation;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface JobCounts {
  readonly pending: number;
  readonly processing: number;
  readonly completed: number;
  readonly failed: number;
  readonly lastCompletedAt: string | null;
}

interface JobRow {
  readonly job_id: string;
  readonly index_name: string;
  readonly document_id: string;
  readonly document_version: number;
  readonly operation: JobOperation;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly available_at: string;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
}

function toJob(row: JobRow): IndexingJob {
  return {
    jobId: row.job_id,
    indexName: row.index_name,
    documentId: row.document_id,
    documentVersion: row.document_version,
    operation: row.operation,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

const JOB_COLUMNS = `job_id, index_name, document_id, document_version, operation,
  status, attempts, available_at, claimed_at, completed_at, last_error, created_at`;

export class JobRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public get(indexName: string, jobId: string): IndexingJob | undefined {
    const row = this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM indexing_jobs WHERE index_name = ? AND job_id = ?`)
      .get(indexName, jobId) as unknown as JobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  public list(indexName: string, limit: number): readonly IndexingJob[] {
    const rows = this.database
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM indexing_jobs
         WHERE index_name = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(indexName, limit) as unknown as JobRow[];
    return rows.map(toJob);
  }

  public count(indexName: string): JobCounts {
    const row = this.database
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           MAX(completed_at) AS last_completed_at
         FROM indexing_jobs WHERE index_name = ?`,
      )
      .get(indexName) as unknown as {
      pending: number | null;
      processing: number | null;
      completed: number | null;
      failed: number | null;
      last_completed_at: string | null;
    };
    return {
      pending: row.pending ?? 0,
      processing: row.processing ?? 0,
      completed: row.completed ?? 0,
      failed: row.failed ?? 0,
      lastCompletedAt: row.last_completed_at,
    };
  }

  public countOutstanding(indexName: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM indexing_jobs
         WHERE index_name = ? AND status IN ('pending', 'processing')`,
      )
      .get(indexName) as unknown as { count: number };
    return row.count;
  }

  public recoverProcessingJobs(): number {
    const result = this.database
      .prepare(
        `UPDATE indexing_jobs SET status = 'pending', claimed_at = NULL,
           available_at = ?, last_error = 'worker restarted'
         WHERE status = 'processing'`,
      )
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  public claimNext(now: Date, leaseMs: number): IndexingJob | undefined {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - leaseMs).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `UPDATE indexing_jobs SET status = 'pending', claimed_at = NULL,
             available_at = ?, last_error = 'worker lease expired'
           WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ?`,
        )
        .run(nowIso, staleBefore);

      const row = this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM indexing_jobs
           WHERE status = 'pending' AND available_at <= ?
           ORDER BY available_at, created_at LIMIT 1`,
        )
        .get(nowIso) as unknown as JobRow | undefined;
      if (row === undefined) {
        this.database.exec('COMMIT');
        return undefined;
      }

      const attempts = row.attempts + 1;
      this.database
        .prepare(
          `UPDATE indexing_jobs SET status = 'processing', attempts = ?, claimed_at = ?
           WHERE job_id = ? AND status = 'pending'`,
        )
        .run(attempts, nowIso, row.job_id);
      this.database.exec('COMMIT');
      return toJob({ ...row, status: 'processing', attempts, claimed_at: nowIso });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public complete(jobId: string): void {
    this.database
      .prepare(
        `UPDATE indexing_jobs SET status = 'completed', completed_at = ?, claimed_at = NULL
         WHERE job_id = ? AND status = 'processing'`,
      )
      .run(new Date().toISOString(), jobId);
  }

  public pruneTerminal(indexName: string, maxHistory: number): void {
    for (const status of ['completed', 'failed'] as const) {
      const timestampColumn = status === 'completed' ? 'completed_at' : 'created_at';
      this.database
        .prepare(
          `DELETE FROM indexing_jobs
           WHERE index_name = ? AND status = ? AND job_id NOT IN (
             SELECT job_id FROM indexing_jobs
             WHERE index_name = ? AND status = ?
             ORDER BY ${timestampColumn} DESC LIMIT ?
           )`,
        )
        .run(indexName, status, indexName, status, maxHistory);
    }
  }

  public fail(jobId: string, errorMessage: string, maxAttempts: number): IndexingJob | undefined {
    const current = this.findById(jobId);
    if (current === undefined || current.status !== 'processing') {
      return current;
    }

    const terminal = current.attempts >= maxAttempts;
    const availableAt = new Date(Date.now() + Math.min(60_000, 100 * 2 ** (current.attempts - 1)));
    this.database
      .prepare(
        `UPDATE indexing_jobs SET
           status = ?, available_at = ?, claimed_at = NULL, completed_at = NULL, last_error = ?
         WHERE job_id = ? AND status = 'processing'`,
      )
      .run(
        terminal ? 'failed' : 'pending',
        terminal ? current.availableAt : availableAt.toISOString(),
        errorMessage,
        jobId,
      );
    return this.findById(jobId);
  }

  public retry(indexName: string, jobId: string): IndexingJob | undefined {
    this.database
      .prepare(
        `UPDATE indexing_jobs SET status = 'pending', available_at = ?, claimed_at = NULL, last_error = NULL
         WHERE index_name = ? AND job_id = ? AND status = 'failed'`,
      )
      .run(new Date().toISOString(), indexName, jobId);
    return this.get(indexName, jobId);
  }

  private findById(jobId: string): IndexingJob | undefined {
    const row = this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM indexing_jobs WHERE job_id = ?`)
      .get(jobId) as unknown as JobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  }
}
