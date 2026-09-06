/**
 * @dsh-supreme/router — pure selection engine.
 *
 * Hard gates first, then normalized weighted scoring (Spec §11 original).
 * UNKNOWN inputs receive conservative values. No automatic paid fallback:
 * when no candidate is eligible the engine returns BLOCKED_NO_ELIGIBLE_ROUTE
 * and NEVER relaxes gates.
 */

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
}

export interface RouteInput {
  requiredCapabilities?: string[];
  requiredContextTokens?: number;
  risk?: string;
}

export interface CandidateModelPerf {
  avgQuality: number | null;
  samples: number;
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
}

export interface RouterConfig {
  weights: ScoreWeights;
  minBenchmarkSamples: number;
  latencyCeilingMs: number;
  minQuotaHeadroom: number;
  circuit: CircuitConfig;
}

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
  weights: { ...DEFAULT_WEIGHTS },
  minBenchmarkSamples: 5,
  latencyCeilingMs: 30_000,
  minQuotaHeadroom: 0.05,
  circuit: { ...DEFAULT_CIRCUIT },
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
  const hardGates: GateResult[] = [];
  const required = input.requiredCapabilities ?? [];
  const requiredTokens = input.requiredContextTokens ?? 0;

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

    // Gate 7: health / circuit.
    const circuitState = circuit.stateOf(candidate.key, now);
    const healthOk = circuitState.state !== 'CIRCUIT_OPEN';
    push('health_ok', healthOk, healthOk ? circuitState.state : 'CIRCUIT_OPEN');

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
    };
  }

  // Failure-domain diversity input: share of eligible candidates per domain.
  const domainCount = new Map<string, number>();
  for (const c of eligible) domainCount.set(c.failureDomain, (domainCount.get(c.failureDomain) ?? 0) + 1);

  interface Scored {
    candidate: RouterCandidate;
    score: number;
    components: Record<ScoreComponent, number>;
  }
  const scored: Scored[] = eligible.map((candidate) => {
    const perfEntry = perf.get(candidate.key);
    const hasHistory = (perfEntry?.samples ?? 0) >= config.minBenchmarkSamples;
    const quality = hasHistory ? (perfEntry?.avgQuality ?? 0.5) : 0.5; // exploration default
    if (!hasHistory) degraded = true;
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
    const score = SCORE_COMPONENTS.reduce((acc, k) => acc + weights[k] * components[k], 0);
    return { candidate, score, components };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
  const best = scored[0];
  if (!hasExplorationEvidence(perf, config, eligible)) reasonCodes.push('EXPLORATION_NO_HISTORY');
  reasonCodes.push('OK');

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
