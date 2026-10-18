import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { FieldValue } from '../indexes/index-config';
import { decodePositions } from './compression';
import { validateTermDictionaryBlocks, type TermDictionaryBlock } from './term-dictionary';

export interface SerializedDocument {
  readonly id: string;
  readonly version: number;
  readonly deleted?: boolean;
  readonly fields: Record<string, FieldValue>;
  readonly fieldLengths: Record<string, number>;
}

export interface SerializedPosting {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly termFrequency: number;
  readonly positions?: readonly number[];
  readonly positionsEncoded?: string;
}

export interface SerializedTerm {
  readonly field: string;
  readonly term: string;
  readonly postings: readonly SerializedPosting[];
}

/**
 * A segment is immutable once its temporary file has been renamed into the
 * generations directory. Format 1 is accepted for recovery of indexes made
 * before Phase 4; all newly written files use format 2 and a checksum.
 */
export interface SegmentSnapshot {
  readonly magic: 'SEARCHCRAFT_SEGMENT';
  readonly formatVersion: 1 | 2;
  readonly indexName: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly documents: readonly SerializedDocument[];
  readonly terms: readonly SerializedTerm[];
  readonly termBlocks?: readonly TermDictionaryBlock[];
  readonly checksum?: string;
}

/**
 * Version 2 manifests list the complete immutable segment view for one
 * publication. The optional v1 field is retained only so old manifests can
 * be inspected and migrated through the normal source rebuild path.
 */
export interface SegmentManifest {
  readonly magic: 'SEARCHCRAFT_MANIFEST';
  readonly formatVersion: 2;
  readonly indexName: string;
  readonly activeGeneration: number;
  readonly activeSegments: readonly string[];
  readonly checksum: string;
}

export interface LegacySegmentManifest {
  readonly magic: 'SEARCHCRAFT_MANIFEST';
  readonly formatVersion: 1;
  readonly indexName: string;
  readonly activeGeneration: number;
  readonly segmentFile: string;
}

export type ReadableSegmentManifest = SegmentManifest | LegacySegmentManifest;

export interface SegmentReaderResult {
  readonly snapshots: readonly SegmentSnapshot[];
  readonly files: readonly string[];
}

