# Changelog

All notable changes to SearchCraft are recorded here.

## Unreleased

### Added

- Initial strict TypeScript project foundation.
- Native HTTP health, readiness, metrics, Prometheus, and OpenAPI endpoints.
- Explicit idempotent SQLite migration for index metadata, documents, and indexing jobs.
- Baseline unit, integration, documentation, build, lint, and formatting checks.
- Initial architecture plan, ADR, setup notes, and Mermaid diagrams.
- Named index creation and inspection.
- Durable source-document upserts, reads, deletes, and document versions.
- Unicode-aware tokenization with positions and token-length safeguards.
- Custom inverted index snapshots with term statistics and field lengths.
- Custom BM25 scoring, field boosts, deterministic ordering, and cursor pagination.
- Restart recovery from the active index manifest.

### Not yet implemented

- Asynchronous indexing worker, immutable segments, compaction, reindexing, and snapshots.
- Bulk NDJSON ingestion, filters, and operational job inspection.
