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
- Streaming `application/x-ndjson` bulk ingestion with index, create, update, and delete actions.
- Atomic bulk source-document and indexing-job transactions with bounded queue admission.
- Batched worker claims and one multi-document segment publication per index.
- Bulk request, document, and latency metrics with OpenAPI coverage.
- Background online reindexing with atomic target-generation manifest swaps.
- Validated gzip snapshot archives containing SQLite and active index segments, with restore tooling.
- Reproducible bulk-throughput and BM25-latency benchmark output plus pull-request/main CI checks.
- Exact and bounded-slop phrase queries using token positions.
- VByte delta-gap compression for newly written posting positions.
- Bounded sorted term-dictionary blocks with shared-prefix metadata and binary lookup.

### Not yet implemented

- No additional planned milestones; future optimizations remain measurement-driven.
