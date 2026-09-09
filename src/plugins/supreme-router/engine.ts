/**
 * @dsh-supreme/router — pure selection engine.
 *
 * Hard gates first, then normalized weighted scoring (Spec §11 original).
 * UNKNOWN inputs receive conservative values. No automatic paid fallback:
 * when no candidate is eligible the engine returns BLOCKED_NO_ELIGIBLE_ROUTE
 * and NEVER relaxes gates.
 */

// v1.3 CapabilitySignal contract — single source of truth lives in
// supreme-policy/engine.ts (V13-A). TYPE-ONLY import: erased at runtime, so
// the router gains no runtime coupling to policy. Field names are contractual
// and must stay byte-identical: `capabilityClass?: string` and
// `cotVisibility?: 'verbose' | 'terse' | 'none'` (the router is the label
// CARRIER on decision records; enforcement lives in policy).
import type { CapabilitySignal } from '../supreme-policy/engine';

export type { CapabilitySignal };

export const HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'AUTH_FAILED',
  'MODEL_INVALID',
  'PROVIDER_DOWN',
  'UNKNOWN',
  'CIRCUIT_OPEN',
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HARD_GATES = [
  'policy_cost',
  'provider_available',
  'credential_available',
  'model_valid',
  'capability_fit',
  'context_sufficient',
  'health_ok',
  'quota_ok',
] as const;
export type HardGate = (typeof HARD_GATES)[number];

export const SCORE_COMPONENTS = [
  'quality',
  'health',
  'quota',
  'reliability',
  'latency',
  'capabilityFit',
  'diversity',
] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export type ScoreWeights = Record<ScoreComponent, number>;

/** Spec §11 default weights (30/20/15/10/10/10/5). Config-owned. */
export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  quality: 0.3,
  health: 0.2,
  quota: 0.15,
  reliability: 0.1,
  latency: 0.1,
  capabilityFit: 0.1,
  diversity: 0.05,
});

/**
 * v1.3 CapabilitySignal (ASTRA-hardening P3) — the shared interface is
 * imported (type-only) from supreme-policy/engine.ts and re-exported here for
 * router-side consumers. The router attaches the SELECTED candidate's labels
 * to the decision record; it never enforces them.
 */

export interface RouterCandidate {
  key: string;
  provider: string;
  model: string;
  costClass: string;
  capabilities: string[];
  contextWindow: number;
  credentialConfigured: boolean;
  quotaHeadroom: number;
  failureDomain: string;
  /** Provider is present in the live llm.listProviders() catalog. */
  providerAvailable: boolean;
  /** Model resolves through the live llm runtime. */
  modelValid: boolean;
  /** v1.3: config-owned capability label carried onto the decision record (no enforcement here). */
  capabilityClass?: string;
  /** v1.3: config-owned CoT-visibility label carried onto the decision record (no enforcement here). */
  cotVisibility?: 'verbose' | 'terse' | 'none';
}

export interface RouteInput {
  requiredCapabilities?: string[];
  requiredContextTokens?: number;
  risk?: string;
  /** v1.3.1 (IMP-R): task-class label driving class-aware scoring + the fast path. */
  taskClass?: string;
  /** v1.3.1 (IMP-R): free-form task labels (any label matching a simple class enables the fast path). */
  labels?: string[];
}

export interface CandidateModelPerf {
  avgQuality: number | null;
  samples: number;
  /**
   * v1.3 anti-sandbagging: false ONLY when the candidate's benchmark history
   * carries quality-score claims and NONE/NOT ALL of them are backed by
   * verifier-PASS evidence (computed by the caller from benchmark aggregates).
   * undefined = no score claim exists → nothing to distrust.
   */
  evidenceBacked?: boolean;
}

export interface GateResult {
  gate: HardGate;
  candidate: string;
  passed: boolean;
  reason?: string;
}

export interface RouteAlternative {
  provider: string;
  model: string;
  score: number;
}

export interface RouteDecision {
  decisionId: string;
  blocked: 'BLOCKED_NO_ELIGIBLE_ROUTE' | null;
  provider?: string;
  model?: string;
  score?: number;
  hardGates: GateResult[];
  reasonCodes: string[];
  degraded: boolean;
  alternatives: RouteAlternative[];
  weightsUsed: ScoreWeights;
  /** v1.2: RM0-first rule narrowed the scoring set (evidence preserved for all). */
  costFirstApplied: boolean;
  /**
   * v1.3.1 (IMP-R §4): true ONLY when the deterministic simple-task classifier
   * routed directly and fanout was suppressed. Key stays absent otherwise.
   */
  fastPath?: boolean;
  /** v1.3.1 (IMP-R §4): planned fanout width = cross-provider fallback count (0 on the fast path). */
  fanout?: number;
  /**
   * v1.3.1 (IMP-R §3): cross-provider fallback plan — ONLY candidates whose
   * free-claim evidence passes (FIX-A evidence fields). Never paid.
   */
  fallbackPlan?: FallbackPlanEntry[];
  /** v1.3.1 (IMP-R §1): task class the class-aware scoring actually used (absent when none). */
  taskClass?: string;
  /** v1.3 CapabilitySignal: labels of the SELECTED candidate (policy enforces, router carries). */
  capabilityClass?: string;
  cotVisibility?: 'verbose' | 'terse' | 'none';
  /**
   * v1.3 anti-sandbagging: candidates whose benchmark scores lacked
   * verifier-PASS evidence and received the fixed downweight factor.
   * ids + factors only — never score content.
   */
  unscoredEvidence?: Array<{ candidate: string; factor: number }>;
}

export interface CircuitConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT: Readonly<CircuitConfig> = Object.freeze({
  failureThreshold: 3,
  windowMs: 300_000,
  cooldownMs: 60_000,
});

export interface CircuitEntryState {
  key: string;
  state: HealthState;
  recentFailures: number;
  openedUntil: number | null;
}

/** Deterministic circuit breaker over route keys. */
export class CircuitBreaker {
  private readonly failures = new Map<string, number[]>();
  private readonly openedUntil = new Map<string, number>();
  private readonly successes = new Map<string, number[]>();

  constructor(private readonly config: CircuitConfig) {}

