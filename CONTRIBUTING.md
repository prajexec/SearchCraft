# Contributing to SearchCraft

## Development workflow

1. Use Node.js 22.x and npm.
2. Read the relevant project plan and architecture documents before changing a subsystem.
3. Keep local runtime data under `data/`; never commit databases, segments, snapshots, logs, or generated benchmark output.
4. Make one focused change at a time.
5. Add tests for normal behavior and relevant invalid or failure paths.
6. Update the API specification, documentation, diagrams, and changelog when behavior changes.
7. Run the smallest relevant checks during development and the full baseline checks before a phase commit.
8. Inspect `git diff` and `git status` before committing.

## Code standards

- Use strict TypeScript and explicit domain types.
- Keep HTTP, persistence, indexing, query, maintenance, and observability boundaries clear.
- Use parameterized SQLite statements.
- Avoid unbounded in-memory collections and unbounded logs or caches.
- Do not hide errors or weaken tests to make a check pass.
- Do not claim a feature is implemented until its real behavior and checks exist.
- Record significant architectural decisions in `docs/decisions/`.

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run docs:check
npm run build
```

## Commits

Use small Conventional Commit-style messages such as:

- `chore: initialize lightweight TypeScript project`
- `docs: add architecture overview`
- `feat: implement durable indexing jobs`
- `test: add stale job recovery coverage`

Do not amend or rewrite existing commits unless explicitly requested.
