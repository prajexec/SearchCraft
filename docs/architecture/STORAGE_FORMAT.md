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
            ├── segment-2.json
            ├── segment-3.json
            └── segment-5.json
```

Index names are validated before they are used in paths. They cannot contain path separators or traversal components.

## SQLite metadata

The `001_initial` migration creates:

- `schema_migrations(id, description, applied_at)`
- `indexes(name, config_json, state, active_generation, created_at, updated_at)`
- `documents(index_name, document_id, version, body_json, deleted, created_at, updated_at)`
- `indexing_jobs(job_id, index_name, document_id, document_version, operation, status, attempts, available_at, claimed_at, completed_at, last_error, created_at)`

Source-document mutations and their indexing jobs are written in one SQLite transaction. A document version increases on every upsert or delete. A delete keeps a tombstone row with `body_json = NULL`. The job records the document version so a stale worker attempt cannot overwrite newer source state.

## Manifest

The active manifest is a small JSON object:

```json
{
  "magic": "SEARCHCRAFT_MANIFEST",
  "formatVersion": 2,
  "indexName": "products",
  "activeGeneration": 5,
  "activeSegments": [
    "generations/segment-2.json",
    "generations/segment-3.json",
    "generations/segment-5.json"
  ],
  "checksum": "sha256-of-the-canonical-manifest-payload"
}
```

The manifest is written to a temporary sibling file and published with a filesystem rename after each new segment has been written, validated, and renamed. The manifest checksum, safe relative paths, and each segment checksum are validated before loading. On startup, an invalid manifest or any active segment causes a source-document rebuild instead of silently serving a partially parsed index.

## Immutable segments

Each JSON segment contains:

- Format magic and version.
- Index name and generation.
- Creation timestamp.
- Changed document IDs, versions, source fields, field lengths, and optional tombstones.
- Sorted `(field, term)` entries for the changed documents.
- Sorted postings with document ID, document version, term frequency, and positions.
- A SHA-256 checksum over the canonical payload without the checksum header.

JSON is intentionally not described as compressed. It remains inspectable while the logical posting contract is moved to multiple immutable segments. The reader resolves the newest version for each document across the active list before calculating global document frequency and average field lengths. Compaction writes one consolidated live-document segment, atomically swaps the manifest, and purges tombstones and superseded versions.

## Filesystem failure window

SQLite and the filesystem do not share an atomic transaction. The asynchronous worker's order is:

1. Commit the source-document mutation and pending job to SQLite.
2. Claim the job and increment its attempt count.
3. Update the in-process resolved index.
4. Write, validate, and rename a new immutable segment.
5. Write and rename the manifest containing the complete active segment list.
6. Update `indexes.active_generation` in SQLite.
7. Mark the job completed.

If steps 3–6 fail after step 1, the durable source and pending/processing job remain authoritative. A worker restart returns orphaned processing jobs to `pending`; startup compares resolved segment versions with the active source and rebuilds when necessary. Orphaned immutable files are harmless until cleanup. Job completion occurs only after the required manifest state is durably published.
