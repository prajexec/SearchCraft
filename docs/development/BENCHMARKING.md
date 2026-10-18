# Benchmarking

## Phase 7 benchmark

Run the reproducible local indexing and BM25 workload with:

```bash
npm run benchmark
```

The benchmark uses only the repository's Node.js 22-compatible stack and native APIs. It creates a temporary isolated SQLite/index directory, creates a real index through the application API, and sends deterministic NDJSON documents through the real synchronous bulk endpoint. Each configured batch size gets a fresh index fixture. No indexing worker is started, and the segment compaction threshold is set to `Number.MAX_SAFE_INTEGER` for the workload so background compaction does not change a timed request.

The benchmark emits one JSON result line on stdout. Invalid settings and every non-2xx application response fail the command with an error on stderr and a non-zero exit status.

## Workload controls

All benchmark controls are optional and must be positive safe integers. `SEARCHCRAFT_BENCHMARK_BATCH_SIZES` is a comma-separated list; empty entries and duplicate batch sizes are rejected.

| Environment variable                | Default        | Meaning                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------ |
| `SEARCHCRAFT_BENCHMARK_DOCUMENTS`   | `10000`        | Number of deterministic documents indexed in each batch-size run.  |
| `SEARCHCRAFT_BENCHMARK_BATCH_SIZES` | `100,500,1000` | Sequential synchronous bulk operation counts to compare.           |
| `SEARCHCRAFT_BENCHMARK_QUERIES`     | `100`          | Number of sequential search requests used for latency percentiles. |

For example, a small smoke workload is:

```bash
SEARCHCRAFT_BENCHMARK_DOCUMENTS=100 SEARCHCRAFT_BENCHMARK_BATCH_SIZES=10,25 SEARCHCRAFT_BENCHMARK_QUERIES=20 npm run benchmark
```

Documents and queries are generated from the fixed seed `phase-7-deterministic-v1`. The search run uses the largest configured batch size, a search limit of 10, and cycles through the fixed BM25 queries `searchcraft benchmark`, `deterministic document`, `category searchcraft`, and `workload document`. Document generation, index creation, and temporary-fixture setup are not included in indexing timings. Each bulk request is timed from just before the HTTP request until its JSON response is consumed.

## Output fields

The JSON object contains:

- `benchmark`, `version`, and `nodeVersion`: result identity and runtime metadata.
- `workload`: seed, document count, batch sizes, query count, search batch size, search limit, synchronous mode, compaction threshold, and warm-up count.
- `indexing`: one entry per batch size with `batchSize`, `batches`, `documents`, `durationMs`, and `documentsPerSecond`.
- `searchLatencyMs`: `queries`, `p50Ms`, `p95Ms`, and `p99Ms` for the BM25 search requests.

The percentile calculation uses the nearest-rank position `ceil(percentile * sampleCount)`. The throughput value is `documents / (sum of timed bulk-request durations in seconds)`.

## Interpretation limits

These are local, sequential, single-process measurements. They include loopback HTTP and response parsing overhead, and they do not represent concurrent production traffic, a remote client, a warmed-up process, or a compacted index. Search latency is measured on the largest-batch fixture without compaction, so changing batch sizes also changes the number of immutable segments seen by search. Results are machine-, Node.js-, filesystem-, and load-dependent; the deterministic workload makes runs comparable but cannot make wall-clock timings identical. This document records the harness and its limits, not an unrun performance claim.
