#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-failure-injection.mjs — Improvement §3D "Regression and
 * failure detection": a failure-injection + regression harness that drives the
 * REAL Supreme adapters (mounted on the REAL pinned cordis, exactly like the
 * other v131 verifiers) through injected failures, and proves benign cases stay
 * functional alongside adversarial ones.
 *
 * Scenarios (all inputs + expected verdicts come from tests/fixtures/*.json —
 * the harness reads fixtures, it never hardcodes scenario data):
 *
 *   TIMEOUT                a provider stub that hangs → attempts are bounded by
 *                          an attempt-timeout envelope, retries are bounded by
 *                          the configured max (= the REAL router circuit-breaker
 *                          failureThreshold), the failure is recorded on the
 *                          REAL CircuitBreaker, and the final posture is honest
 *                          degradation (BLOCKED_NO_ELIGIBLE_ROUTE + CIRCUIT_OPEN)
 *                          with zero paid fallback dispatches and no infinite
 *                          loop.
 *
 *   PROVIDER-UNAVAILABLE   a provider stub that throws unavailable → the REAL
 *                          circuit breaker reacts observably
 *                          (HEALTHY → DEGRADED → CIRCUIT_OPEN), the failed route
 *                          becomes ineligible, catalog removal is independently
 *                          gated (PROVIDER_NOT_IN_CATALOG), and the benign
 *                          sibling free provider stays routable (selection AND
 *                          an actual successful dispatch).
 *
 *   CORRUPTED-EVIDENCE     a verifier file-hash artifact is tampered with after
 *                          its evidence was recorded → the REAL verifier adapter
 *                          (real-path confined runtime) rejects the stale
 *                          evidence (FAIL HASH_MISMATCH, never a fabricated
 *                          PASS), an untouched sibling keeps verifying, and the
 *                          REAL workflow-policy close gate blocks the HIGH-risk
 *                          close on the corrupted verdict while still allowing
 *                          the fresh PASS.
 *
 *   CANCELLATION           cancel/dispose a session mid-flight (memory selection
 *                          held + workflow delegation live) → state is released
 *                          exactly (memory map entry released), the surviving
 *                          session is untouched, follow-up lookups stay empty
 *                          (no resurrection, no cross-session contamination),
 *                          and the REAL fiber dispose completes within the
 *                          ceiling with the store fully cleared.
 *
 *   GUARD-PAIRS            for each v1.3.1 guard (cost gate, symlink verifier,
 *                          A2A registry, memory isolation) run ONE adversarial
 *                          case (must be blocked/rejected) AND ONE benign
 *                          sibling case (must PASS untouched) — the false-DENY
 *                          check that proves guards do not kill legitimate
 *                          function.
 *
 *   AUDIT-METADATA-BOUNDS  across ALL scenarios: canary strings (prompt,
 *                          response, credential, reasoning + a SECRET_SENTINEL
 *                          sentinel) are planted into every content-bearing
 *                          input; after all hosts are disposed and flushed, the
 *                          REAL observability JSONL on disk must contain NONE of
 *                          them; every serialized record's keys must be inside
 *                          the REAL engine's RECORD_FIELDS allowlist with scalar
 *                          values only; and the event stream must be proven
 *                          non-vacuous (minimum record count + required event
 *                          names observed).
 *
 * Exercises the REAL code, not a simulation:
 *   - the REAL adapters (src/plugins/<name>/index.ts) of supreme-policy,
 *     supreme-router, supreme-workflow-policy, supreme-memory-policy,
 *     supreme-verifier, supreme-observability, mounted on the REAL pinned
 *     cordis (@deepseek-ai/cordis) with the zod Config resolved BEFORE apply;
 *   - the REAL pinned seams: agent/request + llm/stream waterfalls,
 *     tools/pre-execute waterfall, session/event + session/disposed emits,
 *     systemPrompt.section(), fiber.dispose();
 *   - the REAL CircuitBreaker (router engine) and the REAL JSONL allowlist
 *     writer (observability engine) — theIMP-R circuit breaker IS present in
 *     the tree, so the circuit/health reaction is asserted on the real thing.
 *
 * NO upstream file is modified. No new dependencies. Deterministic: synthetic
 * fixtures only, tempdirs for all transient state, canary-based value-leak
 * assertions.
 *
 * Exit 0 + marker V131_FAILURE_INJECTION_VERIFIED only when ALL scenarios pass;
 * any failure → non-zero with the failing scenario named.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath, relative as relativePath, isAbsolute as isAbsolutePath } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url);
const FIXTURE_VERSION = 1;
const FIXTURE_FILES = {
  canaries: 'fi-canaries.json',
  timeout: 'fi-timeout.json',
  providerUnavailable: 'fi-provider-unavailable.json',
  corruptedEvidence: 'fi-corrupted-evidence.json',
  cancellation: 'fi-cancellation.json',
  guardPairs: 'fi-guard-pairs.json',
};

// ---------------------------------------------------------------------------
// Fixtures: the ONLY source of scenario data (inputs + expected verdicts).
// ---------------------------------------------------------------------------
const loadFixture = (file) => {
  const raw = readFileSync(new URL(`tests/fixtures/${file}`, ROOT), 'utf8');
  const data = JSON.parse(raw);
  if (data.fixtureVersion !== FIXTURE_VERSION) {
    throw new Error(`fixture ${file}: fixtureVersion=${JSON.stringify(data.fixtureVersion)} expected ${FIXTURE_VERSION}`);
  }
  return data;
};

let FX;
try {
  FX = Object.fromEntries(Object.entries(FIXTURE_FILES).map(([key, file]) => [key, loadFixture(file)]));
} catch (err) {
  console.error(`V131_FAILURE_INJECTION_FIXTURES_INVALID: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// REAL pinned cordis (node_modules symlink first, vendored pinned fallback).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// REAL plugin adapters + REAL engines (imported directly by bun, no build).
// ---------------------------------------------------------------------------
const ADAPTERS = {
  policy: ['src/plugins/supreme-policy/index.ts', 'supreme-policy'],
  observability: ['src/plugins/supreme-observability/index.ts', 'supreme-observability'],
  router: ['src/plugins/supreme-router/index.ts', 'supreme-router'],
  verifier: ['src/plugins/supreme-verifier/index.ts', 'supreme-verifier'],
  memory: ['src/plugins/supreme-memory-policy/index.ts', 'supreme-memory-policy'],
  workflow: ['src/plugins/supreme-workflow-policy/index.ts', 'supreme-workflow-policy'],
};
const plugins = {};
for (const [key, [path, name]] of Object.entries(ADAPTERS)) {
  const mod = await import(new URL(path, ROOT).href);
  if (mod.name !== name) throw new Error(`adapter ${key}: module shape unexpected (name=${String(mod.name)})`);
  plugins[key] = mod;
}
const obsEngine = await import(new URL('src/plugins/supreme-observability/engine.ts', ROOT).href);
const routerEngine = await import(new URL('src/plugins/supreme-router/engine.ts', ROOT).href);

// ---------------------------------------------------------------------------
// Probe bookkeeping: any failure names its scenario at the end.
// ---------------------------------------------------------------------------
const probes = [];
const probe = (scenario, name, ok, detail = '') => {
  probes.push({ scenario, name, ok: ok === true });
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${ok === true ? '' : `  << ${detail}`}`);
};
const runScenario = async (label, fn) => {
  console.log(`\n== scenario: ${label} ==`);
  try {
    await fn();
  } catch (err) {
    probe(label, 'scenario ran to completion without crash', false, err instanceof Error ? err.stack : String(err));
  }
};

const jsonOf = (value) => JSON.stringify(value);
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Harness host: mount ALL SIX real plugins on a synthetic pinned-cordis
// context (same mounting pattern as the other v131 verifiers), with stub DSH
// services for the seams the plugins consume. Each host writes its REAL
// observability JSONL into its own tempdir subdirectory.
// ---------------------------------------------------------------------------
const stubStream = async function* () {
  yield { type: 'text-start', index: 0 };
  yield { type: 'text-delta', index: 0, delta: 'ok' };
  yield { type: 'finish', reason: { kind: 'completed' } };
};

const mkHost = async ({
  dataDir,
  llm,
  policyConfig = {},
  verifierConfig = {},
  routerConfig = { candidates: [] },
  memoryConfig = {},
  workflowConfig = {},
} = {}) => {
  const root = new Context();
  root.provide('llm', llm ?? {
    listProviders: () => [],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  root.provide('supremeBenchmark', { aggregateModelPerformance: () => [] });
  root.provide('sessions', { create: () => ({ id: 'stub-session' }), list: () => [] });
  const sections = [];
  root.provide('systemPrompt', { section: (s) => { sections.push(s); return () => {}; } });
  root.provide('subagents', {});
  root.provide('workflowEngine', {});

  await root.plugin(plugins.observability, { enabled: true, dataDir, fileName: 'observability.jsonl' });
  await root.plugin(plugins.policy, policyConfig);
  await root.plugin(plugins.verifier, verifierConfig);
  await root.plugin(plugins.router, routerConfig);
  await root.plugin(plugins.memory, memoryConfig);
  await root.plugin(plugins.workflow, workflowConfig);

  const services = {
    policy: root.get('supremePolicy'),
    observability: root.get('supremeObservability'),
    verifier: root.get('supremeVerifier'),
    router: root.get('supremeRouter'),
    memory: root.get('supremeMemoryPolicy'),
    workflow: root.get('supremeWorkflowPolicy'),
  };
  for (const [name, svc] of Object.entries(services)) {
    if (!svc) throw new Error(`service ${name} missing after mount`);
  }
  const memorySection = sections.find((s) => s.name === 'supreme-memory-context') ?? null;
  return {
    root,
    services,
    renderMemory: (assemblyContext) =>
      memorySection && typeof memorySection.text === 'function' ? memorySection.text(assemblyContext) : '',
    agentCtxOf: (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } }, scope: {} }),
    emitSessionDisposed: (sessionId) => root.emit('session/disposed', { id: sessionId }),
    emitSessionEvent: (sessionId, event) => root.emit('session/event', { id: sessionId }, event),
    dispose: async () => { await root.fiber.dispose(); },
  };
};

// --- pinned-seam drivers ----------------------------------------------------
const fireAgentRequest = async (root, seedConfig, sessionId) => {
  let dispatched = false;
  let result;
  let loopError = null;
  try {
    result = await root.events.waterfall(
      'agent/request',
      { agent: { session: { id: sessionId } }, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ ...seedConfig }),
    );
    if (!result || !result.provider || !result.model) {
      // Pinned loop contract: a waterfall result without provider/model throws
      // BEFORE llm.prepareCall/stream — zero adapter calls.
      throw new Error(`agent "${sessionId}" has no provider/model (simulated pinned guard)`);
    }
    dispatched = true;
  } catch (error) {
    loopError = error;
  }
  return { result, dispatched, loopError };
};

const makeDispatchCounter = () => {
  const byProvider = new Map();
  let total = 0;
  return {
    count: (provider) => { total += 1; byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1); },
    byProvider,
    get total() { return total; },
    for: (provider) => byProvider.get(provider) ?? 0,
  };
};

const fireLlmStream = async (root, options, counter, receiver) => {
  let error = null;
  let chunks = 0;
  try {
    const stream = await root.events.waterfall('llm/stream', options, () => {
      counter?.count(options.provider);
      return receiver ? receiver(options) : stubStream();
    });
    for await (const chunk of stream) chunks += 1;
  } catch (caught) {
    error = caught;
  }
  return { error, chunks };
};

/** Bounded timeout envelope: settles {timedOut:true} at the deadline after
 *  invoking onTimeout (abort); otherwise settles with the promise outcome. */
const raceWithTimeout = (promise, ms, onTimeout) => new Promise((settle) => {
  const timer = setTimeout(() => {
    try { onTimeout?.(); } catch { /* abort must never break the envelope */ }
    settle({ timedOut: true });
  }, ms);
  promise.then(
    (value) => { clearTimeout(timer); settle({ timedOut: false, value }); },
    (error) => { clearTimeout(timer); settle({ timedOut: false, error }); },
  );
});

// NOTE: the provider `source` string enters the REAL engine's secret scan
// (isSecretBearing checks source+tags+text). A name whose substring collides
// with the API-key heuristic /sk-[a-zA-Z0-9]{8,}/ (e.g. 'fi-task-provider' →
// "sk-provider") is CORRECTLY excluded as SECRET_CATEGORY by the engine —
// this fixture provider must stay secret-clean so the benign sibling actually
// receives its own selection (the guard is intentional; the data was wrong).
const makeMemoryTaskProvider = (suffix) => ({
  name: 'fi-longterm-provider',
  status: 'AVAILABLE',
  list: ({ taskText, limit }) => [{
    id: `fi:${taskText.length}:${taskText.slice(0, 24)}`,
    class: 'LONG_TERM',
    source: 'fi-longterm-provider',
    text: `${taskText}${suffix}`,
    estimatedTokens: 8,
    priority: 80,
  }].slice(0, limit),
});

const readFileSyncOrNull = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

/** Post-dispose record reader for the REAL observability JSONL. */
const readRecords = (dataDir, fileName = 'observability.jsonl') => {
  const raw = readFileSyncOrNull(join(dataDir, fileName));
  if (raw === null) return [];
  return raw.split('\n').filter((l) => l.length > 0).map((line) => JSON.parse(line));
};

// ===========================================================================
// TRANSIENT STATE: everything under one tempdir (cleaned in finally).
// ===========================================================================
const BASE = mkdtempSync(join(tmpdir(), 'v131-fi-'));
const dirOf = (scenario) => {
  const dir = join(BASE, scenario);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const CANARIES = FX.canaries.canaries;

// Register the host dirs as scenarios run; scenario f sweeps them all.
const hostDirs = [];
const registerHostDir = (scenario, dir) => hostDirs.push({ scenario, dir });

try {
  // =========================================================================
  // SCENARIO a — TIMEOUT: hanging provider, bounded retries, honest degradation
  // =========================================================================
  await runScenario('timeout', async () => {
    const fx = FX.timeout;
    const dir = dirOf('timeout');
    registerHostDir('timeout', dir);

    const pending = new Set();
    const hangProvider = {
      /** A provider dispatch that NEVER answers until aborted (injected hang). */
      dispatch: () => {
        const entry = {};
        pending.add(entry);
        const promise = new Promise((_, reject) => {
          entry.abort = () => {
            pending.delete(entry);
            const err = new Error('injected provider hang: attempt deadline exceeded');
            err.code = 'PROVIDER_TIMEOUT';
            reject(err);
          };
        });
        return { promise, abort: () => entry.abort?.() };
      },
      get pendingCount() { return pending.size; },
    };

    const host = await mkHost({
      dataDir: dir,
      routerConfig: {
        candidates: [fx.providers.primary, fx.providers.paid].map((c) => ({
          provider: c.provider,
          credentialMode: 'config-owned',
          credentialConfigured: true,
          quotaHeadroom: c.quotaHeadroom,
          models: [{ model: c.model, costClass: c.costClass, capabilities: ['chat'], contextWindow: 32768, failureDomain: c.failureDomain }],
        })),
        circuit: { failureThreshold: fx.attempts.max, windowMs: 300_000, cooldownMs: 60_000 },
      },
      llm: {
        listProviders: () => [fx.providers.primary.provider, fx.providers.paid.provider],
        resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
      },
    });

    const startedAt = Date.now();

    // Initial route: the free candidate must be selected (paid is policy-gated).
    const initial = await host.services.router.route({});
    probe('timeout', `initial route selects the free primary (${fx.expected.initialDecisionProvider})`,
      initial.provider === fx.expected.initialDecisionProvider && !initial.blocked, jsonOf({ provider: initial.provider, blocked: initial.blocked }));

    // Retry loop: bounded by the configured max (the circuit-breaker threshold).
    const counter = makeDispatchCounter();
    const attemptOutcomes = [];
    let attemptsTaken = 0;
    let midFailureRoute = null;
    for (let attempt = 1; attempt <= fx.attempts.max; attempt += 1) {
      const seed = { provider: initial.provider, model: initial.model, _canary: CANARIES.credential };
      const request = await fireAgentRequest(host.root, seed, 'session-timeout');
      if (!request.dispatched) break; // honest failure would end the loop here
      const hangingCall = hangProvider.dispatch();
      const dispatch = fireLlmStream(
        host.root,
        { provider: initial.provider, model: initial.model, _canary: CANARIES.credential },
        counter,
        () => hangingCall.promise,
      );
      const outcome = await raceWithTimeout(dispatch, fx.attempts.timeoutMs, () => hangingCall.abort());
      attemptsTaken = attempt;
      attemptOutcomes.push(outcome);
      // The REAL circuit breaker records the failure (mechanical, no guessing).
      host.services.router.recordOutcome({ provider: initial.provider, model: initial.model, success: false });
      if (attempt < fx.attempts.max) {
        midFailureRoute = await host.services.router.route({});
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const final = await host.services.router.route({});
    const health = host.services.router.healthSnapshot();
    const primaryKey = `${fx.providers.primary.provider}::${fx.providers.primary.model}`;
    const paidKey = `${fx.providers.paid.provider}::${fx.providers.paid.model}`;
    const primaryHealth = health.find((h) => h.key === primaryKey);
    const paidGate = final.hardGates.find((g) => g.candidate === paidKey && g.gate === fx.expected.paidCostGateGate);

    probe('timeout', `every attempt terminated through the timeout envelope (no hang, no infinite loop)`,
      attemptOutcomes.length === fx.expected.attemptsTaken && attemptOutcomes.every((o) => o.timedOut === fx.expected.everyAttemptTimedOut),
      jsonOf(attemptOutcomes.map((o) => o.timedOut)));
    probe('timeout', `attempts bounded by configured max (taken=${attemptsTaken} ≤ max=${fx.attempts.max})`,
      attemptsTaken === fx.expected.attemptsTaken && attemptsTaken <= fx.attempts.max, `taken=${attemptsTaken}`);
    probe('timeout', 'all dispatch attempts hit only the failing free provider',
      counter.for(fx.expected.dispatchedProvider) === attemptsTaken && counter.total === attemptsTaken,
      jsonOf([...counter.byProvider]));
    probe('timeout', 'zero paid dispatches (no paid fallback)',
      counter.for(fx.providers.paid.provider) === fx.expected.paidDispatches, jsonOf([...counter.byProvider]));
    probe('timeout', 'no dangling provider callbacks after the envelope aborts each attempt',
      hangProvider.pendingCount === fx.expected.danglingPendingCalls, `pending=${hangProvider.pendingCount}`);
    probe('timeout', 'route() mid-failures still returns the failing route (retry window stays honest)',
      midFailureRoute !== null && midFailureRoute.provider === fx.expected.midFailureRouteProvider && !midFailureRoute.blocked,
      jsonOf({ provider: midFailureRoute?.provider, blocked: midFailureRoute?.blocked }));
    probe('timeout', `final route() is an honest blocked decision (${fx.expected.finalDecisionBlocked})`,
      final.blocked === fx.expected.finalDecisionBlocked, jsonOf({ blocked: final.blocked, provider: final.provider }));
    probe('timeout', `REAL circuit breaker opened (${fx.expected.finalCircuitState}) with counted failures`,
      primaryHealth?.state === fx.expected.finalCircuitState && primaryHealth?.recentFailures === fx.expected.finalCircuitRecentFailures,
      jsonOf(primaryHealth));
    probe('timeout', 'paid candidate still hard-gated by policy_cost in the final decision (no paid fallback)',
      paidGate?.passed === false || (paidGate === undefined && fx.expected.paidCostGateFailed === false),
      jsonOf(final.hardGates.filter((g) => g.candidate === paidKey)));
    probe('timeout', `wall clock within the ceiling (${elapsedMs}ms < ${fx.attempts.wallClockCeilingMs}ms)`,
      elapsedMs < fx.attempts.wallClockCeilingMs, `elapsed=${elapsedMs}ms`);

    await host.dispose();
  });

  // =========================================================================
  // SCENARIO b — PROVIDER UNAVAILABLE: circuit reaction + benign still routable
  // =========================================================================
  await runScenario('provider-unavailable', async () => {
    const fx = FX.providerUnavailable;
    const dir = dirOf('provider-unavailable');
    registerHostDir('provider-unavailable', dir);
    const [down, benign] = fx.candidates;

    let catalog = [down.provider, benign.provider];
    const host = await mkHost({
      dataDir: dir,
      routerConfig: {
        candidates: fx.candidates.map((c) => ({
          provider: c.provider,
          credentialMode: 'config-owned',
          credentialConfigured: true,
          quotaHeadroom: c.quotaHeadroom,
          models: [{ model: c.model, costClass: c.costClass, capabilities: ['chat'], contextWindow: 32768, failureDomain: c.failureDomain }],
        })),
        circuit: { failureThreshold: fx.threshold, windowMs: 300_000, cooldownMs: 60_000 },
      },
      llm: {
        listProviders: () => catalog,
        resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
      },
    });

    // IMP-R's circuit breaker must be the REAL one present in the tree.
    probe('provider-unavailable', 'REAL CircuitBreaker present in the router engine (used, not re-implemented)',
      typeof routerEngine.CircuitBreaker === 'function', `typeof=${typeof routerEngine.CircuitBreaker}`);

    const downKey = `${down.provider}::${down.model}`;
    const stateOf = () => host.services.router.healthSnapshot().find((h) => h.key === downKey)?.state;

    const initial = await host.services.router.route({});
    probe('provider-unavailable', `initial route selects the provider under test (${fx.expected.initialDecisionProvider})`,
      initial.provider === fx.expected.initialDecisionProvider && !initial.blocked, jsonOf({ provider: initial.provider, blocked: initial.blocked }));
    probe('provider-unavailable', 'circuit starts HEALTHY before the injection', stateOf() === 'HEALTHY', `state=${stateOf()}`);

    // Inject unavailable errors on every dispatch of the failing provider.
    const healthSequence = [];
    for (let i = 1; i <= fx.threshold; i += 1) {
      const counter = makeDispatchCounter();
      const result = await fireLlmStream(
        host.root,
        { provider: down.provider, model: down.model, _canary: CANARIES.credential },
        counter,
        () => Promise.reject(Object.assign(new Error(`injected ${fx.errorKind}`), { code: fx.errorKind })),
      );
      probe('provider-unavailable', `dispatch ${i} surfaced the injected error (no fabricated success)`,
        result.error?.code === fx.errorKind, jsonOf({ code: result.error?.code, message: result.error?.message }));
      host.services.router.recordOutcome({ provider: down.provider, model: down.model, success: false });
      healthSequence.push(stateOf());
    }
    probe('provider-unavailable', `circuit/health reaction observable: ${jsonOf(fx.expected.healthAfterEachFailure)}`,
      jsonOf(healthSequence) === jsonOf(fx.expected.healthAfterEachFailure), jsonOf(healthSequence));

    const after = await host.services.router.route({});
    probe('provider-unavailable', `benign sibling still routable after failures (${fx.expected.afterFailuresDecisionProvider})`,
      !after.blocked && after.provider === fx.expected.afterFailuresDecisionProvider,
      jsonOf({ provider: after.provider, blocked: after.blocked }));
    const downGate = after.hardGates.find((g) => g.candidate === downKey && g.gate === fx.expected.downRouteFailedGate);
    probe('provider-unavailable', `failed route gated (${fx.expected.downRouteFailedGate})`,
      downGate?.passed === false, jsonOf(after.hardGates.filter((g) => g.candidate === downKey)));

    // Benign provider must also DISPATCH successfully (not just be selected).
    const benignCounter = makeDispatchCounter();
    const benignDispatch = await fireLlmStream(
      host.root,
      { provider: benign.provider, model: benign.model },
      benignCounter,
    );
    probe('provider-unavailable', `benign dispatch actually succeeds (${fx.expected.benignDispatchChunks} chunks)`,
      benignDispatch.error === null && benignDispatch.chunks === fx.expected.benignDispatchChunks,
      jsonOf({ error: benignDispatch.error?.message, chunks: benignDispatch.chunks }));

    // Catalog-removal flavor: provider gone from the live catalog is gated too.
    catalog = [benign.provider];
    const afterRemoval = await host.services.router.route({});
    const catalogGate = afterRemoval.hardGates.find(
      (g) => g.candidate === downKey && g.gate === fx.expected.catalogRemovedFailedGate,
    );
    probe('provider-unavailable', `catalog removal gated (${fx.expected.catalogRemovedFailedGate})`,
      catalogGate?.passed === false, jsonOf(afterRemoval.hardGates.filter((g) => g.candidate === downKey)));
    probe('provider-unavailable', 'benign provider still routable after catalog removal',
      fx.expected.benignStillRoutableAfterCatalogRemoval === true && !afterRemoval.blocked && afterRemoval.provider === benign.provider,
      jsonOf({ provider: afterRemoval.provider, blocked: afterRemoval.blocked }));

    await host.dispose();
  });

  // =========================================================================
  // SCENARIO c — CORRUPTED EVIDENCE: stale evidence rejected, close-gate blocks
  // =========================================================================
  await runScenario('corrupted-evidence', async () => {
    const fx = FX.corruptedEvidence;
    const dir = dirOf('corrupted-evidence');
    registerHostDir('corrupted-evidence', dir);

    const rootDir = join(dir, 'allowed-root');
    mkdirSync(rootDir, { recursive: true });
    const freshPath = join(rootDir, fx.files.fresh.name);
    const corruptPath = join(rootDir, fx.files.corrupted.name);
    writeFileSync(freshPath, fx.files.fresh.content);
    writeFileSync(corruptPath, fx.files.corrupted.contentBefore);
    const freshSha = sha256Of(fx.files.fresh.content);
    const corruptShaBefore = sha256Of(fx.files.corrupted.contentBefore);

    const host = await mkHost({
      dataDir: dir,
      verifierConfig: {
        allowCommands: false,
        allowNetwork: false,
        allowedRoots: [rootDir],
        commandTimeoutMs: fx.verifier.commandTimeoutMs,
      },
      workflowConfig: { requireVerifierPassOnClose: true },
    });

    host.services.verifier.register({ validatorId: 'fresh-hash', type: 'file-hash', config: { path: freshPath, sha256: freshSha } });
    host.services.verifier.register({ validatorId: 'manifest-hash', type: 'file-hash', config: { path: corruptPath, sha256: corruptShaBefore } });

    const freshFirst = await host.services.verifier.run('fresh-hash');
    const corruptFirst = await host.services.verifier.run('manifest-hash');
    probe('corrupted-evidence', `fresh artifact verifies (${fx.expected.freshFirstStatus})`,
      freshFirst.status === fx.expected.freshFirstStatus, jsonOf({ status: freshFirst.status, reason: freshFirst.reasonCode }));
    probe('corrupted-evidence', `artifact verifies against its recorded evidence BEFORE corruption`,
      corruptFirst.status === fx.expected.corruptedFirstStatus, jsonOf({ status: corruptFirst.status, reason: corruptFirst.reasonCode }));

    // Inject the corruption: the artifact no longer matches its evidence.
    writeFileSync(corruptPath, fx.files.corrupted.contentAfter);
    const corruptSecond = await host.services.verifier.run('manifest-hash');
    probe('corrupted-evidence', `stale evidence rejected after corruption (${fx.expected.corruptedSecondStatus}/${fx.expected.corruptedSecondReason}) — no PASS fabricated`,
      corruptSecond.status === fx.expected.corruptedSecondStatus && corruptSecond.reasonCode === fx.expected.corruptedSecondReason,
      jsonOf({ status: corruptSecond.status, reason: corruptSecond.reasonCode }));

    const freshSecond = await host.services.verifier.run('fresh-hash');
    probe('corrupted-evidence', 'untouched sibling artifact still verifies (guard does not over-block)',
      freshSecond.status === fx.expected.freshSecondStatus, jsonOf({ status: freshSecond.status, reason: freshSecond.reasonCode }));

    const closeOnFail = host.services.workflow.canCloseTask({ risk: fx.closeGate.risk, verifierStatus: corruptSecond.status });
    probe('corrupted-evidence', `close-gate BLOCKS the HIGH-risk close on the corrupted verdict (${fx.expected.closeBlockedReason})`,
      closeOnFail.closable === fx.expected.closeBlockedOnFail && closeOnFail.reasonCode === fx.expected.closeBlockedReason,
      jsonOf(closeOnFail));
    const closeOnPass = host.services.workflow.canCloseTask({ risk: fx.closeGate.risk, verifierStatus: freshSecond.status });
    probe('corrupted-evidence', `close-gate still allows a fresh PASS (${fx.expected.closeAllowedReason})`,
      closeOnPass.closable === fx.expected.closeAllowedOnPass && closeOnPass.reasonCode === fx.expected.closeAllowedReason,
      jsonOf(closeOnPass));

    await host.dispose();

    const records = readRecords(dir);
    const verificationEvents = records.filter((r) => r.event === 'verification');
    probe('corrupted-evidence', 'all four REAL verifier runs audited (ids/statuses only)',
      verificationEvents.length === 4 && verificationEvents.every((r) => typeof r.verificationId === 'string' && typeof r.verificationStatus === 'string'),
      jsonOf(verificationEvents.map((r) => [r.verificationId, r.verificationStatus])));
  });

  // =========================================================================
  // SCENARIO d — CANCELLATION: mid-flight cancel/dispose, exact state cleanup
  // =========================================================================
  await runScenario('cancellation', async () => {
    const fx = FX.cancellation;
    const dir = dirOf('cancellation');
    registerHostDir('cancellation', dir);

    const host = await mkHost({
      dataDir: dir,
      memoryConfig: { projectKnowledge: [] },
    });
    host.services.memory.registerLongTermProvider(makeMemoryTaskProvider(FX.guardPairs.memoryIsolation.itemTextSuffix));

    const cancelled = fx.sessions.cancelled;
    const survivor = fx.sessions.survivor;

    // Mid-flight state: selections held + a live (benign) delegation decision.
    host.services.memory.select({ taskText: cancelled.task.taskText, sessionId: cancelled.id, taskId: cancelled.task.id });
    host.services.memory.select({ taskText: survivor.task.taskText, sessionId: survivor.id, taskId: survivor.task.id });
    const delegation = host.services.workflow.evaluateDelegation(fx.delegation);
    probe('cancellation', 'delegation decision live mid-flight (benign request not overreach-audited)',
      delegation.overreach === fx.expected.delegationOverreach, jsonOf(delegation));
    probe('cancellation', 'memory selections held pre-cancel (both sessions)',
      host.services.memory.lookup({ sessionId: cancelled.id, taskId: cancelled.task.id }) !== null
      && host.services.memory.lookup({ sessionId: survivor.id, taskId: survivor.task.id }) !== null,
      'pre-cancel lookups must be non-null');

    // Cancel the first session mid-flight: its selection is released exactly.
    const released = host.services.memory.releaseTask({ sessionId: cancelled.id, taskId: cancelled.task.id });
    probe('cancellation', 'cancellation releases exactly the cancelled task selection',
      released === fx.expected.cancelReleasedTask, `released=${released}`);
    probe('cancellation', 'cancelled lookup empty after cancel (no stale state)',
      (host.services.memory.lookup({ sessionId: cancelled.id, taskId: cancelled.task.id }) === null)
      === fx.expected.cancelledLookupNullAfterCancel, 'lookup must be null');
    probe('cancellation', 'cancelled render empty after cancel',
      (host.renderMemory(host.agentCtxOf(cancelled.id)) === '') === fx.expected.cancelledRenderEmptyAfterCancel,
      jsonOf(host.renderMemory(host.agentCtxOf(cancelled.id))));
    probe('cancellation', 'survivor session untouched by the cancelled session cleanup',
      (host.services.memory.lookup({ sessionId: survivor.id, taskId: survivor.task.id }) !== null)
      === fx.expected.survivorLookupKeptAfterCancel
      && host.renderMemory(host.agentCtxOf(survivor.id)).includes('beta-marker') === fx.expected.survivorRenderKeptAfterCancel,
      'survivor must keep its own selection');
    const repeat = host.services.memory.releaseTask({ sessionId: cancelled.id, taskId: cancelled.task.id });
    // fx.expected.repeatReleaseReturnsFalse is boolean-about-boolean: it asserts
    // "the repeat call returns false" (idempotent no-op, per the REAL service
    // contract) — so compare (repeat === false) against it, not repeat itself.
    probe('cancellation', 'repeat release is a no-op (no double count, no resurrection)',
      (repeat === false) === fx.expected.repeatReleaseReturnsFalse, `repeat=${repeat}`);
    probe('cancellation', 'cancelled lookup STAYS empty after further activity (no cross-contamination)',
      (host.services.memory.lookup({ sessionId: cancelled.id, taskId: cancelled.task.id }) === null) === true,
      'cancelled identity must never resurrect');

    // Pinned event-seam canary carriers: reasoning/response/credential content
    // crosses the REAL session/event seam (policy tracker + observability are
    // both listening) but must never reach observability. Emitted BEFORE the
    // fiber dispose — the listeners unwind on dispose.
    host.emitSessionEvent('session-events', {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [
          { type: 'reasoning', reasoning: CANARIES.reasoning },
          { type: 'text', text: CANARIES.response },
        ] },
        usage: { inputTokens: 10, outputTokens: 5 },
        sentinelField: FX.canaries.canaries.prompt,
      },
    });
    host.emitSessionEvent('session-events', {
      type: 'tool/call',
      data: { turn: 1, step: 2, name: 'read_file', arguments: { path: CANARIES.credential } },
    });

    // Dispose the survivor session through the pinned emit seam.
    const entriesBefore = host.services.memory.selectionStoreStats().entries;
    host.emitSessionDisposed(survivor.id);
    const statsAfterDispose = host.services.memory.selectionStoreStats();
    probe('cancellation', `session-disposed releases exactly the survivor's entries (${fx.expected.sessionDisposeReleased})`,
      entriesBefore - statsAfterDispose.entries === fx.expected.sessionDisposeReleased
      && statsAfterDispose.entries === fx.expected.storeEntriesAfterSessionDispose,
      jsonOf({ before: entriesBefore, after: statsAfterDispose.entries }));
    probe('cancellation', 'survivor lookup empty after session dispose',
      (host.services.memory.lookup({ sessionId: survivor.id, taskId: survivor.task.id }) === null)
      === fx.expected.survivorLookupNullAfterSessionDispose, 'lookup must be null');

    // REAL fiber dispose, bounded: completes within the ceiling, store cleared.
    const disposeStart = Date.now();
    const disposed = await Promise.race([
      host.dispose().then(() => true),
      new Promise((settle) => setTimeout(() => settle(false), fx.disposeCeilingMs)),
    ]);
    probe('cancellation', `REAL fiber dispose completes within ${fx.disposeCeilingMs}ms (no dangling timers/callbacks)`,
      disposed === fx.expected.disposeCompletes, `disposed=${disposed} elapsed=${Date.now() - disposeStart}ms`);
    probe('cancellation', 'post-dispose store empty',
      host.services.memory.selectionStoreStats().entries === fx.expected.postDisposeStoreEntries
      && host.services.memory.selectionStoreStats().activeTasks === fx.expected.postDisposeStoreEntries,
      jsonOf(host.services.memory.selectionStoreStats()));
    probe('cancellation', 'post-dispose follow-up lookups stay empty (both sessions)',
      (host.services.memory.lookup({ sessionId: cancelled.id, taskId: cancelled.task.id }) === null
      && host.services.memory.lookup({ sessionId: survivor.id, taskId: survivor.task.id }) === null)
      === fx.expected.postDisposeLookupsEmpty, 'lookups must stay null');
    probe('cancellation', 'post-dispose render stays empty',
      (host.renderMemory(host.agentCtxOf(survivor.id)) === '') === fx.expected.postDisposeRenderEmpty,
      jsonOf(host.renderMemory(host.agentCtxOf(survivor.id))));
  });

  // =========================================================================
  // SCENARIO e — GUARD PAIRS: adversarial blocked + benign sibling untouched
  // =========================================================================
  await runScenario('guard-pairs/cost-gate', async () => {
    const fx = FX.guardPairs.costGate;
    const dir = dirOf('guard-cost-gate');
    registerHostDir('guard-cost-gate', dir);
    const host = await mkHost({
      dataDir: dir,
      routerConfig: {
        candidates: Object.values(fx.candidates).map((c) => ({
          provider: c.provider,
          credentialMode: 'config-owned',
          credentialConfigured: true,
          quotaHeadroom: c.quotaHeadroom,
          models: [{ model: c.model, costClass: c.costClass, capabilities: ['chat'], contextWindow: 32768, failureDomain: c.failureDomain }],
        })),
      },
      llm: {
        listProviders: () => Object.values(fx.candidates).map((c) => c.provider),
        resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
      },
    });
    const counter = makeDispatchCounter();

    // ADVERSARIAL (agent/request seam): paid request denied pre-dispatch.
    const advRequest = await fireAgentRequest(
      host.root,
      { provider: fx.adversarial.provider, model: fx.adversarial.model, _canary: CANARIES.credential },
      'session-cost-adv',
    );
    probe('guard-pairs/cost-gate', 'ADVERSARIAL agent/request: paid route denied pre-dispatch (route-less config)',
      advRequest.dispatched === false
      && (advRequest.result.provider === '' && advRequest.result.model === '') === fx.expected.agentRequestDenyEmptiesRoute,
      jsonOf({ dispatched: advRequest.dispatched, provider: advRequest.result?.provider }));

    // ADVERSARIAL (llm/stream backstop): throws BEFORE next() — zero calls.
    const advStream = await fireLlmStream(
      host.root,
      { provider: fx.adversarial.provider, model: fx.adversarial.model, _canary: CANARIES.credential },
      counter,
    );
    probe('guard-pairs/cost-gate', `ADVERSARIAL llm/stream: deny before next() with code ${fx.expected.llmStreamDenyErrorCode}`,
      advStream.error?.code === fx.expected.llmStreamDenyErrorCode && counter.total === fx.expected.adversarialDispatches,
      jsonOf({ code: advStream.error?.code, dispatches: counter.total }));

    // BENIGN sibling: free route passes untouched on both seams.
    const benignRequest = await fireAgentRequest(
      host.root,
      { provider: fx.benign.provider, model: fx.benign.model },
      'session-cost-benign',
    );
    probe('guard-pairs/cost-gate', 'BENIGN agent/request: free route preserved untouched',
      benignRequest.dispatched === true
      && benignRequest.result.provider === fx.benign.provider
      && benignRequest.result.model === fx.benign.model
      === fx.expected.benignRoutePreserved,
      jsonOf({ dispatched: benignRequest.dispatched, provider: benignRequest.result?.provider }));
    const benign1 = await fireLlmStream(host.root, { provider: fx.benign.provider, model: fx.benign.model }, counter);
    const benign2 = await fireLlmStream(host.root, { provider: fx.benign.provider, model: fx.benign.model }, counter);
    probe('guard-pairs/cost-gate', `BENIGN llm/stream dispatches succeed (${fx.expected.benignChunksPerDispatch} chunks each)`,
      benign1.error === null && benign2.error === null
      && benign1.chunks === fx.expected.benignChunksPerDispatch && benign2.chunks === fx.expected.benignChunksPerDispatch,
      jsonOf({ c1: benign1.chunks, c2: benign2.chunks, error1: benign1.error?.message }));
    probe('guard-pairs/cost-gate', `benign dispatch count ${fx.expected.benignDispatchesAfterRepeat} (adversarial added zero)`,
      counter.for(fx.benign.provider) === fx.expected.benignDispatchesAfterRepeat && counter.for(fx.adversarial.provider) === 0,
      jsonOf([...counter.byProvider]));

    await host.dispose();

    const records = readRecords(dir);
    const denied = records.filter((r) => r.event === fx.expected.deniedEvent);
    const evidence = records.filter((r) => r.event === fx.expected.freeEvidenceEvent);
    probe('guard-pairs/cost-gate', `denial audited value-free on both seams (${denied.length} events)`,
      denied.length === 2, jsonOf(denied.map((r) => [r.event, r.detail ?? r.reason])));
    probe('guard-pairs/cost-gate', `free-route evidence bounded to ONE event across repeat dispatches`,
      evidence.length === fx.expected.freeEvidenceEventCountAfterRepeat, jsonOf(evidence.map((r) => [r.event, r.provider, r.model])));
  });

  await runScenario('guard-pairs/symlink-verifier', async () => {
    const fx = FX.guardPairs.symlinkVerifier;
    const dir = dirOf('guard-symlink');
    registerHostDir('guard-symlink', dir);

    const rootDir = join(dir, 'root');
    const outsideDir = join(dir, fx.outside.dir);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const insidePath = join(rootDir, fx.inside.name);
    const outsidePath = join(outsideDir, fx.outside.name);
    writeFileSync(insidePath, fx.inside.content);
    writeFileSync(outsidePath, fx.outside.content); // CANARY lives OUTSIDE any root
    symlinkSync(outsidePath, join(rootDir, fx.linkName));

    const host = await mkHost({
      dataDir: dir,
      verifierConfig: { allowCommands: false, allowNetwork: false, allowedRoots: [rootDir], commandTimeoutMs: 1000 },
    });
    host.services.verifier.register({
      validatorId: 'escape-hash',
      type: 'file-hash',
      config: { path: join(rootDir, fx.linkName), sha256: sha256Of(fx.outside.content) },
    });
    host.services.verifier.register({
      validatorId: 'escape-exists',
      type: 'file-exists',
      config: { path: join(rootDir, fx.linkName) },
    });
    host.services.verifier.register({
      validatorId: 'benign-hash',
      type: 'file-hash',
      config: { path: insidePath, sha256: sha256Of(fx.inside.content) },
    });

    // ADVERSARIAL: out-of-root symlink must be rejected BEFORE any content read.
    const adv = await host.services.verifier.run('escape-hash');
    probe('guard-pairs/symlink-verifier', `ADVERSARIAL out-of-root symlink rejected (${fx.expected.adversarialStatus}/${fx.expected.adversarialReason})`,
      adv.status === fx.expected.adversarialStatus && adv.reasonCode === fx.expected.adversarialReason,
      jsonOf({ status: adv.status, reason: adv.reasonCode }));
    const advExists = await host.services.verifier.run('escape-exists');
    probe('guard-pairs/symlink-verifier', 'ADVERSARIAL symlink existence not leaked either',
      advExists.status === fx.expected.adversarialStatus && advExists.reasonCode === fx.expected.adversarialReason,
      jsonOf({ status: advExists.status, reason: advExists.reasonCode }));

    // BENIGN sibling: the in-root artifact still verifies.
    const benign = await host.services.verifier.run('benign-hash');
    probe('guard-pairs/symlink-verifier', `BENIGN in-root artifact still verifies (${fx.expected.benignStatus})`,
      benign.status === fx.expected.benignStatus && benign.reasonCode === fx.expected.benignReason,
      jsonOf({ status: benign.status, reason: benign.reasonCode }));

    probe('guard-pairs/symlink-verifier', 'out-of-root canary never appears in any verdict evidence',
      ![adv, advExists, benign].some((r) => r.evidence.includes(CANARIES.credential)),
      'evidence must stay value-free');

    await host.dispose();
  });

  await runScenario('guard-pairs/a2a-registry', async () => {
    const fx = FX.guardPairs.a2aRegistry;
    const dir = dirOf('guard-a2a');
    registerHostDir('guard-a2a', dir);
    const host = await mkHost({
      dataDir: dir,
      workflowConfig: {
        agentContactPolicy: 'DENY',
        allowedContacts: [{ from: fx.graph.from, to: fx.graph.to }],
      },
    });

    const execOf = (agentId, name, args) => ({
      callId: `call-${name}`,
      name,
      arguments: args,
      agent: agentId === null ? undefined : { session: { id: agentId } },
      signal: new AbortController().signal,
    });
    const fire = async (exec) => {
      let executed = 0;
      const decision = await host.root.events.waterfall('tools/pre-execute', exec, () => {
        executed += 1;
        return Promise.resolve({ kind: 'allow' });
      });
      return { decision, executed };
    };
    const a2aCount = () => host.services.observability.stats().seq; // sync counter

    // ADVERSARIAL: out-of-graph message under DENY — refused pre-fact.
    const seqBefore = a2aCount();
    const adv = await fire(execOf(fx.adversarial.from, fx.adversarial.tool, { to: fx.adversarial.to, body: fx.adversarial.body }));
    probe('guard-pairs/a2a-registry', `ADVERSARIAL out-of-graph message denied pre-fact (${fx.expected.adversarialDecision}) carrying ${fx.expected.adversarialDenyReason}`,
      adv.decision.kind === fx.expected.adversarialDecision
      && adv.executed === (fx.expected.adversarialNextCalled ? 1 : 0)
      && String(adv.decision?.reason ?? '').includes(fx.expected.adversarialDenyReason),
      jsonOf({ kind: adv.decision.kind, executed: adv.executed, reason: adv.decision?.reason }));
    probe('guard-pairs/a2a-registry', 'ADVERSARIAL denial audited (a2a_contact)',
      a2aCount() - seqBefore === 1, `events=${a2aCount() - seqBefore}`);

    // BENIGN sibling 1: in-graph message passes untouched (no audit, executes).
    const seqBeforeBenign = a2aCount();
    const benignMsg = await fire(execOf(fx.benignInGraph.from, fx.benignInGraph.tool, { to: fx.benignInGraph.to, body: fx.benignInGraph.body }));
    probe('guard-pairs/a2a-registry', `BENIGN in-graph message passes untouched (${fx.expected.benignInGraphDecision})`,
      benignMsg.decision.kind !== 'deny' && benignMsg.executed === (fx.expected.benignInGraphNextCalled ? 1 : 0),
      jsonOf({ kind: benignMsg.decision.kind, executed: benignMsg.executed }));
    probe('guard-pairs/a2a-registry', 'BENIGN in-graph message produces zero a2a events',
      a2aCount() - seqBeforeBenign === fx.expected.benignInGraphA2aEvents, `events=${a2aCount() - seqBeforeBenign}`);

    // BENIGN sibling 2: ordinary tool with a `target` argument is never
    // inspected (the FIX-D false-positive class).
    const seqBeforeOrdinary = a2aCount();
    const benignCopy = await fire(execOf(fx.benignOrdinary.from, fx.benignOrdinary.tool, fx.benignOrdinary.args));
    probe('guard-pairs/a2a-registry', `BENIGN ordinary copy_file {target} passes untouched (${fx.expected.benignOrdinaryDecision})`,
      benignCopy.decision.kind !== 'deny' && benignCopy.executed === (fx.expected.benignOrdinaryNextCalled ? 1 : 0),
      jsonOf({ kind: benignCopy.decision.kind, executed: benignCopy.executed }));
    probe('guard-pairs/a2a-registry', 'BENIGN ordinary tool produces zero a2a events (no false-DENY, no false audit)',
      a2aCount() - seqBeforeOrdinary === fx.expected.benignOrdinaryA2aEvents, `events=${a2aCount() - seqBeforeOrdinary}`);

    await host.dispose();

    const records = readRecords(dir);
    const contacts = records.filter((r) => r.event === fx.expected.adversarialEvent);
    probe('guard-pairs/a2a-registry', `exactly ONE a2a_contact audit, carrying ${fx.expected.adversarialEventReason}`,
      contacts.length === 1 && (contacts[0].detail ?? '').includes(fx.expected.adversarialEventReason),
      jsonOf(contacts.map((r) => r.detail)));
  });

  await runScenario('guard-pairs/memory-isolation', async () => {
    const fx = FX.guardPairs.memoryIsolation;
    const dir = dirOf('guard-memory');
    registerHostDir('guard-memory', dir);
    const host = await mkHost({ dataDir: dir });
    host.services.memory.registerLongTermProvider(makeMemoryTaskProvider(fx.itemTextSuffix));

    const [A, B] = [fx.sessions.A, fx.sessions.B];
    host.services.memory.select({ taskText: A.task.taskText, sessionId: A.id, taskId: A.task.id });
    host.services.memory.select({ taskText: B.task.taskText, sessionId: B.id, taskId: B.task.id });

    // ADVERSARIAL: cross-session/cross-task identity reads must get NOTHING.
    const crossA = host.services.memory.lookup({ sessionId: A.id, taskId: B.task.id });
    const crossB = host.services.memory.lookup({ sessionId: B.id, taskId: A.task.id });
    probe('guard-pairs/memory-isolation', 'ADVERSARIAL cross-identity lookups return null (both directions)',
      (crossA === null && crossB === null) === fx.expected.crossLookupNull, 'cross lookups must be null');
    const renderA = host.renderMemory(host.agentCtxOf(A.id));
    const renderB = host.renderMemory(host.agentCtxOf(B.id));
    probe('guard-pairs/memory-isolation', 'ADVERSARIAL renders exclude the other session\'s marker',
      !renderA.includes('beta-marker') && !renderB.includes('alpha-marker'),
      jsonOf({ renderA: renderA.slice(0, 80), renderB: renderB.slice(0, 80) }));
    probe('guard-pairs/memory-isolation', 'ADVERSARIAL unknown identity renders nothing (fail-closed)',
      host.renderMemory(host.agentCtxOf('session-unknown')) === '' && host.renderMemory({}) === '',
      'unknown identity must render empty');

    // BENIGN sibling: each session's own selection is returned untouched.
    const ownA = host.services.memory.lookup({ sessionId: A.id, taskId: A.task.id });
    const ownB = host.services.memory.lookup({ sessionId: B.id, taskId: B.task.id });
    probe('guard-pairs/memory-isolation', 'BENIGN own lookups return exactly the own selection',
      ownA?.selected?.[0]?.item?.text?.includes('alpha-marker') === fx.expected.ownLookupHasOwnMarker
      && ownB?.selected?.[0]?.item?.text?.includes('beta-marker') === fx.expected.ownLookupHasOwnMarker,
      jsonOf({ a: ownA?.selected?.[0]?.item?.text, b: ownB?.selected?.[0]?.item?.text }));
    probe('guard-pairs/memory-isolation', 'BENIGN renders keep each own marker',
      renderA.includes('alpha-marker') === fx.expected.ownRenderHasOwnMarker
      && renderB.includes('beta-marker') === fx.expected.ownRenderHasOwnMarker
      && (!renderA.includes('beta-marker') && !renderB.includes('alpha-marker')) === fx.expected.ownRenderExcludesOtherMarker,
      jsonOf({ renderA: renderA.slice(0, 80), renderB: renderB.slice(0, 80) }));

    await host.dispose();
  });

  // =========================================================================
  // SCENARIO f — AUDIT METADATA BOUNDS across ALL scenarios
  // =========================================================================
  await runScenario('audit-metadata-bounds', async () => {
    const fx = FX.canaries;
    const canaryValues = Object.values(CANARIES);
    const ALLOWED_KEYS = new Set(obsEngine.RECORD_FIELDS);

    probe('audit-metadata-bounds', 'REAL engine RECORD_FIELDS allowlist imported (keys checked against it)',
      fx.expected.allowlistSource === 'RECORD_FIELDS_ENGINE_EXPORT' && Array.isArray(obsEngine.RECORD_FIELDS) && ALLOWED_KEYS.size > 0,
      `keys=${ALLOWED_KEYS.size}`);

    let totalRecords = 0;
    const eventNames = new Set();
    let leakedCanary = null;
    let illegalShape = null;
    for (const { scenario, dir } of hostDirs) {
      const raw = readFileSyncOrNull(join(dir, 'observability.jsonl')) ?? '';
      for (const canary of canaryValues) {
        if (raw.includes(canary) && leakedCanary === null) {
          leakedCanary = { scenario, canary };
        }
      }
      for (const line of raw.split('\n').filter((l) => l.length > 0)) {
        let record;
        try { record = JSON.parse(line); } catch { illegalShape = { scenario, reason: 'unparseable line' }; break; }
        totalRecords += 1;
        if (typeof record.event === 'string') eventNames.add(record.event);
        for (const key of Object.keys(record)) {
          if (!ALLOWED_KEYS.has(key)) { illegalShape = { scenario, key, reason: 'key outside RECORD_FIELDS' }; break; }
          const value = record[key];
          if (!(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
            illegalShape = { scenario, key, reason: `non-scalar value ${typeof value}` };
            break;
          }
        }
        if (illegalShape) break;
      }
      if (leakedCanary || illegalShape) break;
    }

    probe('audit-metadata-bounds', `NO canary (prompt/response/credential/reasoning/sentinel) appears in ANY observability record across ${hostDirs.length} scenario streams`,
      leakedCanary === null, jsonOf(leakedCanary));
    probe('audit-metadata-bounds', 'every record: keys inside the REAL RECORD_FIELDS allowlist, scalar values only',
      illegalShape === null, jsonOf(illegalShape));
    probe('audit-metadata-bounds', `event stream non-vacuous (${totalRecords} records ≥ ${fx.expected.minRecords})`,
      totalRecords >= fx.expected.minRecords, `records=${totalRecords}`);
    const missingEvents = fx.expected.requiredEvents.filter((name) => !eventNames.has(name));
    probe('audit-metadata-bounds', `all required event names observed (${fx.expected.requiredEvents.length} kinds)`,
      missingEvents.length === 0, `missing=${jsonOf(missingEvents)} observed=${jsonOf([...eventNames].sort())}`);
  });

  // =========================================================================
  // Verdict
  // =========================================================================
  const failed = probes.filter((p) => !p.ok);
  console.log('\n----------------------------------------------------------------');
  console.log(`scenarios: probes=${probes.length} failed=${failed.length}`);
  if (failed.length === 0) {
    console.log('V131_FAILURE_INJECTION_VERIFIED');
    process.exitCode = 0;
  } else {
    const failedScenarios = [...new Set(failed.map((p) => p.scenario))];
    console.log(`FAILING SCENARIO(S): ${failedScenarios.join(', ')}`);
    for (const p of failed) console.log(`  FAIL [${p.scenario}] ${p.name}`);
    console.log('V131_FAILURE_INJECTION_FAILED');
    process.exitCode = 1;
  }
} finally {
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}
