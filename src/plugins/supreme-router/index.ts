/**
 * @dsh-supreme/router — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeRouter
 * INJECTED DSH SERVICES = ['llm', 'supremePolicy', 'supremeObservability', 'supremeBenchmark']
 *
 * Verified against pinned upstream:
 *   - ctx.llm: packages/llm/llm/src/index.ts:326-339 (listProviders :466, listModels :688,
 *     resolveModelInfo :726 — throws LlmError on invalid model)
 *   - ctx.supremePolicy / supremeObservability / supremeBenchmark: our own services
 *
 * The router SELECTS; it never performs provider HTTP. Actual execution stays
 * with the official DSH LLM adapters (ctx.llm.stream / agent/request waterfall).
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  CircuitBreaker,
  baseEffortFor,
  escalateEffort,
  selectRoute,
  type CandidateModelPerf,
  type CircuitConfig,
  type EffortPacingConfig,
  type HealthState,
  type ReasoningEffortLevel,
  type RouteDecision,
  type RouterCandidate,
  type RouterConfig,
  type ScoreWeights,
} from './engine';
import type { PolicyService } from '../supreme-policy/index';
import type { ObservabilityService } from '../supreme-observability/index';
import type { BenchmarkService } from '../supreme-benchmark/index';
import type { CostClass } from '../supreme-policy/engine';

import '../context-types';
export const name = 'supreme-router';

export const inject = ['llm', 'supremePolicy', 'supremeObservability', 'supremeBenchmark'];

const candidateModelSchema = z.object({
  model: z.string().min(1),
  costClass: z.enum(['FREE_CONFIRMED', 'FREE_LIMITED', 'TRIAL', 'PAID', 'UNKNOWN']).default('UNKNOWN'),
  capabilities: z.array(z.string()).default([]),
  contextWindow: z.number().int().min(0).default(0),
  failureDomain: z.string().default('default'),
});

const candidateProviderSchema = z.object({
  provider: z.string().min(1),
  /** 'config-owned' trusts the explicit credentialConfigured flag (synthetic/test rigs). */
  credentialMode: z.enum(['config-owned', 'service']).default('service'),
  credentialConfigured: z.boolean().default(false),
  credentialRef: z.string().optional(),
  quotaHeadroom: z.number().min(0).max(1).default(0.5),
  models: z.array(candidateModelSchema).min(1),
});

export const Config = z.object({
  candidates: z.array(candidateProviderSchema).default([]),
  weights: z
    .object({
      quality: z.number().min(0).default(0.3),
      health: z.number().min(0).default(0.2),
      quota: z.number().min(0).default(0.15),
      reliability: z.number().min(0).default(0.1),
      latency: z.number().min(0).default(0.1),
      capabilityFit: z.number().min(0).default(0.1),
      diversity: z.number().min(0).default(0.05),
    })
    .default({ quality: 0.3, health: 0.2, quota: 0.15, reliability: 0.1, latency: 0.1, capabilityFit: 0.1, diversity: 0.05 }),
  minBenchmarkSamples: z.number().int().min(1).default(5),
  latencyCeilingMs: z.number().int().min(100).default(30_000),
  minQuotaHeadroom: z.number().min(0).max(1).default(0.05),
  circuit: z
    .object({
      failureThreshold: z.number().int().min(1).default(3),
      windowMs: z.number().int().min(1000).default(300_000),
      cooldownMs: z.number().int().min(0).default(60_000),
    })
    .default({ failureThreshold: 3, windowMs: 300_000, cooldownMs: 60_000 }),
  /** v1.2: RM0-first — score only the cheapest eligible cost class (policy gates still run first). */
  costFirst: z.boolean().default(true),
  /**
   * v1.2: deterministic reasoning-effort pacing over the agent/request seam.
   * Levels are the PINNED DeepSeek adapter set: off | low | high | max
   * (anything else is rejected upstream with UNSUPPORTED_REASONING_EFFORT).
   * Escalation fires ONLY on verifier FAIL evidence (mechanical, never model
   * self-confidence). disabled by default — opt-in pacing.
   */
  effortPacing: z
    .object({
      enabled: z.boolean().default(false),
      byCostClass: z
        .record(z.string(), z.enum(['off', 'low', 'high', 'max']))
        .default({ FREE_CONFIRMED: 'low', FREE_LIMITED: 'low', TRIAL: 'high', PAID: 'high', UNKNOWN: 'high' }),
      escalateOnVerifierFail: z.boolean().default(true),
    })
    .default({ enabled: false, byCostClass: { FREE_CONFIRMED: 'low', FREE_LIMITED: 'low', TRIAL: 'high', PAID: 'high', UNKNOWN: 'high' }, escalateOnVerifierFail: true }),
});

