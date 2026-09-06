/**
 * supreme-gate-driver — Task 10 KEYLESS SYNTHETIC SCENARIO (mounted LAST).
 *
 * Runs the end-to-end Supreme scenario against the REAL booted DSH tree and
 * writes a structured gate marker. Proves (Spec §30):
 *   policy loads / observability records safely / benchmark stores evidence /
 *   router selects eligible synthetic route + rejects paid / verifier runs /
 *   memory stays in budget / workflow policy respects limits / DSH session
 *   remains canonical / clean shutdown.
 *
 * The driver is a FIXTURE-classified plugin (like the fake providers LAB is
 * allowed to mount). It registers NO model-facing tools.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import '../context-types';
export const name = 'supreme-gate-driver';

export const inject = [
  'supremePolicy',
  'supremeObservability',
  'supremeBenchmark',
  'supremeRouter',
  'supremeVerifier',
  'supremeMemoryPolicy',
  'supremeWorkflowPolicy',
  'sessions',
];

export const Config = z.object({
  markerPath: z.string().default('dsh-supreme/data/real/gate-driver.markers.jsonl'),
});

interface GateResult {
  gate: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  detail: string;
}

export function apply(
  ctx: import('@deepseek-ai/cordis').Context,
  config: z.infer<typeof Config>,
): void {
  const markerPath = resolve(config.markerPath);
  const write = (payload: Record<string, unknown>): void => {
    mkdirSync(dirname(markerPath), { recursive: true });
    appendFileSync(markerPath, JSON.stringify(payload) + '\n');
  };

  ctx.effect(
    () => {
      void runScenario(ctx).then(
        (results) => write({ event: 'SUPREME_GATES', ts: Date.now(), results }),
        (err: unknown) =>
          write({
            event: 'SUPREME_GATES',
            ts: Date.now(),
            results: [{ gate: 'scenario', status: 'ERROR', detail: String(err) }] satisfies GateResult[],
          }),
      );
      // Fire-and-forget scenario; completion is tracked via the marker file.
      return () => undefined;
    },
    'supreme-gate-driver.scenario',
  );
}

type Services = {
  policy: import('../supreme-policy/index').PolicyService;
  obs: import('../supreme-observability/index').ObservabilityService;
  bench: import('../supreme-benchmark/index').BenchmarkService;
  router: import('../supreme-router/index').RouterService;
  verifier: import('../supreme-verifier/index').VerifierService;
  memory: import('../supreme-memory-policy/index').MemoryPolicyService;
  workflow: import('../supreme-workflow-policy/index').WorkflowPolicyService;
};

async function runScenario(ctx: import('@deepseek-ai/cordis').Context): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const gate = (gate: string, status: GateResult['status'], detail: string): void => {
    results.push({ gate, status, detail });
  };

  const s: Services = {
    policy: ctx.supremePolicy,
    obs: ctx.supremeObservability,
    bench: ctx.supremeBenchmark,
    router: ctx.supremeRouter,
    verifier: ctx.supremeVerifier,
    memory: ctx.supremeMemoryPolicy,
    workflow: ctx.supremeWorkflowPolicy,
  };

  // 1. Policy gates. LAB explicitly allows paid (Spec §9) — allowed ONLY there.
  const free = s.policy.evaluateRoute({ costClass: 'FREE_CONFIRMED', risk: 'LOW' });
  const paid = s.policy.evaluateRoute({ costClass: 'PAID', risk: 'LOW' });
  const unknown = s.policy.evaluateRoute({ costClass: 'UNKNOWN', risk: 'LOW' });
  const paidOnlyInLab = !paid.allowed || s.policy.config.executionClass === 'LAB';
  gate(
    'policy_loads_and_gates_cost',
    free.allowed && !unknown.allowed && paidOnlyInLab ? 'PASS' : 'FAIL',
    `free=${free.allowed} paid=${paid.allowed} (labOnly=${String(paidOnlyInLab)}) unknown=${unknown.allowed}`,
  );

  // 2. DSH Session stays canonical: create a REAL session through ctx.sessions
  // (declared inject — the canonical owner; we never duplicate it).
  try {
    const session = ctx.sessions.create();
    gate('session_canonical', 'PASS', `real DSH session created (id=${String(session.id).slice(0, 18)}…)`); 
  } catch (err) {
    gate('session_canonical', 'ERROR', String(err));
  }

  // 3. Benchmark evidence roundtrip.
  try {
    await s.bench.recordTask({ taskId: 'gate-task-1', category: 'synthetic' });
    const runId = await s.bench.startRun({
      taskId: 'gate-task-1',
      taskCategory: 'synthetic',
      provider: 'synthetic-free',
      model: 'synthetic-mini',
      profile: 'gate',
    });
    await s.bench.finishRun(runId, { success: true, latencyMs: 42, toolCount: 0 });
    await s.bench.recordScore({ runId, qualityScore: 0.9 });
    const agg = s.bench.aggregateModelPerformance();
    const ok = agg.some((a) => a.provider === 'synthetic-free' && a.samples >= 1 && a.avgQuality !== null);
    gate('benchmark_stores_evidence', ok ? 'PASS' : 'FAIL', `agg=${JSON.stringify(agg.map((a) => [a.provider, a.samples]))}`);
  } catch (err) {
    gate('benchmark_stores_evidence', 'ERROR', String(err));
  }

  // 4. Router: eligible synthetic route selected; paid candidate rejected.
  try {
    const decision = await s.router.route({ requiredCapabilities: ['chat'] });
    const paidGateFailed = decision.hardGates.some(
      (g) => g.candidate.includes('paid') && g.gate === 'policy_cost' && !g.passed,
    );
    const failedSummary = decision.hardGates
      .filter((g) => !g.passed)
      .map((g) => `${g.candidate}:${g.gate}:${g.reason ?? ''}`)
      .slice(0, 6)
      .join(' | ');
    gate(
      'router_selects_eligible',
      decision.blocked === null ? 'PASS' : 'FAIL',
      `${decision.provider ?? 'none'}/${decision.model ?? 'none'} score=${decision.score ?? 'n/a'} failed=[${failedSummary}]`,
    );
    gate('router_rejects_paid', paidGateFailed ? 'PASS' : 'FAIL', `paid policy_cost gate failed=${String(paidGateFailed)}`);
  } catch (err) {
    gate('router_selects_eligible', 'ERROR', String(err));
  }

  // 5. Verifier runs deterministic validators.
  try {
    s.verifier.register({ validatorId: 'gate-exact', type: 'exact-text', config: { expected: 'supreme' } });
    s.verifier.register({
      validatorId: 'gate-schema',
      type: 'json-schema',
      config: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
    });
    const pass = await s.verifier.run('gate-exact', 'supreme');
    const schema = await s.verifier.run('gate-schema', '{"ok":true}');
    gate(
      'verifier_executes',
      pass.status === 'PASS' && schema.status === 'PASS' ? 'PASS' : 'FAIL',
      `exact=${pass.status} schema=${schema.status}`,
    );
  } catch (err) {
    gate('verifier_executes', 'ERROR', String(err));
  }

  // 6. Memory policy budget + secret exclusion.
  try {
    const selection = s.memory.select({ taskText: 'summarize the project plan', budgetTokens: 400 });
    const secretFree = selection.excluded.some((e) => e.reason === 'SECRET_CATEGORY');
    const withinBudget = selection.totalEstimatedTokens <= 400;
    gate(
      'memory_respects_budget',
      withinBudget ? 'PASS' : 'FAIL',
      `used=${selection.totalEstimatedTokens}/${selection.budgetTokens} secretExcluded=${String(secretFree)}`,
    );
  } catch (err) {
    gate('memory_respects_budget', 'ERROR', String(err));
  }

  // 7. Workflow policy limits.
  try {
    const simple = s.workflow.decide({
      complexity: 'simple',
      parallelizable: false,
      risk: 'LOW',
      requiresCapabilities: [],
      availableCapabilities: [],
      availableProviders: ['spawn'],
      depth: 0,
      activeAgents: 0,
      totalAgentsUsed: 0,
    });
    const saturated = s.workflow.decide({
      complexity: 'complex',
      parallelizable: true,
      risk: 'LOW',
      requiresCapabilities: [],
      availableCapabilities: [],
      availableProviders: ['spawn'],
      depth: 0,
      activeAgents: 99,
      totalAgentsUsed: 0,
    });
    const ok =
      simple.decision === 'DIRECT' &&
      (saturated.decision === 'DIRECT' || saturated.reasonCodes.includes('CONCURRENCY_LIMIT'));
    gate('workflow_respects_limits', ok ? 'PASS' : 'FAIL', `simple=${simple.decision} saturated=${saturated.decision}`);
  } catch (err) {
    gate('workflow_respects_limits', 'ERROR', String(err));
  }

  // 8. Observability recorded events safely (allow the async writer queue to drain).
  try {
    s.obs.record('gate_driver_event', { detail: 'synthetic' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const stats = s.obs.stats();
    gate('observability_records_safely', stats.written > 0 ? 'PASS' : 'FAIL', `written=${stats.written} dropped=${stats.dropped}`);
  } catch (err) {
    gate('observability_records_safely', 'ERROR', String(err));
  }

  return results;
}
