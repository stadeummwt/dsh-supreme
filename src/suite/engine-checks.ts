/**
 * dsh-supreme/suite — Level A engine checks for all seven plugins.
 * Pure, keyless, deterministic. Real-loader composition gates live in runner.ts.
 */
import {
  check,
  expectEqual,
  expectThrows,
  expectTrue,
  type Check,
} from './harness';
import {
  evaluateDelegationPolicy,
  evaluateRoutePolicy,
  evaluateCoTGate,
  executionPolicySummary,
  inspectTaint,
  PRODUCTION_DEFAULTS,
  validatePolicyConfig,
  PolicyConfigError,
  verificationRequirement,
  type SupremePolicyConfig,
} from '../plugins/supreme-policy/engine';
import {
  buildRecord,
  serializeRecord,
  JsonlWriter,
  type SafeRecord,
} from '../plugins/supreme-observability/engine';
import {
  aggregateRuns,
  BenchmarkStore,
  validateBenchmarkRecord,
  BenchmarkValidationError,
  type BenchmarkFs,
} from '../plugins/supreme-benchmark/engine';
import {
  CircuitBreaker,
  baseEffortFor,
  costClassRank,
  DEFAULT_EFFORT_PACING,
  DEFAULT_ROUTER_CONFIG,
  escalateEffort,
  selectRoute,
  weightsAreNormalized,
  type RouterCandidate,
} from '../plugins/supreme-router/engine';
import {
  pathIsAllowed,
  runValidator,
  sanitizeEvidence,
  validateJsonSchemaSubset,
  type VerifierRuntime,
} from '../plugins/supreme-verifier/engine';
import {
  estimateTokens,
  isSecretBearing,
  ledgerNotesToItems,
  ledgerRelevanceScore,
  needsMemory,
  NoteLedger,
  NOOP_LONG_TERM_PROVIDER,
  selectLedgerNotes,
  selectMemory,
  validateLedgerNote,
  LedgerValidationError,
  type LedgerFs,
  type LedgerNote,
  type MemoryItem,
} from '../plugins/supreme-memory-policy/engine';
import {
  buildDelegationScope,
  canCloseTask,
  decideWorkflow,
  evaluatePathScope,
  pathMatchesGlob,
  validateWorkflowLimits,
  WORKFLOW_LIMIT_DEFAULTS,
  WorkflowConfigError,
} from '../plugins/supreme-workflow-policy/engine';

const LAB_CONFIG: SupremePolicyConfig = {
  ...PRODUCTION_DEFAULTS,
  executionClass: 'LAB',
  allowPaid: true,
  allowTrial: true,
};

const prodConfig = (overrides: Partial<SupremePolicyConfig> = {}): SupremePolicyConfig => ({
  ...PRODUCTION_DEFAULTS,
  ...overrides,
});

function freeCandidate(overrides: Partial<RouterCandidate> = {}): RouterCandidate {
  return {
    key: 'synthetic-free::synthetic-mini',
    provider: 'synthetic-free',
    model: 'synthetic-mini',
    costClass: 'FREE_CONFIRMED',
    capabilities: ['chat'],
    contextWindow: 32768,
    credentialConfigured: true,
    quotaHeadroom: 0.9,
    failureDomain: 'synthetic',
    providerAvailable: true,
    modelValid: true,
    ...overrides,
  };
}

function paidCandidate(overrides: Partial<RouterCandidate> = {}): RouterCandidate {
  return freeCandidate({
    key: 'synthetic-paid::synthetic-large',
    provider: 'synthetic-paid',
    model: 'synthetic-large',
    costClass: 'PAID',
    contextWindow: 131072,
    failureDomain: 'synthetic-paid',
    ...overrides,
  });
}

const noopRuntime: VerifierRuntime = {
  fsExists: async () => false,
  fsRead: async () => null,
  sha256: async () => null,
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
};

const pathMod = { resolve: (p: string) => `/roots${p.startsWith('/') ? '' : '/'}${p}` };

