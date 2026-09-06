# supreme-router

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeRouter`**

## Purpose

Deterministic model-route selection over **config-owned candidates**: run hard gates first, then normalized weighted scoring over eligible candidates. The router *selects*; it never performs provider HTTP — actual execution stays with the official DSH LLM adapters (`ctx.llm.stream` / `agent/request` waterfall).

## When to mount

- In compositions that need model selection: `supreme`, `lab`.
- Mount **after** policy, observability, and benchmark (it injects all three plus `llm`).

## When NOT to mount

- `core` / `standard` (no selection requirement there).
- Never as an executor, retry engine, or proxy: it owns no request path.
- Never with paid candidates expected to serve production traffic — paid candidates fail the `policy_cost` gate unless the mounted policy is LAB, and the router **never relaxes gates or falls back to paid** on its own.

## Injected services

Exact names:

```ts
export const inject = ['llm', 'supremePolicy', 'supremeObservability', 'supremeBenchmark'];
```

`ctx.llm` is consumed through a structural view of the pinned `LlmRuntime`: `listProviders()` (returns `LlmProviderInfo = { id, name }`) and `resolveModelInfo(provider, model)` (throws on invalid models — used as the `model_valid` gate evidence). Credential checks in `credentialMode: 'service'` consult `ctx.get('credentials')` optionally and fail closed.

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `candidates` | array of provider entries | `[]` | The entire candidate universe — config-owned. |
| `candidates[].provider` | string ≥ 1 | — | Provider id. |
| `candidates[].credentialMode` | `config-owned \| service` | `service` | `config-owned` trusts `credentialConfigured` (synthetic/test rigs). |
| `candidates[].credentialConfigured` | boolean | `false` | Used when `credentialMode: config-owned`. |
| `candidates[].credentialRef` | string (optional) | — | Credential reference for `service` mode. |
| `candidates[].quotaHeadroom` | number 0–1 | `0.5` | Shared per provider entry. |
| `candidates[].models[]` | array ≥ 1 | — | `{ model, costClass (default UNKNOWN), capabilities (default []), contextWindow (default 0), failureDomain (default 'default') }`. |
| `weights` | object | `quality 0.3 · health 0.2 · quota 0.15 · reliability 0.1 · latency 0.1 · capabilityFit 0.1 · diversity 0.05` | Normalized to sum 1 before scoring. |
| `minBenchmarkSamples` | integer ≥ 1 | `5` | Exploration threshold before history is trusted. |
| `latencyCeilingMs` | integer ≥ 100 | `30 000` | Ceiling constant (v1 scoring uses a conservative latency value of 0.5). |
| `minQuotaHeadroom` | number 0–1 | `0.05` | Hard gate threshold. |
| `circuit.failureThreshold` | integer ≥ 1 | `3` | Failures inside the window that open the breaker. |
| `circuit.windowMs` | integer ≥ 1000 | `300 000` | Failure/success window. |
| `circuit.cooldownMs` | integer ≥ 0 | `60 000` | Open-state cooldown. |

## Public service contract (`supremeRouter`)

| Method | Returns | Description |
|---|---|---|
| `route(input)` | `Promise<RouteDecision>` | Runs all 8 hard gates per candidate, scores eligible ones, returns best + up to 3 alternatives (or `BLOCKED_NO_ELIGIBLE_ROUTE`). Records a `route_decision` observability event. |
| `recordOutcome({ provider, model, success, failureClass? })` | void | Feeds the circuit breaker (success clears, failures accumulate). |
| `healthSnapshot()` | array | Per candidate key: `{ key, state, recentFailures }` circuit state. |
| `config()` | `RouterConfig` | Effective, normalized configuration. |

Hard gates, in order: `policy_cost` (only FREE_CONFIRMED / FREE_LIMITED pass locally), `provider_available` (live catalog), `credential_available` (fail-closed), `model_valid` (live resolution), `capability_fit`, `context_sufficient`, `health_ok` (circuit not open), `quota_ok`.

Decision semantics: candidates below `minBenchmarkSamples` score quality at the neutral 0.5 exploration default and flag `degraded: true` (+ `EXPLORATION_NO_HISTORY`); unknown inputs receive conservative values; when nothing is eligible the decision is `blocked: 'BLOCKED_NO_ELIGIBLE_ROUTE'` with `GATE_FAILED:<candidate>:<gate>` reason codes — **never** a relaxed-gate fallback and **never** a paid fallback.

## Security boundary

- Cost admission is enforced locally (`policy_cost`) even if the policy service were bypassed; UNKNOWN cost classes cannot pass.
- Credential state is fail-closed: unusable seam, missing ref, or errored `describe()` ⇒ ineligible.
- Model validity is verified against the live `ctx.llm` resolution, not assumed from config.
- No provider HTTP, no credential values read, no retry storms — one decision per `route()` call, recorded to observability.

## Data retained

None of its own. It writes `route_decision` events (id, provider, model, score/blocked-gate-count `detail`) into the observability store and reads benchmark aggregates. Circuit state is in-memory only.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections.

## Limitations

- Latency scoring is a fixed conservative 0.5 in v1 (no live latency sampling); `latencyCeilingMs` exists for future use.
- Candidate metadata (cost class, capabilities, quota headroom) is **config-owned** — stale config yields stale gating.
- Circuit state and exploration flags reset on process restart.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: router.* (10 checks incl. paid rejection, circuit transitions, exploration)
node dsh-supreme/real/boot.mjs --profile supreme --setup # gates: router_selects_eligible + router_rejects_paid
node dsh-supreme/real/boot.mjs --profile lab --setup
bun run dsh-supreme/src/suite/cli.ts                     # perf: router ~0.02 ms / 1k iterations (8 candidates)
```
