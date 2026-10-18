# Operations Runbook

## Current local process

SearchCraft currently runs as one Node.js process with a SQLite database. Start it with:

```bash
npm run build
npm start
```

Check process and storage readiness:

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ready
```

Inspect JSON or Prometheus-compatible metrics:

```bash
curl -fsS http://127.0.0.1:3000/metrics
curl -fsS http://127.0.0.1:3000/metrics/prometheus
```

## Runtime data

The default runtime directory is `data/`. It contains:

- `searchcraft.sqlite` and SQLite WAL files.
- Active and retired index generation files.
- Staging directories for reindexing and compaction.
- Snapshot archives and temporary snapshot data.

Do not delete runtime data while the service is running. Use the snapshot command to back up the database and active index generations together.

## Current recovery behavior

If migration or SQLite initialization fails, the process exits rather than claiming readiness. Stop the process, preserve the data directory, inspect the error, and run `npm run db:migrate` after correcting the underlying path or permission issue.

The current Phase 6 job, generation, corruption, and snapshot recovery procedures are documented in [RECOVERY.md](RECOVERY.md). Restore requires the service and its SQLite connection to be stopped.

## Resource guidance

Use the default one-process configuration on an 8 GB MacBook Air. Do not add background services merely to run the foundation. Keep benchmark data and snapshots outside the repository if they become large.
