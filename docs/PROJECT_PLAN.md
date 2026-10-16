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

| Phase | Scope                                                                        | Status      |
| ----- | ---------------------------------------------------------------------------- | ----------- |
| 0     | Project foundation, operational endpoints, SQLite migrations, docs, diagrams | In progress |
| 1     | Searchable vertical slice, tokenization, inverted index, BM25                | Planned     |
| 2     | Durable asynchronous indexing and recovery                                   | Planned     |
| 3     | Filters, field boosts, and cursor pagination                                 | Planned     |
| 4     | Versioned immutable segments and compaction                                  | Planned     |
| 5     | Streaming bulk ingestion and operational metrics                             | Planned     |
| 6     | Generations, reindexing, snapshots, and online swaps                         | Planned     |
| 7     | Reproducible benchmarks, CI, and engineering polish                          | Planned     |
| 8     | Optional advanced features selected from measured needs                      | Planned     |

## Phase 0 acceptance criteria

- A reproducible npm install and strict TypeScript build work on Node.js 22.
- The service starts without external infrastructure.
- SQLite migrations are explicit and idempotent.
- Health, readiness, JSON metrics, Prometheus metrics, and OpenAPI endpoints work.
- Baseline unit and integration tests run with the built-in Node test runner.
- The architecture, resource constraints, and current limitations are documented.
- Foundational Mermaid diagrams describe the implemented foundation and clearly label future boundaries.

## Next implementation slice

The next slice is the smallest useful search flow: create an index, persist a source document, tokenize configured text fields, construct an in-memory segment backed by a versioned on-disk format, calculate BM25, and return deterministic search results. It will be implemented behind service interfaces so the later durable worker can use the same indexing engine.

## Required evidence for each phase

Every phase must finish with:

1. User-visible functionality or an operationally useful foundation.
2. Tests for normal, invalid, and failure behavior within that phase.
3. Updated API, architecture, algorithm, or operations documentation.
4. Relevant Mermaid diagrams synchronized with the actual implementation.
5. Typecheck, lint, format, test, build, and documentation checks appropriate to the changed scope.
6. A focused Conventional Commit after the checks pass.

## Known gaps at project start

- No search endpoints are implemented yet.
- No external benchmark result exists; the current benchmark script measures only the foundation health endpoint.
- No authentication or multitenancy is planned for the local-first trust boundary.
- No license has been selected, so the repository is currently marked `UNLICENSED`.
