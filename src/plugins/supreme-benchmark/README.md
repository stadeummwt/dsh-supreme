# supreme-benchmark

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeBenchmark`**

## Purpose

Records reproducible end-to-end task performance as **routing evidence** (never model training): tasks, runs, and quality scores in an append-only JSONL store, with in-process aggregation by provider+model. Storage preference honored: simple portable storage first — the store seam is abstract enough that a backend migration does not affect router logic.

## When to mount

- In compositions where routing evidence should accumulate: `supreme`, `lab`.
- Mount **before** `supreme-router` in composition order — the router consumes its aggregates.

## When NOT to mount

- `core` / `standard` intentionally omit it (no router there, so no consumer of the evidence).
- Never as a training-data pipeline or a general analytics warehouse: the schema is strictly task/run/score.

## Injected services

Exact names — the plugin declares **none**:

```ts
export const inject: string[] = [];
```

**Anti-cycle rule:** benchmark MUST NOT depend on the router. The router consumes benchmark history; the reverse edge is forbidden (enforced by review; documented in the adapter header and AGENTS.md).

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `dataDir` | string | `dsh-supreme/data/benchmark` | Store directory (resolved against cwd). |
| `fileName` | string | `benchmark.jsonl` | Append-only JSONL file. |
| `requireEvidenceForScores` | boolean | `false` | v1.3 anti-sandbagging: when `true`, quality-score claims without verifier-PASS evidence are flagged `evidenceBacked: false` (score record + its run) and audited (`unscored_evidence`, record id + reason label only — never the score value). Default `false` = behavior-preserving. |

## Public service contract (`supremeBenchmark`)

| Method | Returns | Description |
|---|---|---|
| `recordTask({ taskId, category, description? })` | `Promise<string>` | Registers a benchmark task; returns its `taskId`. |
| `startRun({ taskId, taskCategory, provider, model, profile, sessionId? })` | `Promise<string>` | Opens a run (`runId` generated, schemaVersion 1); returns the id. |
| `finishRun(runId, outcome)` | `Promise<BenchmarkRun \| undefined>` | Closes a run with success/latency/usage/tool counts/failure class/verification; `undefined` for unknown runId. |
| `recordScore({ runId, qualityScore, validatorId? })` | `Promise<void>` | Attaches a quality score in `[0,1]` (throws outside bounds). With `requireEvidenceForScores: true`, the score + run also carry `evidenceBacked` (`true` iff the scored run has `verification.status === 'PASS'`); an unbacked claim additionally emits the `unscored_evidence` audit event (optional `ctx.get('supremeObservability')` seam). |
| `queryHistory(filter?)` | `BenchmarkRun[]` | Finished runs filtered by provider/model/taskId/success, newest first. |
| `aggregateModelPerformance()` | `ModelPerformance[]` | Per `provider::model`: samples, success rate, avg quality/latency, failure breakdown — plus v1.3 `scoredSamples` (samples carrying a quality claim) and `evidenceBackedScores` (claims backed by verifier-PASS evidence), which the router's anti-sandbagging downweight consumes. |
| `stats()` | `{ tasks, runs, scores, corruptLines }` | Store counters; corrupt JSONL lines are counted, never fatal. |

Record kinds (`schemaVersion: 1`): `task`, `run`, `score`. `failureClass` is one of 16 bounded classes (`AUTH`, `RATE_LIMIT`, `QUOTA`, `TIMEOUT`, `NETWORK`, `SERVER`, `INVALID_MODEL`, `INVALID_SCHEMA`, `WRONG_TOOL`, `TOOL_EXECUTION`, `WRONG_ANSWER`, `FORMAT`, `CONTEXT`, `COST_POLICY`, `VERIFICATION`, `UNKNOWN`).

## Security boundary

- Records are secret-free by construction: no prompt/response payloads, no credentials — only ids, classes, counts, timings, and scores, validated by `validateBenchmarkRecord` before indexing.
- Every write is validated deterministically; unparseable lines on load are skipped and counted (`corruptLines`), never fatal.
- Disk writes fail open (in-memory evidence retained; the write is dropped). The flush effect drains the write queue on unload.

## Data retained

- `dsh-supreme/data/benchmark/benchmark.jsonl` — one JSON object per line: `task` (`taskId`, `category`, `description?`, `createdAt`), `run` (`runId`, `taskId`, `taskCategory`, `sessionId?`, `provider`, `model`, `profile`, `startedAt`, `finishedAt?`, `latencyMs?`, `ttftMs?`, `usageIn?`, `usageOut?`, `toolCount?`, `subagentCount?`, `workflowCount?`, `success?`, `qualityScore?`, `failureClass?`, `verification?`, `evidenceBacked?`), `score` (`runId`, `qualityScore`, `validatorId?`, `scoredAt`, `evidenceBacked?`). `evidenceBacked` is written only when `requireEvidenceForScores` is enabled and re-evaluates when final verification lands (last-write-wins).
- Replay semantics: **last write wins per `runId`/`taskId`** when the log is re-indexed.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections, no events consumed.

## Limitations

- Single-process, in-process aggregation; no cross-process locking on the JSONL file.
- `ttftMs` is part of the schema but not populated by current gate flows.
- History load happens once at apply (`init()`); records appended by other processes after boot are not re-read.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: benchmark.* (5 checks)
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: benchmark_stores_evidence
node dsh-supreme/real/boot.mjs --profile lab --setup
bun dsh-supreme/real/v13-routing-verify.mjs              # v1.3 E2E: evidence-backed flag + unscored_evidence audit (V13_ROUTING_E2E_COMPLETE)
```