  recordFailure(key: string, now: number): CircuitEntryState {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t <= this.config.windowMs);
    list.push(now);
    this.failures.set(key, list);
    if (list.length >= this.config.failureThreshold) {
      this.openedUntil.set(key, now + this.config.cooldownMs);
    }
    return this.stateOf(key, now);
  }

  recordSuccess(key: string, now: number): CircuitEntryState {
    const list = (this.successes.get(key) ?? []).filter((t) => now - t <= this.config.windowMs);
    list.push(now);
    this.successes.set(key, list);
    this.failures.set(key, []);
    this.openedUntil.delete(key);
    return this.stateOf(key, now);
  }

  stateOf(key: string, now: number): CircuitEntryState {
    const openUntil = this.openedUntil.get(key);
    if (openUntil !== undefined && now < openUntil) {
      return {
        key,
        state: 'CIRCUIT_OPEN',
        recentFailures: this.failures.get(key)?.length ?? 0,
        openedUntil: openUntil,
      };
    }
    const recent = this.failures.get(key)?.length ?? 0;
    let state: HealthState = 'HEALTHY';
    if (recent > 0) state = recent >= this.config.failureThreshold ? 'DEGRADED' : 'DEGRADED';
    return { key, state, recentFailures: recent, openedUntil: null };
  }

  /** Reliability score in [0,1]: successes vs failures inside the window. */
  reliability(key: string, now: number): number {
    const s = (this.successes.get(key) ?? []).filter((t) => now - t <= this.config.windowMs).length;
    const f = (this.failures.get(key) ?? []).filter((t) => now - t <= this.config.windowMs).length;
    if (s + f === 0) return 0.5; // conservative default for unknown
    return s / (s + f);
  }
}

function normalizeWeights(raw: ScoreWeights): ScoreWeights {
  const sum = SCORE_COMPONENTS.reduce((acc, k) => acc + (Number.isFinite(raw[k]) ? Math.max(0, raw[k]) : 0), 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  const out = {} as ScoreWeights;
  for (const k of SCORE_COMPONENTS) out[k] = (Math.max(0, Number.isFinite(raw[k]) ? raw[k] : 0)) / sum;
  return out;
}

export function weightsAreNormalized(w: ScoreWeights, epsilon = 1e-6): boolean {
  const sum = SCORE_COMPONENTS.reduce((acc, k) => acc + w[k], 0);
  return Math.abs(sum - 1) < epsilon;
}

export interface SelectRouteDeps {
  config: RouterConfig;
  candidates: RouterCandidate[];
  circuit: CircuitBreaker;
  /** provider::model → performance */
  perf: Map<string, CandidateModelPerf>;
  now: number;
  decisionId: string;
  input: RouteInput;
  /**
   * v1.3.1 (IMP-R §1): per-task-class outcome history. When present AND the
   * input carries a taskClass, the quality component becomes the class-aware
   * Wilson lower bound (documented formula in ClassPerformanceTracker).
   */
  classPerf?: ClassPerformanceTracker;
  /**
   * v1.3.1 (IMP-R §2): outcome-driven circuit breaker (consecutive failures →
   * open → half-open single probe). When present, the health gate ALSO blocks
   * candidates whose key OR provider bucket is open.
   */
  outcomeCircuit?: OutcomeCircuitBreaker;
  /**
   * v1.3.1 (IMP-R §3): routeKey → free-claim evidence (FIX-A fields). Only
   * candidates whose evidence exists AND is current may appear in the
   * cross-provider fallback plan.
   */
  freeEvidence?: ReadonlyMap<string, FreeClaimEvidence>;
}

export interface RouterConfig {
  weights: ScoreWeights;
  minBenchmarkSamples: number;
  latencyCeilingMs: number;
  minQuotaHeadroom: number;
  circuit: CircuitConfig;
  /** v1.2: RM0-first — among eligible candidates, score only the cheapest cost class. */
  costFirst: boolean;
  /** v1.3.1 (IMP-R §3): retry/fanout/wall-clock bounds. Optional → v1.2 constructions keep working. */
  bounds?: BoundsConfig;
  /** v1.3.1 (IMP-R §4): fast-path classifier config. Optional → default = disabled. */
  fastPath?: FastPathConfig;
  /**
   * v1.3 anti-sandbagging: FIXED multiplicative downweight applied to the
   * routing score of candidates whose benchmark record is not-evidence-backed
   * (claimed scores without verifier-PASS evidence). Deterministic, no ML.
   * 1.0 = disabled (default, back-compat); e.g. 0.5 halves such scores.
   */
  unscoredEvidenceWeight: number;
}

/** v1.2: cheapest-first order (rank 0 = truly free). Policy still gates hard before this. */
export const COST_CLASS_ORDER = ['FREE_CONFIRMED', 'FREE_LIMITED', 'TRIAL', 'PAID', 'UNKNOWN'] as const;

export function costClassRank(costClass: string): number {
  const idx = (COST_CLASS_ORDER as readonly string[]).indexOf(costClass);
  return idx >= 0 ? idx : COST_CLASS_ORDER.length;
}

// ---------------------------------------------------------------------------
// v1.2 — Deterministic reasoning-effort pacing (v3 plan §3B).
//
// Valid levels are the PINNED DeepSeek adapter set ('off' | 'low' | 'high' |
// 'max' — packages/llm/llm-deepseek/src/serialize.ts); anything else is
// rejected upstream with UNSUPPORTED_REASONING_EFFORT. Escalation is driven
// ONLY by verifier FAIL evidence (mechanical), never model self-confidence.
// ---------------------------------------------------------------------------

export const REASONING_EFFORT_LEVELS = ['off', 'low', 'high', 'max'] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

export interface EffortPacingConfig {
  enabled: boolean;
  byCostClass: Record<string, ReasoningEffortLevel>;
  escalateOnVerifierFail: boolean;
}

export const DEFAULT_EFFORT_PACING: Readonly<EffortPacingConfig> = Object.freeze({
  enabled: false,
  byCostClass: Object.freeze({
    FREE_CONFIRMED: 'low',
    FREE_LIMITED: 'low',
    TRIAL: 'high',
    PAID: 'high',
    UNKNOWN: 'high',
  }),
  escalateOnVerifierFail: true,
});

/** Base effort for a cost class; undefined leaves the adapter default untouched. */
export function baseEffortFor(pacing: EffortPacingConfig, costClass: string): ReasoningEffortLevel | undefined {
  if (!pacing.enabled) return undefined;
  return pacing.byCostClass[costClass];
}

/** One-step mechanical escalation (low→high after verifier FAIL; max is terminal). */
export function escalateEffort(effort: ReasoningEffortLevel): ReasoningEffortLevel {
  switch (effort) {
    case 'off':
      return 'low';
    case 'low':
      return 'high';
    case 'high':
    case 'max':
      return 'max';
    default:
      return 'high';
  }
}

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
  weights: { ...DEFAULT_WEIGHTS },
  minBenchmarkSamples: 5,
  latencyCeilingMs: 30_000,
  minQuotaHeadroom: 0.05,
  circuit: { ...DEFAULT_CIRCUIT },
  costFirst: true,
  unscoredEvidenceWeight: 1,
});

const HEALTH_SCORE: Partial<Record<HealthState, number>> = {
  HEALTHY: 1,
  DEGRADED: 0.5,
};

/**
 * Deterministic route selection. All hard gates run for every candidate
 * (evidence preserved), scoring runs only on eligible candidates.
 */
