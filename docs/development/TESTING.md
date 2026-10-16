# Testing and Quality Checks

SearchCraft uses the built-in Node.js test runner and strict TypeScript. Tests are compiled to `dist/` before execution so the tested artifact matches the production build path.

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run docs:check
npm run build
```

The current baseline tests cover configuration validation, bounded metrics, idempotent SQLite migrations, and operational HTTP endpoints. Search correctness, recovery, segments, and API ingestion tests will be added with their respective phases.

## Test categories

- `test/unit/`: deterministic module behavior without a listening server.
- `test/integration/`: SQLite and HTTP behavior using temporary directories.
- Future `test/api/`: request validation and complete API contracts.
- Future `test/recovery/`: restart, stale job, corrupt segment, and interrupted publication scenarios.

Tests must use temporary directories and clean them up. No test should depend on the repository's `data/` directory or on an external service.

## Failure handling

When a check fails, inspect the first actual error, fix the implementation or test cause, and rerun the failed check. A passing build alone is not evidence that a search feature is correct.
