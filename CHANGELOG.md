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
- Durable SQLite indexing jobs with bounded queue admission.
- One indexing worker with processing leases, orphan recovery, retries, and stale-version protection.
- Job inspection, retry, and index status endpoints.
- Configured exact-match and numeric-range filters with safe query parsing.
- Query term-count and punctuation-only safeguards.
- Versioned immutable segments with atomic manifest append and restart recovery.
- Cross-segment document-version resolution, tombstones, and global BM25 statistics.
- Checksummed segment and manifest validation with safe relative-path enforcement.
- Threshold-triggered immutable segment compaction with retired-file cleanup.

### Not yet implemented

- Bulk NDJSON ingestion, reindexing, and snapshots.
