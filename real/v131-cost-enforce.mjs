#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-cost-enforce.mjs — FIX-A probe (v1.3.1 review P1).
 *
 * Issue under test (external review of v1.3.0):
 *   "In src/plugins/supreme-router/index.ts, the agent/request hook only
 *    adjusts reasoningEffort. With default config, requests to paid
 *    providers/models pass through WITHOUT route/cost checks."
 *
 * Root cause: the v1.3.0 router adapter bound only the agent/request
 * waterfall to REWRITE reasoningEffort; it never consulted supremePolicy
 * with the resolved provider/model/cost-class, so any dispatched request
 * (paid, trial, or a model on no allowlist at all) crossed the seam with
 * zero cost checks. The router ENGINE gates candidates (policy_cost), but
 * nothing forces dispatched requests through route().
 *
 * Two modes:
 *   bun real/v131-cost-enforce.mjs repro   — demonstrate the bug on the
 *       CURRENT tree: a paid/unknown-model request sails through with no
 *       deny. Exit 0 + V131_COST_BUG_REPRODUCED when observed.
 *   bun real/v131-cost-enforce.mjs verify  — acceptance after the fix
 *       (must FAIL on the original code). Exit 0 + V131_COST_FIX_VERIFIED
 *       only when every probe passes.
 *
 * Exercises the REAL code (no simulation of the logic under test):
 *   - the REAL router adapter (src/plugins/supreme-router/index.ts) mounted
 *     on the REAL pinned cordis (@deepseek-ai/cordis) with the zod Config
 *     resolved BEFORE apply (cordis plugin convention);
 *   - the REAL supreme-policy adapter (production defaults: STANDARD,
 *     allowPaid=false, allowTrial=false, allowUnknownCost=false) so the
 *     consulted cost decision is the REAL policy engine's, not a stub;
 *   - the REAL pinned seams:
 *       agent/request — config-proposal waterfall; the pinned agent loop
 *         throws BEFORE llm.prepareCall/stream when the waterfall result
 *         has no provider/model (packages/core/agent-loop/src/agent.ts:522-534,
 *         pin d347e703908d0406b7a7ef80e3a0e594d86b2215);
 *       llm/stream — the waterfall wrapped around EVERY adapter stream
 *         (packages/llm/llm/src/index.ts:58-74 + 1093-1107); the innermost
 *         `next()` IS the adapter dispatch (adapterStream), so a listener
 *         that refuses before next() performs zero adapter calls.
 *     A dispatch counter stands in for the adapter/LLM call: the count MUST
 *     be 0 on every deny.
 *
 * NO upstream file is modified. No new dependencies. Deterministic only.
 */
