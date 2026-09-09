#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-outcome-routing.mjs — IMP-R verifier (v1.3.1 §3B+§3C
 * "routing based on work outcomes").
 *
 * Proves, on the REAL code and the REAL pinned cordis (tempdirs only):
 *   (a) class-aware selection — a candidate strong in class A / weak in class B
 *       is chosen for A, NOT for B (freshness-decayed Wilson lower bound per
 *       (candidate, taskClass)); engine-level AND adapter-level (real
 *       benchmark history through the real router service);
 *   (b) uncertainty — a 1/1 record does NOT outrank a stable 50/52 record
 *       (Wilson LB ≈ 0.207 vs ≈ 0.87);
 *   (c) freshness — a stale perfect score decays below a recent good score
 *       after the configured half-life (small halfLifeMs);
 *   (d) outcome circuit — opens after N consecutive same-class failures,
 *       blocks routing, and the single half-open probe recovers after cooldown;
 *   (e) classifyFailure maps rate-limit / timeout / credential / verifier
 *       codes deterministically (closed vocabulary);
 *   (f) fast path — a simple task routes directly with fanout 0; a complex
 *       task is never fast-pathed;
 *   (g) the cross-provider fallback plan includes ONLY verified-free
 *       candidates — a paid candidate is never planned while free exists;
 *   (h) AttemptLedger refuses attempts beyond maxRetries (bounded retries
 *       under injected failures) + wall-clock budget check;
 *   (i) checkpoint/resume — resume returns completed state only when the
 *       REAL current artifact hash still matches; side effects are NEVER
 *       auto-repeated (side-effect counter unchanged);
 *   (j) the end-to-end task latency event is emitted through observability
 *       with durations only.
 *
 * Mounting pattern mirrors real/v131-cost-enforce.mjs: REAL zod-resolved
 * adapters (supreme-benchmark, supreme-policy, supreme-router) on the REAL
 * pinned cordis Context. NO upstream file is modified. No new dependencies.
 * Exit 0 + V131_OUTCOME_ROUTING_VERIFIED only when every probe passes.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const routerAdapterHref = new URL('src/plugins/supreme-router/index.ts', ROOT).href;
const routerEngineHref = new URL('src/plugins/supreme-router/engine.ts', ROOT).href;
const benchAdapterHref = new URL('src/plugins/supreme-benchmark/index.ts', ROOT).href;
const benchEngineHref = new URL('src/plugins/supreme-benchmark/engine.ts', ROOT).href;
const policyAdapterHref = new URL('src/plugins/supreme-policy/index.ts', ROOT).href;

// Pinned cordis resolution: node_modules symlink first, vendored fallback.
let Context;
try {
  ({ Context } = await import('@deepseek-ai/cordis'));
} catch {
  const candidates = [
    new URL('../node_modules/.upstream/deepseek-harness/vendor/cordis/src/index.ts', ROOT),
    new URL('../../node_modules/.upstream/deepseek-harness/vendor/cordis/src/index.ts', ROOT),
  ];
  let loaded = null;
  for (const url of candidates) {
    try { loaded = await import(url.href); break; } catch { /* try next */ }
  }
  if (!loaded || typeof loaded.Context !== 'function') {
    throw new Error('pinned cordis unavailable: install @deepseek-ai/cordis or check out deepseek-harness');
  }
  ({ Context } = loaded);
}

