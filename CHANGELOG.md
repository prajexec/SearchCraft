# Changelog

All notable changes to SearchCraft are recorded here.

## Unreleased

### Added

- Initial strict TypeScript project foundation.
- Native HTTP health, readiness, metrics, Prometheus, and OpenAPI endpoints.
- Explicit idempotent SQLite migration for index metadata, documents, and indexing jobs.
- Baseline unit, integration, documentation, build, lint, and formatting checks.
- Initial architecture plan, ADR, setup notes, and Mermaid diagrams.

### Not yet implemented

- Document ingestion and search endpoints.
- Custom tokenizer, inverted index, and BM25 ranking.
- Asynchronous indexing worker, immutable segments, compaction, reindexing, and snapshots.
