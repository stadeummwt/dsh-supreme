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
  selectRoute,
  type CandidateModelPerf,
  type CircuitConfig,
  type HealthState,
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
  };
  const circuit = new CircuitBreaker(routerConfig.circuit);
  const candidatesConfig = config.candidates as ResolvedCandidateConfig[];
  const context = ctx as Context & RouterDeps;

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

    config: () => routerConfig,
  };

  ctx.provide('supremeRouter', Object.freeze(service));
  ctx.logger.info('supreme-router active with %d configured candidates', candidatesConfig.length);
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
