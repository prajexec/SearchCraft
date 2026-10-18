import type { IndexConfig, SearchDocument } from '../indexes/index-config';
import { bm25Score } from '../query/bm25';
import { matchesFilters, type SearchFilters } from '../query/filters';
import type {
  SerializedDocument,
  SerializedPosting,
  SerializedTerm,
  SegmentSnapshot,
} from './segment';
import { decodePositions, encodePositions } from './compression';
import { buildTermDictionaryBlocks } from './term-dictionary';
import { tokenize } from './tokenizer';

interface Posting {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly termFrequency: number;
  readonly positions: readonly number[];
}

interface IndexedDocument {
  readonly id: string;
  readonly version: number;
  readonly fields: SearchDocument['fields'];
  readonly fieldLengths: Readonly<Record<string, number>>;
}

interface ResolvedSegmentDocument {
  readonly document: SerializedDocument;
  readonly order: number;
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  readonly document: { readonly id: string; readonly fields: Record<string, unknown> };
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  readonly totalHits: number;
  readonly nextCursor: string | null;
}

export interface SearchCursor {
  readonly score: number;
  readonly id: string;
}

export interface SearchOptions {
  readonly phrase?: boolean;
  readonly slop?: number;
}

export class QueryLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QueryLimitError';
  }
}

function termKey(field: string, term: string): string {
  return `${field}\u0000${term}`;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareHits(left: SearchHit, right: SearchHit): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return compareText(left.id, right.id);
}

