import type { IndexConfig } from '../indexes/index-config';
import type { SearchDocument } from '../indexes/index-config';
import { bm25Score } from '../query/bm25';
import { matchesFilters, type SearchFilters } from '../query/filters';
import type {
  SerializedDocument,
  SerializedPosting,
  SerializedTerm,
  SegmentSnapshot,
} from './segment';
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

export class InvertedIndex {
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly postings = new Map<string, Map<string, Posting>>();

  public constructor(
    private readonly indexName: string,
    private readonly config: IndexConfig,
  ) {}

  public static fromSnapshot(
    indexName: string,
    config: IndexConfig,
    snapshot: SegmentSnapshot,
  ): InvertedIndex {
    const index = new InvertedIndex(indexName, config);
    for (const document of snapshot.documents) {
      index.documents.set(document.id, {
        id: document.id,
        version: document.version,
        fields: document.fields,
        fieldLengths: document.fieldLengths,
      });
    }
    for (const term of snapshot.terms) {
      const postingMap = new Map<string, Posting>();
      for (const posting of term.postings) {
        postingMap.set(posting.documentId, posting);
      }
      index.postings.set(termKey(term.field, term.term), postingMap);
    }
    return index;
  }

  public upsert(document: SearchDocument, version: number): void {
    this.remove(document.id);
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

  public remove(documentId: string): void {
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

  public documentVersion(documentId: string): number | undefined {
    return this.documents.get(documentId)?.version;
  }

  public search(
    query: string,
    limit: number,
    cursor: SearchCursor | undefined,
    filters: SearchFilters = {},
  ): SearchPage {
    const queryTerms = [
      ...new Set(tokenize(query, this.config.maxTokenLength).map((token) => token.term)),
    ];
    if (queryTerms.length === 0) {
      throw new QueryLimitError('The query contains no searchable terms');
    }
    const maxQueryTerms = this.config.maxQueryTerms ?? 32;
    if (queryTerms.length > maxQueryTerms) {
      throw new QueryLimitError(`The query contains more than ${maxQueryTerms} searchable terms`);
    }
    const scores = new Map<string, number>();
    const averageLengths = new Map<string, number>();
    for (const fieldName of Object.keys(this.config.searchableFields)) {
      averageLengths.set(fieldName, averageLength(this.documents.values(), fieldName));
    }

    for (const term of queryTerms) {
      for (const [fieldName, fieldConfig] of Object.entries(this.config.searchableFields)) {
        const postingMap = this.postings.get(termKey(fieldName, term));
        if (postingMap === undefined) {
          continue;
        }
        for (const posting of postingMap.values()) {
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
            documentFrequency: postingMap.size,
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
      .map((document) => ({
        id: document.id,
        version: document.version,
        fields: document.fields,
        fieldLengths: document.fieldLengths,
      }));
    const terms: SerializedTerm[] = [];
    for (const [key, postingMap] of this.postings) {
      const separator = key.indexOf('\u0000');
      const field = key.slice(0, separator);
      const term = key.slice(separator + 1);
      const postings: SerializedPosting[] = [...postingMap.values()].sort((left, right) =>
        compareText(left.documentId, right.documentId),
      );
      terms.push({ field, term, postings });
    }
    terms.sort((left, right) =>
      compareText(`${left.field}\u0000${left.term}`, `${right.field}\u0000${right.term}`),
    );
    return {
      magic: 'SEARCHCRAFT_SEGMENT',
      formatVersion: 1,
      indexName: this.indexName,
      generation,
      createdAt: new Date().toISOString(),
      documents,
      terms,
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
