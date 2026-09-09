// src/plugins/supreme-router/index.ts
import { z } from "zod";

// src/plugins/supreme-router/engine.ts
var SCORE_COMPONENTS = [
  "quality",
  "health",
  "quota",
  "reliability",
  "latency",
  "capabilityFit",
  "diversity"
];
var DEFAULT_WEIGHTS = Object.freeze({
  quality: 0.3,
  health: 0.2,
  quota: 0.15,
  reliability: 0.1,
  latency: 0.1,
  capabilityFit: 0.1,
  diversity: 0.05
});
var DEFAULT_CIRCUIT = Object.freeze({
  failureThreshold: 3,
  windowMs: 300000,
  cooldownMs: 60000
});

class CircuitBreaker {
  config;
  failures = new Map;
  openedUntil = new Map;
  successes = new Map;
  constructor(config) {
    this.config = config;
  }
  recordFailure(key, now) {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t <= this.config.windowMs);
    list.push(now);
    this.failures.set(key, list);
    if (list.length >= this.config.failureThreshold) {
      this.openedUntil.set(key, now + this.config.cooldownMs);
    }
    return this.stateOf(key, now);
  }
  recordSuccess(key, now) {
    const list = (this.successes.get(key) ?? []).filter((t) => now - t <= this.config.windowMs);
    list.push(now);
    this.successes.set(key, list);
    this.failures.set(key, []);
    this.openedUntil.delete(key);
    return this.stateOf(key, now);
  }
  stateOf(key, now) {
    const openUntil = this.openedUntil.get(key);
    if (openUntil !== undefined && now < openUntil) {
      return {
        key,
        state: "CIRCUIT_OPEN",
        recentFailures: this.failures.get(key)?.length ?? 0,
        openedUntil: openUntil
      };
    }
    const recent = this.failures.get(key)?.length ?? 0;
    let state = "HEALTHY";
    if (recent > 0)
      state = recent >= this.config.failureThreshold ? "DEGRADED" : "DEGRADED";
    return { key, state, recentFailures: recent, openedUntil: null };
  }
  reliability(key, now) {
    const s = (this.successes.get(key) ?? []).filter((t) => now - t <= this.config.windowMs).length;
    const f = (this.failures.get(key) ?? []).filter((t) => now - t <= this.config.windowMs).length;
    if (s + f === 0)
      return 0.5;
    return s / (s + f);
  }
}
function normalizeWeights(raw) {
  const sum = SCORE_COMPONENTS.reduce((acc, k) => acc + (Number.isFinite(raw[k]) ? Math.max(0, raw[k]) : 0), 0);
  if (sum <= 0)
    return { ...DEFAULT_WEIGHTS };
  const out = {};
  for (const k of SCORE_COMPONENTS)
    out[k] = Math.max(0, Number.isFinite(raw[k]) ? raw[k] : 0) / sum;
  return out;
}
var COST_CLASS_ORDER = ["FREE_CONFIRMED", "FREE_LIMITED", "TRIAL", "PAID", "UNKNOWN"];
function costClassRank(costClass) {
  const idx = COST_CLASS_ORDER.indexOf(costClass);
  return idx >= 0 ? idx : COST_CLASS_ORDER.length;
}
var DEFAULT_EFFORT_PACING = Object.freeze({
  enabled: false,
  byCostClass: Object.freeze({
    FREE_CONFIRMED: "low",
    FREE_LIMITED: "low",
    TRIAL: "high",
    PAID: "high",
    UNKNOWN: "high"
  }),
  escalateOnVerifierFail: true
});
function baseEffortFor(pacing, costClass) {
  if (!pacing.enabled)
    return;
  return pacing.byCostClass[costClass];
}
function escalateEffort(effort) {
  switch (effort) {
    case "off":
      return "low";
    case "low":
      return "high";
    case "high":
    case "max":
      return "max";
    default:
      return "high";
  }
}
var DEFAULT_ROUTER_CONFIG = Object.freeze({
  weights: { ...DEFAULT_WEIGHTS },
  minBenchmarkSamples: 5,
  latencyCeilingMs: 30000,
  minQuotaHeadroom: 0.05,
  circuit: { ...DEFAULT_CIRCUIT },
  costFirst: true,
  unscoredEvidenceWeight: 1
});
var HEALTH_SCORE = {
  HEALTHY: 1,
  DEGRADED: 0.5
};
function selectRoute(deps) {
  const { config, candidates, circuit, perf, now, decisionId, input } = deps;
  const { classPerf, outcomeCircuit, freeEvidence } = deps;
  const hardGates = [];
  const required = input.requiredCapabilities ?? [];
  const requiredTokens = input.requiredContextTokens ?? 0;
  const taskClass = input.taskClass;
  const eligible = [];
  for (const candidate of candidates) {
    const push = (gate, passed, reason) => hardGates.push({ gate, candidate: candidate.key, passed, reason });
    const costAllowed = candidate.costClass === "FREE_CONFIRMED" || candidate.costClass === "FREE_LIMITED";
    push("policy_cost", costAllowed, costAllowed ? undefined : `COST_${candidate.costClass}_DENIED`);
    push("provider_available", candidate.providerAvailable, candidate.providerAvailable ? undefined : "PROVIDER_NOT_IN_CATALOG");
    push("credential_available", candidate.credentialConfigured, candidate.credentialConfigured ? undefined : "CREDENTIAL_UNVERIFIED");
    push("model_valid", candidate.modelValid, candidate.modelValid ? undefined : "INVALID_MODEL");
    const missing = required.filter((cap) => !candidate.capabilities.includes(cap));
    push("capability_fit", missing.length === 0, missing.length === 0 ? undefined : `MISSING:${missing.join("+")}`);
    const contextOk = candidate.contextWindow === 0 || candidate.contextWindow >= requiredTokens;
    push("context_sufficient", contextOk, contextOk ? undefined : `CONTEXT_${candidate.contextWindow}_${requiredTokens}`);
    const circuitState = circuit.stateOf(candidate.key, now);
    let healthOk = circuitState.state !== "CIRCUIT_OPEN";
    let healthReason = healthOk ? circuitState.state : "CIRCUIT_OPEN";
    if (healthOk && outcomeCircuit) {
      const keyState = outcomeCircuit.stateOf(candidate.key, now);
      const bucketState = outcomeCircuit.stateOf(providerBucketOf(candidate.provider), now);
      if (keyState.phase === "open" || bucketState.phase === "open") {
        healthOk = false;
        healthReason = "OUTCOME_CIRCUIT_OPEN";
      }
    }
    push("health_ok", healthOk, healthReason);
    const quotaOk = candidate.quotaHeadroom >= config.minQuotaHeadroom;
    push("quota_ok", quotaOk, quotaOk ? undefined : `QUOTA_${candidate.quotaHeadroom.toFixed(2)}`);
    if (costAllowed && candidate.providerAvailable && candidate.credentialConfigured && candidate.modelValid && missing.length === 0 && contextOk && healthOk && quotaOk) {
      eligible.push(candidate);
    }
  }
  const weights = normalizeWeights(config.weights);
  const reasonCodes = [];
  let degraded = false;
  if (eligible.length === 0) {
    reasonCodes.push("BLOCKED_NO_ELIGIBLE_ROUTE");
    const blockedReasons = new Set(hardGates.filter((g) => !g.passed).map((g) => `${g.candidate}:${g.gate}`));
    for (const r of blockedReasons)
      reasonCodes.push(`GATE_FAILED:${r}`);
    return {
      decisionId,
      blocked: "BLOCKED_NO_ELIGIBLE_ROUTE",
      hardGates,
      reasonCodes,
      degraded: false,
      alternatives: [],
      weightsUsed: weights,
      costFirstApplied: false
    };
  }
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
  const domainCount = new Map;
  for (const c of scoringSet)
    domainCount.set(c.failureDomain, (domainCount.get(c.failureDomain) ?? 0) + 1);
  const scored = scoringSet.map((candidate) => {
    const perfEntry = perf.get(candidate.key);
    const hasHistory = (perfEntry?.samples ?? 0) >= config.minBenchmarkSamples;
    const classStat = taskClass !== undefined && classPerf !== undefined ? classPerf.score(candidate.key, taskClass, now) : undefined;
    const classAware = classStat !== undefined && classStat.samples > 0;
    const quality = classAware ? classStat.score : hasHistory ? perfEntry?.avgQuality ?? 0.5 : 0.5;
    if (!hasHistory && !classAware)
      degraded = true;
    const circuitState = circuit.stateOf(candidate.key, now);
    const health = HEALTH_SCORE[circuitState.state] ?? 0;
    if (circuitState.state === "DEGRADED")
      degraded = true;
    const quota = clamp01(candidate.quotaHeadroom);
    const reliability = circuit.reliability(candidate.key, now);
    const latency = 0.5;
    const capabilityFit = required.length === 0 ? 1 : required.filter((cap) => candidate.capabilities.includes(cap)).length / required.length;
    const share = (domainCount.get(candidate.failureDomain) ?? 1) / eligible.length;
    const diversity = clamp01(1 - share);
    const components = {
      quality,
      health,
      quota,
      reliability,
      latency,
      capabilityFit,
      diversity
    };
    let score = SCORE_COMPONENTS.reduce((acc, k) => acc + weights[k] * components[k], 0);
    let downweighted = false;
    if (config.unscoredEvidenceWeight !== 1 && perfEntry?.evidenceBacked === false) {
      score = score * config.unscoredEvidenceWeight;
      downweighted = true;
    }
    return { candidate, score, components, downweighted, classAware };
  });
  scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
  const best = scored[0];
  if (!hasExplorationEvidence(perf, config, eligible))
    reasonCodes.push("EXPLORATION_NO_HISTORY");
  reasonCodes.push("OK");
  const unscoredEvidence = scored.filter((s) => s.downweighted).map((s) => ({ candidate: s.candidate.key, factor: config.unscoredEvidenceWeight }));
  if (unscoredEvidence.length > 0)
    reasonCodes.push("UNSCORED_EVIDENCE_DOWNWEIGHT");
  const selectedClassAware = best.classAware;
  if (selectedClassAware)
    reasonCodes.push("CLASS_AWARE_QUALITY");
  const fastPathConfig = resolveFastPathConfig(config);
  const simpleTask = isSimpleTask(input, fastPathConfig);
  const bounds = resolveBoundsConfig(config);
  const fallbackPlan = simpleTask ? [] : planCrossProviderFallbacks({
    pool: scored.map((s) => ({
      key: s.candidate.key,
      provider: s.candidate.provider,
      model: s.candidate.model,
      costClass: s.candidate.costClass,
      failureDomain: s.candidate.failureDomain,
      score: s.score
    })),
    excludeKey: best.candidate.key,
    freeEvidence: freeEvidence ?? new Map,
    now,
    maxFanout: bounds.maxFanout
  });
  if (simpleTask)
    reasonCodes.push("FAST_PATH_SIMPLE");
  else if (fallbackPlan.length > 0)
    reasonCodes.push("FALLBACK_PLAN_VERIFIED_FREE");
  else if (eligible.length > 1)
    reasonCodes.push("FALLBACK_PLAN_EMPTY_DEGRADED");
  const signal = {};
  if (best.candidate.capabilityClass !== undefined)
    signal.capabilityClass = best.candidate.capabilityClass;
  if (best.candidate.cotVisibility !== undefined)
    signal.cotVisibility = best.candidate.cotVisibility;
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
      score: round4(s.score)
    })),
    weightsUsed: weights,
    costFirstApplied,
    ...simpleTask ? { fastPath: true } : {},
    fanout: fallbackPlan.length,
    ...fallbackPlan.length > 0 ? { fallbackPlan } : {},
    ...taskClass !== undefined ? { taskClass } : {},
    ...signal,
    ...unscoredEvidence.length > 0 ? { unscoredEvidence } : {}
  };
}
function hasExplorationEvidence(perf, config, eligible) {
  return eligible.every((c) => (perf.get(c.key)?.samples ?? 0) >= config.minBenchmarkSamples);
}
function clamp01(v) {
  if (!Number.isFinite(v))
    return 0.5;
  return Math.min(1, Math.max(0, v));
}
function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}
var ROUTE_COST_DENIED_EVENT = "route_cost_denied";
var FREE_ROUTE_EVIDENCE_EVENT = "free_route_evidence";
var COST_POLICY_DENIED_CODE = "COST_POLICY_DENIED";
var COST_POLICY_UNAVAILABLE_REASON = "COST_POLICY_UNAVAILABLE";
function freeClaimEvidence(source, checkedAt, ttlMs) {
  const checked = Number.isFinite(checkedAt) ? Math.max(0, Math.floor(checkedAt)) : 0;
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { source, checkedAt: checked, status: "active", expiresAt: null };
  }
  const expiresAt = checked + Math.floor(ttlMs);
  return { source, checkedAt: checked, status: "active", expiresAt };
}
function freeClaimIsCurrent(evidence, now) {
  if (evidence.status === "expired")
    return false;
  if (evidence.expiresAt === null)
    return true;
  return Number.isFinite(now) && now < evidence.expiresAt;
}
function resolveRouteCostClass(allowlist, provider, model) {
  return allowlist.get(`${provider}::${model}`) ?? "UNKNOWN";
}
function buildRouteCostGate(input) {
  const failClosed = input.policyDecision === null;
  const policyAllowed = input.policyDecision !== null && input.policyDecision.allowed === true;
  const allowed = policyAllowed && input.costClass !== "UNKNOWN";
  const reasonCodes = failClosed ? [COST_POLICY_UNAVAILABLE_REASON] : [...input.policyDecision?.reasonCodes ?? []];
  if (!allowed && input.costClass === "UNKNOWN" && !reasonCodes.includes("COST_UNKNOWN_DENIED")) {
    reasonCodes.push("COST_UNKNOWN_DENIED");
  }
  const freeClaim = allowed && (input.costClass === "FREE_CONFIRMED" || input.costClass === "FREE_LIMITED") ? freeClaimEvidence(input.freeClaimSource ?? "config", input.now) : null;
  return {
    allowed,
    provider: input.provider,
    model: input.model,
    costClass: input.costClass,
    reasonCodes,
    freeClaim
  };
}
function routeCostDeniedMessage(gate) {
  return `supreme-router: LLM dispatch refused by cost policy (${gate.reasonCodes.join("+")}; cost=${gate.costClass}; route=${gate.provider}::${gate.model})`;
}
var WILSON_Z = 1.96;
var DEFAULT_CLASS_HALF_LIFE_MS = 3600000;
function freshnessWeight(at, now, halfLifeMs) {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return 0;
  }
  const ageMs = Math.max(0, now - at);
  return Math.pow(0.5, ageMs / halfLifeMs);
}
function wilsonLowerBound(pHat, n, z = WILSON_Z) {
  if (!Number.isFinite(pHat) || !Number.isFinite(n) || n <= 0)
    return 0.5;
  const p = Math.min(1, Math.max(0, pHat));
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const radius = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  const lb = (centre - radius) / (1 + z2 / n);
  return Math.min(1, Math.max(0, lb));
}