interface ResolvedCandidateConfig {
  provider: string;
  credentialMode: 'config-owned' | 'service';
  credentialConfigured: boolean;
  credentialRef?: string;
  quotaHeadroom: number;
  models: Array<{
    model: string;
    costClass: CostClass;
    capabilities: string[];
    contextWindow: number;
    failureDomain: string;
  }>;
}

interface RouterDeps {
  llm: DshLlmView;
  supremePolicy: PolicyService;
  supremeObservability: ObservabilityService;
  supremeBenchmark: BenchmarkService;
}

/** Structural view of the pinned LlmRuntime methods the router consumes.
 *  listProviders() returns LlmProviderInfo = { id: string; name: string }
 *  (verified: packages/llm/llm/src/index.ts:466-468 + prepareRoutes shape). */
interface DshLlmView {
  listProviders(): Array<{ id?: string; provider?: string; name?: string } | string>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ provider: string; id: string; context?: { contextWindow?: number } }>;
}

export type RouterService = {
  route(input: { requiredCapabilities?: string[]; requiredContextTokens?: number; risk?: string }): Promise<RouteDecision>;
  recordOutcome(input: { provider: string; model: string; success: boolean; failureClass?: string }): void;
  healthSnapshot(): Array<{ key: string; state: HealthState; recentFailures: number }>;
  config(): RouterConfig;
  /** v1.2: deterministic effort for a candidate route (undefined = leave adapter default). */
  effortFor(input: { provider: string; model: string; verifierFailed?: boolean }): ReasoningEffortLevel | undefined;
  /** v1.2: feed mechanical verifier evidence; FAIL escalates effort until a PASS. */
  reportVerifierOutcome(input: { provider: string; model: string; passed: boolean }): void;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const deps = {
    llm: ctx.llm as unknown as DshLlmView,
    supremePolicy: ctx.supremePolicy,
    supremeObservability: ctx.supremeObservability,
    supremeBenchmark: ctx.supremeBenchmark,
  } satisfies RouterDeps;

  const routerConfig: RouterConfig = {
    weights: config.weights as ScoreWeights,
    minBenchmarkSamples: config.minBenchmarkSamples,
    latencyCeilingMs: config.latencyCeilingMs,
    minQuotaHeadroom: config.minQuotaHeadroom,
    circuit: config.circuit as CircuitConfig,
    costFirst: config.costFirst,
  };
  const effortPacing: EffortPacingConfig = {
    enabled: config.effortPacing.enabled,
    byCostClass: { ...config.effortPacing.byCostClass },
    escalateOnVerifierFail: config.effortPacing.escalateOnVerifierFail,
  };
  const circuit = new CircuitBreaker(routerConfig.circuit);
  const candidatesConfig = config.candidates as ResolvedCandidateConfig[];
  const context = ctx as Context & RouterDeps;

  // provider::model → costClass (drives deterministic effort pacing).
  const costClassByKey = new Map<string, string>();
  for (const entry of candidatesConfig) {
    for (const model of entry.models) costClassByKey.set(`${entry.provider}::${model.model}`, model.costClass);
  }
  // Mechanical verifier-failure escalation state (bounded).
  const escalatedKeys = new Set<string>();
  const ESCALATION_LIMIT = 256;

  async function credentialConfiguredFor(entry: ResolvedCandidateConfig): Promise<boolean> {
    if (entry.credentialMode === 'config-owned') return entry.credentialConfigured;
    const credentials = context.get('credentials') as
      | { describe(ref: string): Promise<{ configured: boolean }> }
      | undefined;
    if (!credentials || !entry.credentialRef) return false; // fail-closed
    try {
      const info = await credentials.describe(entry.credentialRef);
      return info.configured === true;
    } catch {
      return false; // fail-closed when the seam is unusable
    }
  }

  const service: RouterService = {
    async route(input) {
      const now = Date.now();
      const decisionId = genId('route');

      // Live provider catalog (advisory; a provider absent here is ineligible).
      let liveProviders: string[] = [];
      try {
        liveProviders = deps.llm
          .listProviders()
          .map((p) => (typeof p === 'string' ? p : (p.id ?? p.provider ?? '')))
          .filter((id) => id.length > 0);
      } catch {
        liveProviders = [];
      }

      // Historical performance (bounded exploration until min samples).
      const perf = new Map<string, CandidateModelPerf>();
      try {
        for (const agg of deps.supremeBenchmark.aggregateModelPerformance()) {
          perf.set(`${agg.provider}::${agg.model}`, { avgQuality: agg.avgQuality, samples: agg.samples });
        }
      } catch {
        // Empty/failed history → exploration mode.
      }

      const candidates: RouterCandidate[] = [];
      for (const entry of candidatesConfig) {
        const credentialConfigured = await credentialConfiguredFor(entry);
        for (const model of entry.models) {
          let modelValid = false;
          let contextWindow = model.contextWindow;
          try {
            const resolved = await deps.llm.resolveModelInfo(entry.provider, model.model);
            modelValid = Boolean(resolved);
            if (resolved?.context?.contextWindow) contextWindow = resolved.context.contextWindow;
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
        input,
      });

      deps.supremeObservability.record('route_decision', {
        routeDecisionId: decision.decisionId,
        provider: decision.provider,
        model: decision.model,
        detail: decision.blocked
          ? `blocked:${decision.reasonCodes.filter((r) => r.startsWith('GATE_FAILED')).length}gates`
          : `score:${decision.score ?? 0}`,
      });

      return decision;
    },

    recordOutcome({ provider, model, success }) {
      const key = `${provider}::${model}`;
      const now = Date.now();
      if (success) circuit.recordSuccess(key, now);
      else circuit.recordFailure(key, now);
    },

    healthSnapshot() {
      const now = Date.now();
      const keys = new Set<string>();
      for (const entry of candidatesConfig) for (const m of entry.models) keys.add(`${entry.provider}::${m.model}`);
      return [...keys].map((key) => circuit.stateOf(key, now));
    },

    effortFor({ provider, model, verifierFailed }) {
      const costClass = costClassByKey.get(`${provider}::${model}`);
      if (costClass === undefined) return undefined;
      const base = baseEffortFor(effortPacing, costClass);
      if (base === undefined) return undefined;
      // Reflect the exact state the agent/request waterfall would apply:
      // either an explicit verifierFailed signal or recorded FAIL evidence.
      const key = `${provider}::${model}`;
      const escalated =
        effortPacing.escalateOnVerifierFail && (verifierFailed === true || escalatedKeys.has(key));
      return escalated ? escalateEffort(base) : base;
    },

    reportVerifierOutcome({ provider, model, passed }) {
      if (!effortPacing.enabled || !effortPacing.escalateOnVerifierFail) return;
      const key = `${provider}::${model}`;
      if (passed) {
        escalatedKeys.delete(key);
        return;
      }
      if (escalatedKeys.size >= ESCALATION_LIMIT && !escalatedKeys.has(key)) {
        // Bounded: drop the oldest escalation (insertion order is deterministic).
        const oldest = escalatedKeys.values().next().value;
        if (oldest !== undefined) escalatedKeys.delete(oldest);
      }
      escalatedKeys.add(key);
    },

    config: () => routerConfig,
  };

  ctx.provide('supremeRouter', Object.freeze(service));

  // --- v1.2: agent/request effort pacing (pinned LlmCallConfig seam) -------
  // "agent/request may override it" (upstream agent-loop contract): we rewrite
  // ONLY reasoningEffort on the proposed config; provider/model stay untouched.
  ctx.on('agent/request', async (_payload, next) => {
    const call = await next();
    if (!effortPacing.enabled) return call;
    const costClass = costClassByKey.get(`${call.provider}::${call.model}`);
    if (costClass === undefined) return call;
    const base = baseEffortFor(effortPacing, costClass);
    if (base === undefined) return call;
    const escalated = effortPacing.escalateOnVerifierFail && escalatedKeys.has(`${call.provider}::${call.model}`);
    const effort = escalated ? escalateEffort(base) : base;
    if (call.reasoningEffort === effort) return call;
    deps.supremeObservability.record('effort_pacing', {
      provider: call.provider,
      model: call.model,
      detail: `${call.reasoningEffort ?? 'adapter-default'}->${effort}${escalated ? ':escalated' : ''}`,
    });
    return { ...call, reasoningEffort: effort };
  });

  ctx.logger.info(
    'supreme-router active with %d configured candidates (costFirst=%s effortPacing=%s)',
    candidatesConfig.length,
    String(routerConfig.costFirst),
    String(effortPacing.enabled),
  );
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
