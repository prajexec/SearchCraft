# Development Setup

## Required tools

- Node.js 22.x
- npm 10.x
- Git

SearchCraft checks `node:sqlite` during setup. The project does not require Docker, PostgreSQL, OpenSearch, or another service for local development.

## Install

```bash
npm install
npm run db:migrate
```

The migration command creates `data/searchcraft.sqlite` by default. The `data/` directory is runtime state and is ignored by Git.

## Configuration

Copy `.env.example` into your shell environment as needed. The current server reads environment variables directly; it does not load `.env` files implicitly.

| Variable                              | Default                         | Purpose                                              |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `SEARCHCRAFT_HOST`                    | `127.0.0.1`                     | Bind address                                         |
| `SEARCHCRAFT_PORT`                    | `3000`                          | HTTP port                                            |
| `SEARCHCRAFT_DATA_DIR`                | `./data`                        | Runtime data directory                               |
| `SEARCHCRAFT_DB_PATH`                 | `<data dir>/searchcraft.sqlite` | SQLite database path                                 |
| `SEARCHCRAFT_MAX_BODY_BYTES`          | `1048576`                       | Maximum declared and streamed request body           |
| `SEARCHCRAFT_MAX_QUERY_LENGTH`        | `1000`                          | Maximum query string length                          |
| `SEARCHCRAFT_MAX_BULK_BATCH_SIZE`     | `1000`                          | Maximum bulk operations per request and worker claim |
| `SEARCHCRAFT_MAX_PENDING_JOBS`        | `10000`                         | Pending/processing job limit                         |
| `SEARCHCRAFT_WORKER_POLL_INTERVAL_MS` | `50`                            | Worker idle poll interval                            |
| `SEARCHCRAFT_JOB_LEASE_MS`            | `30000`                         | Processing lease before recovery                     |
| `SEARCHCRAFT_MAX_JOB_ATTEMPTS`        | `5`                             | Attempts before terminal failure                     |
| `SEARCHCRAFT_MAX_JOB_HISTORY`         | `10000`                         | Retained terminal jobs per state                     |
| `SEARCHCRAFT_LOG_LEVEL`               | `info`                          | `debug`, `info`, `warn`, or `error`                  |

## Run

```bash
npm run build
npm start
```

`npm run dev` builds once and uses Node's watch mode on the compiled server. Re-run the build after source changes when using the development loop.

## Operational smoke check

```bash
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/metrics
```

The API specification is available at `http://127.0.0.1:3000/openapi.json`. The checked-in specification is generated from the route contract and verified with `npm run docs:check`.
