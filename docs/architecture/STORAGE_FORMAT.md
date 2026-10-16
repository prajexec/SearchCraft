# Storage Format

## Runtime layout

The default runtime layout is:

```text
data/
├── searchcraft.sqlite
├── searchcraft.sqlite-shm
├── searchcraft.sqlite-wal
└── indexes/
    └── <index-name>/
        ├── manifest.json
        └── generations/
            ├── generation-1.json
            └── generation-2.json
```

Index names are validated before they are used in paths. They cannot contain path separators or traversal components.

## SQLite metadata

The `001_initial` migration creates:

- `schema_migrations(id, description, applied_at)`
- `indexes(name, config_json, state, active_generation, created_at, updated_at)`
- `documents(index_name, document_id, version, body_json, deleted, created_at, updated_at)`
- `indexing_jobs(job_id, index_name, document_id, document_version, operation, status, attempts, available_at, claimed_at, completed_at, last_error, created_at)`

Phase 2 writes source documents and their indexing jobs in one SQLite transaction. A document version increases on every upsert or delete. A delete keeps a tombstone row with `body_json = NULL`. The job records the document version so a stale worker attempt cannot overwrite newer source state.

## Manifest

The active manifest is a small JSON object:

```json
{
  "magic": "SEARCHCRAFT_MANIFEST",
  "formatVersion": 1,
  "indexName": "products",
  "activeGeneration": 4,
  "segmentFile": "generations/generation-4.json"
}
```

The manifest is written to a temporary sibling file and published with a filesystem rename after the generation file has been written and renamed. On startup, an invalid manifest or segment causes a source-document rebuild instead of silently serving a partially parsed index.

## Current snapshot

The JSON snapshot contains:

- Format magic and version.
- Index name and generation.
- Creation timestamp.
- Active document IDs, versions, source fields, and field lengths.
- Sorted `(field, term)` entries.
- Sorted postings with document ID, document version, term frequency, and positions.

JSON is intentionally not described as a compressed or scalable format. It is inspectable and deterministic enough for the current small vertical slice. Phase 4 can introduce multiple immutable segments, checksums, block encoding, and bounded readers without changing the logical posting contract.

## Filesystem failure window

SQLite and the filesystem do not share an atomic transaction. The asynchronous worker's current order is:

1. Commit the source-document mutation and pending job to SQLite.
2. Claim the job and increment its attempt count.
3. Update the in-process index.
4. Write and rename the next generation file.
5. Write and rename the active manifest.
6. Update `indexes.active_generation` in SQLite.
7. Mark the job completed.

If steps 3–6 fail after step 1, the durable source and pending/processing job remain authoritative. A worker restart returns orphaned processing jobs to `pending`; startup also compares source versions with the active snapshot and rebuilds when necessary. Job completion occurs only after the required generation state is durably published.
