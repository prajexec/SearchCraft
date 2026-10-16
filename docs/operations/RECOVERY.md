# Recovery Procedures

## Current Phase 1 recovery

1. Stop the process gracefully with SIGINT or SIGTERM.
2. Preserve the complete configured data directory before making changes.
3. Run `npm run db:migrate` to verify SQLite can open and migrations are applied.
4. Inspect `data/indexes/<index>/manifest.json` and the referenced generation file without editing them.
5. Restart SearchCraft. If the manifest or snapshot is invalid, startup rebuilds the active index from non-deleted source documents in SQLite.
6. Verify `/ready`, index metadata, a representative document read, and representative search queries.

The current rebuild is intentionally simple and can load all active documents for the affected index. It is a recovery path for the small Phase 1 slice, not a claim that large indexes rebuild within a particular time.

## Backups

Back up the SQLite database and the index directory together. Since the Phase 1 source documents are authoritative for rebuild, a database backup is required even if the JSON generations are also copied. Do not copy a live SQLite file without its WAL state; stop the process or use a consistent SQLite backup procedure.

## Future recovery procedures

Later phases must add runbooks for:

- Releasing or retrying claimed indexing jobs.
- Quarantining corrupt segments.
- Cleaning abandoned reindex staging directories.
- Restoring and validating snapshots.
- Rolling back an active generation after failed publication.
