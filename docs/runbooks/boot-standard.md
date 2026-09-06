# Runbook — Boot `standard`

Goal: boot the STANDARD composition — the production-shaped core set: policy + observability + memory-policy + verifier (no router/benchmark).

## What this profile is

Composition source: `config/standard.cordis.yml`. Mounted plugins (insert blocks):

| Plugin | Config |
|---|---|
| `supreme-minimal-probe` | marker path `data/real/minimal-probe.markers.jsonl` |
| `supreme-boot-probe` | marker path `data/real/boot-probe-standard.markers.jsonl` |
| `supreme-policy` | `executionClass: STANDARD` |
| `supreme-observability` | `dataDir: <project>/dsh-supreme/data/observability` |
| `supreme-memory-policy` | `registerPromptSection: false`, one project-knowledge entry (`project-overview`, priority 60) |
| `supreme-verifier` | `allowedRoots: [<project>/dsh-supreme/data]` (commands disabled) |

## Command

```bash
node dsh-supreme/real/boot.mjs --profile standard --setup
```

## Expected result

- Exit code `0`; JSON output with:
  - `bootMs` ≈ **750–900 ms**, `disposeMs` ≈ **20–30 ms**, `disposeError: null`,
  - `services` → `true`: `llm`, `sessions`, `systemPrompt`, `tokenMeter`, `credentials`, `subagents`, `workflowEngine`, `supremePolicy`, `supremeObservability`, `supremeVerifier`, `supremeMemoryPolicy`;
    `false`: `supremeBenchmark`, `supremeRouter`, `supremeWorkflowPolicy`,
  - `gates`: the `BOOT_PROBE` marker line.
- Markers under `dsh-supreme/data/real/`:
  - `minimal-probe.markers.jsonl` — LOAD / OBSERVABLE_EFFECT / DISPOSE triple;
  - `boot-probe-standard.markers.jsonl` — `BOOT_PROBE` with the presence map above.
- Side effects: `dsh-supreme/data/observability/observability.jsonl` grows (observability is mounted; on dispose the writer queue is flushed).

```bash
tail -1 dsh-supreme/data/real/boot-probe-standard.markers.jsonl
tail -2 dsh-supreme/data/observability/observability.jsonl
```

## Failure triage

| Symptom | Likely cause |
|---|---|
| `supremeObservability: false` | dist stale — rebuild and `--setup` again |
| `PolicyConfigError` at boot | someone made policy config invalid (e.g. `allowPaid: true` outside LAB) — this failing loudly is correct; fix the config |
| verifier writes `UNAVAILABLE / COMMAND_EXECUTION_DISABLED` for command validators | expected: `allowCommands` is false in standard by design |
