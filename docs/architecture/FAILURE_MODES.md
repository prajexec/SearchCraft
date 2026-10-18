# Failure Modes

This document distinguishes implemented asynchronous indexing, Phase 5 bulk ingestion, Phase 6 generation/snapshot maintenance, and planned advanced search behavior.

## Implemented behavior

| Failure                                        | Current behavior                                                             | Recovery                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SQLite cannot open                             | Startup fails                                                                | Fix path or permissions; preserve runtime data; restart                |
| Migration fails                                | Startup fails and the connection closes                                      | Correct migration or data issue; rerun migration                       |
| Invalid request JSON                           | `400 invalid_json`                                                           | Correct the request                                                    |
| Invalid bulk NDJSON or action                  | `400 invalid_bulk` with the line number                                      | Correct the action/source pair; no batch mutation is committed         |
| Request exceeds configured body limit          | `413 request_body_too_large`                                                 | Split or reduce the request                                            |
| Bulk body or operation limit exceeded          | `413 bulk_body_too_large` or `413 bulk_batch_too_large`                      | Split the batch or reduce the request                                  |
| Unknown route                                  | `404 route_not_found`                                                        | Use the documented API path                                            |
| Invalid index or document ID                   | `400` validation error                                                       | Use the documented identifier grammar                                  |
| Duplicate index creation                       | `409 index_already_exists`                                                   | Choose another name or inspect the existing index                      |
| Invalid manifest or segment at startup         | Reject the active list and rebuild from active non-deleted SQLite documents  | Preserve the bad file for diagnosis; later recovery will quarantine it |
| Segment write fails after source commit        | Request fails; source mutation remains durable                               | Restart rebuilds the active index from SQLite                          |
| Online reindex preparation fails               | Prior active generation remains searchable; reindex reports `failed`         | Correct the source/filesystem issue and start another reindex          |
| Snapshot archive validation fails              | Create or restore stops before replacing target files                        | Preserve the source/target and repair or replace the archive           |
| Queue reaches configured outstanding-job limit | `429 queue_saturated` with `Retry-After: 1`; no source mutation is committed | Retry after worker drains jobs                                         |
| Bulk create conflicts or update target missing | `409`; the complete batch is rolled back                                     | Correct the IDs or use `index` for replacement                         |
| Worker process stops with a processing job     | Job remains `processing` until the next worker startup                       | Startup returns orphaned processing jobs to `pending`                  |
| Worker encounters an indexing error            | Job returns to `pending` with bounded exponential delay                      | Worker retries until the configured attempt limit                      |
| Job reaches attempt limit                      | Job becomes `failed` with the last error                                     | Inspect and explicitly retry the failed job                            |
| Worker sees a newer document version           | Older job is completed as superseded without changing the index              | Newer job indexes the current source version                           |
| Process receives SIGINT/SIGTERM                | Server closes and SQLite is closed                                           | Restart; source documents remain durable                               |

## Consistency guarantees

Phase 2 document mutations are durably accepted before indexing. The response returns `202` with a job ID, not a read-after-write search guarantee. The source mutation is durable before the worker attempts index publication. Because the database and filesystem are separate systems, a crash can leave a newer source document with an older active snapshot; startup compares source versions and rebuilds when necessary, then the durable job is recovered.

The API includes `version`, `searchVisible`, `jobId`, and `indexVersion` so callers can reason about what was persisted and published. Job and index-status endpoints expose the eventual-consistency boundary.

## Implemented bulk behavior

Bulk requests are parsed from incoming chunks with a bounded line buffer. The parser counts UTF-8 body bytes and logical operations before storage. It accepts `index`, `create`, `update`, and `delete` actions; `update` merges fields into the current non-deleted source document. A valid batch uses one SQLite transaction for all source rows and indexing jobs, and queue admission is checked for the complete batch before any row is committed. Parse, validation, create-conflict, missing-update, and queue-saturation failures leave the database unchanged.

The worker claims bounded job batches and groups them by index so the current documents can be published through one multi-document immutable segment per group. Stale jobs remain safely superseded by the latest source version.

Online reindexing builds a complete target generation from durable non-deleted source documents, validates the segment, atomically publishes a one-segment manifest, and only then swaps the in-memory reader and SQLite active-generation metadata. Snapshot creation uses SQLite `VACUUM INTO` and active manifest references; restore validates all archive contents before staging and replacing the target active index files. Restore is an operator action and requires the service to be stopped.

## Implemented asynchronous failures

The asynchronous worker defines and tests:

- Claimed jobs recovered after worker restart.
- Stale jobs unable to overwrite newer document versions.
- Retryable versus terminal indexing failures.
- Queue saturation and `429 Retry-After` behavior.

Graceful shutdown currently stops the HTTP server and waits for the worker loop before closing SQLite. A future batch worker must add explicit in-flight batch release semantics.

## Implemented segment maintenance failures

Segment compaction builds a consolidated segment, validates it, and publishes it through an atomic manifest replacement. If compaction fails, the previous active segment list remains searchable. Corrupted checksummed segments trigger a source rebuild; interrupted temporary files are never referenced by a manifest.

Reindexing, snapshot restore, and zero-downtime generation swaps remain later maintenance work.