const ROOT = new URL('..', import.meta.url);
const routerAdapterHref = new URL('src/plugins/supreme-router/index.ts', ROOT).href;
const routerEngineHref = new URL('src/plugins/supreme-router/engine.ts', ROOT).href;
const policyAdapterHref = new URL('src/plugins/supreme-policy/index.ts', ROOT).href;
const policyEngineHref = new URL('src/plugins/supreme-policy/engine.ts', ROOT).href;

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
const probe = (name, ok, detail = '') => {
  if (ok !== true) failures += 1;
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

// Content canaries: must NEVER appear in any emitted audit event.
const CANARY_ARG = 'V131_COST_SECRET_PAYLOAD_canary_42';

// ---------------------------------------------------------------------------
// Harness: mount the REAL policy adapter (optional) + REAL router adapter on
// the REAL pinned cordis, with stub llm/benchmark services and a recorder
// observability. Identical mounting pattern to real/v13-policy-verify.mjs.
// ---------------------------------------------------------------------------
const mkHost = async ({ routerConfig, policyConfig = null, policyOverride = null } = {}) => {
  const events = [];
  const record = (event, fields) => events.push({ event, fields });
  const root = new Context();

  // Stub DSH services the router consumes (structural view of LlmRuntime).
  root.provide('llm', {
    listProviders: () => [{ id: 'synthetic-free' }, { id: 'synthetic-paid' }, { id: 'other-provider' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
  });
  root.provide('supremeBenchmark', { aggregateModelPerformance: () => [] });
  root.provide('supremeObservability', { record });

  if (policyOverride !== null) {
    // Policy-UNAVAILABLE rig: a stub without evaluateRoute — router must fail CLOSED.
    root.provide('supremePolicy', policyOverride);
  } else if (policyConfig !== null) {
    const policyMod = await import(policyAdapterHref);
    if (policyMod.name !== 'supreme-policy') throw new Error('policy adapter module shape unexpected');
    await root.plugin(policyMod, policyConfig); // REAL zod Config resolved by cordis BEFORE apply
  } else {
    const policyMod = await import(policyAdapterHref);
    await root.plugin(policyMod, {}); // REAL policy, PRODUCTION defaults (STANDARD, all-paid denied)
  }

  const routerMod = await import(routerAdapterHref);
  if (routerMod.name !== 'supreme-router' || routerMod.inject.length !== 4) {
    throw new Error('router adapter module shape unexpected');
  }
  await root.plugin(routerMod, routerConfig ?? { candidates: [] }); // REAL zod Config resolved by cordis BEFORE apply

  // Adapter/LLM dispatch counter: incremented ONLY where the pinned runtime
  // would actually reach an adapter stream.
  let adapterDispatchCount = 0;
  const dispatchCount = () => adapterDispatchCount;

  // --- agent/request simulation (mirrors the pinned loop contract) ----------
  // The innermost next() yields the seed config exactly like agent.ts:522-525;
  // afterwards the pinned check (agent.ts:527-529) runs: a waterfall result
  // without provider/model throws BEFORE llm.prepareCall/stream — so the
  // simulated adapter dispatch only counts when the guard passes.
  const fireAgentRequest = async (seedConfig) => {
    let loopError = null;
    let dispatched = false;
    let result;
    try {
      result = await root.events.waterfall(
        'agent/request',
        { agent: { session: { id: 'sess-fix-a' } }, turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ ...seedConfig }),
      );
      if (!result.provider || !result.model) {
        // Pinned contract: throw new Error(`agent "..." has no provider/model: ...`)
        throw new Error('agent "sess-fix-a" has no provider/model (simulated pinned guard)');
      }
      dispatched = true;
      adapterDispatchCount += 1; // prepareCall + stream stand-in
    } catch (error) {
      loopError = error;
    }
    return { result, dispatched, loopError };
  };

  // --- llm/stream simulation (the innermost next() IS the adapter stream) ---
  const stubStream = async function* () {
    yield { type: 'text-start', index: 0 };
    yield { type: 'text-end', index: 0 };
    yield { type: 'finish', reason: { kind: 'completed' } };
  };
  const fireLlmStream = async (options) => {
    let error = null;
    let dispatched = false;
    let chunks = 0;
    try {
      const stream = await root.events.waterfall('llm/stream', options, () => {
        adapterDispatchCount += 1; // adapterStream stand-in (receiver invocation)
        dispatched = true;
        return stubStream();
      });
      for await (const chunk of stream) chunks += 1; // consume fully (loop-pull parity)
    } catch (caught) {
      error = caught;
    }
    return { error, dispatched, chunks };
  };

  const eventsNamed = (name) => events.filter((e) => e.event === name);
  const dispose = () => root.fiber.dispose();
  return { root, events, record, eventsNamed, fireAgentRequest, fireLlmStream, dispatchCount, dispose };
};

const routerEngine = await import(routerEngineHref);
const policyEngine = await import(policyEngineHref);
const PAID_SEED = { provider: 'synthetic-paid', model: 'synthetic-paid-large', _canary: CANARY_ARG };
const FREE_SEED = { provider: 'synthetic-free', model: 'synthetic-mini', _canary: CANARY_ARG };
const UNKNOWN_SEED = { provider: 'unlisted-provider', model: 'never-allowlisted-model', _canary: CANARY_ARG };
const ROUTER_CANDIDATES = {
  candidates: [
    {
      provider: 'synthetic-free', credentialMode: 'config-owned', credentialConfigured: true,
      quotaHeadroom: 0.95,
      models: [{ model: 'synthetic-mini', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'synthetic' }],
    },
    {
      provider: 'synthetic-paid', credentialMode: 'config-owned', credentialConfigured: true,
      quotaHeadroom: 0.9,
      models: [{ model: 'synthetic-paid-large', costClass: 'PAID', capabilities: ['chat'], contextWindow: 131072, failureDomain: 'synthetic-paid' }],
    },
  ],
};

const mode = process.argv[2] ?? 'verify';

// ---------------------------------------------------------------------------
// Mode: repro — demonstrate the v1.3.0 passthrough on the CURRENT tree.
// ---------------------------------------------------------------------------
if (mode === 'repro') {
  console.log('== FIX-A repro — paid/unknown-model requests sail through without cost checks ==');
  const host = await mkHost({ routerConfig: ROUTER_CANDIDATES }); // REAL policy, production defaults
  const paid = await host.fireAgentRequest(PAID_SEED);
  const unknown = await host.fireAgentRequest(UNKNOWN_SEED);
  const paidStream = await host.fireLlmStream({ ...PAID_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  host.dispose();
  const bugPresent = (paid.dispatched && paid.result?.provider === PAID_SEED.provider)
    || (unknown.dispatched && unknown.result?.provider === UNKNOWN_SEED.provider)
    || paidStream.dispatched;
  console.log(`  agent/request paid    : dispatched=${paid.dispatched} result=${jsonOf(paid.result)}`);
  console.log(`  agent/request unknown : dispatched=${unknown.dispatched} result=${jsonOf(unknown.result)}`);
  console.log(`  llm/stream paid       : dispatched=${paidStream.dispatched} error=${paidStream.error ? paidStream.error.message : 'none'}`);
  if (bugPresent) {
    console.log('V131_COST_BUG_REPRODUCED — paid/unknown-model request dispatched with no deny');
    process.exit(0);
  }
  console.log('V131_COST_BUG_NOT_REPRODUCED — current tree no longer lets paid/unknown requests through');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mode: verify — acceptance. Must FAIL on the original (v1.3.0) code.
// ---------------------------------------------------------------------------
console.log('== v1.3.1 cost-enforcement verify — REAL engines + REAL adapters on pinned cordis ==');

// ---------------------------------------------------------------------------
// [a] Unauthorized paid/unknown-model requests DENY pre-dispatch, 0 adapter
//     calls, policy-owned reasons (REAL policy adapter, production defaults).
// ---------------------------------------------------------------------------
console.log('[a] unauthorized paid/unknown requests deny pre-dispatch (dispatch count = 0)');
{
  const host = await mkHost({ routerConfig: ROUTER_CANDIDATES });
  const paid = await host.fireAgentRequest(PAID_SEED);
  probe('a1 agent/request: PAID route denied by the pinned no-provider/model guard', paid.loopError !== null && paid.result.provider === '' && paid.result.model === '', `result=${jsonOf(paid.result)} err=${paid.loopError?.message ?? 'none'}`);
  probe('a2 agent/request: PAID route performs ZERO adapter dispatches', host.dispatchCount() === 0 && paid.dispatched === false, `dispatchCount=${host.dispatchCount()}`);
  const paidDenyEvents = host.eventsNamed('route_cost_denied').filter((e) => e.fields.provider === 'synthetic-paid');
  probe('a3 route_cost_denied audit carries policy reason COST_PAID_DENIED', paidDenyEvents.length === 1 && paidDenyEvents[0].fields.reason === 'COST_PAID_DENIED', jsonOf(paidDenyEvents));
  probe('a4 audit event is value-free (no canary, ids/labels only)', !jsonOf(host.events).includes(CANARY_ARG) && paidDenyEvents[0]?.fields.costClass === 'PAID');

  const unknown = await host.fireAgentRequest(UNKNOWN_SEED);
  probe('a5 agent/request: model on NO allowlist => UNKNOWN => deny', unknown.loopError !== null && unknown.result.provider === '' && unknown.result.model === '', `result=${jsonOf(unknown.result)}`);
  probe('a6 agent/request: UNKNOWN route performs ZERO adapter dispatches', host.dispatchCount() === 0, `dispatchCount=${host.dispatchCount()}`);
  const unknownEvents = host.eventsNamed('route_cost_denied').filter((e) => e.fields.provider === 'unlisted-provider');
  probe('a7 UNKNOWN deny reason COST_UNKNOWN_DENIED (from REAL policy evaluateRoute)', unknownEvents.length === 1 && unknownEvents[0].fields.reason.includes('COST_UNKNOWN_DENIED'), jsonOf(unknownEvents));

  // llm/stream backstop — same host, fresh dispatches (message content carries
  // the canary: audits must never echo request content).
  const paidStream = await host.fireLlmStream({ ...PAID_SEED, messages: [{ role: 'user', content: CANARY_ARG }], sessionId: 's', signal: new AbortController().signal });
  probe('a8 llm/stream: PAID dispatch refused before the adapter receiver', paidStream.error !== null && paidStream.dispatched === false, `err=${paidStream.error?.message ?? 'none'}`);
  const unknownStream = await host.fireLlmStream({ ...UNKNOWN_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  probe('a9 llm/stream: UNKNOWN dispatch refused before the adapter receiver', unknownStream.error !== null && unknownStream.dispatched === false, `err=${unknownStream.error?.message ?? 'none'}`);
  probe('a10 llm/stream denials still ZERO adapter dispatches on this host', host.dispatchCount() === 0, `dispatchCount=${host.dispatchCount()}`);
  const streamedDenials = host.eventsNamed('route_cost_denied').filter((e) => e.fields.seam === 'llm/stream');
  probe('a11 llm/stream deny audited with seam label (value-free)', streamedDenials.length === 2 && streamedDenials.every((e) => typeof e.fields.reason === 'string' && e.fields.reason.length > 0), jsonOf(streamedDenials));
  host.dispose();
}

// ---------------------------------------------------------------------------
// [b] Legitimate free-confirmed request succeeds END-TO-END through the real
//     adapter; free-claim evidence recorded once (source/checkedAt/status).
// ---------------------------------------------------------------------------
console.log('[b] free-confirmed route still succeeds end-to-end + free-claim evidence');
{
  const host = await mkHost({ routerConfig: ROUTER_CANDIDATES });
  const free = await host.fireAgentRequest(FREE_SEED);
  probe('b1 agent/request: FREE_CONFIRMED route passes untouched (provider/model preserved)', free.dispatched === true && free.result.provider === 'synthetic-free' && free.result.model === 'synthetic-mini', `result=${jsonOf(free.result)}`);
  probe('b2 free route reaches the simulated machine dispatch exactly once', host.dispatchCount() === 1, `dispatchCount=${host.dispatchCount()}`);
  const evidence = host.eventsNamed('free_route_evidence');
  probe('b3 free_route_evidence recorded with source/checkedAt/status/expiresAt', evidence.length === 1 && evidence[0].fields.source === 'config' && Number.isFinite(evidence[0].fields.checkedAt) && evidence[0].fields.status === 'active' && evidence[0].fields.expiresAt === null, jsonOf(evidence));
  const again = await host.fireAgentRequest(FREE_SEED);
  probe('b4 second free dispatch succeeds and does NOT duplicate the evidence event', again.dispatched === true && host.eventsNamed('free_route_evidence').length === 1, `evidence=${host.eventsNamed('free_route_evidence').length}`);

  const freeStream = await host.fireLlmStream({ ...FREE_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  probe('b5 llm/stream: FREE_CONFIRMED dispatch reaches the adapter stream', freeStream.error === null && freeStream.dispatched === true && freeStream.chunks === 3, `err=${freeStream.error?.message ?? 'none'} chunks=${freeStream.chunks}`);
  probe('b6 engine: freeClaimEvidence is deterministic and value-free', typeof routerEngine.freeClaimEvidence === 'function' && (() => {
    const a = routerEngine.freeClaimEvidence('config', 1000);
    const b = routerEngine.freeClaimEvidence('config', 1000);
    return jsonOf(a) === jsonOf(b) && a.source === 'config' && a.checkedAt === 1000 && a.status === 'active' && a.expiresAt === null;
  })(), typeof routerEngine.freeClaimEvidence === 'function' ? '' : 'engine export missing (pre-fix)');
  probe('b7 engine: FREE_CLAIM_SOURCES vocabulary (config|catalog|user-allowlist)', typeof routerEngine.FREE_CLAIM_SOURCES !== 'undefined' && jsonOf(routerEngine.FREE_CLAIM_SOURCES) === jsonOf(['config', 'catalog', 'user-allowlist']), typeof routerEngine.FREE_CLAIM_SOURCES === 'undefined' ? 'engine export missing (pre-fix)' : jsonOf(routerEngine.FREE_CLAIM_SOURCES));
  host.dispose();
}

// ---------------------------------------------------------------------------
// [c] Empty candidates => deny for EVERYTHING, never paid passthrough.
// ---------------------------------------------------------------------------
console.log('[c] empty candidate allowlist => deny (never passthrough)');
{
  const host = await mkHost({ routerConfig: { candidates: [] } });
  const paid = await host.fireAgentRequest(PAID_SEED);
  const free = await host.fireAgentRequest(FREE_SEED);
  probe('c1 agent/request: PAID denied with empty allowlist', paid.loopError !== null && paid.result.provider === '' && paid.result.model === '', `result=${jsonOf(paid.result)}`);
  probe('c2 agent/request: even FREE-labeled request denied — cost class UNKNOWN without allowlist', free.loopError !== null && free.result.provider === '', `result=${jsonOf(free.result)}`);
  const stream = await host.fireLlmStream({ ...PAID_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  probe('c3 llm/stream: denied with empty allowlist, zero dispatches', stream.error !== null && stream.dispatched === false && host.dispatchCount() === 0, `err=${stream.error?.message ?? 'none'}`);
  probe('c4 every deny is audited with the policy reason', host.eventsNamed('route_cost_denied').length === 3, `events=${jsonOf(host.eventsNamed('route_cost_denied'))}`);
  host.dispose();
}

// ---------------------------------------------------------------------------
// [d] Re-validation on retry/fallback: the pinned loop re-enters the
//     agent/request waterfall on EVERY attempt (agent.ts while(true) →
//     buildRequest; agent/request-error retry → continue → rebuild), and
//     llm/stream re-fires per attempt — a route that switches model/provider
//     between attempts is re-checked against policy at the new key.
// ---------------------------------------------------------------------------
console.log('[d] re-validation when the route changes between attempts');
{
  const host = await mkHost({ routerConfig: ROUTER_CANDIDATES });
  const attempt1 = await host.fireAgentRequest(FREE_SEED); // free attempt allowed
  const attempt2 = await host.fireAgentRequest(PAID_SEED); // fallback proposes a PAID route
  probe('d1 first attempt (free) allowed', attempt1.dispatched === true && attempt1.result.provider === 'synthetic-free');
  probe('d2 retry/fallback attempt re-validated: switched-to PAID route denied', attempt2.loopError !== null && attempt2.result.provider === '', `result=${jsonOf(attempt2.result)}`);
  const unknownAttempt = await host.fireAgentRequest(UNKNOWN_SEED);
  probe('d3 fallback to an unlisted model re-validated: UNKNOWN denied', unknownAttempt.loopError !== null && unknownAttempt.result.provider === '');
  const streamA = await host.fireLlmStream({ ...FREE_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  const streamB = await host.fireLlmStream({ ...PAID_SEED, messages: [], sessionId: 's', signal: new AbortController().signal });
  probe('d4 llm/stream re-checks each attempt: free allowed, then paid denied', streamA.dispatched === true && streamB.error !== null && streamB.dispatched === false);
  probe('d5 total dispatch count reflects ONLY allowed attempts', host.dispatchCount() === 2, `dispatchCount=${host.dispatchCount()}`);
  host.dispose();
}

// ---------------------------------------------------------------------------
// [e] Policy ownership + fail-closed posture.
// ---------------------------------------------------------------------------
console.log('[e] policy ownership (real evaluateRoute) + fail-closed when policy unavailable');
{
  probe('e1 policy engine owns the cost decision: UNKNOWN hard-denied regardless of flags', policyEngine.evaluateRoutePolicy(
    { ...policyEngine.PRODUCTION_DEFAULTS, allowPaid: true, allowTrial: true, executionClass: 'LAB' },
    { costClass: 'UNKNOWN', risk: 'LOW' },
  ).allowed === false);
  const gate = typeof routerEngine.buildRouteCostGate === 'function' ? routerEngine.buildRouteCostGate({
    provider: 'p', model: 'm', costClass: 'PAID', policyDecision: null, now: 5,
  }) : null;
  probe('e2 engine: missing policy decision => fail-closed deny (COST_POLICY_UNAVAILABLE)', gate !== null && gate.allowed === false && gate.reasonCodes.includes('COST_POLICY_UNAVAILABLE'), gate === null ? 'engine export missing (pre-fix)' : jsonOf(gate));
  probe('e3 engine: UNKNOWN cost class never allowed even with a permissive-looking decision', typeof routerEngine.buildRouteCostGate === 'function' && routerEngine.buildRouteCostGate({
    provider: 'p', model: 'm', costClass: 'UNKNOWN', policyDecision: { allowed: true, reasonCodes: ['OK'] }, now: 5,
  }).allowed === false, typeof routerEngine.buildRouteCostGate === 'function' ? '' : 'engine export missing (pre-fix)');

  const host = await mkHost({ routerConfig: ROUTER_CANDIDATES, policyOverride: {} }); // policy WITHOUT evaluateRoute
  const paid = await host.fireAgentRequest(PAID_SEED);
  probe('e4 adapter: unusable policy service => deny (fail-closed), zero dispatches', paid.loopError !== null && paid.result.provider === '' && host.dispatchCount() === 0, `result=${jsonOf(paid.result)}`);
  probe('e5 fail-closed deny audited with COST_POLICY_UNAVAILABLE', host.eventsNamed('route_cost_denied').some((e) => e.fields.reason.includes('COST_POLICY_UNAVAILABLE')), jsonOf(host.eventsNamed('route_cost_denied')));
  host.dispose();
}

// ---------------------------------------------------------------------------
// [f] LAB contract unchanged: allowPaid=true with executionClass=LAB lets the
//     paid route through; production keeps denying (existing contract).
// ---------------------------------------------------------------------------
console.log('[f] LAB relief valve unchanged; production posture unchanged');
{
  const lab = await mkHost({ routerConfig: ROUTER_CANDIDATES, policyConfig: { executionClass: 'LAB', allowPaid: true } });
  const labPaid = await lab.fireAgentRequest(PAID_SEED);
  probe('f1 LAB + allowPaid: paid route allowed end-to-end (existing contract)', labPaid.dispatched === true && labPaid.result.provider === 'synthetic-paid' && lab.dispatchCount() === 1, `result=${jsonOf(labPaid.result)}`);
  probe('f2 LAB paid allow emits NO route_cost_denied', lab.eventsNamed('route_cost_denied').length === 0, jsonOf(lab.eventsNamed('route_cost_denied')));
  lab.dispose();
  const prod = null;
  let prodRejected = false;
  let prodError = null;
  try {
    // STANDARD + allowPaid=true must be rejected by the REAL policy config
    // validation (PolicyConfigError) — the plugin mount itself fails.
    await mkHost({ routerConfig: ROUTER_CANDIDATES, policyConfig: { executionClass: 'STANDARD', allowPaid: true } });
  } catch (error) {
    prodRejected = true;
    prodError = error;
  }
  probe('f3 STANDARD + allowPaid=true rejected by policy validation (fail-closed mount)', prodRejected && String(prodError).includes('allowPaid'), `err=${prodError?.message ?? 'mounted without error'}`);
  void prod;
}

// ---------------------------------------------------------------------------
// [g] v1.2 behavior preserved: effort pacing still rewrites reasoningEffort
//     on ALLOWED routes; route() service untouched.
// ---------------------------------------------------------------------------
console.log('[g] regression: v1.2 effort pacing + route() service intact');
{
  const host = await mkHost({
    routerConfig: { ...ROUTER_CANDIDATES, effortPacing: { enabled: true, byCostClass: { FREE_CONFIRMED: 'low', FREE_LIMITED: 'low', TRIAL: 'high', PAID: 'high', UNKNOWN: 'high' }, escalateOnVerifierFail: true } },
  });
  const paced = await host.root.events.waterfall(
    'agent/request',
    { agent: { session: { id: 's' } }, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ ...FREE_SEED, reasoningEffort: 'high' }),
  );
  probe('g1 allowed free route still gets effort pacing applied (high->low)', paced.provider === 'synthetic-free' && paced.reasoningEffort === 'low', jsonOf(paced));
  const service = host.root.get('supremeRouter');
  const decision = await service.route({ requiredCapabilities: ['chat'] });
  probe('g2 route() service still selects the free candidate', decision.provider === 'synthetic-free' && decision.blocked === null, jsonOf(decision));
  host.dispose();
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('V131_COST_FIX_VERIFIED — cost policy enforced pre-dispatch on every probed path; free/LAB usage intact');
  process.exit(0);
}
console.log(`V131_COST_FIX_VERIFICATION_FAILED — ${failures} probe(s) failed`);
process.exit(1);