class ClassPerformanceTracker {
  classes = new Map;
  halfLifeMs;
  maxSamplesPerClass;
  maxEntries;
  constructor(opts = {}) {
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_CLASS_HALF_LIFE_MS;
    this.maxSamplesPerClass = opts.maxSamplesPerClass ?? 128;
    this.maxEntries = opts.maxEntries ?? 1024;
  }
  observe(key, taskClass, success, at) {
    if (typeof key !== "string" || key.length === 0 || typeof taskClass !== "string" || taskClass.length === 0)
      return;
    const cls = normalizeTaskClass(taskClass);
    const perClass = this.classes.get(key) ?? new Map;
    if (!this.classes.has(key)) {
      if (this.classes.size >= this.maxEntries) {
        const oldest = this.classes.keys().next().value;
        if (oldest !== undefined)
          this.classes.delete(oldest);
      }
      this.classes.set(key, perClass);
    }
    const list = perClass.get(cls) ?? [];
    if (!perClass.has(cls)) {
      if (perClass.size >= 32) {
        const oldest = perClass.keys().next().value;
        if (oldest !== undefined)
          perClass.delete(oldest);
      }
      perClass.set(cls, list);
    }
    list.push({ success: success === true, at: Number.isFinite(at) ? at : 0 });
    if (list.length > this.maxSamplesPerClass)
      list.shift();
  }
  score(key, taskClass, now) {
    const list = this.classes.get(key)?.get(normalizeTaskClass(taskClass));
    if (!list || list.length === 0)
      return { score: 0.5, samples: 0, nEff: 0 };
    let weightSum = 0;
    let weightedSuccess = 0;
    for (const sample of list) {
      const w = freshnessWeight(sample.at, now, this.halfLifeMs);
      weightSum += w;
      if (sample.success)
        weightedSuccess += w;
    }
    const pHat = weightSum > 0 ? weightedSuccess / weightSum : undefined;
    const score = weightSum > 0 ? wilsonLowerBound(pHat ?? 0.5, weightSum) : 0.5;
    return { score, samples: list.length, nEff: weightSum, ...pHat !== undefined ? { pHat } : {} };
  }
}
function providerBucketOf(provider) {
  return `${provider}::*`;
}
function classifyFailure(failure) {
  const code = failure && typeof failure === "object" && typeof failure.code === "string" ? failure.code : "";
  if (code === "VERIFICATION")
    return "verifier";
  if (code === "AUTH" || code === "MISSING_CREDENTIAL" || code === "INVALID_CREDENTIAL" || code === "HTTP_401" || code === "HTTP_403") {
    return "credential";
  }
  if (code === "RATE_LIMIT" || code === "QUOTA" || code === "HTTP_429" || code === "HTTP_402") {
    return "rate_limit";
  }
  if (code === "TIMEOUT" || code.endsWith("_TIMEOUT") && code !== "ABORTED")
    return "timeout";
  return "other";
}
var DEFAULT_OUTCOME_CIRCUIT = Object.freeze({
  consecutiveFailures: 3,
  cooldownMs: 60000
});

