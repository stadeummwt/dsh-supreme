# ADR-0004: Router scoring — config-owned candidates, hard gates then 30/20/15/10/10/10/5, exploration, circuit breaker, no paid fallback

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

The router must pick a provider/model per task from a candidate set, with safety as the first property: missing metadata must never become permission, unhealthy routes must never be selected, and cost policy must be enforced even under failure of other services. It must also degrade gracefully when it has no evidence (fresh deployment) and must never improvise an expensive fallback.

## DECISION

1. **Config-owned candidates.** The entire candidate universe is declared in the composition config (`candidates[]` with provider, credential mode/ref, quota headroom, per-model cost class, capabilities, context window, failure domain). The router never discovers candidates from the live catalog — it verifies them against it.
2. **Hard gates first, all gates evaluated for evidence.** Eight gates run for every candidate (results preserved even for already-disqualified candidates): `policy_cost` (locally: only `FREE_CONFIRMED` / `FREE_LIMITED` pass), `provider_available` (live `ctx.llm.listProviders()`), `credential_available` (fail-closed), `model_valid` (live `ctx.llm.resolveModelInfo()`), `capability_fit`, `context_sufficient`, `health_ok` (circuit not open), `quota_ok` (headroom ≥ `minQuotaHeadroom`, default 0.05).
3. **Normalized weighted scoring** over eligible candidates with default weights **30/20/15/10/10/10/5** (`quality .30`, `health .20`, `quota .15`, `reliability .10`, `latency .10`, `capabilityFit .10`, `diversity .05`). Weights are config-owned, normalized to sum 1 before use; ties break by candidate key for determinism. `latency` scores a conservative constant 0.5 in v1.
4. **Exploration until min samples.** Candidates with fewer than `minBenchmarkSamples` (default 5) benchmark samples score quality at the neutral 0.5 default, flag the decision `degraded: true` and add `EXPLORATION_NO_HISTORY`. Unknown inputs get conservative values throughout (e.g. reliability 0.5 with no history).
5. **Circuit breaker per route key.** `failureThreshold` 3 failures inside a 300 s window open the breaker for a 60 s cooldown (`CIRCUIT_OPEN` fails `health_ok`); success clears state; reliability = successes/(successes+failures) in-window.
6. **`BLOCKED_NO_ELIGIBLE_ROUTE`, no paid fallback.** When no candidate is eligible the decision is `blocked: 'BLOCKED_NO_ELIGIBLE_ROUTE'` with `GATE_FAILED:<candidate>:<gate>` reason codes. The engine **never relaxes gates** and **never falls back to paid routes** — automatic paid fallback is `DISABLED` by construction and enforced by the suite's production-config scan (`allowPaid` never true outside lab).

## EVIDENCE

- Engine: `src/plugins/supreme-router/engine.ts` (`HARD_GATES`, `DEFAULT_WEIGHTS`, `normalizeWeights`, `selectRoute`, `CircuitBreaker`), adapter: `src/plugins/supreme-router/index.ts` (live catalog/resolution wiring, fail-closed credential check, observability record of every decision).
- Level-A checks (10/10 PASS): `router.weights-normalized`, `router.paid-rejected`, `router.unknown-cost-rejected`, `router.invalid-model-rejected`, `router.unhealthy-rejected`, `router.quota-rejected`, `router.context-insufficient`, `router.best-eligible-wins`, `router.circuit-breaker-transitions`, `router.exploration-until-evidence`.
- Real boots: `router_selects_eligible` + `router_rejects_paid` PASS in every supreme/lab run — the paid candidate fails `policy_cost` with `COST_PAID_DENIED` and the free synthetic route is selected (latest markers record `score=0.8125`; scores legitimately vary with accumulated benchmark history). `dsh-supreme/data/real/gates-{supreme,lab}.markers.jsonl`.
- Performance: full `selectRoute` over 8 candidates ~0.02 ms / 1k iterations (suite perf baseline).

## ALTERNATIVES

- **Live catalog as candidate source.** Rejected: turns provider availability into the only filter and loses declared metadata (cost class, capabilities, failure domains) needed for gating; config-owned candidates + live verification gives both.
- **ML/learned scoring.** Rejected for v1: non-deterministic, unexplainable, un-auditable; the weighted scalar keeps every decision reconstructible from reason codes.
- **Paid fallback on no eligible route.** Rejected outright: cost policy is a hard boundary, not a soft preference; silent spend is the failure mode the policy plugin exists to prevent.
- **Single composite gate ("eligible or not").** Rejected: per-gate evidence is required for diagnosis and for the `GATE_FAILED:*` reason codes.
- **Soft health scoring only (no breaker).** Rejected: DEGRADED scoring alone would still route to a failing provider; the breaker makes repeated failure structurally ineligible for the cooldown.

## CONSEQUENCES

- Positive: deterministic, explainable decisions; safe-by-default under missing metadata; bounded blast radius for failing providers; decisions observable (`route_decision` records with id/score/blocked-gate count).
- Negative: candidate metadata can go stale (it is config-owned); latency scoring is placeholder-constant in v1; restarts reset circuit state.
- Neutral: adding a candidate is a config change only; adding a score component requires an engine change and suite coverage.

## ROLLBACK

Lower the risk by config: reduce `weights` to fixed values, raise `minQuotaHeadroom`, or shrink `candidates` to known-good routes — all without code changes. To disable routing decisions entirely, unmount `supreme-router` from the composition (host then calls `ctx.llm` directly). The engine itself can be rolled back by restoring the previous `engine.ts` and re-running the suite; no persisted state depends on router internals (circuit state is in-memory; decisions live in the observability JSONL).