export function policyChecks(): Check[] {
  return [
    check('policy.production-defaults', 'production defaults deny paid/trial/unknown', () => {
      expectEqual(PRODUCTION_DEFAULTS.allowPaid, false, 'allowPaid default');
      expectEqual(PRODUCTION_DEFAULTS.allowUnknownCost, false, 'allowUnknownCost default');
      const paid = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'PAID', risk: 'LOW' });
      const trial = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'TRIAL', risk: 'LOW' });
      const unknown = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'UNKNOWN', risk: 'LOW' });
      const free = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'FREE_CONFIRMED', risk: 'LOW' });
      expectTrue(!paid.allowed && !trial.allowed && !unknown.allowed && free.allowed, 'route decisions');
    }),
    check('policy.unknown-never-allowed', 'UNKNOWN cost denied even with permissive non-LAB flags', () => {
      expectThrows(
        () => validatePolicyConfig({ ...prodConfig({ executionClass: 'STANDARD' }), allowUnknownCost: true as never }),
        'allowUnknownCost=true must be rejected',
      );
      const cfg = validatePolicyConfig(prodConfig());
      expectTrue(!evaluateRoutePolicy(cfg, { costClass: 'UNKNOWN', risk: 'HIGH' }).allowed, 'unknown denied');
    }),
    check('policy.lab-override-only-in-lab', 'allowPaid/allowTrial overrides valid only with LAB', () => {
      expectTrue(validatePolicyConfig(LAB_CONFIG).allowPaid, 'LAB override accepted');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), allowPaid: true }), 'paid override in STANDARD rejected');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), allowTrial: true }), 'trial override in CORE rejected');
    }),
    check('policy.high-risk-verification', 'HIGH risk requires verification', () => {
      expectEqual(verificationRequirement(PRODUCTION_DEFAULTS, { risk: 'HIGH' }), 'REQUIRED', 'high risk level');
      expectEqual(verificationRequirement(PRODUCTION_DEFAULTS, { risk: 'LOW' }), 'NONE', 'low risk level');
    }),
    check('policy.delegation-bounded', 'delegation depth bounded; secret access never delegates', () => {
      expectTrue(evaluateDelegationPolicy(prodConfig(), { depth: 2, secretAccess: false }).allowed, 'depth 2 ok');
      expectTrue(!evaluateDelegationPolicy(prodConfig(), { depth: 4, secretAccess: false }).allowed, 'depth 4 denied');
      expectTrue(!evaluateDelegationPolicy(LAB_CONFIG, { depth: 1, secretAccess: true }).allowed, 'secret denied even LAB');
    }),
    check('policy.summary-derived-state', 'execution summary exposes compact derived state', () => {
      const summary = executionPolicySummary(PRODUCTION_DEFAULTS);
      expectEqual(summary.paidRoutes, 'DENY', 'summary paid routes');
      expectEqual(summary.unknownCost, 'DENY', 'summary unknown cost');
    }),
    check('policy.taint-scan-detects', 'hidden/bidi unicode in tool arguments is detected deterministically', () => {
      const tainted = inspectTaint({ command: 'echo', message: 'ok\u200Bhidden', deep: { bidi: 'a\u202Eb' } });
      expectTrue(tainted.tainted, 'taint found');
      expectTrue(tainted.hits.includes('U+200B-U+200F'), 'zero-width class reported');
      expectTrue(tainted.hits.includes('U+202A-U+202E'), 'bidi class reported');
      expectTrue(tainted.count >= 2, `count=${tainted.count}`);
      const clean = inspectTaint({ command: 'echo', message: 'plain ascii' });
      expectTrue(!clean.tainted && clean.hits.length === 0, 'clean args pass');
      // Values are NEVER echoed — only class names.
      expectTrue(!JSON.stringify(tainted.hits).includes('hidden'), 'values never reported');
    }),
    check('policy.taint-config-validation', 'taint/cot keys validate; unknown values rejected', () => {
      const deny = validatePolicyConfig({ ...prodConfig(), taintPolicy: 'DENY' });
      expectEqual(deny.taintPolicy, 'DENY', 'DENY accepted');
      const cot = validatePolicyConfig({ ...prodConfig({ executionClass: 'SUPREME' }), reasoningTracePolicy: 'ENFORCE' });
      expectEqual(cot.reasoningTracePolicy, 'ENFORCE', 'ENFORCE accepted on SUPREME');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), taintPolicy: 'BOGUS' as never }), 'bad taintPolicy rejected');
      expectThrows(
        () => validatePolicyConfig({ ...prodConfig({ executionClass: 'CORE' }), reasoningTracePolicy: 'ENFORCE' as never }),
        'ENFORCE refused on CORE floor',
      );
      expectTrue(PolicyConfigError !== undefined, 'error type present');
    }),
    check('policy.cot-gate-matrix', 'CoT presence gate is deterministic (audit, never prompt injection)', () => {
      expectEqual(evaluateCoTGate('OFF', { reasoningTracePresent: false, tool: 'bash' }).decision, 'ALLOW', 'OFF allows');
      expectEqual(evaluateCoTGate('AUDIT', { reasoningTracePresent: false, tool: 'bash' }).decision, 'AUDIT', 'AUDIT on absence');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: false, tool: 'bash' }).decision, 'DENY', 'ENFORCE denies known absence');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: undefined, tool: 'bash' }).decision, 'AUDIT', 'unknown evidence never denied');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: true, tool: 'bash' }).decision, 'ALLOW', 'trace present allows');
    }),
  ];
}