class OutcomeCircuitBreaker {
  config;
  entries = new Map;
  maxEntries;
  constructor(config = {}, opts = {}) {
    this.config = {
      consecutiveFailures: config.consecutiveFailures ?? DEFAULT_OUTCOME_CIRCUIT.consecutiveFailures,
      cooldownMs: config.cooldownMs ?? DEFAULT_OUTCOME_CIRCUIT.cooldownMs
    };
    this.maxEntries = opts.maxEntries ?? 512;
  }
  entry(key) {
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined)
          this.entries.delete(oldest);
      }
      e = { consecutive: 0, lastClass: null, openedUntil: null, probeGranted: false };
      this.entries.set(key, e);
    }
    return e;
  }
  recordFailure(key, now, outcomeClass = "other") {
    const e = this.entry(key);
    e.consecutive += 1;
    e.lastClass = outcomeClass;
    if (e.consecutive >= this.config.consecutiveFailures) {
      e.openedUntil = now + this.config.cooldownMs;
    }
    e.probeGranted = false;
    return this.stateOf(key, now);
  }
  recordSuccess(key, now) {
    const e = this.entry(key);
    e.consecutive = 0;
    e.lastClass = null;
    e.openedUntil = null;
    e.probeGranted = false;
    const bucketKey = providerBucketOf(key.split("::")[0] ?? "");
    if (bucketKey !== key && bucketKey !== "::*") {
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
  stateOf(key, now) {
    const e = this.entries.get(key);
    if (!e)
      return { key, phase: "closed", consecutiveFailures: 0, lastOutcomeClass: null, openedUntil: null, probeGranted: false };
    if (e.openedUntil !== null && now < e.openedUntil) {
      return { key, phase: "open", consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: e.openedUntil, probeGranted: e.probeGranted };
    }
    if (e.openedUntil !== null) {
      return { key, phase: "half_open", consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: null, probeGranted: e.probeGranted };
    }
    return { key, phase: "closed", consecutiveFailures: e.consecutive, lastOutcomeClass: e.lastClass, openedUntil: null, probeGranted: e.probeGranted };
  }
  acquireProbe(key, now) {
    const state = this.stateOf(key, now);
    if (state.phase !== "half_open" || state.probeGranted)
      return false;
    this.entry(key).probeGranted = true;
    return true;
  }
  snapshot(now) {
    return [...this.entries.keys()].map((key) => this.stateOf(key, now));
  }
}
var DEFAULT_BOUNDS = Object.freeze({
  maxRetries: 3,
  maxFanout: 4,
  wallClockBudgetMs: 0
});
function resolveBoundsConfig(config) {
  const b = config.bounds;
  return {
    maxRetries: b?.maxRetries ?? DEFAULT_BOUNDS.maxRetries,
    maxFanout: b?.maxFanout ?? DEFAULT_BOUNDS.maxFanout,
    wallClockBudgetMs: b?.wallClockBudgetMs ?? DEFAULT_BOUNDS.wallClockBudgetMs
  };
}
function withinWallClock(startedAt, now, budgetMs) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    return true;
  if (!Number.isFinite(startedAt) || !Number.isFinite(now))
    return true;
  return now - startedAt <= budgetMs;
}

