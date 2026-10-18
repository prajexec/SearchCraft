# SearchCraft Project Plan

SearchCraft is a lightweight, self-contained search indexing and query service. Its purpose is to make the mechanics and operational tradeoffs of a search engine inspectable: tokenization, inverted indexes, BM25 ranking, immutable segments, durable indexing, generation publication, and recovery.

## Constraints and decisions

- Node.js 22 LTS-compatible runtime with strict TypeScript.
- Native `node:http`, `node:sqlite`, and `node:test` APIs wherever practical.
- A custom disk-backed inverted index; no OpenSearch or Elasticsearch delegation.
- SQLite is limited to source documents, metadata, migrations, and the durable indexing queue.
- One worker loop, bounded queues, bounded batches, and configurable request limits initially.
- Local development is one Node.js process and does not require Docker or external services.
- Runtime data lives below `data/` by default and is excluded from Git.

## Phase status

| Phase | Scope                                                                        | Status   |
| ----- | ---------------------------------------------------------------------------- | -------- |
| 0     | Project foundation, operational endpoints, SQLite migrations, docs, diagrams | Complete |
| 1     | Searchable vertical slice, tokenization, inverted index, BM25                | Complete |
| 2     | Durable asynchronous indexing and recovery                                   | Complete |
| 3     | Filters, field boosts, and cursor pagination                                 | Complete |
| 4     | Versioned immutable segments and compaction                                  | Complete |
| 5     | Streaming bulk ingestion and operational metrics                             | Complete |
| 6     | Generations, reindexing, snapshots, and online swaps                         | Complete |
| 7     | Reproducible benchmarks, CI, and engineering polish                          | Complete |
| 8     | Optional advanced features selected from measured needs                      | Planned  |

## Phase 0 acceptance criteria

- A reproducible npm install and strict TypeScript build work on Node.js 22.
- The service starts without external infrastructure.
- SQLite migrations are explicit and idempotent.
- Health, readiness, JSON metrics, Prometheus metrics, and OpenAPI endpoints work.
- Baseline unit and integration tests run with the built-in Node test runner.
- The architecture, resource constraints, and current limitations are documented.
- Foundational Mermaid diagrams describe the implemented foundation and clearly label future boundaries.

Phase 0 was committed as `a257cea` (`chore: initialize lightweight TypeScript project`).

## Phase 1 acceptance criteria

- A client can create a named index with explicit searchable and stored fields.
- A client can upsert, retrieve, and delete structured source documents.
- Text is normalized and tokenized with Unicode-aware deterministic rules.
- A custom inverted index stores term frequencies, positions, field lengths, and document versions.
- BM25 scores candidates with field boosts and deterministic tie-breaking.
- Search supports exact total-hit semantics and cursor pagination.
- Index snapshots are written through a staging file and atomic manifest publication.
- The active index can be loaded after a process restart.
- Unit, API, and restart integration tests protect these behaviors.

Phase 1 was committed as `a6aa0f5` (`feat: add searchable vertical slice`).

## Phase 2 acceptance criteria

- Document mutations and their indexing jobs commit atomically in SQLite.
- Production writes return `202 Accepted` with a job ID and explicit eventual-consistency semantics.
- One bounded worker claims jobs, publishes index state, and marks completion only afterward.
- Processing jobs are recoverable after worker or process restart.
- A stale job cannot overwrite a newer document version.
- Retryable failures return to `pending` with bounded exponential delay; terminal failures become inspectable `failed` jobs.
- Queue saturation returns `429` with `Retry-After` without silently dropping a durable operation.
- Job inspection, retry, and index status endpoints expose operational state.
- Tests cover transaction coupling, queue limits, normal completion, restart recovery, stale handling, and retry transitions.

Phase 2 acceptance criteria are verified by the asynchronous API, worker, transaction, recovery, and job-state tests.

## Phase 3 acceptance criteria

- Index configuration can explicitly allow filterable fields.
- Search supports exact scalar filters and membership in string arrays.
- Search supports finite numeric `gt`, `gte`, `lt`, and `lte` ranges.
- Unknown fields, malformed JSON, unsupported operators, and non-numeric ranges fail before search execution.
- Query terms are bounded per index and punctuation-only queries return a clear `400` error.
- Filtered totals and cursor pages remain deterministic.
- Filter behavior and query safeguards are covered by unit and API tests and documented in the search algorithm reference.

