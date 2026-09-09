#!/usr/bin/env node
/**
 * dsh-supreme/real/v13-routing-verify.mjs — END-TO-END proof of the two
 * V13-C "ASTRA-hardening" features (v1.3 backlog, research/gpt6-astra-2026-09.md):
 *
 *   P3 — Capability-class gating (router side):
 *     route/candidate config gains optional `capabilityClass` + `cotVisibility`
 *     (zod-validated, keys must ARRIVE — v3-review lesson); the router is the
 *     LABEL CARRIER: the selected candidate's labels travel on the decision
 *     record (CapabilitySignal contract with supreme-policy, field names
 *     byte-identical). No enforcement here — policy enforces.
 *
 *   P3 — Anti-sandbagging weighting (benchmark + router):
 *     benchmark: scores claimed WITHOUT verifier-PASS evidence are flagged
 *     `evidenceBacked: false` (toggle `requireEvidenceForScores`, default
 *     false = behavior-preserving) + `unscored_evidence` audit event
 *     (record id + reason label ONLY, never score content).
 *     router: fixed multiplicative downweight `unscoredEvidenceWeight`
 *     (default 1.0 = no change; 0.5 halves) on not-evidence-backed candidates
 *     + `unscored_evidence` audit event (candidate id + applied factor).
 *     Deterministic multiplication — no ML. "evidence > self-confidence".
 *
 * Exercises the REAL code, not a simulation:
 *   - REAL zod Config schemas (src/plugins/<name>/index.ts) → key-arrival proof;
 *   - REAL pure engines (src/plugins/<name>/engine.ts) → selection/flag logic;
 *   - REAL Cordis adapters via their `apply()` on a minimal synthetic context
 *     (same idiom as v12's service-level probes; no upstream build needed —
 *     all type-only upstream imports are erased at runtime).
 *
 * NO upstream file is modified. Temp state lives under os.tmpdir() and is
 * wiped at the start of every run. Exit 0 only if ALL probes pass, finishing
 * with the marker line: V13_ROUTING_E2E_COMPLETE
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const probes = [];
const pending = [];
let probeNo = 0;
function probe(name, fn) {
  probeNo += 1;
  const idx = probeNo;
  pending.push(
    (async () => {
      const label = `[v13 ${String(idx).padStart(2, '0')}] ${name}`;
      try {
        const detail = await fn();
        probes.push({ name, ok: true, detail: detail ?? '' });
        console.log(`${label} — PASS${detail ? ` (${detail})` : ''}`);
      } catch (err) {
        probes.push({ name, ok: false, detail: String(err && err.message ? err.message : err) });
        console.error(`${label} — FAIL: ${err && err.stack ? err.stack : err}`);
        process.exit(1);
      }
    })(),
  );
}
function assert(cond, message) {
  if (cond !== true) throw new Error(message);
  return true;
}

// Wipe-on-start temp workspace (outside the repo — .gitignore untouched).
const TMP = mkdtempSync(join(tmpdir(), 'dsh-supreme-v13-e2e-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

// ---------- REAL sources (bun runs TS natively; type-only imports erased) ---
const routerEngine = await import(join(ROOT, 'src/plugins/supreme-router/engine.ts'));
const routerAdapter = await import(join(ROOT, 'src/plugins/supreme-router/index.ts'));
const benchEngine = await import(join(ROOT, 'src/plugins/supreme-benchmark/engine.ts'));
const benchAdapter = await import(join(ROOT, 'src/plugins/supreme-benchmark/index.ts'));

/** Minimal synthetic context for REAL adapter `apply()` (config-owned creds →
 *  `ctx.get('credentials')` is never consulted). Mirrors the real cordis
 *  shape: provided services land on the context; `ctx.get(name)` resolves
 *  provided services first, then direct properties (the router reads its deps
 *  as `ctx.llm` / `ctx.supremeObservability` etc.). */
function makeCtx({ observability }) {
  const provided = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: () => () => undefined,
    effect: (execute) => execute(),
    provide: (name, service) => provided.set(name, service),
    get: (name) => (provided.has(name) ? provided.get(name) : ctx[name]),
  };
  const setProperty = (k, v) => {
    ctx[k] = v;
  };
  if (observability !== undefined) setProperty('supremeObservability', observability);
  return { ctx, provided, setProperty };
}

