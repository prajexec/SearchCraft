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

Phase 1 writes source documents transactionally, but does not enqueue jobs yet. The job table is intentionally present for Phase 2's durable asynchronous worker. A document version increases on every upsert or delete. A delete keeps a tombstone row with `body_json = NULL`.

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

## Phase 1 snapshot

The JSON snapshot contains:

- Format magic and version.
- Index name and generation.
- Creation timestamp.
- Active document IDs, versions, source fields, and field lengths.
- Sorted `(field, term)` entries.
- Sorted postings with document ID, document version, term frequency, and positions.

JSON is intentionally not described as a compressed or scalable format. It is inspectable and deterministic enough for the first vertical slice. Phase 4 can introduce multiple immutable segments, checksums, block encoding, and bounded readers without changing the logical posting contract.

## Filesystem failure window

SQLite and the filesystem do not share an atomic transaction. The current order is:

1. Commit the source-document mutation to SQLite.
2. Update the in-process index.
3. Write and rename the next generation file.
4. Write and rename the active manifest.
5. Update `indexes.active_generation` in SQLite.

If steps 2–5 fail after step 1, the durable source remains authoritative and startup can rebuild from active source documents. If a future asynchronous worker is introduced, job completion must occur only after the required generation state is durably published.
