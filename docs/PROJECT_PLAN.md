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
| 4     | Versioned immutable segments and compaction                                  | Planned  |
| 5     | Streaming bulk ingestion and operational metrics                             | Planned  |
| 6     | Generations, reindexing, snapshots, and online swaps                         | Planned  |
| 7     | Reproducible benchmarks, CI, and engineering polish                          | Planned  |
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

## Next implementation slice

The next slice is Phase 4: replace full-snapshot rewrites with multiple immutable segments, add segment validation and compaction, and preserve search correctness across merges and tombstones.

## Required evidence for each phase

Every phase must finish with:

1. User-visible functionality or an operationally useful foundation.
2. Tests for normal, invalid, and failure behavior within that phase.
3. Updated API, architecture, algorithm, or operations documentation.
4. Relevant Mermaid diagrams synchronized with the actual implementation.
5. Typecheck, lint, format, test, build, and documentation checks appropriate to the changed scope.
6. A focused Conventional Commit after the checks pass.

## Known gaps at project start

- Bulk NDJSON ingestion, compaction, snapshots, and online generation swaps are not implemented yet.
- No external benchmark result exists; the current benchmark script measures only the foundation health endpoint.
- No authentication or multitenancy is planned for the local-first trust boundary.
- No license has been selected, so the repository is currently marked `UNLICENSED`.
