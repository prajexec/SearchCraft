# ADR-0001: Lightweight single-process architecture

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decision owners:** SearchCraft maintainers

## Context

SearchCraft must demonstrate search-engine internals while remaining comfortable to develop and test on an Apple Silicon MacBook Air with 8 GB of unified memory and 256 GB of storage. The first implementation must not require OpenSearch, PostgreSQL, Redis, Kafka, RabbitMQ, Kubernetes, or a container runtime.

The project also needs durable source-document state, an indexing queue, explicit migrations, and a custom disk-backed inverted index. A solution that stores everything in memory would make restart behavior and failure semantics difficult to demonstrate. A solution that delegates indexing to an external search engine would not meet the project goal.

## Decision

Use a Node.js 22 modular monolith written in strict TypeScript:

- Node's built-in `node:http` for the HTTP server.
- Node's built-in `node:sqlite` for metadata, documents, migrations, and the durable job queue.
- A custom TypeScript indexing engine for tokenization, posting lists, BM25, immutable segments, manifests, and generations.
- One worker loop initially, with bounded queues and batch limits.
- Atomic filesystem publication patterns for segments and manifests.
- Node's built-in test runner and assertions.
- Minimal development-only tooling for TypeScript, linting, and formatting.

## Consequences

### Positive

- No service dependency is required for local development.
- The storage and ranking mechanisms remain inspectable in the repository.
- SQLite provides transactions and restartable durable state without a database server.
- Native Node APIs reduce dependency count and memory overhead.
- A modular monolith keeps failure and consistency boundaries understandable.

### Negative and accepted limitations

- A single worker limits indexing throughput and is not a distributed solution.
- SQLite and filesystem writes do not share one atomic transaction; staging files, validation, and recovery logic are required.
- The first index format will favor clarity and bounded behavior over aggressive compression.
- A small custom index will not match the scale, language analysis, or operational tooling of OpenSearch.
- Node's built-in SQLite API is tied to the supported Node runtime and must be checked during setup.

## Alternatives considered

### PostgreSQL plus a custom index

Not selected for the initial implementation. A server process or container adds setup and resource cost without improving the educational value of the first local slice. PostgreSQL can be evaluated later behind a storage boundary if measured requirements justify it.

### OpenSearch or Elasticsearch

Not selected because the central goal is to implement and explain SearchCraft's own indexing and ranking pipeline. It would also be unnecessarily heavy for the target laptop.

### Go

Go is a reasonable future implementation language, but it is not installed in the current environment. Node.js 22 already provides the required runtime primitives and keeps the first setup reproducible.

## Revisit triggers

Reconsider the architecture only when measured evidence shows one of these conditions:

- SQLite transaction contention materially limits accepted durable writes.
- The custom segment reader cannot meet documented latency or memory bounds for the intended dataset sizes.
- Multiple independent worker processes are required for a real deployment.
- Snapshot or recovery requirements exceed the local filesystem model.

Any change must be recorded in a new or superseding ADR and supported by benchmark evidence.
