# Benchmarking

## Current benchmark

The current command measures a local health-endpoint baseline:

```bash
npm run benchmark
SEARCHCRAFT_BENCHMARK_ITERATIONS=1000 npm run benchmark
```

It uses a temporary SQLite database and reports p50, p95, and p99 wall-clock request latency. The script performs real HTTP requests against a real SearchCraft process object, but it is not a search benchmark and its results must not be used as indexing or query claims.

## Planned search benchmark

The Phase 7 harness will generate deterministic documents and measure separate workloads:

- Indexing throughput by batch size.
- Single-term, multi-term, and no-result query latency.
- Cursor pagination latency.
- Restart/reload duration.
- Snapshot size and memory use.

Each report must record Node.js version, machine, dataset generator seed, document and field sizes, warm-up behavior, concurrency, iteration count, p50/p95/p99 methodology, and storage footprint. No target or result should be written before the workload and measurement are reproducible.