function checksum(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshotPayload(snapshot: SegmentSnapshot): Omit<SegmentSnapshot, 'checksum'> {
  return {
    magic: 'SEARCHCRAFT_SEGMENT',
    formatVersion: 2,
    indexName: snapshot.indexName,
    generation: snapshot.generation,
    createdAt: snapshot.createdAt,
    documents: snapshot.documents,
    terms: snapshot.terms,
    ...(snapshot.termBlocks === undefined ? {} : { termBlocks: snapshot.termBlocks }),
  };
}

function manifestPayload(manifest: {
  readonly indexName: string;
  readonly activeGeneration: number;
  readonly activeSegments?: readonly string[];
}): {
  readonly magic: 'SEARCHCRAFT_MANIFEST';
  readonly formatVersion: 2;
  readonly indexName: string;
  readonly activeGeneration: number;
  readonly activeSegments: readonly string[];
} {
  return {
    magic: 'SEARCHCRAFT_MANIFEST',
    formatVersion: 2,
    indexName: manifest.indexName,
    activeGeneration: manifest.activeGeneration,
    activeSegments: manifest.activeSegments ?? [],
  };
}

function prepareSnapshot(snapshot: SegmentSnapshot): SegmentSnapshot {
  const payload = snapshotPayload(snapshot);
  return {
    ...payload,
    checksum: checksum(JSON.stringify(payload)),
  };
}

function prepareManifest(
  manifest: Pick<
    SegmentManifest,
    'magic' | 'formatVersion' | 'indexName' | 'activeGeneration' | 'activeSegments'
  >,
): SegmentManifest {
  const payload = manifestPayload(manifest);
  return {
    ...payload,
    checksum: checksum(JSON.stringify(payload)),
  };
}

function isSafeRelativeSegmentFile(file: string): boolean {
  if (file.length === 0 || file.startsWith('/') || file.includes('\\')) {
    return false;
  }
  const normalized = file.split('/').filter((part) => part.length > 0);
  return (
    normalized.length >= 2 &&
    normalized[0] === 'generations' &&
    normalized.every((part) => part !== '.' && part !== '..')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function validFieldValue(value: unknown): value is FieldValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validDocument(document: unknown): document is SerializedDocument {
  if (!isRecord(document)) {
    return false;
  }
  if (
    typeof document.id !== 'string' ||
    !isFiniteSafeInteger(document.version, 1) ||
    !isRecord(document.fields) ||
    !isRecord(document.fieldLengths)
  ) {
    return false;
  }
  if (document.deleted !== undefined && typeof document.deleted !== 'boolean') {
    return false;
  }
  if (!Object.values(document.fields).every(validFieldValue)) {
    return false;
  }
  if (
    !Object.values(document.fieldLengths).every(
      (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    return false;
  }
  if (document.deleted === true) {
    return (
      Object.keys(document.fields).length === 0 && Object.keys(document.fieldLengths).length === 0
    );
  }
  return true;
}

function validPosting(posting: unknown): posting is SerializedPosting {
  if (!isRecord(posting)) {
    return false;
  }
  if (
    typeof posting.documentId === 'string' &&
    isFiniteSafeInteger(posting.documentVersion, 1) &&
    isFiniteSafeInteger(posting.termFrequency, 1)
  ) {
    const hasPositions = Array.isArray(posting.positions);
    const hasEncodedPositions = typeof posting.positionsEncoded === 'string';
    if (hasPositions === hasEncodedPositions) {
      return false;
    }
    try {
      const positions = hasEncodedPositions
        ? decodePositions(posting.positionsEncoded as string, posting.termFrequency)
        : posting.positions;
      return (
        Array.isArray(positions) &&
        positions.length === posting.termFrequency &&
        positions.every((position) => isFiniteSafeInteger(position))
      );
    } catch {
      return false;
    }
  }
  return false;
}

function validTerm(term: unknown): term is SerializedTerm {
  if (!isRecord(term) || typeof term.field !== 'string' || typeof term.term !== 'string') {
    return false;
  }
  if (!Array.isArray(term.postings) || !term.postings.every(validPosting)) {
    return false;
  }
  const documentIds = new Set<string>();
  return term.postings.every((posting) => {
    if (documentIds.has(posting.documentId)) {
      return false;
    }
    documentIds.add(posting.documentId);
    try {
      const positions =
        posting.positionsEncoded === undefined
          ? (posting.positions ?? [])
          : decodePositions(posting.positionsEncoded, posting.termFrequency);
      return positions.length === posting.termFrequency;
    } catch {
      return false;
    }
  });
}

function validSnapshotStructure(snapshot: Partial<SegmentSnapshot>): snapshot is SegmentSnapshot {
  if (
    snapshot.magic !== 'SEARCHCRAFT_SEGMENT' ||
    (snapshot.formatVersion !== 1 && snapshot.formatVersion !== 2) ||
    typeof snapshot.indexName !== 'string' ||
    !isFiniteSafeInteger(snapshot.generation) ||
    typeof snapshot.createdAt !== 'string' ||
    !Array.isArray(snapshot.documents) ||
    !Array.isArray(snapshot.terms) ||
    !snapshot.documents.every(validDocument) ||
    !snapshot.terms.every(validTerm)
  ) {
    return false;
  }

  if (snapshot.termBlocks !== undefined) {
    try {
      validateTermDictionaryBlocks(snapshot.termBlocks);
    } catch {
      return false;
    }
    if (
      snapshot.termBlocks.reduce((total, block) => total + block.length, 0) !==
      snapshot.terms.length
    ) {
      return false;
    }
  }

  const documentVersions = new Map<string, number>();
  for (const document of snapshot.documents) {
    if (documentVersions.has(document.id)) {
      return false;
    }
    documentVersions.set(document.id, document.version);
  }
  return snapshot.terms.every((term) =>
    term.postings.every(
      (posting) => documentVersions.get(posting.documentId) === posting.documentVersion,
    ),
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function segmentPath(indexDirectory: string, generation: number): string {
  return join(indexDirectory, 'generations', `segment-${generation}.json`);
}

export function manifestPath(indexDirectory: string): string {
  return join(indexDirectory, 'manifest.json');
}

export function manifestSegmentFiles(manifest: ReadableSegmentManifest): readonly string[] {
  if (manifest.formatVersion === 2) {
    return manifest.activeSegments;
  }
  return manifest.segmentFile === undefined ? [] : [manifest.segmentFile];
}

export function readManifest(path: string, indexName: string): ReadableSegmentManifest | undefined {
  try {
    const manifest = readJson(path) as {
      readonly magic?: unknown;
      readonly formatVersion?: unknown;
      readonly indexName?: unknown;
      readonly activeGeneration?: unknown;
      readonly activeSegments?: unknown;
      readonly segmentFile?: unknown;
      readonly checksum?: unknown;
    };
    if (
      manifest.magic !== 'SEARCHCRAFT_MANIFEST' ||
      manifest.indexName !== indexName ||
      !isFiniteSafeInteger(manifest.activeGeneration)
    ) {
      return undefined;
    }

    if (manifest.formatVersion === 1) {
      return typeof manifest.segmentFile === 'string' &&
        isSafeRelativeSegmentFile(manifest.segmentFile)
        ? (manifest as unknown as LegacySegmentManifest)
        : undefined;
    }

    if (
      manifest.formatVersion !== 2 ||
      !Array.isArray(manifest.activeSegments) ||
      !manifest.activeSegments.every(
        (file): file is string => typeof file === 'string' && isSafeRelativeSegmentFile(file),
      ) ||
      new Set(manifest.activeSegments).size !== manifest.activeSegments.length ||
      typeof manifest.checksum !== 'string'
    ) {
      return undefined;
    }
    const payload = manifestPayload({
      indexName: manifest.indexName,
      activeGeneration: manifest.activeGeneration,
      activeSegments: manifest.activeSegments,
    });
    return checksum(JSON.stringify(payload)) === manifest.checksum
      ? (manifest as SegmentManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readSegment(path: string, indexName: string): SegmentSnapshot | undefined {
  try {
    const parsed = readJson(path) as Partial<SegmentSnapshot>;
    if (!validSnapshotStructure(parsed) || parsed.indexName !== indexName) {
      return undefined;
    }
    if (parsed.formatVersion === 2) {
      if (typeof parsed.checksum !== 'string') {
        return undefined;
      }
      const payload = snapshotPayload(parsed);
      if (checksum(JSON.stringify(payload)) !== parsed.checksum) {
        return undefined;
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export class SegmentReader {
  private constructor(
    public readonly snapshots: readonly SegmentSnapshot[],
    public readonly files: readonly string[],
  ) {}

  public static open(
    indexDirectory: string,
    indexName: string,
    manifest: ReadableSegmentManifest,
  ): SegmentReader | undefined {
    const files = manifestSegmentFiles(manifest);
    const snapshots: SegmentSnapshot[] = [];
    for (const file of files) {
      if (!isSafeRelativeSegmentFile(file)) {
        return undefined;
      }
      const snapshot = readSegment(join(indexDirectory, file), indexName);
      if (snapshot === undefined) {
        return undefined;
      }
      snapshots.push(snapshot);
    }
    return new SegmentReader(snapshots, files);
  }

  public result(): SegmentReaderResult {
    return { snapshots: this.snapshots, files: this.files };
  }
}

function relativeSegmentFile(indexDirectory: string, file: string): string {
  return relative(indexDirectory, file).split(sep).join('/');
}

export function writeSegmentFileAtomic(
  indexDirectory: string,
  snapshot: SegmentSnapshot,
): { readonly file: string; readonly snapshot: SegmentSnapshot } {
  const generationDirectory = join(indexDirectory, 'generations');
  mkdirSync(generationDirectory, { recursive: true });
  const prepared = prepareSnapshot(snapshot);
  const file = segmentPath(indexDirectory, prepared.generation);
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(prepared)}\n`, 'utf8');
  if (readSegment(temporaryFile, prepared.indexName) === undefined) {
    throw new Error(`segment validation failed for ${file}`);
  }
  renameSync(temporaryFile, file);
  return { file: relativeSegmentFile(indexDirectory, file), snapshot: prepared };
}

export function writeManifestAtomic(
  indexDirectory: string,
  manifest: SegmentManifest,
): SegmentManifest {
  mkdirSync(indexDirectory, { recursive: true });
  const prepared = prepareManifest(manifest);
  const file = manifestPath(indexDirectory);
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(prepared)}\n`, 'utf8');
  if (readManifest(temporaryFile, prepared.indexName) === undefined) {
    throw new Error(`manifest validation failed for ${file}`);
  }
  renameSync(temporaryFile, file);
  return prepared;
}

export function createManifest(
  indexName: string,
  activeGeneration: number,
  activeSegments: readonly string[],
): SegmentManifest {
  return prepareManifest({
    magic: 'SEARCHCRAFT_MANIFEST',
    formatVersion: 2,
    indexName,
    activeGeneration,
    activeSegments,
  });
}

export function appendSegmentAtomic(
  indexDirectory: string,
  previousManifest: ReadableSegmentManifest,
  snapshot: SegmentSnapshot,
): SegmentManifest {
  const written = writeSegmentFileAtomic(indexDirectory, snapshot);
  return writeManifestAtomic(
    indexDirectory,
    createManifest(snapshot.indexName, snapshot.generation, [
      ...manifestSegmentFiles(previousManifest),
      written.file,
    ]),
  );
}

export function replaceWithCompactedSegmentAtomic(
  indexDirectory: string,
  snapshot: SegmentSnapshot,
): SegmentManifest {
  const written = writeSegmentFileAtomic(indexDirectory, snapshot);
  return writeManifestAtomic(
    indexDirectory,
    createManifest(snapshot.indexName, snapshot.generation, [written.file]),
  );
}

/**
 * Compatibility helper for callers that still want to publish one complete
 * snapshot. IndexManager uses appendSegmentAtomic for normal mutations and
 * replaceWithCompactedSegmentAtomic for rebuilds and compaction.
 */
export function writeSegmentAtomic(
  indexDirectory: string,
  snapshot: SegmentSnapshot,
): SegmentManifest {
  return replaceWithCompactedSegmentAtomic(indexDirectory, snapshot);
}

export function indexDirectoryForManifest(indexDirectory: string, file: string): string {
  return resolve(indexDirectory, file);
}