function averageLength(documents: Iterable<IndexedDocument>, field: string): number {
  let total = 0;
  let count = 0;
  for (const document of documents) {
    total += document.fieldLengths[field] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

function isDeleted(document: SerializedDocument): boolean {
  return document.deleted === true;
}

function serializedDocument(document: IndexedDocument, deleted = false): SerializedDocument {
  return {
    id: document.id,
    version: document.version,
    deleted,
    fields: document.fields,
    fieldLengths: document.fieldLengths,
  };
}

function compareSegmentDocuments(
  current: ResolvedSegmentDocument | undefined,
  candidate: SerializedDocument,
  order: number,
): boolean {
  return (
    current === undefined ||
    candidate.version > current.document.version ||
    (candidate.version === current.document.version && order >= current.order)
  );
}

function matchesPhrase(postings: readonly Posting[], slop: number): boolean {
  if (postings.length === 0) {
    return false;
  }
  let candidates = postings[0]!.positions.map((position) => ({ position, slop: 0 }));
  for (const posting of postings.slice(1)) {
    const nextCandidates: Array<{ readonly position: number; readonly slop: number }> = [];
    for (const candidate of candidates) {
      for (const position of posting.positions) {
        if (position <= candidate.position) {
          continue;
        }
        const nextSlop = candidate.slop + position - candidate.position - 1;
        if (nextSlop <= slop) {
          nextCandidates.push({ position, slop: nextSlop });
        }
        if (position - candidate.position - 1 > slop) {
          break;
        }
      }
    }
    if (nextCandidates.length === 0) {
      return false;
    }
    candidates = nextCandidates;
  }
  return candidates.length > 0;
}

export class InvertedIndex {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly postings = new Map<string, Map<string, Posting>>();
  private readonly tombstones = new Map<string, number>();

  public constructor(
    private readonly indexName: string,
    private readonly config: IndexConfig,
  ) {}

  public static fromSnapshot(
    indexName: string,
    config: IndexConfig,
    snapshot: SegmentSnapshot,
  ): InvertedIndex {
    return InvertedIndex.fromSegments(indexName, config, [snapshot]);
  }

  /**
   * Materialize the logical index represented by the active immutable
   * segments. Newer versions win, and a winning tombstone hides every older
   * posting. BM25 is then computed from this resolved view, so N, df, and
   * average field lengths are global rather than segment-local.
   */
  public static fromSegments(
    indexName: string,
    config: IndexConfig,
    snapshots: readonly SegmentSnapshot[],
  ): InvertedIndex {
    const index = new InvertedIndex(indexName, config);
    const resolved = new Map<string, ResolvedSegmentDocument>();

    snapshots.forEach((snapshot, order) => {
      for (const document of snapshot.documents) {
        if (compareSegmentDocuments(resolved.get(document.id), document, order)) {
          resolved.set(document.id, { document, order });
        }
      }
    });

    for (const [documentId, resolvedDocument] of resolved) {
      if (isDeleted(resolvedDocument.document)) {
        index.tombstones.set(documentId, resolvedDocument.document.version);
        continue;
      }
      index.documents.set(documentId, {
        id: resolvedDocument.document.id,
        version: resolvedDocument.document.version,
        fields: resolvedDocument.document.fields,
        fieldLengths: resolvedDocument.document.fieldLengths,
      });
    }

    for (const snapshot of snapshots) {
      for (const term of snapshot.terms) {
        const key = termKey(term.field, term.term);
        for (const posting of term.postings) {
          const resolvedDocument = resolved.get(posting.documentId);
          if (
            resolvedDocument === undefined ||
            isDeleted(resolvedDocument.document) ||
            resolvedDocument.document.version !== posting.documentVersion
          ) {
            continue;
          }
          const postingMap = index.postings.get(key) ?? new Map<string, Posting>();
          postingMap.set(posting.documentId, {
            ...posting,
            positions:
              posting.positionsEncoded === undefined
                ? (posting.positions ?? [])
                : decodePositions(posting.positionsEncoded, posting.termFrequency),
          });
          index.postings.set(key, postingMap);
        }
      }
    }
    return index;
  }

  public upsert(document: SearchDocument, version: number): void {
    this.removeDocumentData(document.id);
    this.tombstones.delete(document.id);
    const fieldLengths: Record<string, number> = {};
    for (const fieldName of Object.keys(this.config.searchableFields)) {
      const value = document.fields[fieldName];
      const text = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
      const tokens = tokenize(text, this.config.maxTokenLength);
      fieldLengths[fieldName] = tokens.length;

      const terms = new Map<string, number[]>();
      for (const token of tokens) {
        const positions = terms.get(token.term) ?? [];
        positions.push(token.position);
        terms.set(token.term, positions);
      }
      for (const [term, positions] of terms) {
        const key = termKey(fieldName, term);
        const postingMap = this.postings.get(key) ?? new Map<string, Posting>();
        postingMap.set(document.id, {
          documentId: document.id,
          documentVersion: version,
          termFrequency: positions.length,
          positions,
        });
        this.postings.set(key, postingMap);
      }
    }

    this.documents.set(document.id, {
      id: document.id,
      version,
      fields: document.fields,
      fieldLengths,
    });
  }

  public remove(documentId: string, version?: number): void {
    const existingTombstone = this.tombstones.get(documentId);
    this.removeDocumentData(documentId);
    if (
      version !== undefined &&
      (existingTombstone === undefined || version >= existingTombstone)
    ) {
      this.tombstones.set(documentId, version);
    }
  }

  public documentVersion(documentId: string): number | undefined {
    return this.documents.get(documentId)?.version ?? this.tombstones.get(documentId);
  }

  public isDocumentDeleted(documentId: string): boolean {
    return this.tombstones.has(documentId) && !this.documents.has(documentId);
  }

  public search(
    query: string,
    limit: number,
    cursor: SearchCursor | undefined,
    filters: SearchFilters = {},
    options: SearchOptions = {},
  ): SearchPage {
    const tokenTerms = tokenize(query, this.config.maxTokenLength).map((token) => token.term);
    const phrase = options.phrase === true;
    const queryTerms = phrase ? tokenTerms : [...new Set(tokenTerms)];
    if (queryTerms.length === 0) {
      throw new QueryLimitError('The query contains no searchable terms');
    }
    const maxQueryTerms = this.config.maxQueryTerms ?? 32;
    if (queryTerms.length > maxQueryTerms) {
      throw new QueryLimitError(`The query contains more than ${maxQueryTerms} searchable terms`);
    }
    const slop = options.slop ?? 0;
    if (!Number.isSafeInteger(slop) || slop < 0 || slop > 100) {
      throw new QueryLimitError('Phrase slop must be an integer between 0 and 100');
    }
    const scores = new Map<string, number>();
    const averageLengths = new Map<string, number>();
    for (const fieldName of Object.keys(this.config.searchableFields)) {
      averageLengths.set(fieldName, averageLength(this.documents.values(), fieldName));
    }

    for (const [fieldName, fieldConfig] of Object.entries(this.config.searchableFields)) {
      const postingMaps = queryTerms.map((term) => this.postings.get(termKey(fieldName, term)));
      if (postingMaps.some((postingMap) => postingMap === undefined)) {
        continue;
      }
      if (phrase) {
        const firstPostingMap = postingMaps[0]!;
        for (const documentId of firstPostingMap.keys()) {
          const postings = postingMaps.map((postingMap) => postingMap!.get(documentId));
          if (
            postings.some((posting) => posting === undefined) ||
            !matchesPhrase(postings as Posting[], slop)
          ) {
            continue;
          }
          const document = this.documents.get(documentId);
          if (document === undefined || !matchesFilters(document.fields, filters)) {
            continue;
          }
          for (const [index, posting] of (postings as Posting[]).entries()) {
            const score = bm25Score({
              termFrequency: posting.termFrequency,
              documentFrequency: postingMaps[index]!.size,
              documentCount: this.documents.size,
              documentLength: document.fieldLengths[fieldName] ?? 0,
              averageDocumentLength: averageLengths.get(fieldName) ?? 0,
              k1: 1.2,
              b: 0.75,
            });
            scores.set(documentId, (scores.get(documentId) ?? 0) + score * fieldConfig.boost);
          }
        }
        continue;
      }

      for (const termPostingMap of postingMaps) {
        for (const posting of termPostingMap!.values()) {
          const document = this.documents.get(posting.documentId);
          if (
            document === undefined ||
            document.version !== posting.documentVersion ||
            !matchesFilters(document.fields, filters)
          ) {
            continue;
          }
          const score = bm25Score({
            termFrequency: posting.termFrequency,
            documentFrequency: termPostingMap!.size,
            documentCount: this.documents.size,
            documentLength: document.fieldLengths[fieldName] ?? 0,
            averageDocumentLength: averageLengths.get(fieldName) ?? 0,
            k1: 1.2,
            b: 0.75,
          });
          scores.set(
            posting.documentId,
            (scores.get(posting.documentId) ?? 0) + score * fieldConfig.boost,
          );
        }
      }
    }

    const hits: SearchHit[] = [];
    for (const [documentId, score] of scores) {
      const document = this.documents.get(documentId);
      if (document === undefined) {
        continue;
      }
      if (
        cursor !== undefined &&
        !(
          score < cursor.score ||
          (score === cursor.score && compareText(documentId, cursor.id) > 0)
        )
      ) {
        continue;
      }
      hits.push({
        id: document.id,
        score,
        document: {
          id: document.id,
          fields: Object.fromEntries(
            this.config.storedFields
              .filter((fieldName) => fieldName in document.fields)
              .map((fieldName) => [fieldName, document.fields[fieldName]]),
          ),
        },
      });
    }

    hits.sort(compareHits);
    const page = hits.slice(0, limit);
    const last = page.at(-1);
    return {
      hits: page,
      totalHits: scores.size,
      nextCursor:
        last === undefined || hits.length <= limit
          ? null
          : encodeCursor({ score: last.score, id: last.id }),
    };
  }

  public toSnapshot(generation: number): SegmentSnapshot {
    const documents: SerializedDocument[] = [...this.documents.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((document) => serializedDocument(document));
    return this.snapshotForDocuments(generation, documents, this.postings);
  }

  /** Serialize one or more mutations so normal indexing never rewrites old data. */
  public toDeltaSnapshot(
    generation: number,
    documentIds: string | readonly string[],
  ): SegmentSnapshot {
    const sortedIds = [...(typeof documentIds === 'string' ? [documentIds] : documentIds)].sort(
      compareText,
    );
    const ids = [...new Set(sortedIds)];
    const documents: SerializedDocument[] = [];
    const selectedIds = new Set(ids);

    for (const documentId of ids) {
      const document = this.documents.get(documentId);
      if (document !== undefined) {
        documents.push(serializedDocument(document));
        continue;
      }

      const version = this.tombstones.get(documentId);
      if (version === undefined) {
        throw new Error(`document "${documentId}" is not present in the index`);
      }
      documents.push({
        id: documentId,
        version,
        deleted: true,
        fields: {},
        fieldLengths: {},
      });
    }

    const filteredPostings = new Map<string, Map<string, Posting>>();
    for (const [key, postingMap] of this.postings) {
      const selectedPostings = [...postingMap.entries()].filter(([documentId]) =>
        selectedIds.has(documentId),
      );
      if (selectedPostings.length > 0) {
        filteredPostings.set(key, new Map(selectedPostings));
      }
    }

    return this.snapshotForDocuments(generation, documents, filteredPostings);
  }

  private removeDocumentData(documentId: string): void {
    const existing = this.documents.get(documentId);
    if (existing === undefined) {
      return;
    }

    for (const fieldName of Object.keys(this.config.searchableFields)) {
      const value = existing.fields[fieldName];
      const text = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
      const terms = new Set(tokenize(text, this.config.maxTokenLength).map((token) => token.term));
      for (const term of terms) {
        const key = termKey(fieldName, term);
        const postingMap = this.postings.get(key);
        postingMap?.delete(documentId);
        if (postingMap?.size === 0) {
          this.postings.delete(key);
        }
      }
    }
    this.documents.delete(documentId);
  }

  private snapshotForDocuments(
    generation: number,
    documents: readonly SerializedDocument[],
    sourcePostings: ReadonlyMap<string, ReadonlyMap<string, Posting>>,
  ): SegmentSnapshot {
    const terms: SerializedTerm[] = [];
    for (const [key, postingMap] of sourcePostings) {
      const separator = key.indexOf('\u0000');
      const field = key.slice(0, separator);
      const term = key.slice(separator + 1);
      const postings: SerializedPosting[] = [...postingMap.values()]
        .sort((left, right) => compareText(left.documentId, right.documentId))
        .map((posting) => ({
          documentId: posting.documentId,
          documentVersion: posting.documentVersion,
          termFrequency: posting.termFrequency,
          positionsEncoded: encodePositions(posting.positions),
        }));
      if (postings.length > 0) {
        terms.push({ field, term, postings });
      }
    }
    terms.sort((left, right) =>
      compareText(`${left.field}\u0000${left.term}`, `${right.field}\u0000${right.term}`),
    );
    const termBlocks = buildTermDictionaryBlocks(
      terms.map((term) => termKey(term.field, term.term)),
    );
    return {
      magic: 'SEARCHCRAFT_SEGMENT',
      formatVersion: 2,
      indexName: this.indexName,
      generation,
      createdAt: new Date().toISOString(),
      documents,
      terms,
      termBlocks,
    };
  }
}

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): SearchCursor | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<SearchCursor>;
    if (
      typeof parsed.score !== 'number' ||
      !Number.isFinite(parsed.score) ||
      typeof parsed.id !== 'string'
    ) {
      return undefined;
    }
    return { score: parsed.score, id: parsed.id };
  } catch {
    return undefined;
  }
}
