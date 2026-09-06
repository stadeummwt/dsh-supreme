# Runbook — Boot `supreme`

Goal: boot the SUPREME composition — the complete seven-plugin suite plus the keyless synthetic end-to-end scenario (9 gates).

## What this profile is

Composition source: `config/supreme.cordis.yml`. Mounted plugins (insert blocks, in order):

| Plugin | Config |
|---|---|
| `supreme-policy` | `executionClass: SUPREME` (paid denied) |
| `supreme-observability` | `dataDir: <project>/dsh-supreme/data/observability` |
| `supreme-benchmark` | `dataDir: <project>/dsh-supreme/data/benchmark` |
| `supreme-fake-llm` | LAB-fixture adapter registering `synthetic-free` through the official `ctx.llm.registerAdapter()` seam |
| `supreme-router` | two config-owned candidates: `synthetic-free/synthetic-mini` (FREE_CONFIRMED, capabilities `[chat]`, contextWindow 32768, quota 0.95) and `synthetic-paid/synthetic-paid-large` (PAID) — both `credentialMode: config-owned` |
| `supreme-verifier` | `allowedRoots: [<project>/dsh-supreme/data]`, commands disabled |
| `supreme-memory-policy` | `registerPromptSection: false`, `project-overview` entry |
| `supreme-workflow-policy` | defaults (`{}`) — maxConcurrent 3 / maxTotal 12 / maxDepth 2 |
| `supreme-gate-driver` | marker path `data/real/gates-supreme.markers.jsonl` (mounted LAST) |

The `deepseek` synthetic candidate is validated against the **live** llm catalog (provider + model resolution); credential/cost metadata is a documented synthetic assumption (`credentialMode: config-owned`). Remove `supreme-fake-llm` and configure real providers for production use.

## Command

```bash
node dsh-supreme/real/boot.mjs --profile supreme --setup
```

## Expected result

- Exit code `0`; JSON output with:
  - `bootMs` ≈ **750–900 ms**, `disposeMs` ≈ **20–30 ms**, `disposeError: null`,
  - `services`: all 7 DSH core names and all 7 `supreme*` names `true`,
  - `gates`: the `SUPREME_GATES` entry with **9/9 PASS**:
    `policy_loads_and_gates_cost` (free=true, paid=false, unknown=false) ·
    `session_canonical` (a real DSH session created via `ctx.sessions`) ·
    `benchmark_stores_evidence` · `router_selects_eligible` (synthetic free route selected; latest markers record `score=0.8125`) ·
    `router_rejects_paid` (paid candidate fails `policy_cost` with `COST_PAID_DENIED`) ·
    `verifier_executes` (exact=PASS, schema=PASS) ·
    `memory_respects_budget` (used ≤ 400 tokens) ·
    `workflow_respects_limits` (simple=DIRECT, saturated=DIRECT) ·
    `observability_records_safely` (`written=7 dropped=0`).
- Markers under `dsh-supreme/data/real/`:
  - `minimal-probe.markers.jsonl` — LOAD / OBSERVABLE_EFFECT / DISPOSE triple;
  - `gates-supreme.markers.jsonl` — one `SUPREME_GATES` line per run with the 9 gate results.

## Failure triage

| Symptom | Likely cause |
|---|---|
| `router_selects_eligible` FAIL with `GATE_FAILED:*` | dist stale, or the synthetic adapter/candidates were removed — check `config/supreme.cordis.yml` |
| `session_canonical` ERROR | upstream sessions seam changed — verify the pin is intact before investigating plugin code |
| `observability_records_safely` FAIL (`dropped > 0`) | filesystem permissions on `data/observability` — writer failed open by design; fix the directory, not the plugin |
| any gate ERROR with `String(err)` detail | plugin threw inside the scenario — re-run the suite's Level A for the isolated engine check |
