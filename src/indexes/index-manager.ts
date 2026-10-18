import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../config';
import {
  InvertedIndex,
  type SearchCursor,
  type SearchPage,
  decodeCursor,
} from '../indexing/inverted-index';
import {
  appendSegmentAtomic,
  createManifest,
  manifestPath,
  manifestSegmentFiles,
  readManifest,
  replaceWithCompactedSegmentAtomic,
  SegmentReader,
  writeManifestAtomic,
} from '../indexing/segment';
import type { SegmentSnapshot } from '../indexing/segment';
import type { SearchFilters } from '../query/filters';
import {
  parseIndexConfig,
  type IndexMetadata,
  type SearchDocument,
  validateDocumentId,
  validateIndexName,
} from './index-config';
import { DocumentRepository, type StoredSourceDocument } from '../storage/documents';
import { IndexRepository } from '../storage/indexes';
import { JobRepository, type IndexingJob, type JobCounts } from '../storage/jobs';

interface RuntimeIndex {
  readonly metadata: IndexMetadata;
  readonly directory: string;
  index: InvertedIndex;
  generation: number;
  activeSegments: string[];
  compactionScheduled: boolean;
}

export interface SearchResponse {
  readonly page: SearchPage;
  readonly indexVersion: number;
}

export class IndexManager {
  private readonly indexes = new Map<string, RuntimeIndex>();
  private readonly indexRepository: IndexRepository;
  private readonly documentRepository: DocumentRepository;
  private readonly jobRepository: JobRepository;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly config: Config,
  ) {
    this.indexRepository = new IndexRepository(database);
    this.documentRepository = new DocumentRepository(database);
    this.jobRepository = new JobRepository(database);
  }

  public load(): void {
    for (const metadata of this.indexRepository.list()) {
      this.indexes.set(metadata.name, this.loadRuntime(metadata));
    }
  }

  public createIndex(name: string, rawConfig: unknown): IndexMetadata | undefined {
    validateIndexName(name);
    const indexConfig = parseIndexConfig(rawConfig);
    const metadata = this.indexRepository.create(name, indexConfig);
    if (metadata === undefined) {
      return undefined;
    }

    const directory = this.indexDirectory(name);
    const runtime: RuntimeIndex = {
      metadata,
      directory,
      index: new InvertedIndex(name, indexConfig),
      generation: 1,
      activeSegments: [],
      compactionScheduled: false,
    };
    writeManifestAtomic(directory, createManifest(name, 1, []));
    this.indexRepository.setActiveGeneration(name, 1);
    this.indexes.set(name, runtime);
    return this.indexRepository.get(name);
  }

  public listIndexes(): readonly IndexMetadata[] {
    return this.indexRepository.list();
  }

  public getIndex(name: string): IndexMetadata | undefined {
    return this.indexRepository.get(name);
  }

  public getDocument(indexName: string, documentId: string): StoredSourceDocument | undefined {
    validateDocumentId(documentId);
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.documentRepository.get(indexName, documentId);
  }

  public isDocumentSearchVisible(indexName: string, document: StoredSourceDocument): boolean {
    const runtime = this.indexes.get(indexName);
    return (
      runtime !== undefined &&
      !runtime.index.isDocumentDeleted(document.id) &&
      runtime.index.documentVersion(document.id) === document.version
    );
  }

  public upsertDocument(
    indexName: string,
    document: SearchDocument,
  ): StoredSourceDocument | undefined {
    const runtime = this.indexes.get(indexName);
    if (runtime === undefined) {
      return undefined;
    }
    const stored = this.documentRepository.upsert(indexName, document);
    runtime.index.upsert(document, stored.version);
    try {
      this.publishMutation(runtime, document.id);
    } catch (error) {
      this.restoreActiveIndex(runtime);
      throw error;
    }
    return stored;
  }

  public upsertSourceDocument(
    indexName: string,
    document: SearchDocument,
    maxPendingJobs: number,
  ): StoredSourceDocument | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.documentRepository.upsert(indexName, document, {
      enqueueJob: true,
      maxPendingJobs,
    });
  }

  public deleteDocument(indexName: string, documentId: string): StoredSourceDocument | undefined {
    const runtime = this.indexes.get(indexName);
    if (runtime === undefined) {
      return undefined;
    }
    validateDocumentId(documentId);
    const stored = this.documentRepository.delete(indexName, documentId);
    runtime.index.remove(documentId, stored.version);
    try {
      this.publishMutation(runtime, documentId);
    } catch (error) {
      this.restoreActiveIndex(runtime);
      throw error;
    }
    return stored;
  }

  public deleteSourceDocument(
    indexName: string,
    documentId: string,
    maxPendingJobs: number,
  ): StoredSourceDocument | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    validateDocumentId(documentId);
    return this.documentRepository.delete(indexName, documentId, {
      enqueueJob: true,
      maxPendingJobs,
    });
  }

  public getJob(indexName: string, jobId: string): IndexingJob | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.jobRepository.get(indexName, jobId);
  }

  public listJobs(indexName: string, limit: number): readonly IndexingJob[] | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.jobRepository.list(indexName, limit);
  }

  public retryJob(indexName: string, jobId: string): IndexingJob | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.jobRepository.retry(indexName, jobId);
  }

  public jobCounts(indexName: string): JobCounts | undefined {
    if (!this.indexes.has(indexName)) {
      return undefined;
    }
    return this.jobRepository.count(indexName);
  }

  public applyIndexedDocument(indexName: string, document: StoredSourceDocument): boolean {
    const runtime = this.indexes.get(indexName);
    if (runtime === undefined) {
      return false;
    }

    const currentVersion = runtime.index.documentVersion(document.id);
    if (
      currentVersion !== undefined &&
      (currentVersion > document.version ||
        (currentVersion === document.version &&
          runtime.index.isDocumentDeleted(document.id) === document.deleted))
    ) {
      // A retry after publication is idempotent. A stale job is normally
      // filtered by IndexWorker, but keeping this guard here prevents an old
      // caller from resurrecting a newer segment.
      return true;
    }

    if (document.deleted) {
      runtime.index.remove(document.id, document.version);
    } else {
      runtime.index.upsert(document, document.version);
    }
    try {
      this.publishMutation(runtime, document.id);
    } catch (error) {
      this.restoreActiveIndex(runtime);
      throw error;
    }
    return true;
  }

  public search(
    indexName: string,
    query: string,
    limit: number,
    cursorValue: string | undefined,
    filters: SearchFilters = {},
  ): SearchResponse | undefined {
    const runtime = this.indexes.get(indexName);
    if (runtime === undefined) {
      return undefined;
    }
    const cursor: SearchCursor | undefined =
      cursorValue === undefined ? undefined : decodeCursor(cursorValue);
    if (cursorValue !== undefined && cursor === undefined) {
      throw new Error('invalid_cursor');
    }
    return {
      page: runtime.index.search(query, limit, cursor, filters),
      indexVersion: runtime.generation,
    };
  }

  /** Force a merge; normal indexing schedules this operation at the threshold. */
  public compactIndex(indexName: string): boolean {
    const runtime = this.indexes.get(indexName);
    if (runtime === undefined) {
      return false;
    }
    this.compactRuntime(runtime);
    return true;
  }

  private publishMutation(runtime: RuntimeIndex, documentId: string): void {
    const nextGeneration = runtime.generation + 1;
    const snapshot = runtime.index.toDeltaSnapshot(nextGeneration, documentId);
    const manifest = appendSegmentAtomic(
      runtime.directory,
      createManifest(runtime.metadata.name, runtime.generation, runtime.activeSegments),
      snapshot,
    );
    runtime.activeSegments = [...manifestSegmentFiles(manifest)];
    runtime.generation = manifest.activeGeneration;
    this.indexRepository.setActiveGeneration(runtime.metadata.name, runtime.generation);
    this.scheduleCompaction(runtime);
  }

  private loadRuntime(metadata: IndexMetadata): RuntimeIndex {
    const directory = this.indexDirectory(metadata.name);
    mkdirSync(directory, { recursive: true });
    const activeDocuments = this.documentRepository.listActive(metadata.name);
    const manifest = readManifest(manifestPath(directory), metadata.name);
    if (manifest !== undefined) {
      const reader = SegmentReader.open(directory, metadata.name, manifest);
      if (
        reader !== undefined &&
        this.segmentsMatchSource(metadata, reader.snapshots, activeDocuments)
      ) {
        const runtime: RuntimeIndex = {
          metadata,
          directory,
          index: InvertedIndex.fromSegments(metadata.name, metadata.config, reader.snapshots),
          generation: manifest.activeGeneration,
          activeSegments: [...reader.files],
          compactionScheduled: false,
        };
        if (
          manifest.formatVersion === 1 ||
          reader.snapshots.some((snapshot) => snapshot.formatVersion === 1)
        ) {
          this.compactRuntime(runtime);
        }
        return runtime;
      }
    }

    const runtime: RuntimeIndex = {
      metadata,
      directory,
      index: this.buildIndexFromSource(metadata),
      generation: Math.max(metadata.activeGeneration, manifest?.activeGeneration ?? 0),
      activeSegments: [],
      compactionScheduled: false,
    };
    this.compactRuntime(runtime);
    return runtime;
  }

  private compactRuntime(runtime: RuntimeIndex): void {
    const previousSegments = [...runtime.activeSegments];
    const snapshot = runtime.index.toSnapshot(runtime.generation + 1);
    const manifest = replaceWithCompactedSegmentAtomic(runtime.directory, snapshot);
    runtime.activeSegments = [...manifestSegmentFiles(manifest)];
    runtime.generation = manifest.activeGeneration;
    this.indexRepository.setActiveGeneration(runtime.metadata.name, runtime.generation);
    for (const file of previousSegments) {
      if (runtime.activeSegments.includes(file)) {
        continue;
      }
      try {
        unlinkSync(join(runtime.directory, file));
      } catch {
        // Retired files are cleanup work. A failed unlink cannot invalidate
        // the atomically published compacted manifest.
      }
    }
  }

  private scheduleCompaction(runtime: RuntimeIndex): void {
    if (
      runtime.activeSegments.length < this.config.segmentCompactionThreshold ||
      runtime.compactionScheduled
    ) {
      return;
    }
    runtime.compactionScheduled = true;
    setImmediate(() => {
      runtime.compactionScheduled = false;
      if (this.indexes.get(runtime.metadata.name) !== runtime) {
        return;
      }
      try {
        if (runtime.activeSegments.length >= this.config.segmentCompactionThreshold) {
          this.compactRuntime(runtime);
        }
      } catch {
        // Search continues against the previous immutable segment list. The
        // next mutation will schedule another attempt.
      }
    });
  }

  private restoreActiveIndex(runtime: RuntimeIndex): void {
    const manifest = createManifest(
      runtime.metadata.name,
      runtime.generation,
      runtime.activeSegments,
    );
    const reader = SegmentReader.open(runtime.directory, runtime.metadata.name, manifest);
    runtime.index =
      reader === undefined
        ? this.buildIndexFromSource(runtime.metadata)
        : InvertedIndex.fromSegments(
            runtime.metadata.name,
            runtime.metadata.config,
            reader.snapshots,
          );
  }

  private buildIndexFromSource(metadata: IndexMetadata): InvertedIndex {
    const index = new InvertedIndex(metadata.name, metadata.config);
    for (const document of this.documentRepository.listActive(metadata.name)) {
      index.upsert(document, document.version);
    }
    return index;
  }

  private segmentsMatchSource(
    metadata: IndexMetadata,
    snapshots: readonly SegmentSnapshot[],
    sourceDocuments: readonly StoredSourceDocument[],
  ): boolean {
    const index = InvertedIndex.fromSegments(metadata.name, metadata.config, snapshots);
    const resolvedDocuments = index.toSnapshot(0).documents;
    if (resolvedDocuments.length !== sourceDocuments.length) {
      return false;
    }
    const versions = new Map(resolvedDocuments.map((document) => [document.id, document.version]));
    return sourceDocuments.every((document) => versions.get(document.id) === document.version);
  }

  private indexDirectory(name: string): string {
    return join(this.config.dataDir, 'indexes', name);
  }
}