/** Allowlist-recording observability stub — captures event + fields only. */
function makeRecorder() {
  const events = [];
  return {
    events,
    isEnabled: () => true,
    record: (event, fields) => events.push({ event, fields }),
  };
}

const CANDIDATE_BASE = {
  costClass: 'FREE_CONFIRMED',
  capabilities: ['chat'],
  contextWindow: 32768,
  credentialConfigured: true,
  quotaHeadroom: 0.9,
  providerAvailable: true,
  modelValid: true,
};

// ===========================================================================
console.log('=== V13-C E2E — real engines + real adapters (no upstream build) ===');

// ---------------------------------------------------------------------------
// Group 1 — config keys ARRIVE at the service (v3-review lesson: zod must not
// silently strip). REAL zod schemas from both adapters.
// ---------------------------------------------------------------------------
probe('router Config: capabilityClass + cotVisibility arrive (no strip)', () => {
  const parsed = routerAdapter.Config.parse({
    candidates: [{
      provider: 'prov-a',
      credentialMode: 'config-owned',
      credentialConfigured: true,
      models: [{ model: 'm', capabilityClass: 'CYBER_OFFENSIVE', cotVisibility: 'none' }],
    }],
  });
  const model = parsed.candidates[0].models[0];
  assert(model.capabilityClass === 'CYBER_OFFENSIVE', `capabilityClass stripped: ${JSON.stringify(model)}`);
  assert(model.cotVisibility === 'none', `cotVisibility stripped: ${JSON.stringify(model)}`);
  return 'keys survive zod';
});

probe('router Config: unscoredEvidenceWeight arrives; defaults are back-compat', () => {
  const explicit = routerAdapter.Config.parse({ unscoredEvidenceWeight: 0.5 });
  assert(explicit.unscoredEvidenceWeight === 0.5, `explicit weight lost: ${explicit.unscoredEvidenceWeight}`);
  const defaults = routerAdapter.Config.parse({});
  assert(defaults.unscoredEvidenceWeight === 1, `default weight != 1: ${defaults.unscoredEvidenceWeight}`);
  assert(defaults.costFirst === true, 'costFirst default changed');
  return 'default 1.0 = no change';
});

probe('router Config: invalid label values rejected by zod', () => {
  let rejected = 0;
  for (const bad of [
    { unscoredEvidenceWeight: 1.5 }, // > 1 — not a downweight
    { unscoredEvidenceWeight: -0.1 }, // negative
    { candidates: [{ provider: 'p', models: [{ model: 'm', cotVisibility: 'shout' }] }] }, // bad enum
    { candidates: [{ provider: 'p', models: [{ model: 'm', capabilityClass: '' }] }] }, // empty label
  ]) {
    try {
      routerAdapter.Config.parse(bad);
    } catch {
      rejected += 1;
    }
  }
  assert(rejected === 4, `expected 4 rejections, got ${rejected}`);
  return '4/4 invalid shapes rejected';
});

probe('benchmark Config: requireEvidenceForScores arrives; default false', () => {
  const explicit = benchAdapter.Config.parse({ requireEvidenceForScores: true });
  assert(explicit.requireEvidenceForScores === true, 'toggle stripped');
  const defaults = benchAdapter.Config.parse({});
  assert(defaults.requireEvidenceForScores === false, `default toggle not false: ${defaults.requireEvidenceForScores}`);
  return 'default false = behavior-preserving';
});

// ---------------------------------------------------------------------------
// Group 2 — P3 capability-class gating: router is the label carrier.
// ---------------------------------------------------------------------------
probe('engine selectRoute: decision record carries selected candidate labels', () => {
  const cfg = { ...routerEngine.DEFAULT_ROUTER_CONFIG };
  const decision = routerEngine.selectRoute({
    config: cfg,
    candidates: [
      { ...CANDIDATE_BASE, key: 'risky::m', provider: 'risky', model: 'm', failureDomain: 'risky', capabilityClass: 'CYBER_OFFENSIVE', cotVisibility: 'none' },
      { ...CANDIDATE_BASE, key: 'plain::m', provider: 'plain', model: 'm', failureDomain: 'plain' },
    ],
    circuit: new routerEngine.CircuitBreaker(cfg.circuit),
    perf: new Map([['risky::m', { avgQuality: 0.9, samples: 20 }]]),
    now: 1_000_000,
    decisionId: 'dec_labels',
    input: {},
  });
  assert(decision.blocked === null, 'unexpected block');
  assert(decision.provider === 'risky', `labelled candidate should win: ${decision.provider}`);
  assert(decision.capabilityClass === 'CYBER_OFFENSIVE', `decision.capabilityClass=${decision.capabilityClass}`);
  assert(decision.cotVisibility === 'none', `decision.cotVisibility=${decision.cotVisibility}`);
  return "capabilityClass 'CYBER_OFFENSIVE' + cotVisibility 'none' on decision";
});

