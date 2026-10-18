# Search Algorithms

## Tokenization

SearchCraft's Phase 1 tokenizer applies Unicode NFKC normalization, converts text to lowercase with the `en-US` locale, and extracts runs of Unicode letters and numbers using `\p{L}` and `\p{N}`. Punctuation is a separator. Each extracted token receives a zero-based position. Tokens longer than the configured `maxTokenLength` are skipped while their position is still consumed.

The tokenizer is deliberately deterministic and language-neutral. It does not perform stemming, stop-word removal, synonym expansion, or language detection yet. Those choices affect recall and must be introduced as explicit index-configuration or analyzer-version decisions rather than hidden in the query path.

## Inverted index

The Phase 1 in-process index stores:

```text
(field, term) -> document ID -> {
  document version,
  term frequency,
  token positions
}
```

Each indexed document also stores its configured field lengths and the stored source fields returned in a hit. Updating a document removes its existing postings before adding postings for the new version. Deleting a document removes it from the active in-process index and persists a SQLite tombstone. New segment postings encode sorted token positions as VByte delta gaps; readers decode them into the same in-process position lists and retain compatibility with legacy uncompressed arrays.

The persisted representation is a set of inspectable JSON segments. Each segment is versioned with `magic: SEARCHCRAFT_SEGMENT`, carries a checksum, and contains one indexing mutation or one compacted live view. A manifest atomically publishes the complete active segment list. The segment reader resolves the highest document version across that list; a tombstone hides every older posting until compaction purges it.

## BM25

SearchCraft uses the standard BM25 term score with `k1 = 1.2` and `b = 0.75`:

```text
IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))

score(t, d) = IDF(t) *
             (tf(t,d) * (k1 + 1)) /
             (tf(t,d) + k1 * (1 - b + b * |d| / avgdl))
```

Where:

- `N` is the number of active documents in the index.
- `df(t)` is the number of active documents containing term `t` in the field.
- `tf(t,d)` is the term frequency in the field of document `d`.
- `|d|` is the field token length of document `d`.
- `avgdl` is the average active field length.
- `k1` controls term-frequency saturation.
- `b` controls document-length normalization.

Scores are summed across query terms and searchable fields. Each field has a positive configured boost. Query terms are deduplicated after tokenization so repeating a term in the query does not accidentally multiply its contribution. Results are ordered by score descending and document ID ascending for deterministic ties.

Phrase searches set `phrase=true` on the search API. Terms must occur in order within one searchable field. With the default `slop=0`, each term must be adjacent; a positive slop permits that many total unmatched token gaps while preserving order. Phrase candidates are filtered by positions before their BM25 scores are calculated.

## Pagination

Search returns exact `totalHits` for the current in-memory generation. A cursor encodes the last returned score and ID as base64url JSON. The next page contains hits with a lower score, or the same score and a lexicographically greater ID. This gives stable pagination for an unchanged generation without offset scanning.

The cursor is not a promise that results remain stable after an update. Clients should treat `indexVersion` as the generation observed and restart pagination if they require a consistent result set across mutations.

## Term dictionary blocks

Sorted serialized terms are grouped into bounded blocks of 16 entries. Each block records its first and last term, shared prefix, offset, and length. Readers validate block ordering and can locate a candidate block with binary search before examining terms within it. The flat term array remains available for compatibility and inspectability while the block metadata establishes the format for bounded dictionary lookup.

## Filters and query safeguards

Indexes explicitly list `filterableFields`. The search API accepts a URL-encoded JSON object in the `filter` query parameter:

```json
{
  "category": "laptop",
  "available": true,
  "price": { "gte": 500, "lt": 1500 }
}
```

Scalar filters use exact equality. A string filter against a string array matches membership. Numeric ranges support `gt`, `gte`, `lt`, and `lte`; range operands must be finite numbers. Unknown fields and unsupported operators are rejected before posting lookup, so the filter path never becomes a SQL or filesystem expression.

Each index also bounds unique query terms with `maxQueryTerms` (default `32`). Queries that contain only punctuation or exceed that term count return `400` rather than creating unbounded candidate work.

## Current limitations

- All candidates are scored in memory after posting lookup.
- Posting metadata remains JSON and compaction currently materializes the resolved live view in memory.
- Phrase slop is ordered-gap matching rather than a full positional edit-distance model.
- Synonyms, stemming, and vector search are not implemented.
- The multi-segment reader and compactor preserve the version and tombstone invariants tested here. Compaction writes only winning live documents, so deleted tombstones and superseded versions do not contribute to later global statistics.