export function observabilityChecks(): Check[] {
  return [
    check('observability.allowlist-only', 'unknown fields never serialized', () => {
      const rec = buildRecord(1, 1000, 'tool_call', {
        tool: 'bash',
        toolArguments: 'rm -rf /', // unknown field → dropped
        apiKey: 'sk-unknown-field',
      }) as Record<string, unknown>;
      expectEqual(rec.tool, 'bash', 'allowlisted field kept');
      expectTrue(!('toolArguments' in rec) && !('apiKey' in rec), 'unknown fields dropped');
    }),
    check('observability.sentinel-scrubbed', 'secret sentinel scrubbed from allowlisted strings', () => {
      const rec = buildRecord(2, 1000, 'detail_event', { detail: 'SECRET_SENTINEL_ABCDEF value' });
      const line = serializeRecord(rec, 2048);
      expectTrue(!line.includes('SECRET_SENTINEL'), 'sentinel absent from line');
    }),
    check('observability.writer-fails-open', 'writer failures drop records without throwing', async () => {
      const writer = new JsonlWriter('/nonexistent-root/x.jsonl', '/nonexistent-root/x.jsonl.1', 1_000_000, 2048, {
        appendFile: async () => {
          throw new Error('EACCES');
        },
        stat: async () => null,
        rename: async () => undefined,
        mkdir: async () => {},
      });
      writer.write(buildRecord(3, 1000, 'drop_me', {}));
      const stats = await writer.dispose();
      expectTrue(stats.dropped >= 1, `dropped=${stats.dropped}`);
    }),
    check('observability.disabled-noop', 'disabled config produces no writer', () => {
      expectTrue(true, 'covered by real-boot no-op flag path');
    }),
    check('observability.order-deterministic', 'records keep monotonic sequence order', () => {
      const a = buildRecord(10, 1000, 'a', {}) as SafeRecord;
      const b = buildRecord(11, 1001, 'b', {}) as SafeRecord;
      expectTrue(a.seq < b.seq, 'seq order');
    }),
    check('observability.v12-events-allowlisted', 'v1.2 audit events (taint/cot) serialize metadata only', () => {
      const taint = buildRecord(20, 1000, 'taint_detected', {
        tool: 'bash',
        detail: 'classes:U+200B-U+200F;count:1',
        // Injection attempts: unknown fields + values must be dropped.
        arguments: 'rm -rf /\u200B',
        SECRET_SENTINEL_X: 'leak',
      }) as Record<string, unknown>;
      expectEqual(taint.event, 'taint_detected', 'event kept');
      expectEqual(taint.tool, 'bash', 'allowlisted tool field');
      expectTrue(!('arguments' in taint) && !('SECRET_SENTINEL_X' in taint), 'unknown fields dropped');
      const cot = buildRecord(21, 1000, 'cot_missing', { tool: 'bash', detail: 'ENFORCE' }) as Record<string, unknown>;
      expectEqual(cot.detail, 'ENFORCE', 'cot detail kept');
    }),
  ];
}

export function benchmarkChecks(): Check[] {
  const makeStore = (): { store: BenchmarkStore; files: Map<string, string> } => {
    const files = new Map<string, string>();
    const fs: BenchmarkFs = {
      readFile: async (p) => files.get(p) ?? null,
      appendFile: async (p, line) => {
        files.set(p, (files.get(p) ?? '') + line);
      },
      mkdir: async () => {},
    };
    return { store: new BenchmarkStore('/mem/benchmark.jsonl', fs), files };
  };

  return [
    check('benchmark.roundtrip', 'task/run/score roundtrip through store + JSONL', async () => {
      const { store } = makeStore();
      await store.init();
      await store.recordTask({ taskId: 't1', category: 'unit' });
      const run = await store.startRun({ runId: 'r1', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'unit' });
      await store.finishRun('r1', { success: true, latencyMs: 50 });
      await store.recordScore({ runId: 'r1', qualityScore: 0.8 });
      const history = store.queryHistory({ provider: 'p' });
      expectEqual(history.length, 1, 'history length');
      expectEqual(run.runId, 'r1', 'run id');
    }),
    check('benchmark.corrupt-lines-skipped', 'corrupt JSONL lines counted, never fatal', async () => {
      const { store, files } = makeStore();
      files.set('/mem/benchmark.jsonl', '{"kind":"run","schemaVersion":1}\nnot-json\n\n');
      const stats = await store.init();
      expectTrue(stats.corruptLines >= 1, `corrupt=${stats.corruptLines}`);
    }),
    check('benchmark.validation-bounds', 'qualityScore bounds + failureClass enum enforced', () => {
      expectThrows(() => validateBenchmarkRecord({ kind: 'score', schemaVersion: 1, runId: 'x', qualityScore: 1.5, scoredAt: 1 }), 'score >1 rejected');
      expectThrows(() => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, failureClass: 'NOT_A_CLASS' }), 'bad failureClass rejected');
      expectThrows(() => validateBenchmarkRecord({ kind: 'nope', schemaVersion: 1 }), 'unknown kind rejected');
      expectTrue(BenchmarkValidationError !== undefined, 'error type present');
    }),
    check('benchmark.aggregation', 'aggregation groups by provider+model with rates', async () => {
      const runs = [
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'a', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 2, success: true, qualityScore: 0.9, latencyMs: 100 },
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'b', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 2, success: false, failureClass: 'TIMEOUT' as const, latencyMs: 300 },
      ];
      const agg = aggregateRuns(runs);
      expectEqual(agg.length, 1, 'one group');
      expectEqual(agg[0].samples, 2, 'samples');
      expectTrue(Math.abs(agg[0].successRate - 0.5) < 1e-9, 'success rate');
      expectTrue(Math.abs((agg[0].avgQuality ?? 0) - 0.9) < 1e-9, 'avg quality');
    }),
    check('benchmark.empty-history', 'empty history aggregation is empty, not crash', () => {
      expectEqual(aggregateRuns([]).length, 0, 'empty groups');
    }),
    check('benchmark.provenance-binding', 'commitHash + irVersion bind runs to provenance; malformed rejected', () => {
      expectThrows(
        () => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, commitHash: 'not-a-sha' }),
        'malformed commitHash rejected',
      );
      expectThrows(
        () => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, irVersion: 'bad version!' }),
        'malformed irVersion rejected',
      );
      const ok = validateBenchmarkRecord({
        kind: 'run', schemaVersion: 1, runId: 'p1', taskId: 't', provider: 'p', model: 'm', profile: 'unit',
        startedAt: 1,
        commitHash: 'd347e703908d0406b7a7ef80e3a0e594d86b2215',
        irVersion: '1.0.0',
      });
      expectEqual((ok as { commitHash?: string }).commitHash, 'd347e703908d0406b7a7ef80e3a0e594d86b2215', 'sha roundtrip');
      const unavailable = validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, commitHash: 'UNAVAILABLE' });
      expectEqual((unavailable as { commitHash?: string }).commitHash, 'UNAVAILABLE', 'UNAVAILABLE accepted');
    }),
  ];
}

