# supreme-observability

Cordis adapter: `index.ts` · Engine: `engine.ts` · Event map: `event-map.ts` · Service: **`supremeObservability`**

## Purpose

Durable, safe operational metadata for DSH sessions: subscribes to the **official DSH event seams** and appends allowlisted, secret-scrubbed records to an append-only JSONL file. DSH sessions remain the runtime source of truth; this store holds derived operational metadata only (no second session database).

## When to mount

- In any composition where an operational record is wanted: `standard`, `supreme`, `lab`.
- The router and workflow-policy record through it (route decisions, workflow decisions); the verifier optionally writes verification results. Mount it before/with those plugins so their records land.

## When NOT to mount

- `core` composition intentionally mounts it (clean baseline) — do not add it where a *zero-write* guarantee is required; instead set `enabled: false`, which makes the plugin a complete no-op (no writer, no file).
- Not a metrics/time-series backend and not a session store: no aggregation queries, no payload replay.

## Injected services

Exact names — the plugin declares **none**; all consumption is via official events (`ctx.on`):

```ts
export const inject: string[] = [];
```

Subscribed bus events (names verified against the pin; see `event-map.ts`):
`session/created`, `session/disposed`, `session/event` (log types: `turn/start|end`, `step/start|end`, `tool/call`, `tool/result`, `assistant/message`, `request/context`, `compaction/start|end`), `agent/request` (waterfall), `agent/request-error` (waterfall), `tools/execute` (waterfall), `subagent/start`, `subagent/end`, `workflow/start`, `workflow/end`.

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` ⇒ complete no-op. |
| `dataDir` | string | `dsh-supreme/data/observability` | Directory for the JSONL file (resolved against cwd). |
| `fileName` | string | `observability.jsonl` | Rotates to `fileName + '.1'`. |
| `maxFileBytes` | integer ≥ 10 000 | `5 000 000` | Size-based rotation threshold. |
| `maxLineChars` | integer ≥ 256 | `2048` | Hard per-record serialization bound (deterministic truncation). |

## Public service contract (`supremeObservability`)

| Method | Returns | Description |
|---|---|---|
| `isEnabled()` | boolean | Whether the file writer is active (not no-op mode). |
| `record(event, fields)` | void | Records an already-safe, allowlisted event (host-side use, e.g. router). |
| `stats()` | `{ written, dropped, rotations, seq }` | Writer counters including fail-open drops. |
| `recent(count)` | `Promise<SafeRecord[]>` | Reads the last `count` records for dashboard projection (corrupt tail lines skipped). |

Record fields are allowlisted by `RECORD_FIELDS` (25 entries: `seq`, `ts`, `event`, `sessionId`, `turn`, `step`, `provider`, `model`, `latencyMs`, `ttftMs`, `tool`, `toolError`, `subagent`, `workflow`, `compaction`, `tokenPressure`, `usageIn`, `usageOut`, `errorClass`, `verificationId`, `verificationStatus`, `routeDecisionId`, `benchmarkRunId`, `workflowDecisionId`, `detail`). Unknown fields are never serialized.

## Security boundary

- **Metadata allowlisting only** — never serializes payloads, tool arguments, prompts, responses, credentials, or environment values (`tool/call` deliberately drops `event.arguments`; `assistant/message` records usage counts only).
- **Sentinel scrub:** every string field is scrubbed of `SECRET_SENTINEL[A-Z0-9_]*` → `[REDACTED]` before serialization, and bounded to 256 chars per field / `maxLineChars` per line.
- **Fail-open:** fs failures are captured into `stats.dropped` / `lastWriteError`; the agent is never crashed by a write. Dispose flushes the writer queue and warns about drops.
- Every `ctx.on` registration is a Cordis effect and unwinds on unload; waterfall handlers always call `next()` exactly once and pass results through unchanged (pure observation).

## Data retained

- `dsh-supreme/data/observability/observability.jsonl` (append-only; rotated to `observability.jsonl.1` at `maxFileBytes`).
- Per line: one `SafeRecord` — allowlisted metadata fields only, as above.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections. Model traffic is observed strictly through events, content-free.

## Limitations

- `latency` is recorded for LLM requests/tool executions, but there is no TTFT capture in v1 (field exists, unused by current handlers).
- Rotation keeps a single previous file (`.1`); there is no retention policy beyond that.
- `recent()` reads only the active file; rotated history is not queryable through the service.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: observability.* (5 checks)
node dsh-supreme/real/boot.mjs --profile standard --setup
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: observability_records_safely (written=7 dropped=0)
bun run dsh-supreme/src/suite/cli.ts                     # full suite: sentinel leaks must remain 0
```
