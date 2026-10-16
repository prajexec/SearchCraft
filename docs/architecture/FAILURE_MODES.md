# Failure Modes

This document distinguishes implemented Phase 1 behavior from planned asynchronous and maintenance behavior.

## Implemented behavior

| Failure                                 | Current behavior                                 | Recovery                                                               |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| SQLite cannot open                      | Startup fails                                    | Fix path or permissions; preserve runtime data; restart                |
| Migration fails                         | Startup fails and the connection closes          | Correct migration or data issue; rerun migration                       |
| Invalid request JSON                    | `400 invalid_json`                               | Correct the request                                                    |
| Request exceeds configured body limit   | `413 request_body_too_large`                     | Split or reduce the request                                            |
| Unknown route                           | `404 route_not_found`                            | Use the documented API path                                            |
| Invalid index or document ID            | `400` validation error                           | Use the documented identifier grammar                                  |
| Duplicate index creation                | `409 index_already_exists`                       | Choose another name or inspect the existing index                      |
| Invalid index snapshot at startup       | Rebuild from active non-deleted SQLite documents | Preserve the bad file for diagnosis; later recovery will quarantine it |
| Segment write fails after source commit | Request fails; source mutation remains durable   | Restart rebuilds the active index from SQLite                          |
| Process receives SIGINT/SIGTERM         | Server closes and SQLite is closed               | Restart; source documents remain durable                               |

## Consistency guarantees

Phase 1 document mutations are synchronous from the caller's perspective: the response is returned only after the process has written the new snapshot and manifest. The source mutation is durable before index publication. Because the database and filesystem are separate systems, a crash can leave a newer source document with an older active snapshot; startup rebuilds from source documents.

The API includes `version`, `searchVisible`, and `indexVersion` so callers can reason about what was persisted and published. Phase 2 will make the failure window explicit through durable jobs and status APIs.

## Planned asynchronous failures

Phase 2 must define and test:

- Claimed jobs recovered after worker restart.
- Stale jobs unable to overwrite newer document versions.
- Retryable versus terminal indexing failures.
- Queue saturation and `429 Retry-After` behavior.
- Graceful shutdown while a batch is in flight.

## Planned maintenance failures

Reindexing, compaction, and snapshot restore must build in staging, validate before publication, publish through an atomic manifest replacement, and retain the prior active generation until the new generation is known to be usable. Interrupted staging directories must be discoverable and safe to remove only after checking they are not active.