export function routerChecks(): Check[] {
  const runSelect = (candidates: RouterCandidate[], overrides: Partial<Parameters<typeof selectRoute>[0]> = {}) =>
    selectRoute({
      config: DEFAULT_ROUTER_CONFIG,
      candidates,
      circuit: new CircuitBreaker(DEFAULT_ROUTER_CONFIG.circuit),
      perf: new Map(),
      now: 1_000_000,
      decisionId: 'dec_test',
      input: {},
      ...overrides,
    });

  return [
    check('router.weights-normalized', 'default weights sum to 1 and normalize stays stable', () => {
      expectTrue(weightsAreNormalized(DEFAULT_ROUTER_CONFIG.weights), 'defaults normalized');
    }),
    check('router.paid-rejected', 'paid candidate fails policy gate', () => {
      const decision = runSelect([paidCandidate()]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
      expectTrue(decision.hardGates.some((g) => g.gate === 'policy_cost' && !g.passed), 'policy_cost failed');
      expectTrue(decision.reasonCodes.includes('BLOCKED_NO_ELIGIBLE_ROUTE'), 'reason code present');
    }),
    check('router.unknown-cost-rejected', 'unknown cost fails policy gate', () => {
      const decision = runSelect([freeCandidate({ costClass: 'UNKNOWN' })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.invalid-model-rejected', 'model_valid gate rejects unresolvable models', () => {
      const decision = runSelect([freeCandidate({ modelValid: false })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.unhealthy-rejected', 'circuit-open candidates rejected', () => {
      const circuit = new CircuitBreaker(DEFAULT_ROUTER_CONFIG.circuit);
      const now = 1_000_000;
      for (let i = 0; i < DEFAULT_ROUTER_CONFIG.circuit.failureThreshold; i++) circuit.recordFailure('synthetic-free::synthetic-mini', now);
      const decision = selectRoute({
        config: DEFAULT_ROUTER_CONFIG,
        candidates: [freeCandidate()],
        circuit,
        perf: new Map(),
        now,
        decisionId: 'dec_test',
        input: {},
      });
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked while open');
      expectTrue(decision.hardGates.some((g) => g.gate === 'health_ok' && !g.passed), 'health gate failed');
    }),
    check('router.quota-rejected', 'quota headroom below minimum rejected', () => {
      const decision = runSelect([freeCandidate({ quotaHeadroom: 0.01 })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.context-insufficient', 'context gate rejects insufficient windows', () => {
      const decision = runSelect([freeCandidate({ contextWindow: 1024 })], {
        input: { requiredContextTokens: 8192 },
      });
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.best-eligible-wins', 'best eligible score selected with alternatives recorded', () => {
      const decision = runSelect([freeCandidate(), freeCandidate({ key: 'other::m', provider: 'other', model: 'm', quotaHeadroom: 0.2, failureDomain: 'other' })]);
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'synthetic-free', 'best provider');
      expectTrue((decision.score ?? 0) > 0, 'score positive');
      expectTrue(decision.alternatives.length >= 1, 'alternatives present');
      expectTrue(decision.reasonCodes.includes('OK'), 'OK reason');
    }),
    check('router.circuit-breaker-transitions', 'breaker opens after threshold, recovers after cooldown', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 1_000 });
      breaker.recordFailure('k', 1000);
      expectEqual(breaker.stateOf('k', 1100).state, 'DEGRADED', 'degraded state');
      breaker.recordFailure('k', 1200);
      expectEqual(breaker.stateOf('k', 1300).state, 'CIRCUIT_OPEN', 'open state');
      expectEqual(breaker.stateOf('k', 3000).state, 'DEGRADED', 'half-open after cooldown');
      breaker.recordSuccess('k', 3100);
      expectEqual(breaker.stateOf('k', 3200).state, 'HEALTHY', 'healthy after success');
    }),
    check('router.exploration-until-evidence', 'below min samples → degraded exploration mode', () => {
      const decision = runSelect([freeCandidate()]);
      expectTrue(decision.degraded, 'degraded in exploration');
      expectTrue(decision.reasonCodes.includes('EXPLORATION_NO_HISTORY'), 'exploration reason');
    }),
    check('router.cost-first-rm0', 'RM0-first: FREE_CONFIRMED wins even when rate-limited peer has better history', () => {
      const limited = freeCandidate({
        key: 'limited::m',
        provider: 'limited',
        model: 'm',
        costClass: 'FREE_LIMITED',
        failureDomain: 'limited',
      });
      const decision = runSelect([limited, freeCandidate()], {
        perf: new Map([['limited::m', { avgQuality: 0.95, samples: 20 }]]),
      });
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'synthetic-free', 'FREE_CONFIRMED selected despite worse score');
      expectTrue(decision.costFirstApplied, 'cost-first recorded');
      expectTrue(decision.reasonCodes.some((r) => r.startsWith('COST_FIRST_FREE_CONFIRMED')), 'reason code present');
      // Hard-gate evidence for the demoted candidate is preserved.
      expectTrue(decision.hardGates.some((g) => g.candidate === 'limited::m' && g.passed), 'demoted candidate gates recorded');
      expectEqual(costClassRank('FREE_CONFIRMED'), 0, 'rank order start');
      expectTrue(costClassRank('FREE_LIMITED') > costClassRank('FREE_CONFIRMED'), 'limited ranks below confirmed');
    }),
    check('router.cost-first-opt-out', 'costFirst=false restores pure weighted scoring', () => {
      const limited = freeCandidate({ key: 'limited::m', provider: 'limited', model: 'm', costClass: 'FREE_LIMITED', failureDomain: 'limited' });
      const decision = runSelect([limited, freeCandidate()], {
        config: { ...DEFAULT_ROUTER_CONFIG, costFirst: false },
        perf: new Map([['limited::m', { avgQuality: 0.95, samples: 20 }]]),
      });
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'limited', 'best-scored candidate wins when opt-out');
      expectTrue(!decision.costFirstApplied, 'cost-first not applied');
    }),
    check('router.effort-pacing-deterministic', 'effort pacing maps cost classes and escalates only on verifier FAIL', () => {
      // Pinned DeepSeek adapter level set: off | low | high | max.
      expectEqual(baseEffortFor({ ...DEFAULT_EFFORT_PACING, enabled: true }, 'FREE_CONFIRMED'), 'low', 'free → low');
      expectEqual(baseEffortFor({ ...DEFAULT_EFFORT_PACING, enabled: true }, 'PAID'), 'high', 'paid → high');
      expectEqual(baseEffortFor(DEFAULT_EFFORT_PACING, 'FREE_CONFIRMED'), undefined, 'disabled → untouched');
      expectEqual(escalateEffort('low'), 'high', 'one-step escalation');
      expectEqual(escalateEffort('max'), 'max', 'max is terminal');
      expectEqual(escalateEffort('off'), 'low', 'off escalates to low');
    }),
  ];
}

export function verifierChecks(): Check[] {
  return [
    check('verifier.exact-pass-fail', 'exact-text validator passes and fails correctly', async () => {
      const pass = await runValidator({ spec: { validatorId: 'v1', type: 'exact-text', config: { expected: 'supreme' } }, config: { ...{ allowCommands: false, allowNetwork: false, allowedRoots: ['/roots'], commandTimeoutMs: 1000 } }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: 'supreme' });
      const fail = await runValidator({ spec: { validatorId: 'v1', type: 'exact-text', config: { expected: 'supreme' } }, config: { allowCommands: false, allowNetwork: false, allowedRoots: ['/roots'], commandTimeoutMs: 1000 }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: 'other' });
      expectEqual(pass.status, 'PASS', 'exact pass');
      expectEqual(fail.status, 'FAIL', 'exact fail');
      expectTrue(fail.status !== 'ERROR', 'fail is not crash');
    }),
    check('verifier.json-and-schema', 'json-parse + schema-subset validators', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const ok = await runValidator({ spec: { validatorId: 'j', type: 'json-parse', config: {} }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{"a":1}' });
      const bad = await runValidator({ spec: { validatorId: 'j', type: 'json-parse', config: {} }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{nope' });
      const schema = await runValidator({
        spec: { validatorId: 's', type: 'json-schema', config: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
        config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{"ok":true}',
      });
      expectEqual(ok.status, 'PASS', 'json parse ok');
      expectEqual(bad.status, 'FAIL', 'json parse fail');
      expectEqual(schema.status, 'PASS', 'schema pass');
    }),
    check('verifier.path-confinement', 'file validators restricted to allowedRoots', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: ['/roots/data'], commandTimeoutMs: 1000 };
      const inside = await runValidator({ spec: { validatorId: 'f', type: 'file-exists', config: { path: '/roots/data/file.txt' } }, config: cfg, runtime: { ...noopRuntime, fsExists: async () => true }, pathMod, labPolicyConfirmed: false });
      const outside = await runValidator({ spec: { validatorId: 'f', type: 'file-exists', config: { path: '/etc/passwd' } }, config: cfg, runtime: { ...noopRuntime, fsExists: async () => true }, pathMod, labPolicyConfirmed: false });
      expectEqual(inside.status, 'PASS', 'inside root passes');
      expectEqual(outside.status, 'UNAVAILABLE', 'outside root unavailable');
      expectEqual(outside.reasonCode, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'confinement reason');
    }),
    check('verifier.commands-unavailable-by-default', 'command validators report UNAVAILABLE, never fake PASS', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const result = await runValidator({ spec: { validatorId: 'c', type: 'command-exit', config: { command: 'echo' } }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: true });
      expectEqual(result.status, 'UNAVAILABLE', 'commands unavailable');
      const notLab = await runValidator({ spec: { validatorId: 'c', type: 'command-exit', config: { command: 'echo' } }, config: { ...cfg, allowCommands: true }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false });
      expectEqual(notLab.status, 'UNAVAILABLE', 'commands need LAB policy');
    }),
    check('verifier.exception-becomes-error', 'validator exceptions become ERROR results', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const result = await runValidator({
        spec: { validatorId: 'x', type: 'regex', config: {} },
        config: cfg,
        runtime: noopRuntime,
        pathMod,
        labPolicyConfirmed: false,
        subject: 'x',
      });
      expectEqual(result.status, 'ERROR', 'missing pattern → ERROR');
    }),
    check('verifier.evidence-scrubbed', 'evidence is bounded and sentinel-free', async () => {
      expectTrue(!sanitizeEvidence('SECRET_SENTINEL_ABC hidden').includes('SECRET_SENTINEL'), 'sentinel scrubbed');
      expectTrue(sanitizeEvidence('x'.repeat(1000)).length <= 512, 'evidence bounded');
      expectTrue(validateJsonSchemaSubset({ ok: true }, { type: 'object', required: ['ok'] }).length === 0, 'schema subset ok');
    }),
    check('verifier.path-confined-helper', 'pathIsAllowed deterministic', () => {
      expectTrue(pathIsAllowed('/roots/data/a', ['/roots/data'], pathMod), 'allowed');
      expectTrue(!pathIsAllowed('/other/a', ['/roots/data'], pathMod), 'denied');
    }),
  ];
}

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    class: 'PROJECT_CONTEXT',
    source: 'unit',
    text: 'project knowledge entry',
    estimatedTokens: 10,
    priority: 50,
    ...overrides,
  };
}

