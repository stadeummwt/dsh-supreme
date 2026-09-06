# Runbook — Boot `lab`

Goal: boot the LAB composition — the full suite plus **LAB-only overrides**, used for verbose diagnostics and testing. Structurally distinct from production: `allowPaid: true` is legal **only here**.

## What this profile is

Composition source: `config/lab.cordis.yml`. Differences from `supreme` (everything else identical):

| Plugin | LAB override |
|---|---|
| `supreme-policy` | `executionClass: LAB` **and `allowPaid: true`** — the only composition where this is valid; `validatePolicyConfig` rejects it anywhere else |
| `supreme-verifier` | `allowCommands: true` — command-exit / test-suite validators unlock (dual gate: config + LAB policy) |
| `supreme-workflow-policy` | `maxConcurrentAgents: 4` (schema range 1–8) |
| `supreme-memory-policy` | LAB knowledge entry (`lab-overview`, priority 70) |
| `supreme-gate-driver` | marker path `data/real/gates-lab.markers.jsonl` |

`supreme-fake-llm` remains mounted (test-only adapter, LAB-legal by definition).

## Command

```bash
node dsh-supreme/real/boot.mjs --profile lab --setup
```

## Expected result

- Exit code `0`; JSON output with:
  - `bootMs` ≈ **750–900 ms**, `disposeMs` ≈ **20–30 ms**, `disposeError: null`,
  - `services`: all 7 DSH core names and all 7 `supreme*` names `true`,
  - `gates`: the `SUPREME_GATES` entry with **9/9 PASS** — note the LAB-specific detail in the first gate: `policy_loads_and_gates_cost … free=true paid=true (labOnly=true) unknown=false` (paid allowed *because* executionClass=LAB; UNKNOWN still hard-denied),
  - remaining gates as in `supreme` (router selects the free route — latest markers `score=0.8125` — and still rejects the paid *candidate* from selection via `policy_cost` in this scenario, verifier exact=PASS/schema=PASS, memory within budget, workflow limits held, observability `written=7 dropped=0`).
- Markers under `dsh-supreme/data/real/`:
  - `minimal-probe.markers.jsonl` — LOAD / OBSERVABLE_EFFECT / DISPOSE triple;
  - `gates-lab.markers.jsonl` — one `SUPREME_GATES` line per run with the 9 gate results.

## LAB rules (do not violate)

- LAB is **structurally separate** from production compositions: never merge `allowPaid`, `allowCommands`, or the fake adapter into `core` / `standard` / `supreme`. The suite's `productionConfigAllowsPaid()` scan blocks release if `allowPaid: true` appears in any of those three files.
- `supreme-fake-llm` is a fixture: it must never be mounted outside LAB.
- Paid being *allowed* in LAB means the policy gate would admit a paid route; it does not mean paid routes are used — the scenario's router gate still demonstrates cost gating on the paid candidate.

## Failure triage

| Symptom | Likely cause |
|---|---|
| boot fails with `PolicyConfigError` | `allowPaid: true` copied into a non-LAB profile — move it back to lab |
| `workflow_respects_limits` FAIL | limits config out of schema range (e.g. concurrency > 8) — `validateWorkflowLimits` threw at apply |
| command validators return `UNAVAILABLE / COMMAND_EXECUTION_DISABLED` | `allowCommands` false or policy not LAB — both must hold; in lab both hold by default |