class AttemptLedger {
  attempts = new Map;
  maxRetries;
  maxEntries;
  constructor(config = {}) {
    this.maxRetries = Math.max(1, Math.floor(config.maxRetries ?? DEFAULT_BOUNDS.maxRetries));
    this.maxEntries = config.maxEntries ?? 256;
  }
  registerAttempt(taskId, now = Date.now()) {
    if (typeof taskId !== "string" || taskId.length === 0) {
      return { allowed: true, attempts: 0, maxRetries: this.maxRetries };
    }
    const current = this.attempts.get(taskId) ?? 0;
    const next = current + 1;
    if (!this.attempts.has(taskId) && this.attempts.size >= this.maxEntries) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined)
        this.attempts.delete(oldest);
    }
    this.attempts.set(taskId, next);
    return { allowed: next <= this.maxRetries, attempts: next, maxRetries: this.maxRetries };
  }
  status(taskId) {
    return { attempts: this.attempts.get(taskId) ?? 0, maxRetries: this.maxRetries };
  }
  releaseTask(taskId) {
    this.attempts.delete(taskId);
  }
  releaseAll() {
    this.attempts.clear();
  }
}
function planCrossProviderFallbacks(input) {
  if (!Number.isFinite(input.maxFanout) || input.maxFanout <= 0)
    return [];
  const ordered = [...input.pool].filter((c) => c.key !== input.excludeKey).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const out = [];
  const seen = new Set;
  for (const candidate of ordered) {
    if (out.length >= input.maxFanout)
      break;
    if (seen.has(candidate.key))
      continue;
    seen.add(candidate.key);
    const isFree = candidate.costClass === "FREE_CONFIRMED" || candidate.costClass === "FREE_LIMITED";
    const evidence = input.freeEvidence.get(candidate.key);
    const evidenceCurrent = evidence !== undefined && freeClaimIsCurrent(evidence, input.now);
    if (!isFree || !evidenceCurrent)
      continue;
    if (candidate.provider === input.pool.find((p) => p.key === input.excludeKey)?.provider)
      continue;
    out.push({
      provider: candidate.provider,
      model: candidate.model,
      key: candidate.key,
      reason: `FREE_CLAIM_${evidence.source}_CURRENT`
    });
  }
  return out;
}
var DEFAULT_SIMPLE_TASK_CLASSES = Object.freeze([
  "SUMMARIZE",
  "TRANSLATE",
  "FORMAT",
  "CLASSIFY",
  "EXTRACT",
  "SHORT_ANSWER",
  "CHAT"
]);
var DEFAULT_FAST_PATH = Object.freeze({
  enabled: false,
  simpleClasses: DEFAULT_SIMPLE_TASK_CLASSES
});
function resolveFastPathConfig(config) {
  const fp = config.fastPath;
  return {
    enabled: fp?.enabled ?? DEFAULT_FAST_PATH.enabled,
    simpleClasses: fp?.simpleClasses ?? [...DEFAULT_FAST_PATH.simpleClasses]
  };
}
function normalizeTaskClass(raw) {
  return typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 64) : "";
}
function isSimpleTask(input, config) {
  if (!config.enabled)
    return false;
  if (input.risk !== undefined && normalizeTaskClass(input.risk) !== "LOW")
    return false;
  const simple = new Set(config.simpleClasses.map(normalizeTaskClass));
  if (input.taskClass !== undefined && simple.has(normalizeTaskClass(input.taskClass)))
    return true;
  if (Array.isArray(input.labels) && input.labels.some((l) => simple.has(normalizeTaskClass(l))))
    return true;
  return false;
}