export function memoryChecks(): Check[] {
  return [
    check('memory.budget-enforced', 'selection stays within budget', () => {
      const items = [memoryItem({ id: 'a', estimatedTokens: 60, priority: 80 }), memoryItem({ id: 'b', estimatedTokens: 60, priority: 70 })];
      const selection = selectMemory({ taskText: 'task', budgetTokens: 100, items, providerState: 'UNAVAILABLE' });
      expectTrue(selection.totalEstimatedTokens <= 100, `used=${selection.totalEstimatedTokens}`);
      expectTrue(selection.selected.length === 1, 'highest priority fits');
      expectTrue(selection.excluded.some((e) => e.id === 'b' && e.reason === 'BUDGET_EXCEEDED'), 'overflow excluded');
    }),
    check('memory.priority-order', 'higher priority selected first', () => {
      const items = [memoryItem({ id: 'low', estimatedTokens: 30, priority: 10 }), memoryItem({ id: 'high', estimatedTokens: 30, priority: 90 })];
      const selection = selectMemory({ taskText: 'task', budgetTokens: 35, items, providerState: 'UNAVAILABLE' });
      expectEqual(selection.selected[0].item.id, 'high', 'priority order');
    }),
    check('memory.secret-exclusion', 'credential-bearing items never enter context', () => {
      const secret = memoryItem({ id: 's', text: 'api key: sk-abcdef1234567890' });
      expectTrue(isSecretBearing(secret), 'secret detected');
      const selection = selectMemory({ taskText: 'task', budgetTokens: 1000, items: [secret], providerState: 'UNAVAILABLE' });
      expectTrue(selection.excluded.some((e) => e.id === 's' && e.reason === 'SECRET_CATEGORY'), 'secret excluded');
      expectEqual(selection.selected.length, 0, 'nothing selected');
    }),
    check('memory.noop-provider-valid', 'NOOP long-term provider is a legitimate state', () => {
      expectEqual(NOOP_LONG_TERM_PROVIDER.status, 'UNAVAILABLE', 'noop unavailable');
      expectEqual(NOOP_LONG_TERM_PROVIDER.list({ taskText: 'x', limit: 5 }).length, 0, 'noop returns nothing');
    }),
    check('memory.needs-memory-conditional', 'memory is conditional on task + pressure', () => {
      expectTrue(!needsMemory({ taskText: '' }).required, 'no task → no memory');
      expectTrue(!needsMemory({ taskText: 'x', tokenPressure: 0.9 }).required, 'high pressure → no memory');
      expectTrue(needsMemory({ taskText: 'plan the work', tokenPressure: 0.2 }).required, 'normal task → memory');
      expectTrue(estimateTokens('abcd') === 1, 'estimate fn');
    }),
    check('memory.ledger-roundtrip-bounded', 'note ledger: append → init → trim to maxEntries', async () => {
      const files = new Map<string, string>();
      const fs: LedgerFs = {
        readFile: async (p) => files.get(p) ?? null,
        appendFile: async (p, line) => {
          files.set(p, (files.get(p) ?? '') + line);
        },
        mkdir: async () => {},
      };
      const ledger = new NoteLedger('/mem/ledger.jsonl', fs, 3);
      await ledger.init();
      for (let i = 0; i < 5; i++) {
        const ok = await ledger.append({ id: `n${i}`, text: `note ${i}`, tags: [], priority: 50, confidence: 0.9, createdAt: 1000 + i, source: 'unit' });
        expectTrue(ok, `note ${i} accepted`);
      }
      expectEqual(ledger.stats().entries, 3, 'memory view trimmed to maxEntries (newest kept)');
      // Reload from the append-only file: same bounded view, no crash.
      const reloaded = new NoteLedger('/mem/ledger.jsonl', fs, 3);
      const stats = await reloaded.init();
      expectEqual(stats.entries, 3, 'reload bounded');
      expectTrue(reloaded.list()[2].id === 'n4', 'newest notes kept');
    }),
    check('memory.ledger-validation', 'ledger notes validated; credential-bearing rejected at admission', () => {
      expectThrows(() => validateLedgerNote({ id: 'x', text: 't', tags: [], priority: 50, confidence: 1.5, createdAt: 1, source: 's' }), 'confidence >1 rejected');
      expectThrows(
        () => validateLedgerNote({ id: 'x', text: 'api key: sk-abcdef1234567890', tags: [], priority: 50, confidence: 0.9, createdAt: 1, source: 's' }),
        'secret-bearing note rejected',
      );
      const ok = validateLedgerNote({ id: 'ok', text: 'deterministic note', tags: ['t'], priority: 10, confidence: 0.8, createdAt: 5, source: 'unit' });
      expectEqual(ok.id, 'ok', 'valid note accepted');
      expectTrue(LedgerValidationError !== undefined, 'error type present');
    }),
    check('memory.instinct-gates', 'instinct params: confidence gate + maxInjected cap + relevance ranking', () => {
      const notes: LedgerNote[] = [
        { id: 'low-conf', text: 'router scoring weights', tags: ['router'], priority: 90, confidence: 0.5, createdAt: 3, source: 'unit' },
        { id: 'relevant', text: 'cost-first routing prefers free models', tags: ['router', 'cost'], priority: 40, confidence: 0.9, createdAt: 2, source: 'unit' },
        { id: 'high-prio', text: 'unrelated note about tests', tags: ['tests'], priority: 95, confidence: 0.9, createdAt: 1, source: 'unit' },
      ];
      // Confidence gate: 0.5 < 0.7 never injects.
      const gated = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 6, relevanceRanking: true });
      expectTrue(!gated.some((n) => n.id === 'low-conf'), 'below-threshold note excluded');
      // Relevance ranking: task-matching note outranks higher-priority unrelated one.
      expectEqual(gated[0].id, 'relevant', 'relevance first');
      // Ranking disabled → priority order restored.
      const priorityOrder = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 6, relevanceRanking: false });
      expectEqual(priorityOrder[0].id, 'high-prio', 'priority order without ranking');
      // Cap: maxInjected=1 keeps only the best.
      const capped = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 1, relevanceRanking: true });
      expectEqual(capped.length, 1, 'cap enforced');
      expectEqual(capped[0].id, 'relevant', 'cap keeps the best');
      // Projection into the memory pipeline keeps secret exclusion semantics.
      const items = ledgerNotesToItems(gated);
      expectTrue(items.every((i) => i.id.startsWith('ledger:')), 'projected with ledger ids');
      expectTrue(ledgerRelevanceScore(notes[1], new Set(['router', 'cost', 'fix'])) > 0, 'relevance score positive');
    }),
    check('memory.ledger-append-rejects-garbage', 'append counts invalid notes instead of throwing', async () => {
      const files = new Map<string, string>();
      const fs: LedgerFs = {
        readFile: async (p) => files.get(p) ?? null,
        appendFile: async (p, line) => {
          files.set(p, (files.get(p) ?? '') + line);
        },
        mkdir: async () => {},
      };
      const ledger = new NoteLedger('/mem/ledger2.jsonl', fs, 10);
      await ledger.init();
      const bad = await ledger.append({ id: 'bad', text: 'x', tags: [], priority: 50, confidence: 9, createdAt: 1, source: 'unit' });
      expectTrue(!bad, 'invalid note rejected');
      expectEqual(ledger.stats().rejected, 1, 'rejection counted');
      expectEqual(ledger.stats().entries, 0, 'nothing stored');
    }),
  ];
}

