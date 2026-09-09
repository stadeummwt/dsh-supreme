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
  const hardGates = [];
  const required = input.requiredCapabilities ?? [];
  const requiredTokens = input.requiredContextTokens ?? 0;
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
    const healthOk = circuitState.state !== "CIRCUIT_OPEN";
    push("health_ok", healthOk, healthOk ? circuitState.state : "CIRCUIT_OPEN");
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
    const quality = hasHistory ? perfEntry?.avgQuality ?? 0.5 : 0.5;
    if (!hasHistory)
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
    return { candidate, score, components, downweighted };
  });
  scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
  const best = scored[0];
  if (!hasExplorationEvidence(perf, config, eligible))
    reasonCodes.push("EXPLORATION_NO_HISTORY");
  reasonCodes.push("OK");
  const unscoredEvidence = scored.filter((s) => s.downweighted).map((s) => ({ candidate: s.candidate.key, factor: config.unscoredEvidenceWeight }));
  if (unscoredEvidence.length > 0)
    reasonCodes.push("UNSCORED_EVIDENCE_DOWNWEIGHT");
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

// src/plugins/supreme-router/index.ts
var name = "supreme-router";
var inject = ["llm", "supremePolicy", "supremeObservability", "supremeBenchmark"];
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
  }).default({ enabled: false, byCostClass: { FREE_CONFIRMED: "low", FREE_LIMITED: "low", TRIAL: "high", PAID: "high", UNKNOWN: "high" }, escalateOnVerifierFail: true })
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
    unscoredEvidenceWeight: config.unscoredEvidenceWeight
  };
  const effortPacing = {
    enabled: config.effortPacing.enabled,
    byCostClass: { ...config.effortPacing.byCostClass },
    escalateOnVerifierFail: config.effortPacing.escalateOnVerifierFail
  };
  const circuit = new CircuitBreaker(routerConfig.circuit);
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
      const decision = selectRoute({
        config: routerConfig,
        candidates,
        circuit,
        perf,
        now,
        decisionId,
        input
      });
      deps.supremeObservability.record("route_decision", {
        routeDecisionId: decision.decisionId,
        provider: decision.provider,
        model: decision.model,
        capabilityClass: decision.capabilityClass,
        cotVisibility: decision.cotVisibility,
        detail: decision.blocked ? `blocked:${decision.reasonCodes.filter((r) => r.startsWith("GATE_FAILED")).length}gates` : `score:${decision.score ?? 0}`
      });
      for (const entry of decision.unscoredEvidence ?? []) {
        deps.supremeObservability.record("unscored_evidence", {
          candidate: entry.candidate,
          appliedFactor: entry.factor,
          routeDecisionId: decision.decisionId
        });
      }
      return decision;
    },
    recordOutcome({ provider, model, success }) {
      const key = `${provider}::${model}`;
      const now = Date.now();
      if (success)
        circuit.recordSuccess(key, now);
      else
        circuit.recordFailure(key, now);
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
      if (!effortPacing.enabled || !effortPacing.escalateOnVerifierFail)
        return;
      const key = `${provider}::${model}`;
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
    config: () => routerConfig
  };
  ctx.provide("supremeRouter", Object.freeze(service));
  ctx.on("agent/request", async (_payload, next) => {
    const call = await next();
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
  ctx.logger.info("supreme-router active with %d configured candidates (costFirst=%s effortPacing=%s)", candidatesConfig.length, String(routerConfig.costFirst), String(effortPacing.enabled));
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