export function selectRoute(deps: SelectRouteDeps): RouteDecision {
  const { config, candidates, circuit, perf, now, decisionId, input } = deps;
  const { classPerf, outcomeCircuit, freeEvidence } = deps;
  const hardGates: GateResult[] = [];
  const required = input.requiredCapabilities ?? [];
  const requiredTokens = input.requiredContextTokens ?? 0;
  const taskClass = input.taskClass;

  const eligible: RouterCandidate[] = [];

  for (const candidate of candidates) {
    const push = (gate: HardGate, passed: boolean, reason?: string) =>
      hardGates.push({ gate, candidate: candidate.key, passed, reason });

    // Gate 1: policy/cost class (UNKNOWN → deny happens inside policy; we still
    // enforce locally so the engine is safe when policy service is bypassed).
    const costAllowed = candidate.costClass === 'FREE_CONFIRMED' || candidate.costClass === 'FREE_LIMITED';
    push('policy_cost', costAllowed, costAllowed ? undefined : `COST_${candidate.costClass}_DENIED`);

    // Gate 2: provider availability (live catalog).
    push('provider_available', candidate.providerAvailable, candidate.providerAvailable ? undefined : 'PROVIDER_NOT_IN_CATALOG');

    // Gate 3: credential availability (fail-closed when unverified).
    push('credential_available', candidate.credentialConfigured, candidate.credentialConfigured ? undefined : 'CREDENTIAL_UNVERIFIED');

    // Gate 4: model validity (live resolution).
    push('model_valid', candidate.modelValid, candidate.modelValid ? undefined : 'INVALID_MODEL');

    // Gate 5: capability fit.
    const missing = required.filter((cap) => !candidate.capabilities.includes(cap));
    push('capability_fit', missing.length === 0, missing.length === 0 ? undefined : `MISSING:${missing.join('+')}`);

    // Gate 6: context sufficiency.
    const contextOk = candidate.contextWindow === 0 || candidate.contextWindow >= requiredTokens;
    push('context_sufficient', contextOk, contextOk ? undefined : `CONTEXT_${candidate.contextWindow}_${requiredTokens}`);

    // Gate 7: health / circuit (v1.2 windowed breaker + v1.3.1 outcome breaker).
    const circuitState = circuit.stateOf(candidate.key, now);
    let healthOk = circuitState.state !== 'CIRCUIT_OPEN';
    let healthReason: string = healthOk ? circuitState.state : 'CIRCUIT_OPEN';
    if (healthOk && outcomeCircuit) {
      // IMP-R §2: block when the candidate key OR its provider bucket
      // (unattributed agent/request-error failures) is OPEN. half_open passes —
      // the next dispatch IS the single probe (enforced by acquireProbe()).
      const keyState = outcomeCircuit.stateOf(candidate.key, now);
      const bucketState = outcomeCircuit.stateOf(providerBucketOf(candidate.provider), now);
      if (keyState.phase === 'open' || bucketState.phase === 'open') {
        healthOk = false;
        healthReason = 'OUTCOME_CIRCUIT_OPEN';
      }
    }
    push('health_ok', healthOk, healthReason);

    // Gate 8: quota headroom.
    const quotaOk = candidate.quotaHeadroom >= config.minQuotaHeadroom;
    push('quota_ok', quotaOk, quotaOk ? undefined : `QUOTA_${candidate.quotaHeadroom.toFixed(2)}`);

    if (
      costAllowed &&
      candidate.providerAvailable &&
      candidate.credentialConfigured &&
      candidate.modelValid &&
      missing.length === 0 &&
      contextOk &&
      healthOk &&
      quotaOk
    ) {
      eligible.push(candidate);
    }
  }

  const weights = normalizeWeights(config.weights);
  const reasonCodes: string[] = [];
  let degraded = false;

  if (eligible.length === 0) {
    reasonCodes.push('BLOCKED_NO_ELIGIBLE_ROUTE');
    const blockedReasons = new Set(
      hardGates.filter((g) => !g.passed).map((g) => `${g.candidate}:${g.gate}`),
    );
    for (const r of blockedReasons) reasonCodes.push(`GATE_FAILED:${r}`);
    return {
      decisionId,
      blocked: 'BLOCKED_NO_ELIGIBLE_ROUTE',
      hardGates,
      reasonCodes,
      degraded: false,
      alternatives: [],
      weightsUsed: weights,
      costFirstApplied: false,
    };
  }

  // v1.2 RM0-first: score only the cheapest cost class among eligible
  // candidates. Hard-gate evidence for ALL candidates is preserved above; the
  // filter can never empty the set (the minimum rank is always present).
  let scoringSet = eligible;
  let costFirstApplied = false;
  if (config.costFirst && eligible.length > 1) {
    const cheapestRank = Math.min(...eligible.map((c) => costClassRank(c.costClass)));
    const narrowed = eligible.filter((c) => costClassRank(c.costClass) === cheapestRank);
    if (narrowed.length > 0 && narrowed.length < eligible.length) {
      scoringSet = narrowed;
      costFirstApplied = true;
      reasonCodes.push(`COST_FIRST_${COST_CLASS_ORDER[cheapestRank]}`);
    }
  }

  // Failure-domain diversity input: share of scoring candidates per domain.
  const domainCount = new Map<string, number>();
  for (const c of scoringSet) domainCount.set(c.failureDomain, (domainCount.get(c.failureDomain) ?? 0) + 1);

  interface Scored {
    candidate: RouterCandidate;
    score: number;
    components: Record<ScoreComponent, number>;
    downweighted: boolean;
    classAware: boolean;
  }
  const scored: Scored[] = scoringSet.map((candidate) => {
    const perfEntry = perf.get(candidate.key);
    const hasHistory = (perfEntry?.samples ?? 0) >= config.minBenchmarkSamples;
    // v1.3.1 (IMP-R §1): class-aware quality. When a taskClass is supplied and
    // the tracker holds samples for (candidate, class), the quality component
    // becomes the deterministic freshness-decayed Wilson lower bound of the
    // per-class success history (formula documented on ClassPerformanceTracker).
    // Otherwise the v1.2 global benchmark quality applies unchanged.
    const classStat =
      taskClass !== undefined && classPerf !== undefined
        ? classPerf.score(candidate.key, taskClass, now)
        : undefined;
    const classAware = classStat !== undefined && classStat.samples > 0;
    const quality = classAware
      ? classStat.score
      : hasHistory
        ? (perfEntry?.avgQuality ?? 0.5)
        : 0.5; // exploration default
    if (!hasHistory && !classAware) degraded = true;
    const circuitState = circuit.stateOf(candidate.key, now);
    const health = HEALTH_SCORE[circuitState.state] ?? 0;
    if (circuitState.state === 'DEGRADED') degraded = true;
    const quota = clamp01(candidate.quotaHeadroom);
    const reliability = circuit.reliability(candidate.key, now);
    const latency = 0.5; // no live latency sample in v1 scoring; conservative
    const capabilityFit =
      required.length === 0
        ? 1
        : required.filter((cap) => candidate.capabilities.includes(cap)).length / required.length;
    const share = (domainCount.get(candidate.failureDomain) ?? 1) / eligible.length;
    const diversity = clamp01(1 - share);
    const components: Record<ScoreComponent, number> = {
      quality,
      health,
      quota,
      reliability,
      latency,
      capabilityFit,
      diversity,
    };
    let score = SCORE_COMPONENTS.reduce((acc, k) => acc + weights[k] * components[k], 0);
    // v1.3 anti-sandbagging: a fixed, deterministic downweight — never ML, never
    // adaptive — for candidates whose benchmark scores lack verifier-PASS
    // evidence ("evidence > self-confidence"). weight === 1 is the off switch.
    let downweighted = false;
    if (config.unscoredEvidenceWeight !== 1 && perfEntry?.evidenceBacked === false) {
      score = score * config.unscoredEvidenceWeight;
      downweighted = true;
    }
    return { candidate, score, components, downweighted, classAware };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
  const best = scored[0];
  if (!hasExplorationEvidence(perf, config, eligible)) reasonCodes.push('EXPLORATION_NO_HISTORY');
  reasonCodes.push('OK');

  // v1.3: ids + applied factors of downweighted candidates (audit consumes these).
  const unscoredEvidence = scored
    .filter((s) => s.downweighted)
    .map((s) => ({ candidate: s.candidate.key, factor: config.unscoredEvidenceWeight }));
  if (unscoredEvidence.length > 0) reasonCodes.push('UNSCORED_EVIDENCE_DOWNWEIGHT');

  // v1.3.1 (IMP-R §1): the selection used the per-class lower bound.
  const selectedClassAware = best.classAware;
  if (selectedClassAware) reasonCodes.push('CLASS_AWARE_QUALITY');

  // v1.3.1 (IMP-R §4): deterministic fast path — simple tasks route directly
  // and fanout (cross-provider fallback width) is suppressed to ZERO.
  const fastPathConfig = resolveFastPathConfig(config);
  const simpleTask = isSimpleTask(input, fastPathConfig);

  // v1.3.1 (IMP-R §3): cross-provider fallback plan — verified-free candidates
  // only (FIX-A free-claim evidence must exist AND be current), capped at
  // maxFanout. Simple tasks get an empty plan (fanout 0). The plan is
  // advisory: execution stays with the host; a paid candidate can NEVER
  // appear here (paidAutomaticFallback remains DISABLED).
  const bounds = resolveBoundsConfig(config);
  const fallbackPlan = simpleTask
    ? []
    : planCrossProviderFallbacks({
        pool: scored.map((s) => ({
          key: s.candidate.key,
          provider: s.candidate.provider,
          model: s.candidate.model,
          costClass: s.candidate.costClass,
          failureDomain: s.candidate.failureDomain,
          score: s.score,
        })),
        excludeKey: best.candidate.key,
        freeEvidence: freeEvidence ?? new Map(),
        now,
        maxFanout: bounds.maxFanout,
      });
  if (simpleTask) reasonCodes.push('FAST_PATH_SIMPLE');
  else if (fallbackPlan.length > 0) reasonCodes.push('FALLBACK_PLAN_VERIFIED_FREE');
  else if (eligible.length > 1) reasonCodes.push('FALLBACK_PLAN_EMPTY_DEGRADED');

  // v1.3 CapabilitySignal: attach ONLY the labels the selected candidate
  // actually carries (keys stay absent otherwise — back-compat shape).
  const signal: CapabilitySignal = {};
  if (best.candidate.capabilityClass !== undefined) signal.capabilityClass = best.candidate.capabilityClass;
  if (best.candidate.cotVisibility !== undefined) signal.cotVisibility = best.candidate.cotVisibility;

  return {
    decisionId,
    blocked: null,
    provider: best.candidate.provider,
    model: best.candidate.model,
    score: round4(best.score),
    hardGates,
    reasonCodes,
    degraded,
    alternatives: scored.slice(1, 4).map((s) => ({
      provider: s.candidate.provider,
      model: s.candidate.model,
      score: round4(s.score),
    })),
    weightsUsed: weights,
    costFirstApplied,
    ...(simpleTask ? { fastPath: true } : {}),
    fanout: fallbackPlan.length,
    ...(fallbackPlan.length > 0 ? { fallbackPlan } : {}),
    ...(taskClass !== undefined ? { taskClass } : {}),
    ...signal,
    ...(unscoredEvidence.length > 0 ? { unscoredEvidence } : {}),
  };
}

function hasExplorationEvidence(
  perf: Map<string, CandidateModelPerf>,
  config: RouterConfig,
  eligible: RouterCandidate[],
): boolean {
  return eligible.every((c) => (perf.get(c.key)?.samples ?? 0) >= config.minBenchmarkSamples);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// v1.3.1 — Pre-dispatch cost-policy gate (FIX-A; external review P1 of
// v1.3.0: "the agent/request hook only adjusts reasoningEffort. With default
// config, requests to paid providers/models pass through WITHOUT route/cost
// checks").
//
// Ownership (AGENTS.md §5 canonical table): cost/risk policy is owned by
// supremePolicy; the router NEVER re-implements it. The adapter resolves the
// route's cost class, consults `supremePolicy.evaluateRoute` (the existing
// narrow decision method — no policy change needed), and refuses the dispatch
// INSIDE the pinned waterfall when policy denies:
//
//   Seam 1 — `agent/request` (config-proposal waterfall; packages/core/agent/
//   src/runtime-types.ts:276-289): deny = return a provider/model-less config;
//   the pinned loop itself then throws BEFORE llm.prepareCall/stream
//   (packages/core/agent-loop/src/agent.ts:527-529, pin d347e703) — zero
//   adapter calls, nothing fabricated.
//
//   Seam 2 — `llm/stream` (waterfall around EVERY adapter stream;
//   packages/llm/llm/src/index.ts:58-74 + 1093-1107): deny = throw before
//   `next()` so the innermost receiver (adapterStream) is never invoked.
//   Upstream binds the same seam for invariants (packages/llm/llm/src/
//   invariant.ts:88, packages/core/agent-loop/src/invariant.ts:21); upstream
//   documents that middleware failures remain thrown.
//
// Deterministic only; audit events carry labels/ids/reasons — never payloads,
// prompts, or credentials (Spec §10).
// ---------------------------------------------------------------------------

/** Audit event names (value-free: labels/ids/reasons only). */
export const ROUTE_COST_DENIED_EVENT = 'route_cost_denied';
export const FREE_ROUTE_EVIDENCE_EVENT = 'free_route_evidence';

/** Stable machine code carried by the adapter's llm/stream denial error. */
export const COST_POLICY_DENIED_CODE = 'COST_POLICY_DENIED';
/** Reason label used when the policy service is missing or unusable (fail-closed). */
export const COST_POLICY_UNAVAILABLE_REASON = 'COST_POLICY_UNAVAILABLE';

// ---------------------------------------------------------------------------
// v1.3.1 — Free-claim evidence (metadata ONLY, never credential values).
//
// A cost label is NOT proof of a free endpoint: 'FREE_CONFIRMED' in the router
// config is an OPERATOR CLAIM about a route, not verified pricing. When a
// route is treated as free, the adapter records where the claim came from,
// when it was checked, and its expiry/status so the audit trail always shows
// that the "free" posture rests on an unverified config assertion. v1.3.1
// ships the 'config' source only (router candidates are config-owned); the
// vocabulary is closed for future catalog/user-allowlist sources.
// ---------------------------------------------------------------------------

export const FREE_CLAIM_SOURCES = ['config', 'catalog', 'user-allowlist'] as const;
export type FreeClaimSource = (typeof FREE_CLAIM_SOURCES)[number];

export interface FreeClaimEvidence {
  /** Where the free claim came from (config-owned candidates = 'config'). */
  source: FreeClaimSource;
  /** Epoch ms of the check that produced this evidence. */
  checkedAt: number;
  /** Lifecycle status of the claim ('active' until a configured expiry passes). */
  status: 'active' | 'expired';
  /** Epoch ms after which the claim must be re-verified; null = no expiry. */
  expiresAt: number | null;
}

/** Deterministic free-claim evidence record. Non-finite inputs clamp to 0. */
export function freeClaimEvidence(
  source: FreeClaimSource,
  checkedAt: number,
  ttlMs?: number,
): FreeClaimEvidence {
  const checked = Number.isFinite(checkedAt) ? Math.max(0, Math.floor(checkedAt)) : 0;
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { source, checkedAt: checked, status: 'active', expiresAt: null };
  }
  const expiresAt = checked + Math.floor(ttlMs);
  return { source, checkedAt: checked, status: 'active', expiresAt };
}

/** Whether the claim is still current at `now` (deterministic; null expiry never expires). */
export function freeClaimIsCurrent(evidence: FreeClaimEvidence, now: number): boolean {
  if (evidence.status === 'expired') return false;
  if (evidence.expiresAt === null) return true;
  return Number.isFinite(now) && now < evidence.expiresAt;
}

/**
 * Resolve the cost class of a route against the config-owned allowlist
 * (`provider::model` → cost class). A route absent from EVERY allowlist is
 * UNKNOWN — and UNKNOWN is never routable in production (RM0 posture; the
 * policy engine hard-denies it and the belt-and-braces rule below re-asserts
 * it even if a misconfigured policy service claimed otherwise).
 */
export function resolveRouteCostClass(
  allowlist: ReadonlyMap<string, string>,
  provider: string,
  model: string,
): string {
  return allowlist.get(`${provider}::${model}`) ?? 'UNKNOWN';
}

export interface RouteCostGateInput {
  provider: string;
  model: string;
  /** Resolved cost class (resolveRouteCostClass; UNKNOWN when unlisted). */
  costClass: string;
  /**
   * The policy decision for this cost class (supremePolicy.evaluateRoute).
   * null = the policy service is missing/unusable ⇒ fail-closed deny.
   */
  policyDecision: { allowed: boolean; reasonCodes: string[] } | null;
  /** Epoch ms for free-claim evidence (checkedAt). */
  now: number;
  /** Where the free claim (if any) came from; default 'config'. */
  freeClaimSource?: FreeClaimSource;
}

export interface RouteCostGate {
  allowed: boolean;
  provider: string;
  model: string;
  costClass: string;
  /** Value-free reason labels (policy reason codes + local hard-rule codes). */
  reasonCodes: string[];
  /** Present ONLY when the route is allowed as free (metadata, never secrets). */
  freeClaim: FreeClaimEvidence | null;
}

/**
 * Compose the pre-dispatch cost gate from the policy decision. Pure +
 * deterministic: policy is the sole owner of allow/deny; this adds only the
 * fail-closed default, the UNKNOWN belt-and-braces rule, and free-claim
 * evidence metadata.
 */
export function buildRouteCostGate(input: RouteCostGateInput): RouteCostGate {
  const failClosed = input.policyDecision === null;
  const policyAllowed = input.policyDecision !== null && input.policyDecision.allowed === true;
  // Hard local rule mirroring the policy engine: UNKNOWN cost is never
  // routable — missing metadata must never become permission (Spec §11).
  const allowed = policyAllowed && input.costClass !== 'UNKNOWN';
  const reasonCodes = failClosed
    ? [COST_POLICY_UNAVAILABLE_REASON]
    : [...(input.policyDecision?.reasonCodes ?? [])];
  if (!allowed && input.costClass === 'UNKNOWN' && !reasonCodes.includes('COST_UNKNOWN_DENIED')) {
    reasonCodes.push('COST_UNKNOWN_DENIED');
  }
  const freeClaim =
    allowed && (input.costClass === 'FREE_CONFIRMED' || input.costClass === 'FREE_LIMITED')
      ? freeClaimEvidence(input.freeClaimSource ?? 'config', input.now)
      : null;
  return {
    allowed,
    provider: input.provider,
    model: input.model,
    costClass: input.costClass,
    reasonCodes,
    freeClaim,
  };
}

/**
 * Stable deny message for the llm/stream refusal. Labels only: reason codes +
 * cost class + route key (ids the existing audits already carry) — never
 * request content, argument values, or credentials.
 */
export function routeCostDeniedMessage(gate: RouteCostGate): string {
  return `supreme-router: LLM dispatch refused by cost policy (${gate.reasonCodes.join('+')}; cost=${gate.costClass}; route=${gate.provider}::${gate.model})`;
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — §1 Routing based on work outcomes: per-task-class
// performance with recency decay + uncertainty shrinkage.
//
// ALL formulas below are FIXED and deterministic — no ML, no network, no
// adaptive thresholds:
//
//   1. Freshness weight of one outcome sample recorded at `at`, evaluated at
//      `now`:
//          w = 0.5 ^ (ageMs / halfLifeMs),  ageMs = max(0, now - at)
//      Fixed half-life (config `classAware.halfLifeMs`, default 3,600,000 ms
//      = 1 hour). A sample loses HALF its weight every half-life.
//
//   2. Effective sample size (decayed count) over samples S:
//          n_eff = Σ w_i
//      (a plain sum of freshness weights: stale evidence literally shrinks
//      the sample count, so old perfect records lose statistical weight).
//
//   3. Freshness-weighted success fraction:
//          p̂ = Σ w_i·s_i / n_eff     (s_i = 1 for success, 0 for failure)
//      n_eff ≤ 0 ⇒ no signal ⇒ neutral 0.5.
//
//   4. Score = Wilson score LOWER BOUND at fixed confidence z = 1.96 (~95%,
//      one-sided), computed with p̂ and n = n_eff:
//
//        LB = ( p̂ + z²/(2n) − z·√( p̂(1−p̂)/n + z²/(4n²) ) ) / ( 1 + z²/n )
//
//      This is the deterministic uncertainty shrinkage: a 1/1 record has
//      LB = 1/(1+z²) ≈ 0.207 (huge uncertainty), while a stable 50/52 record
//      has LB ≈ 0.87 — a single lucky sample can NEVER outrank stable
//      evidence, and a stale perfect score decays (through n_eff) below a
//      recent good score after roughly one half-life.
// ---------------------------------------------------------------------------

/** Fixed Wilson z (documented constant — never tuned at runtime). */
export const WILSON_Z = 1.96;
/** Default recency half-life for class samples: 1 hour (config-overridable). */
export const DEFAULT_CLASS_HALF_LIFE_MS = 3_600_000;

/** Freshness weight of one sample (formula 1 above). Deterministic, clamped to [0,1]. */
export function freshnessWeight(at: number, now: number, halfLifeMs: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return 0; // unusable inputs carry no evidential weight
  }
  const ageMs = Math.max(0, now - at);
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/** Wilson score lower bound (formula 4 above). n ≤ 0 ⇒ 0.5 (neutral). */
export function wilsonLowerBound(pHat: number, n: number, z: number = WILSON_Z): number {
  if (!Number.isFinite(pHat) || !Number.isFinite(n) || n <= 0) return 0.5;
  const p = Math.min(1, Math.max(0, pHat));
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const radius = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lb = (centre - radius) / (1 + z2 / n);
  return Math.min(1, Math.max(0, lb));
}

export interface ClassScoreBreakdown {
  /** Wilson lower bound of the freshness-weighted success history ([0,1]). */
  score: number;
  /** Raw samples recorded for this (candidate, class) pair (bounded). */
  samples: number;
  /** Σ w_i — the decayed effective sample size. */
  nEff: number;
  /** Freshness-weighted success fraction (undefined when no samples). */
  pHat?: number;
}

/**
 * Per-(candidate, taskClass) outcome tracker. Bounded: at most
 * `maxSamplesPerClass` samples per (key, class) pair (oldest evicted first,
 * insertion order) and at most `maxEntries` pairs (oldest evicted first).
 */
export class ClassPerformanceTracker {
  private readonly classes = new Map<string, Map<string, Array<{ success: boolean; at: number }>>>();
  private readonly halfLifeMs: number;
  private readonly maxSamplesPerClass: number;
  private readonly maxEntries: number;

  constructor(opts: { halfLifeMs?: number; maxSamplesPerClass?: number; maxEntries?: number } = {}) {
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_CLASS_HALF_LIFE_MS;
    this.maxSamplesPerClass = opts.maxSamplesPerClass ?? 128;
    this.maxEntries = opts.maxEntries ?? 1024;
  }

  /** Record one outcome sample. IDs/labels/booleans only — never content. */
  observe(key: string, taskClass: string, success: boolean, at: number): void {
    if (typeof key !== 'string' || key.length === 0 || typeof taskClass !== 'string' || taskClass.length === 0) return;
    const cls = normalizeTaskClass(taskClass);
    const perClass = this.classes.get(key) ?? new Map<string, Array<{ success: boolean; at: number }>>();
    if (!this.classes.has(key)) {
      if (this.classes.size >= this.maxEntries) {
        const oldest = this.classes.keys().next().value;
        if (oldest !== undefined) this.classes.delete(oldest);
      }
      this.classes.set(key, perClass);
    }
    const list = perClass.get(cls) ?? [];
    if (!perClass.has(cls)) {
      if (perClass.size >= 32) {
        const oldest = perClass.keys().next().value;
        if (oldest !== undefined) perClass.delete(oldest);
      }
      perClass.set(cls, list);
    }
    list.push({ success: success === true, at: Number.isFinite(at) ? at : 0 });
    if (list.length > this.maxSamplesPerClass) list.shift(); // bounded: drop oldest
  }

  /** Deterministic class-aware score (formulas 1–4 above). */
  score(key: string, taskClass: string, now: number): ClassScoreBreakdown {
    const list = this.classes.get(key)?.get(normalizeTaskClass(taskClass));
    if (!list || list.length === 0) return { score: 0.5, samples: 0, nEff: 0 };
    let weightSum = 0;
    let weightedSuccess = 0;
    for (const sample of list) {
      const w = freshnessWeight(sample.at, now, this.halfLifeMs);
      weightSum += w;
      if (sample.success) weightedSuccess += w;
    }
    const pHat = weightSum > 0 ? weightedSuccess / weightSum : undefined;
    const score = weightSum > 0 ? wilsonLowerBound(pHat ?? 0.5, weightSum) : 0.5;
    return { score, samples: list.length, nEff: weightSum, ...(pHat !== undefined ? { pHat } : {}) };
  }
}

/** Provider-level circuit key for unattributed failures (agent/request-error carries no model). */
export function providerBucketOf(provider: string): string {
  return `${provider}::*`;
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — §2 Outcome → health/circuit breaker.
//
// Failure classes are a CLOSED vocabulary classified deterministically from
// the REAL pinned upstream error codes (deepseek-harness @ d347e703,
// packages/llm/llm/src/error.ts + packages/llm/llm-deepseek/src/adapter.ts
// httpErrorCode / stream watchdog):
//   AUTH (401/403), MISSING_CREDENTIAL, INVALID_CREDENTIAL  → credential
//   RATE_LIMIT (429), HTTP_429, HTTP_402, QUOTA (exhausted
//   account quota/balance)                                  → rate_limit
//   TIMEOUT and any *_TIMEOUT suffix (LLM_STREAM_IDLE_TIMEOUT,
//   DEEPSEEK_FILES_API_TIMEOUT). ABORTED is caller-initiated and is
//   deliberately NOT a timeout.                             → timeout
//   VERIFICATION (verifier FAIL evidence — only ever produced by an explicit
//   verifier outcome, never inferred from an LLM code)      → verifier
//   everything else (SERVER, TRANSPORT, EMPTY_RESPONSE,
//   INVALID_*, CONTEXT_WINDOW_EXCEEDED, HTTP_*, ABORTED,
//   UNKNOWN, missing)                                       → other
// ---------------------------------------------------------------------------

export const OUTCOME_CLASSES = ['rate_limit', 'timeout', 'credential', 'verifier', 'other'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** Deterministic mapping from upstream/provider failure labels to the outcome class. */
export function classifyFailure(failure: { code?: unknown; status?: unknown; name?: unknown } | null | undefined): OutcomeClass {
  const code = failure && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : '';
  if (code === 'VERIFICATION') return 'verifier';
  if (code === 'AUTH' || code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL' || code === 'HTTP_401' || code === 'HTTP_403') {
    return 'credential';
  }
  if (code === 'RATE_LIMIT' || code === 'QUOTA' || code === 'HTTP_429' || code === 'HTTP_402') {
    return 'rate_limit';
  }
  if (code === 'TIMEOUT' || (code.endsWith('_TIMEOUT') && code !== 'ABORTED')) return 'timeout';
  return 'other';
}

export interface OutcomeCircuitConfig {
  /** Consecutive failures (same candidate key/bucket) that open the circuit. */
  consecutiveFailures: number;
  /** Open-circuit cooldown before the single half-open probe is allowed. */
  cooldownMs: number;
}

export const DEFAULT_OUTCOME_CIRCUIT: Readonly<OutcomeCircuitConfig> = Object.freeze({
  consecutiveFailures: 3,
  cooldownMs: 60_000,
});

export type CircuitPhase = 'closed' | 'open' | 'half_open';

export interface OutcomeCircuitState {
  key: string;
  phase: CircuitPhase;
  consecutiveFailures: number;
  lastOutcomeClass: OutcomeClass | null;
  /** Epoch ms until which the circuit stays open (null when not open). */
  openedUntil: number | null;
  /** True while the single half-open probe slot is granted and unresolved. */
  probeGranted: boolean;
}

/**
 * Consecutive-failure circuit breaker with half-open single-probe recovery.
 *
 * Semantics (documented contract):
 *  - `recordFailure(key, now, cls)` increments the per-key consecutive
 *    counter; when the counter reaches `consecutiveFailures` the circuit
 *    OPENS until `now + cooldownMs`.
 *  - After the cooldown elapses, `stateOf` reports `half_open`. The SINGLE
 *    probe slot is granted by `acquireProbe` (once per open episode); while
 *    the slot is outstanding no second probe is granted.
 *  - Probe outcome: `recordSuccess` closes the circuit and resets the
 *    counter; `recordFailure` re-opens it for a fresh cooldown.
 *  - A success on any candidate key also clears the provider bucket
 *    `provider::*` (attributed success is evidence the provider recovered).
 *    The reverse is NOT true: bucket failures never touch candidate keys.
 *  - No timers, no background work: state advances only through explicit
 *    record/state calls with the caller-supplied `now` (deterministic).
 */
export class OutcomeCircuitBreaker {
  private readonly config: OutcomeCircuitConfig;
  private readonly entries = new Map<string, { consecutive: number; lastClass: OutcomeClass | null; openedUntil: number | null; probeGranted: boolean }>();
  private readonly maxEntries: number;

  constructor(config: Partial<OutcomeCircuitConfig> = {}, opts: { maxEntries?: number } = {}) {
    this.config = {
      consecutiveFailures: config.consecutiveFailures ?? DEFAULT_OUTCOME_CIRCUIT.consecutiveFailures,
      cooldownMs: config.cooldownMs ?? DEFAULT_OUTCOME_CIRCUIT.cooldownMs,
    };
    this.maxEntries = opts.maxEntries ?? 512;
  }

  private entry(key: string): { consecutive: number; lastClass: OutcomeClass | null; openedUntil: number | null; probeGranted: boolean } {
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      e = { consecutive: 0, lastClass: null, openedUntil: null, probeGranted: false };
      this.entries.set(key, e);
    }
    return e;
  }

  recordFailure(key: string, now: number, outcomeClass: OutcomeClass = 'other'): OutcomeCircuitState {
    const e = this.entry(key);
    e.consecutive += 1;
    e.lastClass = outcomeClass;
    if (e.consecutive >= this.config.consecutiveFailures) {
      e.openedUntil = now + this.config.cooldownMs;
    }
    e.probeGranted = false; // any failure invalidates an outstanding probe
    return this.stateOf(key, now);
  }

  recordSuccess(key: string, now: number): OutcomeCircuitState {
    const e = this.entry(key);
    e.consecutive = 0;
    e.lastClass = null;
    e.openedUntil = null;
    e.probeGranted = false;
    // Documented cross-clear: an attributed success also clears the provider
    // bucket so provider-level open states recover through real evidence.
    const bucketKey = providerBucketOf(key.split('::')[0] ?? '');
    if (bucketKey !== key && bucketKey !== '::*') {
      const bucket = this.entries.get(bucketKey);
      if (bucket) {
        bucket.consecutive = 0;
        bucket.lastClass = null;
        bucket.openedUntil = null;
        bucket.probeGranted = false;
      }
    }
    return this.stateOf(key, now);
  }

  stateOf(key: string, now: number): OutcomeCircuitState {
    const e = this.entries.get(key);
    if (!e) return { key, phase: 'closed', consecutiveFailures: 0, lastOutcomeClass: null, openedUntil: null, probeGranted: false };
    if (e.openedUntil !== null && now < e.openedUntil) {
      return { key, phase: 'open', consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: e.openedUntil, probeGranted: e.probeGranted };
    }
    if (e.openedUntil !== null) {
      // Cooldown elapsed: half-open until the single probe resolves.
      return { key, phase: 'half_open', consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: null, probeGranted: e.probeGranted };
    }
    return { key, phase: 'closed', consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: null, probeGranted: e.probeGranted };
  }

  /**
   * Grant the SINGLE half-open probe slot. Returns true exactly once per open
   * episode (false when closed, still open, or the probe is already granted).
   */
  acquireProbe(key: string, now: number): boolean {
    const state = this.stateOf(key, now);
    if (state.phase !== 'half_open' || state.probeGranted) return false;
    this.entry(key).probeGranted = true;
    return true;
  }

  /** Bounded snapshot (ids/phases/counts only). */
  snapshot(now: number): OutcomeCircuitState[] {
    return [...this.entries.keys()].map((key) => this.stateOf(key, now));
  }
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — §3 Bounds against retry storms.
// ---------------------------------------------------------------------------

export interface BoundsConfig {
  /** Maximum dispatch attempts per task (attempts beyond are refused). */
  maxRetries: number;
  /** Maximum fanout width (cross-provider fallback candidates per decision). */
  maxFanout: number;
  /** Wall-clock budget for one task in ms; 0 = OFF (behavior-preserving). */
  wallClockBudgetMs: number;
}

/** Defaults preserve v1.2 behavior: 3 attempts, fanout ≤ 4, wall-clock OFF. */
export const DEFAULT_BOUNDS: Readonly<BoundsConfig> = Object.freeze({
  maxRetries: 3,
  maxFanout: 4,
  wallClockBudgetMs: 0,
});

export function resolveBoundsConfig(config: RouterConfig): BoundsConfig {
  const b = config.bounds;
  return {
    maxRetries: b?.maxRetries ?? DEFAULT_BOUNDS.maxRetries,
    maxFanout: b?.maxFanout ?? DEFAULT_BOUNDS.maxFanout,
    wallClockBudgetMs: b?.wallClockBudgetMs ?? DEFAULT_BOUNDS.wallClockBudgetMs,
  };
}

/** Wall-clock budget check. budgetMs ≤ 0 (or non-finite inputs) = OFF → true. */
export function withinWallClock(startedAt: number, now: number, budgetMs: number): boolean {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return true;
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return true;
  return now - startedAt <= budgetMs;
}

/**
 * Bounded per-task attempt ledger. `registerAttempt` returns whether the
 * attempt is still inside `maxRetries`; attempts beyond the bound are REFUSED
 * (the caller must not dispatch). Pure bookkeeping — never sleeps, never
 * retries on its own.
 */
export class AttemptLedger {
  private readonly attempts = new Map<string, number>();
  private readonly maxRetries: number;
  private readonly maxEntries: number;

  constructor(config: { maxRetries?: number; maxEntries?: number } = {}) {
    this.maxRetries = Math.max(1, Math.floor(config.maxRetries ?? DEFAULT_BOUNDS.maxRetries));
    this.maxEntries = config.maxEntries ?? 256;
  }

  registerAttempt(taskId: string, now: number = Date.now()): { allowed: boolean; attempts: number; maxRetries: number } {
    void now;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      // No task identity → nothing to bound against; report the budget only.
      return { allowed: true, attempts: 0, maxRetries: this.maxRetries };
    }
    const current = this.attempts.get(taskId) ?? 0;
    const next = current + 1;
    if (!this.attempts.has(taskId) && this.attempts.size >= this.maxEntries) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    this.attempts.set(taskId, next);
    return { allowed: next <= this.maxRetries, attempts: next, maxRetries: this.maxRetries };
  }

  /** Deterministic read-only view (no mutation). */
  status(taskId: string): { attempts: number; maxRetries: number } {
    return { attempts: this.attempts.get(taskId) ?? 0, maxRetries: this.maxRetries };
  }

  releaseTask(taskId: string): void {
    this.attempts.delete(taskId);
  }

  releaseAll(): void {
    this.attempts.clear();
  }
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — §3 Cross-provider fallback plan (verified-free only).
// ---------------------------------------------------------------------------

export interface FallbackPlanEntry {
  provider: string;
  model: string;
  key: string;
  /** Deterministic reason label: why this candidate qualified. */
  reason: string;
}

export interface FallbackPoolEntry {
  key: string;
  provider: string;
  model: string;
  costClass: string;
  failureDomain: string;
  /** Deterministic ordering score (descending). */
  score: number;
}

/**
 * Build the cross-provider fallback plan from an already-scored candidate
 * pool. HARD rules (documented, deterministic):
 *   1. the primary (excludeKey) is never part of the plan;
 *   2. ONLY candidates whose cost class is FREE_CONFIRMED / FREE_LIMITED AND
 *      whose FIX-A free-claim evidence exists AND is current
 *      (freeClaimIsCurrent) may enter the plan — a candidate with missing or
 *      expired evidence is skipped, and PAID/TRIAL/UNKNOWN can NEVER appear;
 *   3. cross-provider: at least a different provider from the primary;
 *   4. capped at maxFanout, ordered by descending score then key.
 * An empty plan is the HONEST degradation — never a silent paid fallback
 * (paidAutomaticFallback stays DISABLED).
 */
export function planCrossProviderFallbacks(input: {
  pool: FallbackPoolEntry[];
  excludeKey: string;
  freeEvidence: ReadonlyMap<string, FreeClaimEvidence>;
  now: number;
  maxFanout: number;
}): FallbackPlanEntry[] {
  if (!Number.isFinite(input.maxFanout) || input.maxFanout <= 0) return [];
  const ordered = [...input.pool]
    .filter((c) => c.key !== input.excludeKey)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const out: FallbackPlanEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (out.length >= input.maxFanout) break;
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const isFree = candidate.costClass === 'FREE_CONFIRMED' || candidate.costClass === 'FREE_LIMITED';
    const evidence = input.freeEvidence.get(candidate.key);
    const evidenceCurrent = evidence !== undefined && freeClaimIsCurrent(evidence, input.now);
    if (!isFree || !evidenceCurrent) continue; // verified-free ONLY
    if (candidate.provider === input.pool.find((p) => p.key === input.excludeKey)?.provider) continue;
    out.push({
      provider: candidate.provider,
      model: candidate.model,
      key: candidate.key,
      reason: `FREE_CLAIM_${evidence.source}_CURRENT`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — §4 Fast path (deterministic simple-task classifier).
// ---------------------------------------------------------------------------

/**
 * Config-owned simple-task classes (fixed default set; operators may extend
 * via `fastPath.simpleClasses`). Matching is exact after normalization
 * (trim + uppercase), never heuristic.
 */
export const DEFAULT_SIMPLE_TASK_CLASSES: readonly string[] = Object.freeze([
  'SUMMARIZE',
  'TRANSLATE',
  'FORMAT',
  'CLASSIFY',
  'EXTRACT',
  'SHORT_ANSWER',
  'CHAT',
]);

export interface FastPathConfig {
  /** Default false — the fast path is opt-in (behavior-preserving). */
  enabled: boolean;
  simpleClasses: readonly string[];
}

export const DEFAULT_FAST_PATH: Readonly<FastPathConfig> = Object.freeze({
  enabled: false,
  simpleClasses: DEFAULT_SIMPLE_TASK_CLASSES,
});

export function resolveFastPathConfig(config: RouterConfig): FastPathConfig {
  const fp = config.fastPath;
  return {
    enabled: fp?.enabled ?? DEFAULT_FAST_PATH.enabled,
    simpleClasses: fp?.simpleClasses ?? [...DEFAULT_FAST_PATH.simpleClasses],
  };
}

/** Task-class normalization: trim + uppercase + bounded (workflow-policy convention). */
export function normalizeTaskClass(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase().slice(0, 64) : '';
}

/**
 * Deterministic simple-task rule: the fast path applies iff (a) it is
 * enabled, (b) the taskClass OR any label normalizes to a configured simple
 * class, and (c) measured risk evidence (when present) is LOW. No model
 * self-assessment, no content inspection — labels only.
 */
export function isSimpleTask(input: RouteInput, config: FastPathConfig): boolean {
  if (!config.enabled) return false;
  if (input.risk !== undefined && normalizeTaskClass(input.risk) !== 'LOW') return false;
  const simple = new Set(config.simpleClasses.map(normalizeTaskClass));
  if (input.taskClass !== undefined && simple.has(normalizeTaskClass(input.taskClass))) return true;
  if (Array.isArray(input.labels) && input.labels.some((l) => simple.has(normalizeTaskClass(l)))) return true;
  return false;
}
