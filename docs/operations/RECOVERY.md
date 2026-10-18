# Recovery Procedures

## Current Phase 6 recovery

1. Stop the process gracefully with SIGINT or SIGTERM.
2. Preserve the complete configured data directory before making changes.
3. Run `npm run db:migrate` to verify SQLite can open and migrations are applied.
4. Inspect `data/indexes/<index>/manifest.json` and the referenced generation files without editing them.
5. Restart SearchCraft. Processing jobs left by the previous worker are returned to `pending`; claimed bulk jobs are recovered the same way. If the manifest or segment list is invalid or stale, startup rebuilds the active index from non-deleted source documents in SQLite.
6. Verify `/ready`, index metadata, representative job status, a representative document read, and representative search queries.

The online reindex endpoint builds a target generation without changing the active reader until the validated manifest is published. If it fails, the prior active generation remains searchable; inspect the reindex status endpoint and retry after correcting the source or filesystem issue.

## Backups

Back up the SQLite database and the active index files together. Create a consistent archive with:

```bash
npm run snapshot:create -- --output ./data/snapshots/searchcraft.snapshot.gz
```

The archive contains a SQLite `VACUUM INTO` copy, active manifests, and referenced checksummed segments. Keep it outside the live index directory when possible.

To restore, stop SearchCraft and ensure no process has the SQLite connection open, then run:

```bash
npm run snapshot:restore -- --archive ./data/snapshots/searchcraft.snapshot.gz
```

The restore validates the archive before replacing the target database and active index directory. Preserve the target data directory before restoring in case an operator needs to roll back.

## Future recovery procedures

Later phases must add runbooks for:

- Releasing or retrying claimed indexing jobs.
- Quarantining corrupt segments.
- Cleaning abandoned reindex staging directories.
- Rolling back an active generation after a completed but incorrect publication.