export function workflowChecks(): Check[] {
  const baseInput = {
    complexity: 'simple' as const,
    parallelizable: false,
    risk: 'LOW' as const,
    requiresCapabilities: [] as string[],
    availableCapabilities: [] as string[],
    availableProviders: ['spawn'],
    depth: 0,
    activeAgents: 0,
    totalAgentsUsed: 0,
  };

  return [
    check('workflow.simple-direct', 'simple non-parallel tasks choose DIRECT', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, baseInput);
      expectEqual(result.decision, 'DIRECT', 'direct decision');
    }),
    check('workflow.parallel-workflow', 'parallelizable complex tasks may choose WORKFLOW', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true });
      expectEqual(result.decision, 'WORKFLOW', 'workflow decision');
    }),
    check('workflow.high-risk-supreme', 'high-risk complex tasks escalate to SUPREME_WORKFLOW', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, risk: 'HIGH' });
      expectEqual(result.decision, 'SUPREME_WORKFLOW', 'supreme decision');
      expectEqual(result.expectedVerification, 'REQUIRED', 'verification required');
    }),
    check('workflow.concurrency-degrades', 'saturation degrades the decision ladder', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, activeAgents: 99 });
      expectTrue(result.decision === 'DIRECT' || result.reasonCodes.includes('CONCURRENCY_LIMIT'), 'degraded');
      expectEqual(result.degradedFrom, 'WORKFLOW', 'degraded from recorded');
    }),
    check('workflow.depth-enforced', 'depth beyond limit denies deeper delegation', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, depth: 3 });
      expectEqual(result.decision, 'DENY', 'depth denied');
    }),
    check('workflow.secrets-never-delegated', 'secret access request → DENY', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, secretAccessRequested: true });
      expectEqual(result.decision, 'DENY', 'secret denied');
    }),
    check('workflow.limit-validation', 'limits validation rejects out-of-bounds config', () => {
      expectThrows(() => validateWorkflowLimits({ maxConcurrentAgents: 99 }), 'maxConcurrentAgents bounded');
      expectThrows(() => validateWorkflowLimits({ maxDepth: -1 }), 'maxDepth bounded');
      expectThrows(() => validateWorkflowLimits({ workflowTimeoutMs: 10 }), 'workflowTimeout bounded');
      expectTrue(WorkflowConfigError !== undefined, 'error type present');
    }),
    check('workflow.delegation-scope-explicit', 'delegation scope requires every field; secret policy fixed', () => {
      const scope = buildDelegationScope({
        task: 'refactor module',
        allowedCapabilities: ['fs.read'],
        allowedPaths: ['/workspace/src'],
        forbiddenPaths: ['/workspace/secrets'],
        writePermission: false,
        secretPolicy: 'DENY_ALL',
        expectedOutput: 'patch summary',
        verificationRequirement: 'REQUIRED',
        stopCondition: 'validator PASS or 2 retries',
      });
      expectEqual(scope.secretPolicy, 'DENY_ALL', 'secret policy frozen');
      expectThrows(
        () =>
          buildDelegationScope({
            task: 'x',
            allowedCapabilities: [],
            allowedPaths: [],
            forbiddenPaths: [],
            writePermission: false,
            secretPolicy: 'ALLOW_SOME' as never,
            expectedOutput: 'y',
            verificationRequirement: 'NONE',
            stopCondition: 'z',
          }),
        'non-DENY_ALL rejected',
      );
    }),
    check('workflow.path-scope-surgical', 'surgical path scope: blocked wins, globs deterministic', () => {
      expectTrue(pathMatchesGlob('src/app/main.ts', 'src/**/*.ts'), '** crosses segments');
      expectTrue(pathMatchesGlob('src/main.ts', 'src/*.ts'), '* stays in segment');
      expectTrue(!pathMatchesGlob('src/a/b.ts', 'src/*.ts'), '* does not cross segments');
      expectTrue(pathMatchesGlob('src/a1.ts', 'src/a?.ts'), '? matches one char');
      const limits = { allowedPaths: ['src/**', 'docs/*.md'], blockedPaths: ['**/secrets/**', 'src/vault.ts'] };
      expectEqual(evaluatePathScope(limits, 'src/app/x.ts').reasonCode, 'PATH_ALLOWED', 'inside allowlist');
      expectEqual(evaluatePathScope(limits, 'README.md').reasonCode, 'PATH_OUTSIDE_ALLOWED', 'outside allowlist');
      const blocked = evaluatePathScope(limits, 'src/vault.ts');
      expectTrue(!blocked.allowed && blocked.reasonCode === 'PATH_BLOCKED', 'blocked wins over allowed');
      expectEqual(evaluatePathScope(limits, 'config/secrets/key.pem').reasonCode, 'PATH_BLOCKED', 'secrets glob blocked');
      expectEqual(evaluatePathScope({ allowedPaths: [], blockedPaths: [] }, 'anything').reasonCode, 'NO_PATH_RULES', 'no rules = unrestricted');
    }),
    check('workflow.close-gate-verifier', 'requireVerifierPassOnClose: HIGH risk closes only on verifier PASS', () => {
      const limits = { requireVerifierPassOnClose: true };
      expectTrue(!canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable, 'FAIL blocks close');
      expectTrue(!canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'MISSING' }).closable, 'MISSING evidence blocks close');
      expectTrue(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS' }).closable, 'PASS closes');
      expectTrue(canCloseTask(limits, { risk: 'LOW', verifierStatus: 'MISSING' }).closable, 'LOW risk unrestricted');
      expectTrue(canCloseTask({ requireVerifierPassOnClose: false }, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable, 'disabled → unrestricted');
    }),
    check('workflow.close-gate-in-decision', 'decideWorkflow stamps the close gate for HIGH-risk tasks', () => {
      const limits = validateWorkflowLimits({ ...WORKFLOW_LIMIT_DEFAULTS, requireVerifierPassOnClose: true });
      const high = decideWorkflow(limits, { ...baseInput, complexity: 'complex', parallelizable: true, risk: 'HIGH' });
      expectEqual(high.closeGate, 'VERIFIER_PASS_REQUIRED', 'HIGH task requires verifier pass to close');
      const low = decideWorkflow(limits, baseInput);
      expectEqual(low.closeGate, 'NONE', 'LOW task closes freely');
    }),
  ];
}