probe('engine selectRoute: unlabelled winner → no label keys on decision', () => {
  const cfg = { ...routerEngine.DEFAULT_ROUTER_CONFIG };
  const decision = routerEngine.selectRoute({
    config: cfg,
    candidates: [
      { ...CANDIDATE_BASE, key: 'risky::m', provider: 'risky', model: 'm', failureDomain: 'risky' },
      { ...CANDIDATE_BASE, key: 'plain::m', provider: 'plain', model: 'm', failureDomain: 'plain' },
    ],
    circuit: new routerEngine.CircuitBreaker(cfg.circuit),
    perf: new Map([['risky::m', { avgQuality: 0.9, samples: 20 }]]),
    now: 1_000_000,
    decisionId: 'dec_nolabels',
    input: {},
  });
  assert(decision.blocked === null, 'unexpected block');
  assert(!('capabilityClass' in decision) && !('cotVisibility' in decision), 'label keys leaked onto unlabelled decision');
  return 'back-compat decision shape';
});

probe('REAL router adapter: labels flow config → zod → candidate → decision → audit event', () => {
  const recorder = makeRecorder();
  const { ctx, provided, setProperty } = makeCtx({ observability: recorder });
  setProperty('llm', {
    listProviders: () => [{ id: 'risky' }, { id: 'plain' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  setProperty('supremePolicy', {});
  // risky gets the better evidenced-free history so it wins on quality
  // (scoredSamples 0 → no score claims → nothing to distrust).
  setProperty('supremeBenchmark', {
    aggregateModelPerformance: () => [
      { provider: 'risky', model: 'm', samples: 20, successRate: 1, avgQuality: 0.9, avgLatencyMs: null, failureBreakdown: {}, scoredSamples: 0, evidenceBackedScores: 0 },
    ],
  });
  routerAdapter.apply(ctx, routerAdapter.Config.parse({
    candidates: [
      {
        provider: 'risky',
        credentialMode: 'config-owned',
        credentialConfigured: true,
        models: [{ model: 'm', costClass: 'FREE_CONFIRMED', capabilityClass: 'CYBER_OFFENSIVE', cotVisibility: 'none' }],
      },
      {
        provider: 'plain',
        credentialMode: 'config-owned',
        credentialConfigured: true,
        models: [{ model: 'm', costClass: 'FREE_CONFIRMED' }],
      },
    ],
  }));
  const service = provided.get('supremeRouter');
  assert(service !== undefined, 'supremeRouter not provided by REAL apply()');
  return service.route({}).then((decision) => {
    assert(decision.blocked === null, 'unexpected block');
    assert(decision.provider === 'risky', `selected=${decision.provider}`);
    assert(decision.capabilityClass === 'CYBER_OFFENSIVE', `service decision.capabilityClass=${decision.capabilityClass}`);
    assert(decision.cotVisibility === 'none', `service decision.cotVisibility=${decision.cotVisibility}`);
    const routeEvents = recorder.events.filter((e) => e.event === 'route_decision');
    assert(routeEvents.length === 1, `route_decision events=${routeEvents.length}`);
    assert(routeEvents[0].fields.capabilityClass === 'CYBER_OFFENSIVE', 'route_decision event lost the label');
    assert(routeEvents[0].fields.cotVisibility === 'none', 'route_decision event lost cotVisibility');
    return 'full adapter path proven (route_decision event carries labels)';
  });
});

// ---------------------------------------------------------------------------
// Group 3 — anti-sandbagging: benchmark evidence detection (REAL engine).
// ---------------------------------------------------------------------------
function memFs() {
  const files = new Map();
  return {
    files,
    fs: {
      readFile: async (p) => files.get(p) ?? null,
      appendFile: async (p, line) => files.set(p, (files.get(p) ?? '') + line),
      mkdir: async () => {},
    },
  };
}

probe('benchmark engine: PASS-evidenced score → evidenceBacked true (toggle on)', async () => {
  const { fs, files } = memFs();
  const store = new benchEngine.BenchmarkStore('/mem/b.jsonl', fs, { requireEvidenceForScores: true });
  await store.init();
  await store.recordTask({ taskId: 't1', category: 'unit' });
  await store.startRun({ runId: 'r_pass', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  await store.finishRun('r_pass', { success: true, verification: { validatorId: 'v', status: 'PASS' } });
  const score = await store.recordScore({ runId: 'r_pass', qualityScore: 0.9 });
  assert(score.evidenceBacked === true, `evidenced score not backed: ${JSON.stringify(score)}`);
  const run = store.queryHistory({ provider: 'p' })[0];
  assert(run.evidenceBacked === true, 'run flag missing');
  const line = [...files.values()].join('').split('\n').find((l) => l.includes('"kind":"score"'));
  assert(benchEngine.validateBenchmarkRecord(JSON.parse(line)).evidenceBacked === true, 'persisted score line re-validates');
  return 'flag survives the JSONL roundtrip';
});

probe('benchmark engine: claimed score without verifier-PASS → evidenceBacked false', async () => {
  const { fs } = memFs();
  const store = new benchEngine.BenchmarkStore('/mem/b.jsonl', fs, { requireEvidenceForScores: true });
  await store.init();
  await store.recordTask({ taskId: 't1', category: 'unit' });
  // No verification at all:
  await store.startRun({ runId: 'r_noverify', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  await store.finishRun('r_noverify', { success: true });
  // Explicit verifier FAIL:
  await store.startRun({ runId: 'r_fail', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  await store.finishRun('r_fail', { success: true, verification: { validatorId: 'v', status: 'FAIL' } });
  const s1 = await store.recordScore({ runId: 'r_noverify', qualityScore: 0.99 });
  const s2 = await store.recordScore({ runId: 'r_fail', qualityScore: 0.98 });
  assert(s1.evidenceBacked === false && s2.evidenceBacked === false, `flags: ${s1.evidenceBacked}/${s2.evidenceBacked}`);
  const agg = store.aggregateModelPerformance()[0];
  assert(agg.scoredSamples === 2, `scoredSamples=${agg.scoredSamples}`);
  assert(agg.evidenceBackedScores === 0, `evidenceBackedScores=${agg.evidenceBackedScores}`);
  assert(benchEngine.isVerifierPassEvidence({ validatorId: 'v', status: 'PASS' }) === true, 'PASS must count as evidence');
  assert(benchEngine.isVerifierPassEvidence(undefined) === false, 'missing verification is NOT evidence');
  return 'unverified claims are marked not-evidence-backed (deterministic)';
});

probe('benchmark engine: toggle OFF (default) writes NO evidenceBacked key', async () => {
  const { fs } = memFs();
  const store = new benchEngine.BenchmarkStore('/mem/b.jsonl', fs); // v1.2-style construction
  await store.init();
  await store.recordTask({ taskId: 't1', category: 'unit' });
  await store.startRun({ runId: 'r1', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  await store.finishRun('r1', { success: true });
  const score = await store.recordScore({ runId: 'r1', qualityScore: 0.8 });
  assert(!('evidenceBacked' in score), 'score flag written while toggle off');
  const run = store.queryHistory({ provider: 'p' })[0];
  assert(!('evidenceBacked' in run), 'run flag written while toggle off');
  const agg = store.aggregateModelPerformance()[0];
  assert(agg.scoredSamples === 1 && agg.evidenceBackedScores === 0, `agg=${JSON.stringify(agg)}`);
  return 'behavior-preserving default';
});

probe('benchmark engine: late verification re-evaluates the claim (last-write-wins)', async () => {
  const { fs } = memFs();
  const store = new benchEngine.BenchmarkStore('/mem/b.jsonl', fs, { requireEvidenceForScores: true });
  await store.init();
  await store.recordTask({ taskId: 't1', category: 'unit' });
  await store.startRun({ runId: 'r_late', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  const earlyScore = await store.recordScore({ runId: 'r_late', qualityScore: 0.7 });
  assert(earlyScore.evidenceBacked === false, 'claim before evidence must start unbacked');
  await store.finishRun('r_late', { success: true, verification: { validatorId: 'v', status: 'PASS' } });
  const run = store.queryHistory()[0];
  assert(run !== undefined && run.evidenceBacked === true, 'final verification must re-evaluate the flag');
  const agg = store.aggregateModelPerformance()[0];
  assert(agg.scoredSamples === 1 && agg.evidenceBackedScores === 1, 'aggregate must count the re-evaluated claim');
  return 'finishRun re-evaluation deterministic';
});

probe('benchmark engine: non-boolean evidenceBacked rejected by validateBenchmarkRecord', () => {
  let rejected = 0;
  for (const bad of [
    { kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', profile: 'u', startedAt: 0, evidenceBacked: 'yes' },
    { kind: 'score', schemaVersion: 1, runId: 'x', qualityScore: 0.5, scoredAt: 0, evidenceBacked: 1 },
  ]) {
    try {
      benchEngine.validateBenchmarkRecord(bad);
    } catch {
      rejected += 1;
    }
  }
  assert(rejected === 2, `expected 2 rejections, got ${rejected}`);
  return 'schema hygiene enforced';
});

probe('REAL benchmark adapter: unscored_evidence audit carries id+reason, never score content', async () => {
  const recorder = makeRecorder();
  const { ctx, provided } = makeCtx({ observability: recorder });
  const dataDir = join(TMP, 'bench-adapter');
  benchAdapter.apply(ctx, benchAdapter.Config.parse({ dataDir, requireEvidenceForScores: true }));
  const service = provided.get('supremeBenchmark');
  assert(service !== undefined, 'supremeBenchmark not provided by REAL apply()');
  await service.recordTask({ taskId: 't1', category: 'unit' });
  const evidRunId = await service.startRun({ taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'e2e' });
  await service.finishRun(evidRunId, { success: true, verification: { validatorId: 'v', status: 'PASS' } });
  const claimRunId = await service.startRun({ taskId: 't1', taskCategory: 'unit', provider: 'q', model: 'm', profile: 'e2e' });
  await service.finishRun(claimRunId, { success: true }); // no evidence
  await service.recordScore({ runId: evidRunId, qualityScore: 0.9 }); // evidenced → NO event
  await service.recordScore({ runId: claimRunId, qualityScore: 0.42 }); // claim w/o evidence → event
  const events = recorder.events.filter((e) => e.event === 'unscored_evidence');
  assert(events.length === 1, `unscored_evidence events=${events.length}`);
  assert(events[0].fields.recordId === claimRunId, `recordId=${events[0].fields.recordId}`);
  assert(events[0].fields.reason === 'score_without_verifier_pass', `reason=${events[0].fields.reason}`);
  const serialized = JSON.stringify(events[0].fields);
  assert(!serialized.includes('0.42') && !serialized.includes('qualityScore'), 'AUDIT LEAK: score content in event');
  const agg = service.aggregateModelPerformance().find((a) => a.provider === 'q');
  assert(agg.scoredSamples === 1 && agg.evidenceBackedScores === 0, 'aggregate evidence counts wrong');
  return 'audit = record id + reason label only';
});
// ---------------------------------------------------------------------------
// Group 4 — anti-sandbagging: router weighting (engine + REAL adapter).
// ---------------------------------------------------------------------------
probe('engine selectRoute: factor 0.5 → evidence-backed candidate wins the flip', () => {
  const perf = new Map([
    ['evid::m', { avgQuality: 0.85, samples: 20, evidenceBacked: true }],
    ['claim::m', { avgQuality: 0.9, samples: 20, evidenceBacked: false }],
  ]);
  const mk = (key, provider) => ({ ...CANDIDATE_BASE, key, provider, model: 'm', failureDomain: provider });
  const run = (weight) => routerEngine.selectRoute({
    config: { ...routerEngine.DEFAULT_ROUTER_CONFIG, unscoredEvidenceWeight: weight },
    candidates: [mk('claim::m', 'claim'), mk('evid::m', 'evid')],
    circuit: new routerEngine.CircuitBreaker(routerEngine.DEFAULT_ROUTER_CONFIG.circuit),
    perf,
    now: 1_000_000,
    decisionId: `dec_${weight}`,
    input: {},
  });

  const hardened = run(0.5);
  assert(hardened.blocked === null, 'unexpected block');
  assert(hardened.provider === 'evid', `factor 0.5 should select the evidenced candidate, got ${hardened.provider}`);
  assert(Array.isArray(hardened.unscoredEvidence) && hardened.unscoredEvidence.length === 1, 'unscoredEvidence missing');
  assert(hardened.unscoredEvidence[0].candidate === 'claim::m', `downweighted=${hardened.unscoredEvidence[0].candidate}`);
  assert(hardened.unscoredEvidence[0].factor === 0.5, `factor=${hardened.unscoredEvidence[0].factor}`);
  assert(hardened.reasonCodes.includes('UNSCORED_EVIDENCE_DOWNWEIGHT'), 'reason code missing');

  const legacy = run(1);
  assert(legacy.provider === 'claim', `default weight must preserve v1.2 selection (better raw score), got ${legacy.provider}`);
  assert(!('unscoredEvidence' in legacy) && !legacy.reasonCodes.includes('UNSCORED_EVIDENCE_DOWNWEIGHT'), 'downweight artifacts at weight 1');
  return 'selection flips only under the factor; weight 1.0 = unchanged (back-compat)';
});

probe('engine selectRoute: no score claims → no downweight (fresh candidates untouched)', () => {
  const cfg = { ...routerEngine.DEFAULT_ROUTER_CONFIG, unscoredEvidenceWeight: 0.5 };
  const decision = routerEngine.selectRoute({
    config: cfg,
    candidates: [{ ...CANDIDATE_BASE, key: 'fresh::m', provider: 'fresh', model: 'm', failureDomain: 'fresh' }],
    circuit: new routerEngine.CircuitBreaker(cfg.circuit),
    perf: new Map([['fresh::m', { avgQuality: null, samples: 0 }]]),
    now: 1_000_000,
    decisionId: 'dec_fresh',
    input: {},
  });
  assert(decision.blocked === null, 'unexpected block');
  assert(!('unscoredEvidence' in decision), 'fresh candidate downweighted without any claim');
  return 'unclaimed ≠ unbacked';
});

probe('REAL router adapter: factor 0.5 selects evidenced peer + emits unscored_evidence', async () => {
  const recorder = makeRecorder();
  const { ctx, provided, setProperty } = makeCtx({ observability: recorder });
  setProperty('llm', {
    listProviders: () => [{ id: 'evid' }, { id: 'claim' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  setProperty('supremePolicy', {});
  setProperty('supremeBenchmark', {
    aggregateModelPerformance: () => [
      { provider: 'evid', model: 'm', samples: 20, successRate: 1, avgQuality: 0.85, avgLatencyMs: null, failureBreakdown: {}, scoredSamples: 2, evidenceBackedScores: 2 },
      { provider: 'claim', model: 'm', samples: 20, successRate: 1, avgQuality: 0.9, avgLatencyMs: null, failureBreakdown: {}, scoredSamples: 2, evidenceBackedScores: 0 },
    ],
  });
  routerAdapter.apply(ctx, routerAdapter.Config.parse({
    unscoredEvidenceWeight: 0.5,
    candidates: [
      { provider: 'evid', credentialMode: 'config-owned', credentialConfigured: true, models: [{ model: 'm', costClass: 'FREE_CONFIRMED' }] },
      { provider: 'claim', credentialMode: 'config-owned', credentialConfigured: true, models: [{ model: 'm', costClass: 'FREE_CONFIRMED' }] },
    ],
  }));
  const service = provided.get('supremeRouter');
  const hardened = await service.route({});
  assert(hardened.provider === 'evid', `hardened router selected ${hardened.provider} (evidence must win)`);
  const events = recorder.events.filter((e) => e.event === 'unscored_evidence');
  assert(events.length === 1, `unscored_evidence events=${events.length}`);
  assert(events[0].fields.candidate === 'claim::m', `candidate=${events[0].fields.candidate}`);
  assert(events[0].fields.appliedFactor === 0.5, `appliedFactor=${events[0].fields.appliedFactor}`);
  const serialized = JSON.stringify(events[0].fields);
  assert(!serialized.includes('0.9') && !serialized.includes('avgQuality'), 'AUDIT LEAK: score content in router event');

  // Back-compat: the same candidates through a REAL adapter with the default
  // weight (config WITHOUT the key) must keep the v1.2 selection (claim wins
  // on raw score) and emit no event.
  const recorder2 = makeRecorder();
  const { ctx: ctx2, provided: provided2, setProperty: setProperty2 } = makeCtx({ observability: recorder2 });
  setProperty2('llm', {
    listProviders: () => [{ id: 'evid' }, { id: 'claim' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  setProperty2('supremePolicy', {});
  setProperty2('supremeBenchmark', {
    aggregateModelPerformance: () => [
      { provider: 'evid', model: 'm', samples: 20, successRate: 1, avgQuality: 0.85, avgLatencyMs: null, failureBreakdown: {}, scoredSamples: 2, evidenceBackedScores: 2 },
      { provider: 'claim', model: 'm', samples: 20, successRate: 1, avgQuality: 0.9, avgLatencyMs: null, failureBreakdown: {}, scoredSamples: 2, evidenceBackedScores: 0 },
    ],
  });
  routerAdapter.apply(ctx2, routerAdapter.Config.parse({
    candidates: [
      { provider: 'evid', credentialMode: 'config-owned', credentialConfigured: true, models: [{ model: 'm', costClass: 'FREE_CONFIRMED' }] },
      { provider: 'claim', credentialMode: 'config-owned', credentialConfigured: true, models: [{ model: 'm', costClass: 'FREE_CONFIRMED' }] },
    ],
  }));
  const legacy = await provided2.get('supremeRouter').route({});
  assert(legacy.provider === 'claim', `default-weight adapter must preserve raw-score selection, got ${legacy.provider}`);
  assert(recorder2.events.every((e) => e.event !== 'unscored_evidence'), 'unscored_evidence emitted while weight=1');
  return 'hardened → evid + 1 audit event; default → claim + 0 events';
});

// ---------------------------------------------------------------------------
// Shared-contract check: field names must be byte-identical to the policy
// CapabilitySignal shape (`capabilityClass?: string`, `cotVisibility?:
// 'verbose' | 'terse' | 'none'`) — asserted structurally on the REAL engine's
// exported contract object.
// ---------------------------------------------------------------------------
probe('shared contract: CapabilitySignal field names exact on decision records', async () => {
  const cfg = { ...routerEngine.DEFAULT_ROUTER_CONFIG };
  const decision = routerEngine.selectRoute({
    config: cfg,
    candidates: [{ ...CANDIDATE_BASE, key: 'r::m', provider: 'r', model: 'm', failureDomain: 'r', capabilityClass: 'DESTRUCTIVE_OPS', cotVisibility: 'terse' }],
    circuit: new routerEngine.CircuitBreaker(cfg.circuit),
    perf: new Map(),
    now: 1_000_000,
    decisionId: 'dec_contract',
    input: {},
  });
  assert(Object.prototype.hasOwnProperty.call(decision, 'capabilityClass'), 'capabilityClass key missing');
  assert(Object.prototype.hasOwnProperty.call(decision, 'cotVisibility'), 'cotVisibility key missing');
  assert(typeof decision.capabilityClass === 'string', 'capabilityClass must be string');
  assert(['verbose', 'terse', 'none'].includes(decision.cotVisibility), `cotVisibility=${decision.cotVisibility}`);
  return "exact keys: capabilityClass + cotVisibility ('verbose'|'terse'|'none')";
});

// ---------- verdict ----------------------------------------------------------
await Promise.all(pending);
const failed = probes.filter((p) => !p.ok);
console.log('---');
for (const p of probes) console.log(`${p.ok ? 'PASS' : 'FAIL'}  ${p.name}`);
console.log(`---\nv13 probes: ${probes.length - failed.length}/${probes.length} passed`);
if (failed.length > 0) {
  console.error('V13_ROUTING_E2E_FAILED');
  process.exit(1);
}
console.log('V13_ROUTING_E2E_COMPLETE');
process.exit(0);
