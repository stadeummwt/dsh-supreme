# ADR-0002: Observability storage — append-only JSONL + allowlist + sentinel scrub + fail-open

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

`supremeObservability` needs durable operational metadata (sessions, turns, tools, LLM requests, subagents, workflows, compaction) with three hard constraints from the spec:

- **never** become a second session database (DSH `ctx.sessions` stays canonical);
- **never** leak secrets, payloads, prompts, or credentials into artifacts;
- **never** take the agent down — telemetry must fail open.

The storage choice had to work inside the host process with zero external services and zero configuration burden.

## DECISION

1. **Append-only JSONL** at `dsh-supreme/data/observability/observability.jsonl` (configurable), size-based rotation to `.1` at `maxFileBytes` (default 5 MB), per-line bound `maxLineChars` (default 2048) with deterministic truncation.
2. **Field allowlist:** `RECORD_FIELDS` (25 fixed fields: `seq`, `ts`, `event`, `sessionId`, `turn`, `step`, `provider`, `model`, `latencyMs`, `ttftMs`, `tool`, `toolError`, `subagent`, `workflow`, `compaction`, `tokenPressure`, `usageIn`, `usageOut`, `errorClass`, `verificationId`, `verificationStatus`, `routeDecisionId`, `benchmarkRunId`, `workflowDecisionId`, `detail`). `buildRecord` copies **only** these; unknown fields can never be serialized. Values are bounded (strings ≤ 256 chars; finite numbers; booleans).
3. **Sentinel scrub (defense in depth):** every string field is scrubbed of `/SECRET_SENTINEL[A-Z0-9_]*/ → '[REDACTED]'` **before** the allowlist copy — even allowlisted fields are scrubbed, because the sentinel guarantees absence in artifacts.
4. **Fail-open:** `JsonlWriter` chains writes through a serialized queue; any fs error is captured into `stats.dropped` / `lastWriteError` and the record is dropped. The writer never throws into the event path; dispose flushes the queue.
5. Event names consumed over official seams are centralized in `event-map.ts` with per-name source citations in the pinned upstream.

## EVIDENCE

- Engine: `src/plugins/supreme-observability/engine.ts` (`RECORD_FIELDS`, `buildRecord`, `serializeRecord`, `JsonlWriter`, `readRecent`, `SECRET_SENTINEL`).
- Adapter: `src/plugins/supreme-observability/index.ts` (subscription set, no-op mode when `enabled: false`, flush effect on unload).
- Event names verified against the pin — see `event-map.ts` table (`session/*` in `packages/core/session/src/index.ts`, `agent/request*` in `packages/core/agent/src/runtime-types.ts`, `tools/execute` in `packages/core/tools/src/index.ts`, `subagent/*`, `workflow/*`).
- Level-A checks: `observability.allowlist-only`, `observability.sentinel-scrubbed`, `observability.writer-fails-open`, `observability.disabled-noop`, `observability.order-deterministic` (all PASS, 5/5).
- Real boots: gate `observability_records_safely` — `written=7 dropped=0` in every supreme/lab run (`dsh-supreme/data/real/gates-{supreme,lab}.markers.jsonl`); sentinel leak scan over `dsh-supreme/data` = `0`.
- Performance: serialize ~0.003 ms / 1k iterations (suite `measurePerformance`).

## ALTERNATIVES

- **SQLite / embedded DB.** Rejected for v1: adds a native dependency and a second query surface for what is an append-only audit trail; violates "simple portable storage first".
- **NDJSON via stdout / external collector.** Rejected: couples telemetry to an out-of-process collector and risks losing records when no collector exists.
- **Full payload logging with redaction filters.** Rejected outright: redaction of arbitrary payloads is undecidable; the allowlist makes leakage structurally impossible instead of probabilistically unlikely.
- **Per-event schema validation.** Rejected: the allowlist + bounded types already guarantee shape; schemas would add cost on the hot path.

## CONSEQUENCES

- Positive: grep-able, portable artifacts; provable secret absence; telemetry cannot harm the agent; deterministic order (monotonic `seq`).
- Negative: no queries beyond `recent(count)`; rotation keeps one previous file; rotated history is not queryable via the service.
- Neutral: consumers wanting richer analytics must post-process the JSONL out of band.

## ROLLBACK

Set `enabled: false` in any composition to make the plugin a complete no-op (verified by `observability.disabled-noop`). To remove the plugin entirely, drop its insert block from the composition; router/workflow-policy record calls must then be removed or guarded (they treat observability as an injected service, so `standard`-style compositions without observability must not mount the router). Artifacts already written remain valid JSONL and can be archived or deleted freely.
