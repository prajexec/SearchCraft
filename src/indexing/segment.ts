import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FieldValue } from '../indexes/index-config';

export interface SerializedDocument {
  readonly id: string;
  readonly version: number;
  readonly fields: Record<string, FieldValue>;
  readonly fieldLengths: Record<string, number>;
}

export interface SerializedPosting {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly termFrequency: number;
  readonly positions: readonly number[];
}

export interface SerializedTerm {
  readonly field: string;
  readonly term: string;
  readonly postings: readonly SerializedPosting[];
}

export interface SegmentSnapshot {
  readonly magic: 'SEARCHCRAFT_SEGMENT';
  readonly formatVersion: 1;
  readonly indexName: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly documents: readonly SerializedDocument[];
  readonly terms: readonly SerializedTerm[];
}

export interface SegmentManifest {
  readonly magic: 'SEARCHCRAFT_MANIFEST';
  readonly formatVersion: 1;
  readonly indexName: string;
  readonly activeGeneration: number;
  readonly segmentFile: string;
}

export function segmentPath(indexDirectory: string, generation: number): string {
  return `${indexDirectory}/generations/generation-${generation}.json`;
}

export function manifestPath(indexDirectory: string): string {
  return `${indexDirectory}/manifest.json`;
}

export function readManifest(path: string, indexName: string): SegmentManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<SegmentManifest>;
    if (
      manifest.magic !== 'SEARCHCRAFT_MANIFEST' ||
      manifest.formatVersion !== 1 ||
      manifest.indexName !== indexName ||
      typeof manifest.activeGeneration !== 'number' ||
      typeof manifest.segmentFile !== 'string'
    ) {
      return undefined;
    }
    return manifest as SegmentManifest;
  } catch {
    return undefined;
  }
}

export function readSegment(path: string, indexName: string): SegmentSnapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Partial<SegmentSnapshot>;
    if (
      snapshot.magic !== 'SEARCHCRAFT_SEGMENT' ||
      snapshot.formatVersion !== 1 ||
      snapshot.indexName !== indexName ||
      typeof snapshot.generation !== 'number' ||
      !Array.isArray(snapshot.documents) ||
      !Array.isArray(snapshot.terms)
    ) {
      return undefined;
    }
    return snapshot as SegmentSnapshot;
  } catch {
    return undefined;
  }
}

export function writeSegmentAtomic(
  indexDirectory: string,
  snapshot: SegmentSnapshot,
): SegmentManifest {
  const generationDirectory = `${indexDirectory}/generations`;
  mkdirSync(generationDirectory, { recursive: true });
  const segmentFile = segmentPath(indexDirectory, snapshot.generation);
  const manifestFile = manifestPath(indexDirectory);
  const segmentTemporaryFile = `${segmentFile}.tmp`;
  const manifestTemporaryFile = `${manifestFile}.tmp`;

  // JSON is intentionally used for the first format: it is inspectable while
  // the index is small. The format is versioned so a binary representation can
  // be introduced later without silently reading incompatible data.
  writeFileSync(segmentTemporaryFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
  renameSync(segmentTemporaryFile, segmentFile);

  const manifest: SegmentManifest = {
    magic: 'SEARCHCRAFT_MANIFEST',
    formatVersion: 1,
    indexName: snapshot.indexName,
    activeGeneration: snapshot.generation,
    segmentFile: segmentFile.slice(dirname(manifestFile).length + 1),
  };
  writeFileSync(manifestTemporaryFile, `${JSON.stringify(manifest)}\n`, 'utf8');
  renameSync(manifestTemporaryFile, manifestFile);
  return manifest;
}
