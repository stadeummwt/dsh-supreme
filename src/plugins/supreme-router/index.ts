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
 *
 * v1.3.1 (FIX-A) — PRE-DISPATCH COST ENFORCEMENT. The v1.3.0 adapter only
 * adjusted reasoningEffort on agent/request; paid/unknown-model requests
 * sailed through unchecked. Now the adapter consults supremePolicy (the
 * cost-policy OWNER) with the RESOLVED provider/model/cost-class at BOTH
 * pinned pre-dispatch seams and refuses the dispatch INSIDE the waterfall:
 *
 *   1. `agent/request` (packages/core/agent/src/runtime-types.ts:276-289):
 *      deny = return a provider/model-less config; the pinned loop then
 *      throws BEFORE llm.prepareCall/stream (packages/core/agent-loop/src/
 *      agent.ts:527-529, pin d347e703908d0406b7a7ef80e3a0e594d86b2215) —
 *      zero adapter calls, nothing fabricated. The waterfall re-fires on
 *      EVERY attempt (the loop rebuilds each request after a retry: agent.ts
 *      while(true) → buildRequest; llm-retry returns {kind:'retry'} via
 *      agent/request-error), so a route that changes between attempts is
 *      re-validated at its new key.
 *   2. `llm/stream` (packages/llm/llm/src/index.ts:58-74 + 1093-1107 — the
 *      waterfall wrapped around EVERY adapter stream, covering direct
 *      ctx.llm.stream callers the agent/request seam never sees, e.g.
 *      compaction summarize + session-title providers, and preparedCall
 *      dispatches): deny = throw BEFORE next() so the innermost receiver
 *      (adapterStream) is never invoked. Upstream binds the same seam for
 *      its invariants (llm/src/invariant.ts:88, agent-loop/src/invariant.ts:21)
 *      and documents that middleware failures remain thrown.
 *
 * Root-registered (untagged) listeners receive agent-SCOPED dispatches from
 * every descendant agent (packages/core/scope/src/index.ts:158-185), so
 * subagent and workflow children — which start through the host's agent
 * runtime (subagent/src/child-agent.ts:98-119; workflow-worker-thread/src/
 * host.ts:355) — cross the same seams.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  AttemptLedger,
  CircuitBreaker,
  ClassPerformanceTracker,
  OutcomeCircuitBreaker,
  baseEffortFor,
  buildRouteCostGate,
  classifyFailure,
  escalateEffort,
  freeClaimEvidence,
  resolveRouteCostClass,
  routeCostDeniedMessage,
  selectRoute,
  providerBucketOf,
  withinWallClock,
  COST_POLICY_DENIED_CODE,
  DEFAULT_BOUNDS,
  DEFAULT_SIMPLE_TASK_CLASSES,
  FREE_ROUTE_EVIDENCE_EVENT,
  ROUTE_COST_DENIED_EVENT,
  type BoundsConfig,
  type CandidateModelPerf,
  type CircuitConfig,
  type EffortPacingConfig,
  type FastPathConfig,
  type FreeClaimEvidence,
  type HealthState,
  type OutcomeClass,
  type ReasoningEffortLevel,
  type RouteCostGate,
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

/**
 * Pinned-upstream seam: 'llm/stream' is a real pinned Events-map waterfall —
 * packages/llm/llm/src/index.ts:58-74 (declared around EVERY adapter stream;
 * dispatch site :1097-1107); upstream binds the same name itself in
 * packages/llm/llm/src/invariant.ts:88 and
 * packages/core/agent-loop/src/invariant.ts:21, pin
 * d347e703908d0406b7a7ef80e3a0e594d86b2215. Now listed in the suite's
 * OFFICIAL_SEAMS allowlist with this citation.
 */