Phase 3 acceptance criteria are verified by filter parser, inverted-index, and API search tests.

## Phase 4 acceptance criteria

- Each indexing publication writes a small immutable segment and atomically appends it to the manifest instead of rewriting the active index.
- The manifest tracks all active segments for one publication generation, and readers resolve the newest document version before searching.
- Tombstones hide older postings, deleted and superseded records are excluded from global BM25 statistics, and filtered searches retain exact totals.
- Segment and manifest integrity metadata rejects corrupted or path-escaping files before they become active.
- Background compaction merges active segments, purges tombstones and superseded versions, and atomically swaps the compacted segment list.
- Search remains available from the prior immutable segment view if compaction or validation fails.
- Unit, API, restart, corruption, and compaction tests protect these behaviors.

Phase 4 acceptance criteria are verified by the immutable-segment, integrity, compaction, and existing search/recovery tests.

## Phase 5 acceptance criteria

- `POST /v1/indexes/:name/documents/_bulk` accepts `application/x-ndjson` with bounded streaming parsing.
- Bulk actions support `index`, `create`, `update`, and `delete` using the two-line action/source format; update merges fields into the current source document.
- Request body bytes and logical operation count are bounded by `maxBodyBytes` and `maxBulkBatchSize`.
- A valid bulk request commits all source mutations and their indexing jobs in one SQLite transaction, with queue admission performed for the complete batch.
- Async workers claim bounded job batches and publish one multi-document immutable segment per index; synchronous bulk requests publish one batch segment directly.
- Parse, validation, create-conflict, missing-update, and queue-saturation failures do not partially commit a bulk request.
- Bulk request count, accepted document count, and bounded ingestion latency histograms are exposed through JSON and Prometheus metrics.
- The OpenAPI specification documents the NDJSON endpoint, action format, limits, responses, and failure statuses.

Phase 5 acceptance criteria are verified by streaming parser, bulk API, transaction, worker-batch, metrics, and OpenAPI tests.

## Phase 6 acceptance criteria

- `POST /v1/indexes/:name/documents/_reindex` starts a background rebuild from authoritative SQLite source documents without changing the active reader until publication.
- A target generation is written and validated as an immutable segment, then the manifest's active generation pointer is atomically swapped; prior reads remain available if preparation fails.
- Reindex status is observable through `GET /v1/indexes/:name/documents/_reindex/:jobId`, including the target generation, source count, completion state, and failure message.
- Snapshot creation uses SQLite `VACUUM INTO` plus the active manifests and referenced segments to produce a validated gzip-compressed archive.
- Snapshot restore validates the archive, atomically restores the database and active index files, removes stale SQLite sidecars, and preserves unrelated target data.
- Snapshot create and restore commands and disaster-recovery runbooks document the required process-stop boundary.

Phase 6 acceptance criteria are verified by reindex API/generation-swap and snapshot archive/restore tests.

## Phase 7 acceptance criteria

- The benchmark measures synchronous bulk indexing throughput in documents per second across configurable batch sizes.
- The benchmark measures deterministic BM25 search latency at p50, p95, and p99 and emits one machine-readable JSON result.
- Benchmark inputs, warm-up assumptions, timing boundaries, and interpretation limits are documented.
- GitHub Actions runs typecheck, lint, format, tests, documentation/OpenAPI checks, and build on pushes and pull requests using Node.js 22.

Phase 7 acceptance criteria are verified by the benchmark smoke run and the checked-in CI workflow.

## Subsequent roadmap

- **Phase 8:** Advanced enhancements selected from measured needs, such as phrase queries, compressed posting lists, or term-dictionary blocks.

## Required evidence for each phase

Every phase must finish with:

1. User-visible functionality or an operationally useful foundation.
2. Tests for normal, invalid, and failure behavior within that phase.
3. Updated API, architecture, algorithm, or operations documentation.
4. Relevant Mermaid diagrams synchronized with the actual implementation.
5. Typecheck, lint, format, test, build, and documentation checks appropriate to the changed scope.
6. A focused Conventional Commit after the checks pass.

## Known gaps at project start

- Advanced search enhancements selected from measurement are not implemented yet.
- No authentication or multitenancy is planned for the local-first trust boundary.
- No license has been selected, so the repository is currently marked `UNLICENSED`.
