# ADR-0003: Benchmark storage — JSONL store with last-write-wins per runId, abstract store seam

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

`supremeBenchmark` records reproducible end-to-end task performance as **routing evidence** (never model training): tasks, runs, and quality scores. The router consumes per-model aggregates (success rate, average quality, sample counts). Requirements: durable across restarts, secret-free by construction, tolerant of corrupt input, and structurally simple enough that the storage backend can change without touching router logic.

## DECISION

1. **Append-only JSONL store** at `dsh-supreme/data/benchmark/benchmark.jsonl` (configurable via `dataDir`/`fileName`). Every mutation (`recordTask`, `startRun`, `finishRun`, `recordScore`) appends one validated record line through a serialized write queue; `flush()` drains on unload.
2. **Last-write-wins replay per key:** on `init()` the file is replayed and indexed into in-memory maps — tasks keyed by `taskId`, runs keyed by `runId` (later records replace earlier ones, so a `finishRun` line supersedes its `startRun` line); scores append. Corrupt lines are counted (`corruptLines`) and skipped, never fatal.
3. **Deterministic record validation** (`validateBenchmarkRecord`): `schemaVersion: 1`, `kind ∈ {task, run, score}`, required fields per kind, `qualityScore ∈ [0,1]`, `failureClass` restricted to the 16-value bounded enum.
4. **Abstract store seam:** the engine exposes `BenchmarkStore` over a minimal `BenchmarkFs` interface (`readFile` / `appendFile` / `mkdir`). The router consumes only the service's aggregate/query methods — a backend migration (e.g. SQLite) replaces the fs implementation without touching router logic.
5. **Anti-cycle rule:** benchmark MUST NOT depend on the router; the dependency edge is router → benchmark only.

## EVIDENCE

- Engine: `src/plugins/supreme-benchmark/engine.ts` (`BenchmarkStore.init` replay + `indexRecord` last-write-wins, `persist` fail-open queue, `aggregateRuns` grouping by `provider::model`).
- Adapter: `src/plugins/supreme-benchmark/index.ts` — header states the anti-cycle rule; `await ready` on every call ensures the initial replay completes before use.
- Level-A checks (5/5 PASS): `benchmark.roundtrip` (store + JSONL roundtrip), `benchmark.corrupt-lines-skipped`, `benchmark.validation-bounds`, `benchmark.aggregation`, `benchmark.empty-history`.
- Real boot: gate `benchmark_stores_evidence` PASS in every supreme/lab run — the store records task/run/score and the aggregate reflects it (`dsh-supreme/data/real/gates-{supreme,lab}.markers.jsonl`); real artifacts accumulate at `dsh-supreme/data/benchmark/benchmark.jsonl`.

## ALTERNATIVES

- **SQLite.** Rejected for v1: the evidence volume is tiny; a query engine adds native dependencies and migration concerns for no current benefit. The seam keeps the door open.
- **In-memory only.** Rejected: routing evidence must survive restarts to be useful for exploration/trust decisions.
- **Rewrite-in-place JSON (mutable document).** Rejected: append-only logs are crash-safer and diff-able; last-write-wins replay gives the same semantics without rewriting files.
- **Per-run files under a directory tree.** Rejected: complicates aggregation and archival; a single stream keeps ordering evident.

## CONSEQUENCES

- Positive: portable, human-readable evidence; restart-safe; corrupt-tolerant; backend-swappable; router decoupled.
- Negative: file grows unboundedly with recorded runs (no retention/compaction in v1); single-process semantics — concurrent writers from multiple processes could interleave lines.
- Neutral: replay time grows with history; acceptable at current scale (marker evidence shows single-digit runs per scenario).

## ROLLBACK

Remove the `supreme-benchmark` insert block from a composition to unmount it; `supreme-router` injects it, so router-bearing compositions would need the benchmark retained or the router removed. The store seam means a storage rollback (JSONL → future backend → JSONL) is a filesystem-implementation swap; existing `benchmark.jsonl` files remain valid archives either way.