/**
 * Denial error thrown at the llm/stream seam BEFORE next() (zero adapter
 * calls). Deliberately NOT an upstream LlmError import: the adapter keeps
 * zero runtime dependency on the upstream workspace (type-only imports are
 * erased), so the code rides on the error MESSAGE; the pinned loop flattens
 * non-LlmError failures to `{ code: 'UNKNOWN', message }` and upstream
 * documents that middleware failures remain thrown.
 */
class RouteCostDeniedError extends Error {
  readonly code = COST_POLICY_DENIED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RouteCostDeniedError';
  }
}

const candidateModelSchema = z.object({
  model: z.string().min(1),
  costClass: z.enum(['FREE_CONFIRMED', 'FREE_LIMITED', 'TRIAL', 'PAID', 'UNKNOWN']).default('UNKNOWN'),
  capabilities: z.array(z.string()).default([]),
  contextWindow: z.number().int().min(0).default(0),
  failureDomain: z.string().default('default'),
  /**
   * v1.3 CapabilitySignal labels (contract with supreme-policy/engine.ts).
   * Optional, config-owned; the router only CARRIES them on the decision
   * record — enforcement lives in policy. Declared keys arrive (no strip).
   */
  capabilityClass: z.string().min(1).max(64).optional(),
  cotVisibility: z.enum(['verbose', 'terse', 'none']).optional(),
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
   * v1.3 anti-sandbagging: fixed downweight for candidates whose benchmark
   * scores lack verifier-PASS evidence. Default 1 = disabled (back-compat);
   * e.g. 0.5 halves the routing score of such candidates. Deterministic.
   */
  unscoredEvidenceWeight: z.number().min(0).max(1).default(1),
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
  /**
   * v1.3.1 (IMP-R §3): bounds against retry storms. Defaults preserve
   * behavior: maxRetries 3, maxFanout 4, wallClockBudgetMs 0 = OFF.
   * The ledger REFUSES attempts beyond maxRetries; the fallback plan caps at
   * maxFanout; the wall-clock budget is exposed to hosts via withinWallClock.
   */
  bounds: z
    .object({
      maxRetries: z.number().int().min(1).max(64).default(3),
      maxFanout: z.number().int().min(0).max(64).default(4),
      wallClockBudgetMs: z.number().int().min(0).default(0),
    })
    .default({ maxRetries: 3, maxFanout: 4, wallClockBudgetMs: 0 }),
  /**
   * v1.3.1 (IMP-R §4): fast path. Disabled by default (opt-in,
   * behavior-preserving). When enabled, a task whose class/labels match a
   * simple class (and whose measured risk, when present, is LOW) routes
   * directly with fanout 0 — no delegation/MoA fanout. Effort escalation
   * stays bound to measured verifier-FAIL evidence only (v1.2 pacing).
   */
  fastPath: z
    .object({
      enabled: z.boolean().default(false),
      simpleClasses: z.array(z.string().min(1).max(64)).default([...DEFAULT_SIMPLE_TASK_CLASSES]),
    })
    .default({ enabled: false, simpleClasses: [...DEFAULT_SIMPLE_TASK_CLASSES] }),
  /**
   * v1.3.1 (IMP-R §2): outcome-driven circuit breaker fed ONLY by real
   * outcome events (agent/request-error seam, recordOutcome, verifier FAIL).
   * N consecutive failures (default 3) open the circuit; after cooldownMs a
   * single half-open probe is granted. Enabled by default — with no failures
   * observed the routing behavior is identical to v1.2.
   */
  outcomeCircuit: z
    .object({
      enabled: z.boolean().default(true),
      consecutiveFailures: z.number().int().min(1).max(64).default(3),
      cooldownMs: z.number().int().min(0).default(60_000),
    })
    .default({ enabled: true, consecutiveFailures: 3, cooldownMs: 60_000 }),
  /**
   * v1.3.1 (IMP-R §1): class-aware scoring — per-(candidate, taskClass)
   * outcome history with fixed recency half-life and Wilson lower-bound
   * shrinkage (formula documented in the engine). Active whenever a request
   * carries a taskClass; without one, v1.2 global scoring applies unchanged.
   */
  classAware: z
    .object({
      enabled: z.boolean().default(true),
      halfLifeMs: z.number().int().min(1_000).default(3_600_000),
      sampleLimit: z.number().int().min(16).max(4_096).default(512),
    })
    .default({ enabled: true, halfLifeMs: 3_600_000, sampleLimit: 512 }),
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
    capabilityClass?: string;
    cotVisibility?: 'verbose' | 'terse' | 'none';
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
  route(input: {
    requiredCapabilities?: string[];
    requiredContextTokens?: number;
    risk?: string;
    /** v1.3.1 (IMP-R §1/§4): task-class label (drives class-aware scoring + fast path). */
    taskClass?: string;
    /** v1.3.1 (IMP-R §4): free-form labels (simple-class match enables the fast path). */
    labels?: string[];
  }): Promise<RouteDecision>;
  recordOutcome(input: { provider: string; model: string; success: boolean; failureClass?: string }): void;
  healthSnapshot(): Array<{ key: string; state: HealthState; recentFailures: number }>;
  config(): RouterConfig;
  /** v1.2: deterministic effort for a candidate route (undefined = leave adapter default). */
  effortFor(input: { provider: string; model: string; verifierFailed?: boolean }): ReasoningEffortLevel | undefined;
  /** v1.2: feed mechanical verifier evidence; FAIL escalates effort until a PASS. */
  reportVerifierOutcome(input: { provider: string; model: string; passed: boolean }): void;
  /**
   * v1.3.1 (IMP-R §3): register one dispatch attempt for a task. Returns
   * `allowed:false` once the task exceeded maxRetries — the caller MUST NOT
   * dispatch (retry-storm bound). Pure bookkeeping, never sleeps.
   */
  registerAttempt(taskId: string): { allowed: boolean; attempts: number; maxRetries: number };
  /** v1.3.1 (IMP-R §3): read-only attempt status for a task. */
  attemptStatus(taskId: string): { attempts: number; maxRetries: number };
  /** v1.3.1 (IMP-R §3): deterministic wall-clock budget check (0 budget = OFF → true). */
  withinBudget(startedAt: number, now: number): boolean;
  /** v1.3.1 (IMP-R §2): outcome-circuit snapshot (phases + counters, ids only). */
  outcomeSnapshot(): Array<{
    key: string;
    phase: 'closed' | 'open' | 'half_open';
    consecutiveFailures: number;
    lastOutcomeClass: OutcomeClass | null;
    openedUntil: number | null;
  }>;
  /**
   * v1.3.1 (IMP-R §2): grant the SINGLE half-open probe slot for a route.
   * Dispatchers call this after a successful route() when the chosen route is
   * half-open; only one probe per open episode is granted.
   */
  acquireProbe(provider: string, model: string): boolean;
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
    unscoredEvidenceWeight: config.unscoredEvidenceWeight,
    // v1.3.1 (IMP-R): bounds + fast path (behavior-preserving defaults).
    bounds: config.bounds as BoundsConfig,
    fastPath: config.fastPath as FastPathConfig,
  };
  const effortPacing: EffortPacingConfig = {
    enabled: config.effortPacing.enabled,
    byCostClass: { ...config.effortPacing.byCostClass },
    escalateOnVerifierFail: config.effortPacing.escalateOnVerifierFail,
  };
  const circuit = new CircuitBreaker(routerConfig.circuit);
  // v1.3.1 (IMP-R §2): outcome-driven circuit (consecutive failures → open →
  // half-open single probe). Fed ONLY by real outcome events:
  //   - agent/request-error seam (provider bucket — the seam carries no model),
  //   - recordOutcome (attributed candidate key),
  //   - reportVerifierOutcome(false) (class 'verifier').
  const outcomeCircuitEnabled = config.outcomeCircuit.enabled;
  const outcomeCircuit = new OutcomeCircuitBreaker({
    consecutiveFailures: config.outcomeCircuit.consecutiveFailures,
    cooldownMs: config.outcomeCircuit.cooldownMs,
  });
  // v1.3.1 (IMP-R §3): per-task attempt ledger (retry-storm bound).
  const attemptLedger = new AttemptLedger({ maxRetries: config.bounds.maxRetries });
  // v1.3.1 (IMP-R §1): half-life for per-class freshness decay.
  const classHalfLifeMs = config.classAware.halfLifeMs;
  const classSampleLimit = config.classAware.sampleLimit;
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

  // --- v1.3.1: pre-dispatch cost gate (policy-owned, value-free) -----------
  // Free-claim evidence is recorded ONCE per route key (bounded, insertion-
  // order eviction — deterministic, no timers): the first allowed dispatch of
  // a FREE_* route documents WHERE the free claim came from. A cost label is
  // NOT proof of a free endpoint — the evidence event exists precisely so the
  // audit trail shows the posture rests on a config-owned claim.
  const freeEvidenceRecorded = new Set<string>();
  const FREE_EVIDENCE_LIMIT = 256;
  // v1.3.1 (IMP-R §3): routeKey → free-claim evidence REUSE. The FIX-A evidence
  // fields (source/checkedAt/status/expiresAt) recorded at the cost gate are
  // reused as the fallback-plan admission filter: only routes whose evidence is
  // present AND current may serve as cross-provider fallbacks.
  const freeClaimByKey = new Map<string, FreeClaimEvidence>();

  /**
   * Consult supremePolicy for the RESOLVED provider/model at a pre-dispatch
   * seam. Policy owns the decision (evaluateRoute — existing narrow method;
   * no policy change needed). Fail-closed: a missing/unusable policy service
   * denies. Audit events carry labels/ids/reasons only (Spec §10).
   * `risk: 'LOW'` = no task-risk evidence exists at the request seam; task-risk
   * verification stays owned by the tools/pre-execute policy pipeline.
   */
  function routeCostGate(provider: string, model: string, seam: string): RouteCostGate {
    const costClass = resolveRouteCostClass(costClassByKey, provider, model);
    const policy = deps.supremePolicy as
      | { evaluateRoute?: (input: { costClass: CostClass; risk: 'LOW' }) => { allowed: boolean; reasonCodes: string[] } }
      | undefined;
    const decision =
      policy && typeof policy.evaluateRoute === 'function'
        ? policy.evaluateRoute({ costClass: costClass as CostClass, risk: 'LOW' })
        : null; // fail-closed: no policy => no permission
    const gate = buildRouteCostGate({ provider, model, costClass, policyDecision: decision, now: Date.now() });
    const routeKey = `${provider}::${model}`;
    if (!gate.allowed) {
      deps.supremeObservability?.record(ROUTE_COST_DENIED_EVENT, {
        provider: gate.provider,
        model: gate.model,
        costClass: gate.costClass,
        seam,
        reason: gate.reasonCodes.join('+'),
      });
      return gate;
    }
    if (gate.freeClaim !== null) {
      freeClaimByKey.set(routeKey, gate.freeClaim); // evidence reuse (bounded below)
      if (freeClaimByKey.size > FREE_EVIDENCE_LIMIT) {
        const oldestClaim = freeClaimByKey.keys().next().value;
        if (oldestClaim !== undefined) freeClaimByKey.delete(oldestClaim);
      }
      if (!freeEvidenceRecorded.has(routeKey)) {
        if (freeEvidenceRecorded.size >= FREE_EVIDENCE_LIMIT) {
          const oldest = freeEvidenceRecorded.values().next().value;
          if (oldest !== undefined) freeEvidenceRecorded.delete(oldest);
        }
        freeEvidenceRecorded.add(routeKey);
        deps.supremeObservability?.record(FREE_ROUTE_EVIDENCE_EVENT, {
          provider: gate.provider,
          model: gate.model,
          costClass: gate.costClass,
          source: gate.freeClaim.source,
          checkedAt: gate.freeClaim.checkedAt,
          status: gate.freeClaim.status,
          expiresAt: gate.freeClaim.expiresAt,
        });
      }
    }
    return gate;
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
      // v1.3: benchmark aggregates also carry score-evidence counts — a
      // candidate whose quality claims are not fully verifier-PASS-backed is
      // marked evidenceBacked:false so the engine can apply the fixed
      // anti-sandbagging downweight (see unscoredEvidenceWeight).
      const perf = new Map<string, CandidateModelPerf>();
      try {
        for (const agg of deps.supremeBenchmark.aggregateModelPerformance()) {
          const scoredSamples = agg.scoredSamples ?? 0;
          const evidenceBackedScores = agg.evidenceBackedScores ?? 0;
          perf.set(`${agg.provider}::${agg.model}`, {
            avgQuality: agg.avgQuality,
            samples: agg.samples,
            evidenceBacked: scoredSamples > 0 ? evidenceBackedScores === scoredSamples : true,
          });
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
            ...(model.capabilityClass !== undefined ? { capabilityClass: model.capabilityClass } : {}),
            ...(model.cotVisibility !== undefined ? { cotVisibility: model.cotVisibility } : {}),
          });
        }
      }

      // v1.3.1 (IMP-R §1): per-(candidate, taskClass) outcome history built
      // from REAL benchmark run records (provider/model/taskCategory/success/
      // finishedAt — ids, labels and booleans only). Bounded by sampleLimit;
      // rebuilt per decision so selection is a pure function of store state.
      let classPerf: ClassPerformanceTracker | undefined;
      if (config.classAware.enabled && input.taskClass !== undefined) {
        classPerf = new ClassPerformanceTracker({ halfLifeMs: classHalfLifeMs });
        try {
          const bench = deps.supremeBenchmark as BenchmarkService & {
            classSamples?: (limit?: number) => Array<{ provider: string; model: string; taskClass: string; success: boolean; at: number }>;
          };
          for (const row of bench.classSamples?.(classSampleLimit) ?? []) {
            classPerf.observe(`${row.provider}::${row.model}`, row.taskClass, row.success, row.at);
          }
        } catch {
          classPerf = undefined; // history unavailable → v1.2 global scoring
        }
      }

      // v1.3.1 (IMP-R §3): free-claim evidence for the fallback planner.
      // Every config-owned FREE_* candidate gets the FIX-A evidence fields
      // (source 'config', checkedAt = now, active, no expiry); claims actually
      // recorded at the cost gate (freeClaimByKey) take precedence so their
      // original checkedAt/expiry governs.
      const freeEvidence = new Map<string, FreeClaimEvidence>();
      for (const candidate of candidates) {
        if (candidate.costClass === 'FREE_CONFIRMED' || candidate.costClass === 'FREE_LIMITED') {
          freeEvidence.set(candidate.key, freeClaimByKey.get(candidate.key) ?? freeClaimEvidence('config', now));
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
        ...(classPerf !== undefined ? { classPerf } : {}),
        ...(outcomeCircuitEnabled ? { outcomeCircuit } : {}),
        freeEvidence,
      });

      deps.supremeObservability.record('route_decision', {
        routeDecisionId: decision.decisionId,
        provider: decision.provider,
        model: decision.model,
        // v1.3 CapabilitySignal: labels only (never content) — policy consumes.
        capabilityClass: decision.capabilityClass,
        cotVisibility: decision.cotVisibility,
        detail: decision.blocked
          ? `blocked:${decision.reasonCodes.filter((r) => r.startsWith('GATE_FAILED')).length}gates`
          : `score:${decision.score ?? 0}`,
      });

      // v1.3.1 (IMP-R §4/§3): fast-path + fallback-plan audit (ids/labels/counts).
      if (decision.fastPath === true) {
        deps.supremeObservability.record('route_fast_path', {
          routeDecisionId: decision.decisionId,
          provider: decision.provider,
          model: decision.model,
        });
      }
      if ((decision.fallbackPlan?.length ?? 0) > 0) {
        deps.supremeObservability.record('fallback_planned', {
          routeDecisionId: decision.decisionId,
          detail: `fanout:${decision.fallbackPlan?.length}:${(decision.fallbackPlan ?? []).map((f) => f.key).join(',')}`.slice(0, 256),
        });
      }

      // v1.3 anti-sandbagging audit: one event per candidate that received the
      // fixed downweight (candidate id + applied factor only — never scores).
      for (const entry of decision.unscoredEvidence ?? []) {
        deps.supremeObservability.record('unscored_evidence', {
          candidate: entry.candidate,
          appliedFactor: entry.factor,
          routeDecisionId: decision.decisionId,
        });
      }

      return decision;
    },

    recordOutcome({ provider, model, success, failureClass }) {
      const key = `${provider}::${model}`;
      const now = Date.now();
      if (success) circuit.recordSuccess(key, now);
      else circuit.recordFailure(key, now);
      // v1.3.1 (IMP-R §2): feed the outcome circuit from REAL attributed
      // outcomes. Failure labels are classified deterministically from the
      // caller's failureClass (a benchmark FailureClass label or a pinned
      // upstream LLM code) by the single documented classifier.
      if (outcomeCircuitEnabled) {
        const outcomeClass = success ? null : failureClass !== undefined ? classifyFailure({ code: failureClass }) : 'other';
        if (success) {
          outcomeCircuit.recordSuccess(key, now);
        } else {
          const state = outcomeCircuit.recordFailure(key, now, outcomeClass ?? 'other');
          if (state.phase === 'open') {
            deps.supremeObservability.record('circuit_opened', {
              provider,
              model,
              errorClass: outcomeClass ?? 'other',
              detail: `consecutive:${state.consecutiveFailures}`,
            });
          }
        }
        deps.supremeObservability.record('outcome_recorded', {
          provider,
          model,
          errorClass: outcomeClass ?? 'none',
          detail: success ? 'success' : 'failure',
        });
      }
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
      const key = `${provider}::${model}`;
      // v1.3.1 (IMP-R §2): verifier FAIL/PASS is REAL outcome evidence — it
      // feeds the outcome circuit as class 'verifier' REGARDLESS of the
      // effort-pacing toggle (the toggle only governs effort escalation).
      if (outcomeCircuitEnabled) {
        const now = Date.now();
        if (passed) outcomeCircuit.recordSuccess(key, now);
        else {
          const state = outcomeCircuit.recordFailure(key, now, 'verifier');
          if (state.phase === 'open') {
            deps.supremeObservability.record('circuit_opened', {
              provider,
              model,
              errorClass: 'verifier',
              detail: `consecutive:${state.consecutiveFailures}`,
            });
          }
        }
      }
      if (!effortPacing.enabled || !effortPacing.escalateOnVerifierFail) return;
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

    // --- v1.3.1 (IMP-R §3): retry-storm bounds --------------------------------
    registerAttempt(taskId) {
      const result = attemptLedger.registerAttempt(taskId);
      if (!result.allowed) {
        deps.supremeObservability.record('retry_bound_refused', {
          detail: `attempts:${result.attempts}/max:${result.maxRetries}`.slice(0, 256),
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

    // --- v1.3.1 (IMP-R §2): outcome-circuit introspection + probe ------------
    outcomeSnapshot() {
      return outcomeCircuitEnabled
        ? outcomeCircuit.snapshot(Date.now()).map((s) => ({
            key: s.key,
            phase: s.phase,
            consecutiveFailures: s.consecutiveFailures,
            lastOutcomeClass: s.lastOutcomeClass,
            openedUntil: s.openedUntil,
          }))
        : [];
    },

    acquireProbe(provider, model) {
      if (!outcomeCircuitEnabled) return true; // circuit disabled → always allowed
      return outcomeCircuit.acquireProbe(`${provider}::${model}`, Date.now());
    },

    config: () => routerConfig,
  };

  ctx.provide('supremeRouter', Object.freeze(service));

  // --- v1.2: agent/request effort pacing (pinned LlmCallConfig seam) -------
  // "agent/request may override it" (upstream agent-loop contract): we rewrite
  // ONLY reasoningEffort on the proposed config; provider/model stay untouched
  // on ALLOWED routes.
  //
  // --- v1.3.1 (FIX-A): pre-dispatch cost enforcement on the same seam -------
  // The waterfall fires for EVERY attempt (first request and every retry —
  // the pinned loop rebuilds each request inside its while(true) step and
  // after an agent/request-error retry, so a fallback that switches route is
  // re-validated at its new key). Deny = return a provider/model-less config:
  // the pinned loop's own contract then throws BEFORE llm.prepareCall/stream
  // (agent.ts:527-529) — zero adapter calls, nothing fabricated.
  ctx.on('agent/request', async (_payload, next) => {
    const call = await next();
    // v1.3.1 cost gate FIRST (independent of effortPacing): policy decides.
    const gate = routeCostGate(call.provider, call.model, 'agent/request');
    if (!gate.allowed) return { ...call, provider: '', model: '' };
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

  // --- v1.3.1 (FIX-A): llm/stream backstop — the universal pre-dispatch seam
  // (see the 'llm/stream' seam citation above). EVERY adapter stream crosses this
  // waterfall — loop requests (direct and preparedCall dispatch), retries, and
  // direct ctx.llm.stream callers the agent/request seam never sees (compaction
  // summarize, session-title providers). Deny = throw BEFORE next(), so the
  // innermost receiver (adapterStream) is never invoked — zero adapter calls,
  // and nothing is fabricated (middleware failures remain thrown upstream).
  ctx.on('llm/stream', (options, next) => {
    const gate = routeCostGate(options.provider, options.model, 'llm/stream');
    if (!gate.allowed) throw new RouteCostDeniedError(routeCostDeniedMessage(gate));
    return next();
  });

  // --- v1.3.1 (IMP-R §2): outcome consumption on the OFFICIAL error seam ----
  // 'agent/request-error' (packages/core/agent/src/runtime-types.ts:~277,
  // pin d347e703 — waterfall fired for EVERY failed model-request attempt;
  // already in the suite's OFFICIAL_SEAMS allowlist and already subscribed by
  // supreme-observability). The payload carries provider + a serializable
  // LlmFailure {message, code, status?} — NO model attribution, so the
  // failure lands on the provider bucket `provider::*` (deterministic key;
  // blocks every candidate of that provider while open; cleared by an
  // attributed success via the documented cross-clear). Classify → feed the
  // outcome circuit → observe, then pass through UNCHANGED (next() exactly
  // once; recovery ownership stays with llm-retry / the loop).
  ctx.on('agent/request-error', (payload, next) =>
    next().then((action) => {
      if (outcomeCircuitEnabled) {
        const outcomeClass = classifyFailure(payload.failure);
        const state = outcomeCircuit.recordFailure(providerBucketOf(payload.provider), Date.now(), outcomeClass);
        deps.supremeObservability.record('outcome_recorded', {
          provider: payload.provider,
          errorClass: outcomeClass,
          detail: `failure:agent/request-error${state.phase === 'open' ? ':circuit_open' : ''}`.slice(0, 256),
        });
        if (state.phase === 'open') {
          deps.supremeObservability.record('circuit_opened', {
            provider: payload.provider,
            errorClass: outcomeClass,
            detail: `consecutive:${state.consecutiveFailures}:bucket`,
          });
        }
      }
      return action;
    }),
  );

  ctx.logger.info(
    'supreme-router active with %d configured candidates (costFirst=%s effortPacing=%s costEnforcement=ENFORCE)',
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