const jsonOf = (value) => JSON.stringify(value);
let failures = 0;
let probeNo = 0;
const probe = (name, ok, detail = '') => {
  probeNo += 1;
  if (ok !== true) failures += 1;
  console.log(`  [${String(probeNo).padStart(2, '0')}] ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

// Content canaries: must NEVER appear in any emitted audit event.
const CANARY = 'V131_OR_CONTENT_CANARY_e4b9';
const ARTIFACT_V1 = `STEP0-CONTENT-v1 ${CANARY}`;
const ARTIFACT_TAMPERED = 'STEP0-CONTENT-TAMPERED';

// Temp workspace (outside the repo — wiped on exit).
const TMP = mkdtempSync(join(tmpdir(), 'dsh-supreme-v131-outcome-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

const routerEngine = await import(routerEngineHref);
const benchEngine = await import(benchEngineHref);

// ---------------------------------------------------------------------------
// Harness: REAL pinned cordis + REAL adapters (benchmark on a per-host
// tempdir dataDir, policy at production defaults, router with the config
// under test). Observability is a capturing recorder (ids/labels/counts only
// by construction — the engines under test decide what is emitted).
// ---------------------------------------------------------------------------
const mkHost = async ({ routerConfig, benchDataDir, withBench = true, withPolicy = true } = {}) => {
  const events = [];
  const record = (event, fields) => events.push({ event, fields });
  const root = new Context();

  root.provide('llm', {
    listProviders: () => [{ id: 'prov-a' }, { id: 'prov-b' }, { id: 'prov-c' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  root.provide('supremeObservability', { record, isEnabled: () => true });

  if (withBench) {
    if (!benchDataDir) throw new Error('benchDataDir required for the REAL benchmark adapter');
    mkdirSync(benchDataDir, { recursive: true });
    const benchMod = await import(benchAdapterHref);
    if (benchMod.name !== 'supreme-benchmark') throw new Error('benchmark adapter module shape unexpected');
    await root.plugin(benchMod, { dataDir: benchDataDir, fileName: 'benchmark.jsonl' });
  } else {
    root.provide('supremeBenchmark', { aggregateModelPerformance: () => [] });
  }

  if (withPolicy) {
    const policyMod = await import(policyAdapterHref);
    if (policyMod.name !== 'supreme-policy') throw new Error('policy adapter module shape unexpected');
    await root.plugin(policyMod, {}); // REAL policy, PRODUCTION defaults
  } else {
    root.provide('supremePolicy', {});
  }

  const routerMod = await import(routerAdapterHref);
  if (routerMod.name !== 'supreme-router' || routerMod.inject.length !== 4) {
    throw new Error('router adapter module shape unexpected');
  }
  await root.plugin(routerMod, routerConfig ?? { candidates: [] });

  const router = root.get('supremeRouter');
  const bench = root.get('supremeBenchmark');
  const eventsNamed = (name) => events.filter((e) => e.event === name);
  const dispose = () => root.fiber.dispose();
  return { root, events, eventsNamed, router, bench, dispose };
};

/** Seed REAL benchmark runs (startRun + finishRun) for class-aware evidence. */
const seedRuns = async (bench, { provider, model, taskClass, successes, failures: fails, latencyMs = 5 }) => {
  for (let i = 0; i < successes; i++) {
    const runId = await bench.startRun({ taskId: `t-${provider}-${taskClass}-s${i}`, taskCategory: taskClass, provider, model, profile: 'lab' });
    await bench.finishRun(runId, { success: true, latencyMs });
  }
  for (let i = 0; i < fails; i++) {
    const runId = await bench.startRun({ taskId: `t-${provider}-${taskClass}-f${i}`, taskCategory: taskClass, provider, model, profile: 'lab' });
    await bench.finishRun(runId, { success: false, failureClass: 'WRONG_ANSWER', latencyMs });
  }
};

// Two structurally identical free candidates (identical quota/domain) so ONLY
// the class-aware quality component can decide — any flip is attributable.
const TWO_CANDIDATES = {
  candidates: [
    {
      provider: 'prov-a', credentialMode: 'config-owned', credentialConfigured: true, quotaHeadroom: 0.9,
      models: [{ model: 'model-a', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'dom' }],
    },
    {
      provider: 'prov-b', credentialMode: 'config-owned', credentialConfigured: true, quotaHeadroom: 0.9,
      models: [{ model: 'model-b', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'dom' }],
    },
  ],
};

const T0 = 1_700_000_000_000;

console.log('== v1.3.1 outcome-routing verify — REAL engines + REAL adapters on pinned cordis ==');

// ---------------------------------------------------------------------------
console.log('[a] class-aware selection: strong-in-A candidate chosen for A, not for B');
{
  // Engine level — deterministic tracker fed by hand.
  const tracker = new routerEngine.ClassPerformanceTracker({ halfLifeMs: 3_600_000 });
  for (let i = 0; i < 24; i++) tracker.observe('prov-a::model-a', 'CLASS_A', i < 22, T0); // 22/24 in A
  for (let i = 0; i < 24; i++) tracker.observe('prov-a::model-a', 'CLASS_B', i < 4, T0);  // 4/24 in B
  for (let i = 0; i < 24; i++) tracker.observe('prov-b::model-b', 'CLASS_A', i < 4, T0);
  for (let i = 0; i < 24; i++) tracker.observe('prov-b::model-b', 'CLASS_B', i < 22, T0);
  const mk = (decisionId, taskClass) => routerEngine.selectRoute({
    config: { ...routerEngine.DEFAULT_ROUTER_CONFIG },
    candidates: [
      { key: 'prov-a::model-a', provider: 'prov-a', model: 'model-a', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
      { key: 'prov-b::model-b', provider: 'prov-b', model: 'model-b', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
    ],
    circuit: new routerEngine.CircuitBreaker({ failureThreshold: 3, windowMs: 300_000, cooldownMs: 60_000 }),
    perf: new Map(),
    now: T0 + 1_000,
    decisionId,
    input: { taskClass },
    classPerf: tracker,
  });
  const forA = mk('d-a', 'CLASS_A');
  const forB = mk('d-b', 'CLASS_B');
  probe('a1 engine: CLASS_A task selects the strong-in-A candidate', forA.provider === 'prov-a' && forA.blocked === null, jsonOf({ provider: forA.provider, score: forA.score }));
  probe('a2 engine: CLASS_B task selects the strong-in-B candidate', forB.provider === 'prov-b' && forB.blocked === null, jsonOf({ provider: forB.provider, score: forB.score }));
  probe('a3 engine: class-aware decisions carry taskClass + CLASS_AWARE_QUALITY reason', forA.taskClass === 'CLASS_A' && forB.taskClass === 'CLASS_B' && forA.reasonCodes.includes('CLASS_AWARE_QUALITY') && forB.reasonCodes.includes('CLASS_AWARE_QUALITY'), jsonOf(forA.reasonCodes));

  // Adapter level — REAL benchmark store (tempdir) through the REAL router.
  const dir = join(TMP, 'bench-a');
  const host = await mkHost({ routerConfig: TWO_CANDIDATES, benchDataDir: dir });
  await seedRuns(host.bench, { provider: 'prov-a', model: 'model-a', taskClass: 'CLASS_A', successes: 22, failures: 2 });
  await seedRuns(host.bench, { provider: 'prov-a', model: 'model-a', taskClass: 'CLASS_B', successes: 4, failures: 20 });
  await seedRuns(host.bench, { provider: 'prov-b', model: 'model-b', taskClass: 'CLASS_A', successes: 4, failures: 20 });
  await seedRuns(host.bench, { provider: 'prov-b', model: 'model-b', taskClass: 'CLASS_B', successes: 22, failures: 2 });
  probe('a4 adapter: benchmark classSamples exposes bounded per-class rows from REAL runs', (() => {
    const rows = host.bench.classSamples(512);
    return rows.length === 96 && rows.every((r) => typeof r.success === 'boolean' && typeof r.at === 'number');
  })(), jsonOf(host.bench.classSamples(512).length));
  const routeA = await host.router.route({ taskClass: 'CLASS_A' });
  const routeB = await host.router.route({ taskClass: 'CLASS_B' });
  probe('a5 adapter: route(taskClass=CLASS_A) picks prov-a (real history wiring)', routeA.provider === 'prov-a' && routeA.blocked === null, jsonOf({ provider: routeA.provider, score: routeA.score, reasons: routeA.reasonCodes }));
  probe('a6 adapter: route(taskClass=CLASS_B) picks prov-b — the flip is real', routeB.provider === 'prov-b' && routeB.blocked === null, jsonOf({ provider: routeB.provider, score: routeB.score }));
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('[b] uncertainty: 1/1 does NOT outrank stable 50/52 (Wilson lower bound)');
{
  const tracker = new routerEngine.ClassPerformanceTracker({ halfLifeMs: 1_800_000 });
  tracker.observe('lucky::m', 'CLASS_U', true, T0);                       // 1/1, fresh
  for (let i = 0; i < 52; i++) tracker.observe('stable::m', 'CLASS_U', i < 50, T0); // 50/52
  const lucky = tracker.score('lucky::m', 'CLASS_U', T0 + 1);
  const stable = tracker.score('stable::m', 'CLASS_U', T0 + 1);
  probe('b1 engine: single lucky sample LB shrunk to ~0.207 (0.15..0.25)', lucky.score > 0.15 && lucky.score < 0.25 && lucky.samples === 1, jsonOf(lucky));
  probe('b2 engine: stable 50/52 LB ≈ 0.87 (> 0.8)', stable.score > 0.8, jsonOf(stable));
  probe('b3 engine: lucky does NOT outrank stable', lucky.score < stable.score, `${lucky.score} vs ${stable.score}`);
  probe('b4 engine: wilsonLowerBound determinism + neutral no-signal case', (() => {
    const a = routerEngine.wilsonLowerBound(1, 1);
    const b = routerEngine.wilsonLowerBound(1, 1);
    const neutral = routerEngine.wilsonLowerBound(0.5, 0);
    return a === b && Math.abs(a - 1 / (1 + routerEngine.WILSON_Z * routerEngine.WILSON_Z)) < 1e-9 && neutral === 0.5;
  })(), jsonOf({ one: routerEngine.wilsonLowerBound(1, 1) }));

  // Selection level: identical candidates, only the class history differs.
  const tracker2 = new routerEngine.ClassPerformanceTracker({ halfLifeMs: 1_800_000 });
  tracker2.observe('prov-a::model-a', 'CLASS_U', true, T0);
  for (let i = 0; i < 52; i++) tracker2.observe('prov-b::model-b', 'CLASS_U', i < 50, T0);
  const decision = routerEngine.selectRoute({
    config: { ...routerEngine.DEFAULT_ROUTER_CONFIG },
    candidates: [
      { key: 'prov-a::model-a', provider: 'prov-a', model: 'model-a', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
      { key: 'prov-b::model-b', provider: 'prov-b', model: 'model-b', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
    ],
    circuit: new routerEngine.CircuitBreaker({ failureThreshold: 3, windowMs: 300_000, cooldownMs: 60_000 }),
    perf: new Map(),
    now: T0 + 1,
    decisionId: 'd-u',
    input: { taskClass: 'CLASS_U' },
    classPerf: tracker2,
  });
  probe('b5 engine: selection prefers the stable candidate over the 1/1 record', decision.provider === 'prov-b', jsonOf({ provider: decision.provider, score: decision.score }));
}

// ---------------------------------------------------------------------------
console.log('[c] freshness: stale perfect decays below recent good after half-life');
{
  const HALF = 1_000; // small half-life for the probe
  const tracker = new routerEngine.ClassPerformanceTracker({ halfLifeMs: HALF });
  for (let i = 0; i < 10; i++) tracker.observe('stale::m', 'CLASS_F', true, T0);            // 10/10 at T0
  for (let i = 0; i < 10; i++) tracker.observe('recent::m', 'CLASS_F', i < 8, T0 + 3 * HALF); // 8/10 at T0+3h
  const now = T0 + 4 * HALF;
  const stale = tracker.score('stale::m', 'CLASS_F', now);
  const recent = tracker.score('recent::m', 'CLASS_F', now);
  probe('c1 engine: freshness weight is exactly 0.5^(age/halfLife)', routerEngine.freshnessWeight(T0, T0 + 2 * HALF, HALF) === 0.25 && routerEngine.freshnessWeight(T0, T0, HALF) === 1, jsonOf(routerEngine.freshnessWeight(T0, T0 + 2 * HALF, HALF)));
  probe('c2 engine: stale n_eff decayed to 0.625 (sample count literally shrinks)', Math.abs(stale.nEff - 0.625) < 1e-9, jsonOf(stale));
  probe('c3 engine: stale perfect LB decayed below recent good LB', stale.score < recent.score && stale.score < 0.2 && recent.score > 0.3, jsonOf({ stale: stale.score, recent: recent.score }));
  probe('c4 engine: unusable inputs carry no evidential weight', routerEngine.freshnessWeight(T0, T0, 0) === 0 && routerEngine.freshnessWeight(NaN, T0, HALF) === 0, 'freshnessWeight guards');

  const tracker2 = new routerEngine.ClassPerformanceTracker({ halfLifeMs: HALF });
  for (let i = 0; i < 10; i++) tracker2.observe('prov-a::model-a', 'CLASS_F', true, T0);
  for (let i = 0; i < 10; i++) tracker2.observe('prov-b::model-b', 'CLASS_F', i < 8, T0 + 3 * HALF);
  const decision = routerEngine.selectRoute({
    config: { ...routerEngine.DEFAULT_ROUTER_CONFIG },
    candidates: [
      { key: 'prov-a::model-a', provider: 'prov-a', model: 'model-a', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
      { key: 'prov-b::model-b', provider: 'prov-b', model: 'model-b', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
    ],
    circuit: new routerEngine.CircuitBreaker({ failureThreshold: 3, windowMs: 300_000, cooldownMs: 60_000 }),
    perf: new Map(),
    now,
    decisionId: 'd-f',
    input: { taskClass: 'CLASS_F' },
    classPerf: tracker2,
  });
  probe('c5 engine: selection prefers the RECENT good candidate over the stale perfect one', decision.provider === 'prov-b', jsonOf({ provider: decision.provider, score: decision.score }));
}

// ---------------------------------------------------------------------------
console.log('[d] outcome circuit: opens after N consecutive failures; half-open probe recovers');
{
  // Engine level — deterministic state machine.
  const oc = new routerEngine.OutcomeCircuitBreaker({ consecutiveFailures: 3, cooldownMs: 1_000 });
  const T = 50_000;
  oc.recordFailure('p::m', T, 'rate_limit');
  oc.recordFailure('p::m', T + 1, 'rate_limit');
  const before = oc.stateOf('p::m', T + 2);
  probe('d1 engine: 2 consecutive failures stay closed', before.phase === 'closed' && before.consecutiveFailures === 2, jsonOf(before));
  const third = oc.recordFailure('p::m', T + 3, 'rate_limit');
  probe('d2 engine: 3rd consecutive failure OPENS the circuit (same class)', third.phase === 'open' && third.openedUntil === T + 3 + 1_000 && third.lastOutcomeClass === 'rate_limit', jsonOf(third));
  probe('d3 engine: still open inside the cooldown', oc.stateOf('p::m', T + 500).phase === 'open', jsonOf(oc.stateOf('p::m', T + 500)));
  const halfOpen = oc.stateOf('p::m', T + 1_500);
  probe('d4 engine: cooldown elapsed => half_open', halfOpen.phase === 'half_open', jsonOf(halfOpen));
  probe('d5 engine: single probe granted exactly once per episode', oc.acquireProbe('p::m', T + 1_500) === true && oc.acquireProbe('p::m', T + 1_501) === false, 'second acquireProbe must refuse');
  const closed = oc.recordSuccess('p::m', T + 1_600);
  probe('d6 engine: probe success CLOSES the circuit and resets the counter', closed.phase === 'closed' && closed.consecutiveFailures === 0, jsonOf(closed));

  // Provider bucket: unattributed failures open the bucket; a candidate of the
  // same provider is blocked in selectRoute while the bucket is open.
  const bucketCircuit = new routerEngine.OutcomeCircuitBreaker({ consecutiveFailures: 2, cooldownMs: 60_000 });
  bucketCircuit.recordFailure(routerEngine.providerBucketOf('prov-a'), T, 'timeout');
  bucketCircuit.recordFailure(routerEngine.providerBucketOf('prov-a'), T + 1, 'timeout');
  const blockedDecision = routerEngine.selectRoute({
    config: { ...routerEngine.DEFAULT_ROUTER_CONFIG },
    candidates: [
      { key: 'prov-a::model-a', provider: 'prov-a', model: 'model-a', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, credentialConfigured: true, quotaHeadroom: 0.9, failureDomain: 'dom', providerAvailable: true, modelValid: true },
    ],
    circuit: new routerEngine.CircuitBreaker({ failureThreshold: 3, windowMs: 300_000, cooldownMs: 60_000 }),
    perf: new Map(),
    now: T + 2,
    decisionId: 'd-bucket',
    input: {},
    outcomeCircuit: bucketCircuit,
  });
  probe('d7 engine: open provider bucket blocks the candidate (OUTCOME_CIRCUIT_OPEN)', blockedDecision.blocked === 'BLOCKED_NO_ELIGIBLE_ROUTE' && blockedDecision.hardGates.some((g) => g.gate === 'health_ok' && g.reason === 'OUTCOME_CIRCUIT_OPEN'), jsonOf(blockedDecision.hardGates));

  // Adapter level — REAL router service with a small cooldown.
  const dir = join(TMP, 'bench-d');
  const host = await mkHost({
    routerConfig: {
      candidates: [TWO_CANDIDATES.candidates[0]],
      circuit: { failureThreshold: 64, windowMs: 300_000, cooldownMs: 60_000 }, // keep the v1.2 windowed breaker closed
      outcomeCircuit: { enabled: true, consecutiveFailures: 3, cooldownMs: 120 },
    },
    benchDataDir: dir,
  });
  host.router.recordOutcome({ provider: 'prov-a', model: 'model-a', success: false, failureClass: 'RATE_LIMIT' });
  host.router.recordOutcome({ provider: 'prov-a', model: 'model-a', success: false, failureClass: 'RATE_LIMIT' });
  host.router.recordOutcome({ provider: 'prov-a', model: 'model-a', success: false, failureClass: 'RATE_LIMIT' });
  const snapOpen = host.router.outcomeSnapshot().find((s) => s.key === 'prov-a::model-a');
  probe('d8 adapter: 3 consecutive rate-limit failures open the outcome circuit', snapOpen?.phase === 'open' && snapOpen.consecutiveFailures === 3 && snapOpen.lastOutcomeClass === 'rate_limit', jsonOf(snapOpen));
  probe('d9 adapter: circuit_opened audited with errorClass rate_limit (ids/labels only)', host.eventsNamed('circuit_opened').some((e) => e.fields.provider === 'prov-a' && e.fields.errorClass === 'rate_limit'), jsonOf(host.eventsNamed('circuit_opened')));
  const blockedRoute = await host.router.route({ requiredCapabilities: ['chat'] });
  probe('d10 adapter: routing is BLOCKED while the circuit is open', blockedRoute.blocked === 'BLOCKED_NO_ELIGIBLE_ROUTE' && blockedRoute.hardGates.some((g) => g.reason === 'OUTCOME_CIRCUIT_OPEN'), jsonOf(blockedRoute.reasonCodes));
  await sleep(200); // cooldown 120ms elapses → half-open
  const recovered = await host.router.route({ requiredCapabilities: ['chat'] });
  probe('d11 adapter: after cooldown the route is eligible again (half-open passes the gate)', recovered.blocked === null && recovered.provider === 'prov-a', jsonOf({ blocked: recovered.blocked, provider: recovered.provider }));
  probe('d12 adapter: acquireProbe grants the single half-open probe once', host.router.acquireProbe('prov-a', 'model-a') === true && host.router.acquireProbe('prov-a', 'model-a') === false, 'probe must be single-slot');
  host.router.recordOutcome({ provider: 'prov-a', model: 'model-a', success: true });
  const snapClosed = host.router.outcomeSnapshot().find((s) => s.key === 'prov-a::model-a');
  probe('d13 adapter: attributed success closes the circuit', snapClosed.phase === 'closed' && snapClosed.consecutiveFailures === 0, jsonOf(snapClosed));
  probe('d14 adapter: outcome_recorded audited for real outcomes (errorClass labels only)', host.eventsNamed('outcome_recorded').length >= 4, jsonOf(host.eventsNamed('outcome_recorded').length));
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('[e] classifyFailure maps the closed failure vocabulary');
{
  const cases = [
    [{ code: 'RATE_LIMIT' }, 'rate_limit'],
    [{ code: 'HTTP_429' }, 'rate_limit'],
    [{ code: 'QUOTA' }, 'rate_limit'],
    [{ code: 'HTTP_402' }, 'rate_limit'],
    [{ code: 'TIMEOUT' }, 'timeout'],
    [{ code: 'LLM_STREAM_IDLE_TIMEOUT' }, 'timeout'],
    [{ code: 'ABORTED' }, 'other'],
    [{ code: 'AUTH' }, 'credential'],
    [{ code: 'HTTP_401' }, 'credential'],
    [{ code: 'HTTP_403' }, 'credential'],
    [{ code: 'MISSING_CREDENTIAL' }, 'credential'],
    [{ code: 'INVALID_CREDENTIAL' }, 'credential'],
    [{ code: 'VERIFICATION' }, 'verifier'],
    [{ code: 'SERVER' }, 'other'],
    [{ code: 'SOMETHING_ELSE' }, 'other'],
    [{}, 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ];
  let allOk = true;
  const diffs = [];
  for (const [input, expected] of cases) {
    const got = routerEngine.classifyFailure(input);
    if (got !== expected) { allOk = false; diffs.push(`${jsonOf(input)}=>${got} (want ${expected})`); }
  }
  probe('e1 engine: full rate_limit/timeout/credential/verifier/other mapping table', allOk, diffs.join('; '));
  probe('e2 engine: OUTCOME_CLASSES is the closed 5-value vocabulary', jsonOf(routerEngine.OUTCOME_CLASSES) === jsonOf(['rate_limit', 'timeout', 'credential', 'verifier', 'other']), jsonOf(routerEngine.OUTCOME_CLASSES));
}

// ---------------------------------------------------------------------------
console.log('[f] fast path: simple task routes directly with fanout 0; complex is not fast-pathed');
{
  const dir = join(TMP, 'bench-f');
  const host = await mkHost({
    routerConfig: { ...TWO_CANDIDATES, fastPath: { enabled: true, simpleClasses: [...routerEngine.DEFAULT_SIMPLE_TASK_CLASSES] } },
    benchDataDir: dir,
  });
  const simple = await host.router.route({ taskClass: 'SUMMARIZE' });
  probe('f1 adapter: SUMMARIZE task takes the fast path', simple.fastPath === true && simple.blocked === null, jsonOf({ fastPath: simple.fastPath, provider: simple.provider }));
  probe('f2 adapter: fast-path decision has fanout 0 and NO fallback plan', simple.fanout === 0 && simple.fallbackPlan === undefined && simple.reasonCodes.includes('FAST_PATH_SIMPLE'), jsonOf({ fanout: simple.fanout, reasons: simple.reasonCodes }));
  probe('f3 adapter: route_fast_path audited (ids only)', host.eventsNamed('route_fast_path').some((e) => e.fields.provider === simple.provider && typeof e.fields.routeDecisionId === 'string'), jsonOf(host.eventsNamed('route_fast_path')));
  const lower = await host.router.route({ taskClass: 'summarize' });
  probe('f4 adapter: task-class normalization is exact (trim+uppercase)', lower.fastPath === true, jsonOf(lower.fastPath));
  const complex = await host.router.route({ taskClass: 'DEEP_RESEARCH' });
  probe('f5 adapter: complex task is NOT fast-pathed (key absent)', complex.fastPath === undefined && complex.reasonCodes.includes('FAST_PATH_SIMPLE') === false, jsonOf({ fastPath: complex.fastPath, fanout: complex.fanout }));
  probe('f6 adapter: complex task plans a cross-provider fallback (fanout >= 1)', complex.fanout >= 1 && Array.isArray(complex.fallbackPlan) && complex.fallbackPlan.length >= 1, jsonOf(complex.fallbackPlan));

  const off = await mkHost({ routerConfig: TWO_CANDIDATES, benchDataDir: join(TMP, 'bench-f2') });
  const offDecision = await off.router.route({ taskClass: 'SUMMARIZE' });
  probe('f7 adapter: fast path disabled by default (behavior-preserving)', offDecision.fastPath === undefined, jsonOf(offDecision.fastPath));
  off.dispose();

  const fpConfig = { enabled: true, simpleClasses: routerEngine.DEFAULT_SIMPLE_TASK_CLASSES };
  probe('f8 engine: labels enable the fast path (normalized match)', routerEngine.isSimpleTask({ labels: [' summarize '] }, fpConfig) === true, 'label match failed');
  probe('f9 engine: measured risk gate — non-LOW risk is never fast-pathed', routerEngine.isSimpleTask({ taskClass: 'SUMMARIZE', risk: 'HIGH' }, fpConfig) === false && routerEngine.isSimpleTask({ taskClass: 'SUMMARIZE', risk: 'low' }, fpConfig) === true, 'risk gate failed');
  probe('f10 engine: disabled config never fast-paths', routerEngine.isSimpleTask({ taskClass: 'SUMMARIZE' }, { enabled: false, simpleClasses: [] }) === false, 'disabled still matched');
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('[g] fallback plan: ONLY verified-free candidates; paid never planned');
{
  // Engine level — deterministic planner.
  const now = 10_000;
  const freeCurrent = routerEngine.freeClaimEvidence('config', now);
  const freeExpired = { source: 'config', checkedAt: 0, status: 'active', expiresAt: now - 1 };
  const pool = [
    { key: 'p1::m1', provider: 'p1', model: 'm1', costClass: 'FREE_CONFIRMED', failureDomain: 'd1', score: 0.9 },
    { key: 'p1b::m1b', provider: 'p1', model: 'm1b', costClass: 'FREE_CONFIRMED', failureDomain: 'd1', score: 0.88 },
    { key: 'p3::m3', provider: 'p3', model: 'm3', costClass: 'PAID', failureDomain: 'd3', score: 0.85 },
    { key: 'p2::m2', provider: 'p2', model: 'm2', costClass: 'FREE_CONFIRMED', failureDomain: 'd2', score: 0.8 },
    { key: 'p4::m4', provider: 'p4', model: 'm4', costClass: 'FREE_LIMITED', failureDomain: 'd4', score: 0.7 },
  ];
  const evidence = new Map([
    ['p1::m1', freeCurrent],
    ['p1b::m1b', freeCurrent],
    ['p2::m2', freeCurrent],
    ['p4::m4', freeExpired], // expired claim => NOT verified-free
  ]);
  const plan = routerEngine.planCrossProviderFallbacks({ pool, excludeKey: 'p1::m1', freeEvidence: evidence, now, maxFanout: 4 });
  probe('g1 engine: plan contains only the current-verified free candidate', jsonOf(plan.map((p) => p.key)) === jsonOf(['p2::m2']), jsonOf(plan));
  probe('g2 engine: PAID candidate never planned even with a higher score', plan.every((p) => p.key !== 'p3::m3'), jsonOf(plan));
  probe('g3 engine: expired free claim excluded', plan.every((p) => p.key !== 'p4::m4'), jsonOf(plan));
  probe('g4 engine: same-provider candidate excluded (cross-provider only)', plan.every((p) => p.key !== 'p1b::m1b'), jsonOf(plan));
  const widePool = [2, 3, 4, 5, 6].map((i) => ({ key: `px${i}::m`, provider: `px${i}`, model: 'm', costClass: 'FREE_CONFIRMED', failureDomain: `dx${i}`, score: 0.5 + i / 100 }));
  const wideEvidence = new Map(widePool.map((c) => [c.key, freeCurrent]));
  const capped = routerEngine.planCrossProviderFallbacks({ pool: widePool, excludeKey: 'primary::m', freeEvidence: wideEvidence, now, maxFanout: 2 });
  probe('g5 engine: plan capped at maxFanout=2 and keeps the top-scored candidates (order preserved)', capped.length === 2 && jsonOf(capped.map((p) => p.key)) === jsonOf(['px6::m', 'px5::m']), jsonOf(capped));
  const noEvidence = routerEngine.planCrossProviderFallbacks({ pool, excludeKey: 'p1::m1', freeEvidence: new Map(), now, maxFanout: 4 });
  probe('g6 engine: missing free-claim evidence => empty plan (honest degradation)', noEvidence.length === 0, jsonOf(noEvidence));

  // Adapter level — paid candidate sits between two free ones.
  const dir = join(TMP, 'bench-g');
  const host = await mkHost({
    routerConfig: {
      candidates: [
        TWO_CANDIDATES.candidates[0],
        TWO_CANDIDATES.candidates[1],
        {
          provider: 'prov-c', credentialMode: 'config-owned', credentialConfigured: true, quotaHeadroom: 0.9,
          models: [{ model: 'model-c', costClass: 'PAID', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'dom-c' }],
        },
      ],
    },
    benchDataDir: dir,
  });
  const decision = await host.router.route({ taskClass: 'DEEP_RESEARCH' });
  const plannedKeys = (decision.fallbackPlan ?? []).map((p) => p.key);
  probe('g7 adapter: fallback plan includes the cross-provider free candidate', plannedKeys.includes('prov-b::model-b'), jsonOf(plannedKeys));
  probe('g8 adapter: PAID candidate never planned when a free one exists', plannedKeys.includes('prov-c::model-c') === false, jsonOf(plannedKeys));
  probe('g9 adapter: fallback_planned audit carries ids/counts only', host.eventsNamed('fallback_planned').length === 1 && host.eventsNamed('fallback_planned')[0].fields.detail.startsWith('fanout:'), jsonOf(host.eventsNamed('fallback_planned')));
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('[h] AttemptLedger refuses attempts beyond maxRetries (bounded retries)');
{
  const ledger = new routerEngine.AttemptLedger({ maxRetries: 3 });
  const r1 = ledger.registerAttempt('task-h');
  const r2 = ledger.registerAttempt('task-h');
  const r3 = ledger.registerAttempt('task-h');
  const r4 = ledger.registerAttempt('task-h');
  probe('h1 engine: attempts 1..3 allowed within maxRetries=3', r1.allowed && r2.allowed && r3.allowed && r3.attempts === 3, jsonOf([r1, r2, r3]));
  probe('h2 engine: 4th attempt REFUSED (bounded retries)', r4.allowed === false && r4.attempts === 4 && r4.maxRetries === 3, jsonOf(r4));
  probe('h3 engine: status() is a read-only view', jsonOf(ledger.status('task-h')) === jsonOf({ attempts: 4, maxRetries: 3 }) && ledger.status('unknown').attempts === 0, jsonOf(ledger.status('task-h')));
  ledger.releaseTask('task-h');
  probe('h4 engine: releaseTask resets the bound', ledger.status('task-h').attempts === 0 && ledger.registerAttempt('task-h').allowed === true, 'release failed');
  probe('h5 engine: withinWallClock budget semantics (0 = OFF)', routerEngine.withinWallClock(1_000, 2_000, 500) === false && routerEngine.withinWallClock(1_000, 1_500, 500) === true && routerEngine.withinWallClock(1_000, 9_999, 0) === true, 'budget check failed');

  const dir = join(TMP, 'bench-h');
  const host = await mkHost({
    routerConfig: { ...TWO_CANDIDATES, bounds: { maxRetries: 3, maxFanout: 4, wallClockBudgetMs: 100 } },
    benchDataDir: dir,
  });
  // Bounded retry loop under INJECTED failures: the ledger, not the loop,
  // decides when retries stop.
  let dispatches = 0;
  let refused = null;
  for (let i = 0; i < 10; i++) {
    const reg = host.router.registerAttempt('task-h-adapter');
    if (!reg.allowed) { refused = reg; break; }
    dispatches += 1; // injected failure would follow here in a real host
  }
  probe('h6 adapter: injected-failure loop stops at exactly maxRetries dispatches', dispatches === 3 && refused?.allowed === false, jsonOf({ dispatches, refused }));
  probe('h7 adapter: retry_bound_refused audited', host.eventsNamed('retry_bound_refused').some((e) => String(e.fields.detail).includes('attempts:4')), jsonOf(host.eventsNamed('retry_bound_refused')));
  probe('h8 adapter: attemptStatus reflects the ledger', host.router.attemptStatus('task-h-adapter').attempts === 4 && host.router.attemptStatus('task-h-adapter').maxRetries === 3, jsonOf(host.router.attemptStatus('task-h-adapter')));
  probe('h9 adapter: withinBudget honors the configured wall-clock budget', host.router.withinBudget(0, 50) === true && host.router.withinBudget(0, 101) === false, 'withinBudget failed');
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('[i] checkpoint/resume: hash-gated state, side effects never auto-repeated');
{
  const dir = join(TMP, 'bench-i');
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const step0Path = join(artifacts, 'step0.bin');
  writeFileSync(step0Path, ARTIFACT_V1, 'utf8');
  const hash0 = sha256(ARTIFACT_V1);
  const host = await mkHost({ routerConfig: { candidates: [] }, benchDataDir: dir });

  // A real interrupted task: step0 completed (side effects registered + hashed),
  // step1 interrupted mid-flight. Side-effect counter models the HOST's real
  // world effects: step0 executed once, step1 not yet.
  await host.bench.checkpoint({ taskId: 'T1', step: 0, artifactRefs: ['step0.bin'], artifactHashes: [{ ref: 'step0.bin', hash: hash0 }], sideEffectsRegistered: true, status: 'completed' });
  await host.bench.checkpoint({ taskId: 'T1', step: 1, artifactRefs: ['step1.bin'], sideEffectsRegistered: false, status: 'interrupted' });
  const sideEffects = { 'T1:0': 1, 'T1:1': 0 };

  const plan = await host.bench.resumeCheckpoint('T1', { 'step0.bin': hash0 });
  const step0 = plan.steps.find((s) => s.stepIndex === 0);
  const step1 = plan.steps.find((s) => s.stepIndex === 1);
  probe('i1 adapter: resume returns completed state when the artifact hash STILL matches', step0?.status === 'completed' && step0?.hashCheck === 'verified' && step0?.redo === false, jsonOf(step0));
  probe('i2 adapter: completed step carries sideEffectsRegistered + recorded hash', step0?.sideEffectsRegistered === true && step0?.artifactHashes?.[0]?.hash === hash0, jsonOf(step0));
  probe('i3 adapter: interrupted step is redo work', step1?.status === 'interrupted' && step1?.redo === true && step1?.hashCheck === 'unverified', jsonOf(step1));
  probe('i4 adapter: completedCount/redoCount reflect the plan', plan.completedCount === 1 && plan.redoCount === 1, jsonOf({ completedCount: plan.completedCount, redoCount: plan.redoCount }));

  // Resume execution: ONLY the interrupted step may run again.
  const actions = benchEngine.resumeActions(plan);
  probe('i5 engine: resumeActions contains ONLY the non-completed step', actions.length === 1 && actions[0].stepIndex === 1, jsonOf(actions));
  for (const action of actions) sideEffects[`T1:${action.stepIndex}`] += 1;
  probe('i6 side effects: completed step NOT repeated; interrupted step executed once', sideEffects['T1:0'] === 1 && sideEffects['T1:1'] === 1, jsonOf(sideEffects));
  let threw = null;
  try { benchEngine.assertNoRepeatedSideEffects(plan, [{ stepIndex: 0 }]); } catch (e) { threw = e; }
  probe('i7 engine: assertNoRepeatedSideEffects throws before any completed-step action', threw?.name === 'ResumeSafetyError', String(threw));

  // TAMPER the artifact: the recorded hash no longer matches the REAL current
  // state — resume must NOT report the step as resumable, and must NOT
  // auto-repeat the side effect.
  writeFileSync(step0Path, ARTIFACT_TAMPERED, 'utf8');
  const hashTampered = sha256(ARTIFACT_TAMPERED);
  const plan2 = await host.bench.resumeCheckpoint('T1', { 'step0.bin': hashTampered });
  const step0b = plan2.steps.find((s) => s.stepIndex === 0);
  probe('i8 adapter: hash mismatch => step NOT resumable (hashCheck mismatch, redo)', step0b?.hashCheck === 'mismatch' && step0b?.redo === true, jsonOf(step0b));
  const actions2 = benchEngine.resumeActions(plan2);
  probe('i9 adapter: mismatched completed step is NEVER auto-repeatable', actions2.every((a) => a.stepIndex !== 0), jsonOf(actions2));
  for (const action of actions2) sideEffects[`T1:${action.stepIndex}`] += 1;
  probe('i10 side effects: counter unchanged by the mismatched resume', sideEffects['T1:0'] === 1, jsonOf(sideEffects));
  threw = null;
  try { benchEngine.assertNoRepeatedSideEffects(plan2, [{ stepIndex: 0 }]); } catch (e) { threw = e; }
  probe('i11 engine: completed step still protected by the safety assertion after mismatch', threw?.name === 'ResumeSafetyError', String(threw));

  // Missing current state for a recorded ref also counts as mismatch.
  const plan3 = await host.bench.resumeCheckpoint('T1', {});
  probe('i12 adapter: missing current hash for a recorded ref => mismatch', plan3.steps.find((s) => s.stepIndex === 0)?.hashCheck === 'mismatch', jsonOf(plan3.steps.find((s) => s.stepIndex === 0)));

  // REAL persistence: a FRESH host on the same dataDir reloads the append-only
  // JSONL the benchmark plugin owns and replays the same verdicts.
  const host2 = await mkHost({ routerConfig: { candidates: [] }, benchDataDir: dir });
  const plan4 = await host2.bench.resumeCheckpoint('T1', { 'step0.bin': hash0 });
  probe('i13 adapter: records persist (fresh host, same dataDir) and re-verify', plan4.steps.find((s) => s.stepIndex === 0)?.hashCheck === 'verified' && host2.bench.checkpointStats().checkpoints >= 2, jsonOf(host2.bench.checkpointStats()));
  probe('i14 adapter: checkpoint audits are value-free (ids/status/counts only)', (() => {
    const audits = [...host.eventsNamed('checkpoint_recorded'), ...host.eventsNamed('checkpoint_resumed')];
    return audits.length >= 3 && !jsonOf(audits).includes(ARTIFACT_V1) && !jsonOf(audits).includes(hash0);
  })(), jsonOf(host.eventsNamed('checkpoint_recorded')));
  host.dispose();
  host2.dispose();
}

// ---------------------------------------------------------------------------
console.log('[j] e2e task latency event emitted with duration only');
{
  const dir = join(TMP, 'bench-j');
  const host = await mkHost({ routerConfig: { candidates: [] }, benchDataDir: dir });
  const runId = await host.bench.startRun({ taskId: 'T9', taskCategory: 'SUMMARIZE', provider: 'prov-a', model: 'model-a', profile: 'lab' });
  await host.bench.finishRun(runId, { success: true, latencyMs: 123 });
  const latencyEvents = host.eventsNamed('task_latency');
  probe('j1 adapter: task_latency event emitted exactly once for the finished run', latencyEvents.length === 1, jsonOf(latencyEvents));
  probe('j2 adapter: event carries the run id + the measured DURATION only', latencyEvents[0]?.fields.benchmarkRunId === runId && latencyEvents[0]?.fields.latencyMs === 123, jsonOf(latencyEvents[0]));
  probe('j3 adapter: event detail is a class label, never content', typeof latencyEvents[0]?.fields.detail === 'string' && latencyEvents[0].fields.detail.startsWith('task:SUMMARIZE'), jsonOf(latencyEvents[0]?.fields.detail));

  // Derived duration when the host does not supply latencyMs (finishedAt − startedAt).
  const runId2 = await host.bench.startRun({ taskId: 'T10', taskCategory: 'EXTRACT', provider: 'prov-a', model: 'model-a', profile: 'lab' });
  await host.bench.finishRun(runId2, { success: true });
  const ev2 = host.eventsNamed('task_latency').find((e) => e.fields.benchmarkRunId === runId2);
  probe('j4 adapter: duration falls back to finishedAt−startedAt (finite, >= 0)', typeof ev2?.fields.latencyMs === 'number' && ev2.fields.latencyMs >= 0, jsonOf(ev2));

  const stats = host.bench.taskLatency();
  const summarize = stats.find((s) => s.taskCategory === 'SUMMARIZE');
  probe('j5 adapter: taskLatency() aggregates durations per class (durations only)', !!summarize && summarize.samples === 1 && summarize.avgLatencyMs === 123 && summarize.medianLatencyMs === 123 && summarize.maxLatencyMs === 123, jsonOf(summarize));
  probe('j6 adapter: no artifact content or canary in ANY emitted event', !jsonOf(host.events).includes(CANARY), 'canary leak');
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('V131_OUTCOME_ROUTING_VERIFIED — class-aware, uncertainty/freshness-decayed, outcome-circuited, bounded, checkpoint-safe routing proven on real engines + real adapters');
  process.exit(0);
}
console.log(`V131_OUTCOME_ROUTING_FAILED — ${failures} probe(s) failed`);
process.exit(1);
