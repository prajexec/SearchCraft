import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Config } from '../config';
import {
  InvertedIndex,
  type SearchCursor,
  type SearchPage,
  decodeCursor,
} from '../indexing/inverted-index';
import { manifestPath, readManifest, readSegment, writeSegmentAtomic } from '../indexing/segment';
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
      generation: 0,
    };
    this.indexes.set(name, runtime);
    this.persist(runtime);
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
    return this.indexes.get(indexName)?.index.documentVersion(document.id) === document.version;
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
      this.persist(runtime);
    } catch (error) {
      runtime.index = this.buildIndexFromSource(runtime.metadata);
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
    runtime.index.remove(documentId);
    try {
      this.persist(runtime);
    } catch (error) {
      runtime.index = this.buildIndexFromSource(runtime.metadata);
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
    if (document.deleted) {
      runtime.index.remove(document.id);
    } else {
      runtime.index.upsert(document, document.version);
    }
    try {
      this.persist(runtime);
    } catch (error) {
      runtime.index = this.buildIndexFromSource(runtime.metadata);
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

  private loadRuntime(metadata: IndexMetadata): RuntimeIndex {
    const directory = this.indexDirectory(metadata.name);
    mkdirSync(directory, { recursive: true });
    const activeDocuments = this.documentRepository.listActive(metadata.name);
    const manifest = readManifest(manifestPath(directory), metadata.name);
    if (manifest !== undefined) {
      const snapshot = readSegment(join(directory, manifest.segmentFile), metadata.name);
      if (
        snapshot !== undefined &&
        snapshot.generation === manifest.activeGeneration &&
        this.snapshotMatchesSource(snapshot, activeDocuments)
      ) {
        return {
          metadata,
          directory,
          index: InvertedIndex.fromSnapshot(metadata.name, metadata.config, snapshot),
          generation: snapshot.generation,
        };
      }
    }

    const index = new InvertedIndex(metadata.name, metadata.config);
    const runtime: RuntimeIndex = { metadata, directory, index, generation: 0 };
    for (const document of activeDocuments) {
      index.upsert(document, document.version);
    }
    this.persist(runtime);
    return runtime;
  }

  private persist(runtime: RuntimeIndex): void {
    const nextGeneration = runtime.generation + 1;
    const snapshot = runtime.index.toSnapshot(nextGeneration);
    writeSegmentAtomic(runtime.directory, snapshot);
    runtime.generation = nextGeneration;
    this.indexRepository.setActiveGeneration(runtime.metadata.name, nextGeneration);
  }

  private buildIndexFromSource(metadata: IndexMetadata): InvertedIndex {
    const index = new InvertedIndex(metadata.name, metadata.config);
    for (const document of this.documentRepository.listActive(metadata.name)) {
      index.upsert(document, document.version);
    }
    return index;
  }

  private snapshotMatchesSource(
    snapshot: { readonly documents: readonly { readonly id: string; readonly version: number }[] },
    sourceDocuments: readonly StoredSourceDocument[],
  ): boolean {
    if (snapshot.documents.length !== sourceDocuments.length) {
      return false;
    }
    const snapshotVersions = new Map(
      snapshot.documents.map((document) => [document.id, document.version]),
    );
    if (snapshotVersions.size !== snapshot.documents.length) {
      return false;
    }
    return sourceDocuments.every(
      (document) => snapshotVersions.get(document.id) === document.version,
    );
  }

  private indexDirectory(name: string): string {
    return join(this.config.dataDir, 'indexes', name);
  }
}
