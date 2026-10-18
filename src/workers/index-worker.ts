import type { Config } from '../config';
import type { IndexManager } from '../indexes/index-manager';
import type { Logger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import type { StoredSourceDocument } from '../storage/documents';
import type { IndexingJob, JobRepository } from '../storage/jobs';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

interface CompletedJob {
  readonly job: IndexingJob;
  readonly superseded: boolean;
  readonly currentVersion: number | null;
}

interface JobGroup {
  readonly jobs: IndexingJob[];
  readonly documents: Map<string, StoredSourceDocument>;
}

export class IndexWorker {
  private running = false;
  private loopPromise: Promise<void> | undefined;

  public constructor(
    private readonly indexManager: IndexManager,
    private readonly jobs: JobRepository,
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly metrics?: Metrics,
  ) {}

  public start(): void {
    if (this.running) {
      return;
    }
    const recoveredJobs = this.jobs.recoverProcessingJobs();
    if (recoveredJobs > 0) {
      this.logger.info('indexing_jobs_recovered', { recoveredJobs });
    }
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const jobs = this.jobs.claimBatch(
        new Date(),
        this.config.jobLeaseMs,
        this.config.maxBulkBatchSize,
      );
      if (jobs.length === 0) {
        await wait(this.config.workerPollIntervalMs);
        continue;
      }
      this.processBatch(jobs);
    }
  }

  private process(job: IndexingJob): void {
    this.processBatch([job]);
  }

  private processBatch(jobs: readonly IndexingJob[]): void {
    const groups = new Map<string, JobGroup>();
    const completedJobs: CompletedJob[] = [];

    for (const job of jobs) {
      let currentDocument: StoredSourceDocument | undefined;
      try {
        currentDocument = this.indexManager.getDocument(job.indexName, job.documentId);
        if (currentDocument === undefined || currentDocument.version > job.documentVersion) {
          // A newer mutation has its own job. Completing this stale job prevents
          // an old worker attempt from overwriting the newer source version.
          completedJobs.push({
            job,
            superseded: true,
            currentVersion: currentDocument?.version ?? null,
          });
          continue;
        }

        if (currentDocument.version < job.documentVersion) {
          throw new Error('source document version is older than the claimed job');
        }

        const group = groups.get(job.indexName) ?? {
          jobs: [],
          documents: new Map<string, StoredSourceDocument>(),
        };
        group.jobs.push(job);
        group.documents.set(job.documentId, currentDocument);
        groups.set(job.indexName, group);
      } catch (error) {
        this.fail(job, error);
      }
    }

    for (const [indexName, group] of groups) {
      try {
        if (!this.indexManager.applyIndexedDocuments(indexName, [...group.documents.values()])) {
          throw new Error(`index "${indexName}" no longer exists`);
        }
        for (const job of group.jobs) {
          completedJobs.push({ job, superseded: false, currentVersion: null });
        }
      } catch (error) {
        for (const job of group.jobs) {
          this.fail(job, error);
        }
      }
    }

    if (completedJobs.length === 0) {
      return;
    }

    try {
      this.jobs.completeMany(completedJobs.map(({ job }) => job.jobId));
    } catch (error) {
      for (const { job } of completedJobs) {
        this.fail(job, error);
      }
      return;
    }

    const indexesToPrune = new Set<string>();
    for (const { job, superseded, currentVersion } of completedJobs) {
      indexesToPrune.add(job.indexName);
      if (superseded) {
        this.metrics?.increment('indexing_jobs_superseded_total');
        this.logger.debug('indexing_job_superseded', {
          jobId: job.jobId,
          indexName: job.indexName,
          documentId: job.documentId,
          jobVersion: job.documentVersion,
          currentVersion,
        });
        continue;
      }
      this.metrics?.increment('indexing_jobs_completed_total');
      this.logger.debug('indexing_job_completed', {
        jobId: job.jobId,
        indexName: job.indexName,
        documentId: job.documentId,
        documentVersion: job.documentVersion,
      });
    }
    for (const indexName of indexesToPrune) {
      this.jobs.pruneTerminal(indexName, this.config.maxJobHistory);
    }
  }

  private fail(job: IndexingJob, error: unknown): void {
    const failed = this.jobs.fail(
      job.jobId,
      error instanceof Error ? error.message : String(error),
      this.config.maxJobAttempts,
    );
    this.metrics?.increment('indexing_jobs_failed_total');
    this.jobs.pruneTerminal(job.indexName, this.config.maxJobHistory);
    this.logger.error('indexing_job_failed', {
      error,
      jobId: job.jobId,
      indexName: job.indexName,
      documentId: job.documentId,
      status: failed?.status ?? 'missing',
      attempts: failed?.attempts ?? job.attempts,
    });
  }
}
