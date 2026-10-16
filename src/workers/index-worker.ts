import type { Config } from '../config';
import type { IndexManager } from '../indexes/index-manager';
import type { Logger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import type { IndexingJob, JobRepository } from '../storage/jobs';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
      const job = this.jobs.claimNext(new Date(), this.config.jobLeaseMs);
      if (job === undefined) {
        await wait(this.config.workerPollIntervalMs);
        continue;
      }
      this.process(job);
    }
  }

  private process(job: IndexingJob): void {
    try {
      const currentDocument = this.indexManager.getDocument(job.indexName, job.documentId);
      if (currentDocument === undefined || currentDocument.version > job.documentVersion) {
        // A newer mutation has its own job. Completing this stale job prevents
        // an old worker attempt from overwriting the newer source version.
        this.jobs.complete(job.jobId);
        this.jobs.pruneTerminal(job.indexName, this.config.maxJobHistory);
        this.metrics?.increment('indexing_jobs_superseded_total');
        this.logger.debug('indexing_job_superseded', {
          jobId: job.jobId,
          indexName: job.indexName,
          documentId: job.documentId,
          jobVersion: job.documentVersion,
          currentVersion: currentDocument?.version ?? null,
        });
        return;
      }

      if (currentDocument.version < job.documentVersion) {
        throw new Error('source document version is older than the claimed job');
      }
      if (!this.indexManager.applyIndexedDocument(job.indexName, currentDocument)) {
        throw new Error(`index "${job.indexName}" no longer exists`);
      }
      this.jobs.complete(job.jobId);
      this.jobs.pruneTerminal(job.indexName, this.config.maxJobHistory);
      this.metrics?.increment('indexing_jobs_completed_total');
      this.logger.debug('indexing_job_completed', {
        jobId: job.jobId,
        indexName: job.indexName,
        documentId: job.documentId,
        documentVersion: job.documentVersion,
      });
    } catch (error) {
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
}
