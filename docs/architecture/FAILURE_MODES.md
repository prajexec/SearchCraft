# Failure Modes

This document distinguishes implemented asynchronous indexing and Phase 4 segment maintenance from planned bulk and generation behavior.

## Implemented behavior

| Failure                                        | Current behavior                                                             | Recovery                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SQLite cannot open                             | Startup fails                                                                | Fix path or permissions; preserve runtime data; restart                |
| Migration fails                                | Startup fails and the connection closes                                      | Correct migration or data issue; rerun migration                       |
| Invalid request JSON                           | `400 invalid_json`                                                           | Correct the request                                                    |
| Request exceeds configured body limit          | `413 request_body_too_large`                                                 | Split or reduce the request                                            |
| Unknown route                                  | `404 route_not_found`                                                        | Use the documented API path                                            |
| Invalid index or document ID                   | `400` validation error                                                       | Use the documented identifier grammar                                  |
| Duplicate index creation                       | `409 index_already_exists`                                                   | Choose another name or inspect the existing index                      |
| Invalid manifest or segment at startup         | Reject the active list and rebuild from active non-deleted SQLite documents  | Preserve the bad file for diagnosis; later recovery will quarantine it |
| Segment write fails after source commit        | Request fails; source mutation remains durable                               | Restart rebuilds the active index from SQLite                          |
| Queue reaches configured outstanding-job limit | `429 queue_saturated` with `Retry-After: 1`; no source mutation is committed | Retry after worker drains jobs                                         |
| Worker process stops with a processing job     | Job remains `processing` until the next worker startup                       | Startup returns orphaned processing jobs to `pending`                  |
| Worker encounters an indexing error            | Job returns to `pending` with bounded exponential delay                      | Worker retries until the configured attempt limit                      |
| Job reaches attempt limit                      | Job becomes `failed` with the last error                                     | Inspect and explicitly retry the failed job                            |
| Worker sees a newer document version           | Older job is completed as superseded without changing the index              | Newer job indexes the current source version                           |
| Process receives SIGINT/SIGTERM                | Server closes and SQLite is closed                                           | Restart; source documents remain durable                               |

## Consistency guarantees

Phase 2 document mutations are durably accepted before indexing. The response returns `202` with a job ID, not a read-after-write search guarantee. The source mutation is durable before the worker attempts index publication. Because the database and filesystem are separate systems, a crash can leave a newer source document with an older active snapshot; startup compares source versions and rebuilds when necessary, then the durable job is recovered.

The API includes `version`, `searchVisible`, `jobId`, and `indexVersion` so callers can reason about what was persisted and published. Job and index-status endpoints expose the eventual-consistency boundary.

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