// src/plugins/supreme-router/index.ts
var name = "supreme-router";
var inject = ["llm", "supremePolicy", "supremeObservability", "supremeBenchmark"];

class RouteCostDeniedError extends Error {
  code = COST_POLICY_DENIED_CODE;
  constructor(message) {
    super(message);
    this.name = "RouteCostDeniedError";
  }
}
var candidateModelSchema = z.object({
  model: z.string().min(1),
  costClass: z.enum(["FREE_CONFIRMED", "FREE_LIMITED", "TRIAL", "PAID", "UNKNOWN"]).default("UNKNOWN"),
  capabilities: z.array(z.string()).default([]),
  contextWindow: z.number().int().min(0).default(0),
  failureDomain: z.string().default("default"),
  capabilityClass: z.string().min(1).max(64).optional(),
  cotVisibility: z.enum(["verbose", "terse", "none"]).optional()
});
var candidateProviderSchema = z.object({
  provider: z.string().min(1),
  credentialMode: z.enum(["config-owned", "service"]).default("service"),
  credentialConfigured: z.boolean().default(false),
  credentialRef: z.string().optional(),
  quotaHeadroom: z.number().min(0).max(1).default(0.5),
  models: z.array(candidateModelSchema).min(1)
});
var Config = z.object({
  candidates: z.array(candidateProviderSchema).default([]),
  weights: z.object({
    quality: z.number().min(0).default(0.3),
    health: z.number().min(0).default(0.2),
    quota: z.number().min(0).default(0.15),
    reliability: z.number().min(0).default(0.1),
    latency: z.number().min(0).default(0.1),
    capabilityFit: z.number().min(0).default(0.1),
    diversity: z.number().min(0).default(0.05)
  }).default({ quality: 0.3, health: 0.2, quota: 0.15, reliability: 0.1, latency: 0.1, capabilityFit: 0.1, diversity: 0.05 }),
  minBenchmarkSamples: z.number().int().min(1).default(5),
  latencyCeilingMs: z.number().int().min(100).default(30000),
  minQuotaHeadroom: z.number().min(0).max(1).default(0.05),
  circuit: z.object({
    failureThreshold: z.number().int().min(1).default(3),
    windowMs: z.number().int().min(1000).default(300000),
    cooldownMs: z.number().int().min(0).default(60000)
  }).default({ failureThreshold: 3, windowMs: 300000, cooldownMs: 60000 }),
  costFirst: z.boolean().default(true),
  unscoredEvidenceWeight: z.number().min(0).max(1).default(1),
  effortPacing: z.object({
    enabled: z.boolean().default(false),
    byCostClass: z.record(z.string(), z.enum(["off", "low", "high", "max"])).default({ FREE_CONFIRMED: "low", FREE_LIMITED: "low", TRIAL: "high", PAID: "high", UNKNOWN: "high" }),
    escalateOnVerifierFail: z.boolean().default(true)
  }).default({ enabled: false, byCostClass: { FREE_CONFIRMED: "low", FREE_LIMITED: "low", TRIAL: "high", PAID: "high", UNKNOWN: "high" }, escalateOnVerifierFail: true }),
  bounds: z.object({
    maxRetries: z.number().int().min(1).max(64).default(3),
    maxFanout: z.number().int().min(0).max(64).default(4),
    wallClockBudgetMs: z.number().int().min(0).default(0)
  }).default({ maxRetries: 3, maxFanout: 4, wallClockBudgetMs: 0 }),
  fastPath: z.object({
    enabled: z.boolean().default(false),
    simpleClasses: z.array(z.string().min(1).max(64)).default([...DEFAULT_SIMPLE_TASK_CLASSES])
  }).default({ enabled: false, simpleClasses: [...DEFAULT_SIMPLE_TASK_CLASSES] }),
  outcomeCircuit: z.object({
    enabled: z.boolean().default(true),
    consecutiveFailures: z.number().int().min(1).max(64).default(3),
    cooldownMs: z.number().int().min(0).default(60000)
  }).default({ enabled: true, consecutiveFailures: 3, cooldownMs: 60000 }),
  classAware: z.object({
    enabled: z.boolean().default(true),
    halfLifeMs: z.number().int().min(1000).default(3600000),
    sampleLimit: z.number().int().min(16).max(4096).default(512)
  }).default({ enabled: true, halfLifeMs: 3600000, sampleLimit: 512 })
});
function apply(ctx, config) {
  const deps = {
    llm: ctx.llm,
    supremePolicy: ctx.supremePolicy,
    supremeObservability: ctx.supremeObservability,
    supremeBenchmark: ctx.supremeBenchmark
  };
  const routerConfig = {
    weights: config.weights,
    minBenchmarkSamples: config.minBenchmarkSamples,
    latencyCeilingMs: config.latencyCeilingMs,
    minQuotaHeadroom: config.minQuotaHeadroom,
    circuit: config.circuit,
    costFirst: config.costFirst,
    unscoredEvidenceWeight: config.unscoredEvidenceWeight,
    bounds: config.bounds,
    fastPath: config.fastPath
  };
  const effortPacing = {
    enabled: config.effortPacing.enabled,
    byCostClass: { ...config.effortPacing.byCostClass },
    escalateOnVerifierFail: config.effortPacing.escalateOnVerifierFail
  };
  const circuit = new CircuitBreaker(routerConfig.circuit);
  const outcomeCircuitEnabled = config.outcomeCircuit.enabled;
  const outcomeCircuit = new OutcomeCircuitBreaker({
    consecutiveFailures: config.outcomeCircuit.consecutiveFailures,
    cooldownMs: config.outcomeCircuit.cooldownMs
  });
  const attemptLedger = new AttemptLedger({ maxRetries: config.bounds.maxRetries });
  const classHalfLifeMs = config.classAware.halfLifeMs;
  const classSampleLimit = config.classAware.sampleLimit;
  const candidatesConfig = config.candidates;
  const context = ctx;
  const costClassByKey = new Map;
  for (const entry of candidatesConfig) {
    for (const model of entry.models)
      costClassByKey.set(`${entry.provider}::${model.model}`, model.costClass);
  }
  const escalatedKeys = new Set;
  const ESCALATION_LIMIT = 256;
  async function credentialConfiguredFor(entry) {
    if (entry.credentialMode === "config-owned")
      return entry.credentialConfigured;
    const credentials = context.get("credentials");
    if (!credentials || !entry.credentialRef)
      return false;
    try {
      const info = await credentials.describe(entry.credentialRef);
      return info.configured === true;
    } catch {
      return false;
    }
  }
  const freeEvidenceRecorded = new Set;
  const FREE_EVIDENCE_LIMIT = 256;
  const freeClaimByKey = new Map;
  function routeCostGate(provider, model, seam) {
    const costClass = resolveRouteCostClass(costClassByKey, provider, model);
    const policy = deps.supremePolicy;
    const decision = policy && typeof policy.evaluateRoute === "function" ? policy.evaluateRoute({ costClass, risk: "LOW" }) : null;
    const gate = buildRouteCostGate({ provider, model, costClass, policyDecision: decision, now: Date.now() });
    const routeKey = `${provider}::${model}`;
    if (!gate.allowed) {
      deps.supremeObservability?.record(ROUTE_COST_DENIED_EVENT, {
        provider: gate.provider,
        model: gate.model,
        costClass: gate.costClass,
        seam,
        reason: gate.reasonCodes.join("+")
      });
      return gate;
    }
    if (gate.freeClaim !== null) {
      freeClaimByKey.set(routeKey, gate.freeClaim);
      if (freeClaimByKey.size > FREE_EVIDENCE_LIMIT) {
        const oldestClaim = freeClaimByKey.keys().next().value;
        if (oldestClaim !== undefined)
          freeClaimByKey.delete(oldestClaim);
      }
      if (!freeEvidenceRecorded.has(routeKey)) {
        if (freeEvidenceRecorded.size >= FREE_EVIDENCE_LIMIT) {
          const oldest = freeEvidenceRecorded.values().next().value;
          if (oldest !== undefined)
            freeEvidenceRecorded.delete(oldest);
        }
        freeEvidenceRecorded.add(routeKey);
        deps.supremeObservability?.record(FREE_ROUTE_EVIDENCE_EVENT, {
          provider: gate.provider,
          model: gate.model,
          costClass: gate.costClass,
          source: gate.freeClaim.source,
          checkedAt: gate.freeClaim.checkedAt,
          status: gate.freeClaim.status,
          expiresAt: gate.freeClaim.expiresAt
        });
      }
    }
    return gate;
  }
  const service = {
    async route(input) {
      const now = Date.now();
      const decisionId = genId("route");
      let liveProviders = [];
      try {
        liveProviders = deps.llm.listProviders().map((p) => typeof p === "string" ? p : p.id ?? p.provider ?? "").filter((id) => id.length > 0);
      } catch {
        liveProviders = [];
      }
      const perf = new Map;
      try {
        for (const agg of deps.supremeBenchmark.aggregateModelPerformance()) {
          const scoredSamples = agg.scoredSamples ?? 0;
          const evidenceBackedScores = agg.evidenceBackedScores ?? 0;
          perf.set(`${agg.provider}::${agg.model}`, {
            avgQuality: agg.avgQuality,
            samples: agg.samples,
            evidenceBacked: scoredSamples > 0 ? evidenceBackedScores === scoredSamples : true
          });
        }
      } catch {}
      const candidates = [];
      for (const entry of candidatesConfig) {
        const credentialConfigured = await credentialConfiguredFor(entry);
        for (const model of entry.models) {
          let modelValid = false;
          let contextWindow = model.contextWindow;
          try {
            const resolved = await deps.llm.resolveModelInfo(entry.provider, model.model);
            modelValid = Boolean(resolved);
            if (resolved?.context?.contextWindow)
              contextWindow = resolved.context.contextWindow;
          } catch {
            modelValid = false;
          }
          candidates.push({
            key: `${entry.provider}::${model.model}`,
            provider: entry.provider,
            model: model.model,
            costClass: model.costClass,
            capabilities: model.capabilities,
            contextWindow,
            credentialConfigured,
            quotaHeadroom: entry.quotaHeadroom,
            failureDomain: model.failureDomain,
            providerAvailable: liveProviders.includes(entry.provider),
            modelValid,
            ...model.capabilityClass !== undefined ? { capabilityClass: model.capabilityClass } : {},
            ...model.cotVisibility !== undefined ? { cotVisibility: model.cotVisibility } : {}
          });
        }
      }
      let classPerf;
      if (config.classAware.enabled && input.taskClass !== undefined) {
        classPerf = new ClassPerformanceTracker({ halfLifeMs: classHalfLifeMs });
        try {
          const bench = deps.supremeBenchmark;
          for (const row of bench.classSamples?.(classSampleLimit) ?? []) {
            classPerf.observe(`${row.provider}::${row.model}`, row.taskClass, row.success, row.at);
          }
        } catch {
          classPerf = undefined;
        }
      }
      const freeEvidence = new Map;
      for (const candidate of candidates) {
        if (candidate.costClass === "FREE_CONFIRMED" || candidate.costClass === "FREE_LIMITED") {
          freeEvidence.set(candidate.key, freeClaimByKey.get(candidate.key) ?? freeClaimEvidence("config", now));
        }
      }
      const decision = selectRoute({
        config: routerConfig,
        candidates,
        circuit,
        perf,
        now,
        decisionId,
        input,
        ...classPerf !== undefined ? { classPerf } : {},
        ...outcomeCircuitEnabled ? { outcomeCircuit } : {},
        freeEvidence
      });
      deps.supremeObservability.record("route_decision", {
        routeDecisionId: decision.decisionId,
        provider: decision.provider,
        model: decision.model,
        capabilityClass: decision.capabilityClass,
        cotVisibility: decision.cotVisibility,
        detail: decision.blocked ? `blocked:${decision.reasonCodes.filter((r) => r.startsWith("GATE_FAILED")).length}gates` : `score:${decision.score ?? 0}`
      });
      if (decision.fastPath === true) {
        deps.supremeObservability.record("route_fast_path", {
          routeDecisionId: decision.decisionId,
          provider: decision.provider,
          model: decision.model
        });
      }
      if ((decision.fallbackPlan?.length ?? 0) > 0) {
        deps.supremeObservability.record("fallback_planned", {
          routeDecisionId: decision.decisionId,
          detail: `fanout:${decision.fallbackPlan?.length}:${(decision.fallbackPlan ?? []).map((f) => f.key).join(",")}`.slice(0, 256)
        });
      }
      for (const entry of decision.unscoredEvidence ?? []) {
        deps.supremeObservability.record("unscored_evidence", {
          candidate: entry.candidate,
          appliedFactor: entry.factor,
          routeDecisionId: decision.decisionId
        });
      }
      return decision;
    },
    recordOutcome({ provider, model, success, failureClass }) {
      const key = `${provider}::${model}`;
      const now = Date.now();
      if (success)
        circuit.recordSuccess(key, now);
      else
        circuit.recordFailure(key, now);
      if (outcomeCircuitEnabled) {
        const outcomeClass = success ? null : failureClass !== undefined ? classifyFailure({ code: failureClass }) : "other";
        if (success) {
          outcomeCircuit.recordSuccess(key, now);
        } else {
          const state = outcomeCircuit.recordFailure(key, now, outcomeClass ?? "other");
          if (state.phase === "open") {
            deps.supremeObservability.record("circuit_opened", {
              provider,
              model,
              errorClass: outcomeClass ?? "other",
              detail: `consecutive:${state.consecutiveFailures}`
            });
          }
        }
        deps.supremeObservability.record("outcome_recorded", {
          provider,
          model,
          errorClass: outcomeClass ?? "none",
          detail: success ? "success" : "failure"
        });
      }
    },
    healthSnapshot() {
      const now = Date.now();
      const keys = new Set;
      for (const entry of candidatesConfig)
        for (const m of entry.models)
          keys.add(`${entry.provider}::${m.model}`);
      return [...keys].map((key) => circuit.stateOf(key, now));
    },
    effortFor({ provider, model, verifierFailed }) {
      const costClass = costClassByKey.get(`${provider}::${model}`);
      if (costClass === undefined)
        return;
      const base = baseEffortFor(effortPacing, costClass);
      if (base === undefined)
        return;
      const key = `${provider}::${model}`;
      const escalated = effortPacing.escalateOnVerifierFail && (verifierFailed === true || escalatedKeys.has(key));
      return escalated ? escalateEffort(base) : base;
    },
    reportVerifierOutcome({ provider, model, passed }) {
      const key = `${provider}::${model}`;
      if (outcomeCircuitEnabled) {
        const now = Date.now();
        if (passed)
          outcomeCircuit.recordSuccess(key, now);
        else {
          const state = outcomeCircuit.recordFailure(key, now, "verifier");
          if (state.phase === "open") {
            deps.supremeObservability.record("circuit_opened", {
              provider,
              model,
              errorClass: "verifier",
              detail: `consecutive:${state.consecutiveFailures}`
            });
          }
        }
      }
      if (!effortPacing.enabled || !effortPacing.escalateOnVerifierFail)
        return;
      if (passed) {
        escalatedKeys.delete(key);
        return;
      }
      if (escalatedKeys.size >= ESCALATION_LIMIT && !escalatedKeys.has(key)) {
        const oldest = escalatedKeys.values().next().value;
        if (oldest !== undefined)
          escalatedKeys.delete(oldest);
      }
      escalatedKeys.add(key);
    },
    registerAttempt(taskId) {
      const result = attemptLedger.registerAttempt(taskId);
      if (!result.allowed) {
        deps.supremeObservability.record("retry_bound_refused", {
          detail: `attempts:${result.attempts}/max:${result.maxRetries}`.slice(0, 256)
        });
      }
      return result;
    },
    attemptStatus(taskId) {
      return attemptLedger.status(taskId);
    },
    withinBudget(startedAt, now) {
      return withinWallClock(startedAt, now, routerConfig.bounds?.wallClockBudgetMs ?? 0);
    },
    outcomeSnapshot() {
      return outcomeCircuitEnabled ? outcomeCircuit.snapshot(Date.now()).map((s) => ({
        key: s.key,
        phase: s.phase,
        consecutiveFailures: s.consecutiveFailures,
        lastOutcomeClass: s.lastOutcomeClass,
        openedUntil: s.openedUntil
      })) : [];
    },
    acquireProbe(provider, model) {
      if (!outcomeCircuitEnabled)
        return true;
      return outcomeCircuit.acquireProbe(`${provider}::${model}`, Date.now());
    },
    config: () => routerConfig
  };
  ctx.provide("supremeRouter", Object.freeze(service));
  ctx.on("agent/request", async (_payload, next) => {
    const call = await next();
    const gate = routeCostGate(call.provider, call.model, "agent/request");
    if (!gate.allowed)
      return { ...call, provider: "", model: "" };
    if (!effortPacing.enabled)
      return call;
    const costClass = costClassByKey.get(`${call.provider}::${call.model}`);
    if (costClass === undefined)
      return call;
    const base = baseEffortFor(effortPacing, costClass);
    if (base === undefined)
      return call;
    const escalated = effortPacing.escalateOnVerifierFail && escalatedKeys.has(`${call.provider}::${call.model}`);
    const effort = escalated ? escalateEffort(base) : base;
    if (call.reasoningEffort === effort)
      return call;
    deps.supremeObservability.record("effort_pacing", {
      provider: call.provider,
      model: call.model,
      detail: `${call.reasoningEffort ?? "adapter-default"}->${effort}${escalated ? ":escalated" : ""}`
    });
    return { ...call, reasoningEffort: effort };
  });
  ctx.on("llm/stream", (options, next) => {
    const gate = routeCostGate(options.provider, options.model, "llm/stream");
    if (!gate.allowed)
      throw new RouteCostDeniedError(routeCostDeniedMessage(gate));
    return next();
  });
  ctx.on("agent/request-error", (payload, next) => next().then((action) => {
    if (outcomeCircuitEnabled) {
      const outcomeClass = classifyFailure(payload.failure);
      const state = outcomeCircuit.recordFailure(providerBucketOf(payload.provider), Date.now(), outcomeClass);
      deps.supremeObservability.record("outcome_recorded", {
        provider: payload.provider,
        errorClass: outcomeClass,
        detail: `failure:agent/request-error${state.phase === "open" ? ":circuit_open" : ""}`.slice(0, 256)
      });
      if (state.phase === "open") {
        deps.supremeObservability.record("circuit_opened", {
          provider: payload.provider,
          errorClass: outcomeClass,
          detail: `consecutive:${state.consecutiveFailures}:bucket`
        });
      }
    }
    return action;
  }));
  ctx.logger.info("supreme-router active with %d configured candidates (costFirst=%s effortPacing=%s costEnforcement=ENFORCE)", candidatesConfig.length, String(routerConfig.costFirst), String(effortPacing.enabled));
}
function genId(prefix) {
  const g = globalThis;
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
export {
  name,
  inject,
  apply,
  Config
};
