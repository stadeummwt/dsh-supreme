#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-memory-isolation.mjs — P1 fix gate for the v1.3.0
 * external-review finding: memory selections were SHARED on the plugin
 * instance ("latestSelection"), so concurrent/successive sessions received
 * each other's memory selections (cross-session contamination).
 *
 * Two modes:
 *   bun real/v131-memory-isolation.mjs repro   — demonstrate the BUG on the
 *     current code: session A selects memory; session B's prompt render (and a
 *     fresh unknown-identity request) receive A's selection. Exit 0 plus the
 *     marker V131_MEMORY_BUG_REPRODUCED iff contamination is present.
 *   bun real/v131-memory-isolation.mjs verify  — acceptance for the fix:
 *     (a) two interleaved sessions each receive ONLY their own selection
 *         (exact ownership asserted in both directions, incl. cross lookups);
 *     (b) a NEW/unknown identity gets NO stale selection (empty, fail-closed);
 *     (c) a task with no memory yields an empty section without errors;
 *     (d) cleanup on task end / cancel / session end / plugin dispose really
 *         empties the internal store (asserted via the ids/counts accessor);
 *     (e) the LRU cap is enforced (insert cap+5 ⇒ oldest evicted);
 *     (f) v1.2 bounds still hold (budget, secret exclusion, render char cap,
 *         instinct minConfidence/maxInjected/relevanceRanking);
 *     (g) opt-in shared project knowledge is still visible to every session
 *         that selects, while task-specific items stay isolated.
 *     Exit 0 plus the marker V131_MEMORY_FIX_VERIFIED only when ALL pass.
 *     Must FAIL on the original v1.3.0 code.
 *
 * Exercises the REAL code, not a simulation:
 *   - the REAL engine (src/plugins/supreme-memory-policy/engine.ts) imported
 *     directly by bun — no upstream build needed;
 *   - the REAL Cordis adapter (src/plugins/supreme-memory-policy/index.ts)
 *     mounted on the REAL pinned cordis (@deepseek-ai/cordis) — zod resolves
 *     the Config BEFORE apply; the REAL pinned seams are driven:
 *       systemPrompt.section()  (the conditional memory section renderer),
 *       session/disposed        (pinned emit cleanup seam),
 *       fiber.dispose()         (real Cordis unload — must clear the store),
 *     with a stub `sessions` and a capturing supremeObservability stub.
 *
 * NO upstream file is modified. No new npm dependencies. Deterministic only:
 * audit events are asserted to carry ids/counts and NEVER memory content.
 */
const ROOT = new URL('..', import.meta.url);
const engineHref = new URL('src/plugins/supreme-memory-policy/engine.ts', ROOT).href;
const adapterHref = new URL('src/plugins/supreme-memory-policy/index.ts', ROOT).href;

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

const mode = process.argv[2] ?? '';
if (mode !== 'repro' && mode !== 'verify') {
  console.error('usage: bun real/v131-memory-isolation.mjs <repro|verify>');
  process.exit(2);
}

// Memory CONTENT canaries: they may appear ONLY in a render owned by the
// session/task that selected them — never across sessions, never in audits.
const SHARED_CANARY = 'PROJECT_SHARED_KNOWLEDGE_canary';
// The task provider derives item text from taskText (see registerTaskProvider):
//   taskText 'alpha'     → 'LONGTERM_ALPHA'
//   taskText 'beta'      → 'LONGTERM_BETA'
//   taskText 'alpha-two' → 'LONGTERM_ALPHA_TWO'
const contentOf = (taskText) => `LONGTERM_${String(taskText).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

// ---------------------------------------------------------------------------
// Harness: mount the REAL adapter on the REAL pinned cordis. The systemPrompt
// stub captures registered sections so the test can drive the REAL renderer
// with the REAL pinned AssembleContext shape ({ agent, scope } — assembled by
// packages/core/agent/src/dispatch.ts:174 assembleContextFor(agent, signal)).
// ---------------------------------------------------------------------------
const mkHost = async (config = {}) => {
  const sections = [];
  const auditEvents = [];
  const root = new Context();
  root.provide('sessions', { create: () => ({ id: 'stub-session' }), list: () => [] });
  root.provide('systemPrompt', {
    section: (s) => { sections.push(s); return () => {}; },
  });
  root.provide('supremeObservability', {
    record: (event, fields) => auditEvents.push({ event, fields }),
  });
  const mod = await import(adapterHref);
  if (mod.name !== 'supreme-memory-policy') throw new Error('adapter module shape unexpected');
  await root.plugin(mod, config); // cordis resolves the REAL zod Config BEFORE apply
  const service = root.get('supremeMemoryPolicy');
  if (!service || typeof service.select !== 'function') {
    throw new Error('supremeMemoryPolicy service missing after mount');
  }
  const sectionDef = sections.find((s) => s.name === 'supreme-memory-context') ?? null;
  // Drive the REAL renderer exactly like the pinned agent loop would.
  const render = (assemblyContext) => {
    if (!sectionDef || typeof sectionDef.text !== 'function') return '';
    return sectionDef.text(assemblyContext);
  };
  const agentCtxOf = (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } }, scope: {} });
  const emitSessionDisposed = (sessionId) => root.emit('session/disposed', { id: sessionId });
  const stats = () => (typeof service.selectionStoreStats === 'function' ? service.selectionStoreStats() : null);
  const dispose = () => root.fiber.dispose();
  return { root, service, sections, auditEvents, render, agentCtxOf, emitSessionDisposed, stats, dispose };
};

// Long-term provider whose items are TASK-SPECIFIC (derived from taskText) so
// ownership can be asserted exactly — shared config knowledge is separate.
const registerTaskProvider = (service) => {
  service.registerLongTermProvider({
    name: 'isolation-verify-provider',
    status: 'AVAILABLE',
    list: ({ taskText, limit }) => [{
      id: `lt:${taskText}`,
      class: 'LONG_TERM',
      source: 'isolation-verify',
      text: contentOf(taskText),
      estimatedTokens: 8,
      priority: 80,
    }].slice(0, limit),
  });
};

const checks = [];
const probe = (name, ok, detail = '') => {
  checks.push({ name, ok: ok === true });
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};
const jsonOf = (value) => JSON.stringify(value);
const countPassed = () => checks.filter((c) => c.ok).length;
/** Run one probe section; a crash (e.g. a missing API on the ORIGINAL code)
 *  becomes a FAIL probe so every later section still reports. */
const runSection = async (label, fn) => {
  console.log(label);
  try {
    await fn();
  } catch (err) {
    probe(`section ran to completion — ${label}`, false, String(err));
  }
};

// ===========================================================================
// MODE: repro — demonstrate the v1.3.0 cross-session contamination bug.
// ===========================================================================
if (mode === 'repro') {
  console.log('== v1.3.1 memory isolation — REPRO on current code ==');
  const host = await mkHost({
    projectKnowledge: [{ id: 'proj:shared-1', text: SHARED_CANARY, priority: 60 }],
  });
  registerTaskProvider(host.service);

  // Session A selects memory for its task. On the v1.3.0 adapter the identity
  // args are ignored and the selection lands in ONE shared plugin-instance slot.
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });

  // Session B's prompt assembly renders now (interleaved sessions): the
  // renderer receives the REAL pinned AssembleContext for B's agent…
  const renderB = host.render(host.agentCtxOf('session-B'));
  // …and a fresh request with an unknown/absent identity renders too:
  const renderUnknown = host.render({});
  const renderNoContext = host.render(undefined);

  console.log(`  render(as session-B)      = "[memory:…] ${renderB.slice(0, 140)}`);
  console.log(`  render(unknown identity)  = "[memory:…] ${renderUnknown.slice(0, 140)}`);
  console.log(`  render(no context)        = "[memory:…] ${renderNoContext.slice(0, 140)}`);

  const contaminatedB = renderB.includes(contentOf('alpha'));
  const contaminatedUnknown = renderUnknown.includes(contentOf('alpha')) || renderNoContext.includes(contentOf('alpha'));

  if (contaminatedB || contaminatedUnknown) {
    if (contaminatedB) console.log('  BUG CONFIRMED: session B\'s render received session A\'s memory selection.');
    if (contaminatedUnknown) console.log('  BUG CONFIRMED: a request with unknown/missing identity received the stale previous selection.');
    console.log('V131_MEMORY_BUG_REPRODUCED');
    process.exit(0);
  }
  console.log('  No contamination observed: memory selection is session/task-scoped (fixed).');
  console.log('V131_MEMORY_BUG_NOT_REPRODUCED (fixed)');
  process.exit(1);
}

// ===========================================================================
// MODE: verify — acceptance for the fix. Must FAIL on the original v1.3.0.
// ===========================================================================
const engine = await import(engineHref);
console.log('== v1.3.1 memory isolation — VERIFY (REAL engine + REAL pinned-cordis adapter) ==');

// ---------------------------------------------------------------------------
// [E] Engine level — identity helpers + bounded LRU SelectionStore (pure).
// ---------------------------------------------------------------------------
await runSection('[E] engine: identity helpers + bounded LRU SelectionStore', async () => {
  probe('engine: SHARED_KNOWLEDGE_SCOPE exported as "project"', engine.SHARED_KNOWLEDGE_SCOPE === 'project', String(engine.SHARED_KNOWLEDGE_SCOPE));
  probe('engine: DEFAULT_SELECTION_STORE_CAP = 128 (documented cap)', engine.DEFAULT_SELECTION_STORE_CAP === 128, String(engine.DEFAULT_SELECTION_STORE_CAP));
  probe('engine: MIN_SELECTION_STORE_CAP = 8', engine.MIN_SELECTION_STORE_CAP === 8, String(engine.MIN_SELECTION_STORE_CAP));
  probe('identity: trims and accepts strings', engine.normalizeIdentityText?.('  s1 ') === 's1', String(engine.normalizeIdentityText?.('  s1 ')));
  probe('identity: empty/whitespace ⇒ null (unknown)', engine.normalizeIdentityText?.('') === null && engine.normalizeIdentityText?.('   ') === null, 'empty must be unknown');
  probe('identity: non-string ⇒ null', engine.normalizeIdentityText?.(42) === null && engine.normalizeIdentityText?.(undefined) === null && engine.normalizeIdentityText?.({}) === null, 'ids are strings only');
  probe('identity: both parts required', engine.identityOf?.({ sessionId: 's', taskId: '' }) === null && engine.identityOf?.({ sessionId: 's' }) === null, 'partial identity ⇒ unknown');

  if (typeof engine.identityKey === 'function') {
    probe('identityKey: deterministic + distinguishing', engine.identityKey({ sessionId: 'a', taskId: 'b' }) === engine.identityKey({ sessionId: 'a', taskId: 'b' }) && engine.identityKey({ sessionId: 'a', taskId: 'b' }) !== engine.identityKey({ sessionId: 'b', taskId: 'a' }), 'composite key must be exact');
  } else {
    probe('engine: identityKey present', false, 'missing on original code');
  }
  probe('cap clamp: undefined⇒128, 3⇒8, 8.9⇒8, 200⇒200', engine.clampSelectionStoreCap?.(undefined) === 128 && engine.clampSelectionStoreCap?.(3) === 8 && engine.clampSelectionStoreCap?.(8.9) === 8 && engine.clampSelectionStoreCap?.(200) === 200, 'deterministic clamping');

  if (typeof engine.SelectionStore === 'function') {
    const store = new engine.SelectionStore(4);
    const sel = (n) => ({ selected: [], excluded: [], totalEstimatedTokens: 0, budgetTokens: n, withinBudget: true, providerState: 'UNAVAILABLE' });
    for (const t of ['t1', 't2', 't3', 't4']) store.record({ sessionId: 's', taskId: t }, sel(1));
    probe('engine LRU: bounded at cap (4 entries)', store.stats().entries === 4, jsonOf(store.stats()));
    store.record({ sessionId: 's', taskId: 't5' }, sel(5));
    probe('engine LRU: insert beyond cap evicts the OLDEST (t1)', store.get({ sessionId: 's', taskId: 't1' }) === undefined && store.stats().entries === 4, jsonOf(store.stats()));
    probe('engine LRU: newest kept (t5 present)', store.get({ sessionId: 's', taskId: 't5' }) !== undefined, 't5 missing');
    store.get({ sessionId: 's', taskId: 't2' }); // touch t2 → refresh recency
    store.record({ sessionId: 's', taskId: 't6' }, sel(6));
    probe('engine LRU: read refreshes recency (t2 survives, t3 evicted)', store.get({ sessionId: 's', taskId: 't2' }) !== undefined && store.get({ sessionId: 's', taskId: 't3' }) === undefined, jsonOf(store.stats()));
    probe('engine LRU: evictions counted', store.stats().evictions === 2, jsonOf(store.stats()));
    store.releaseTask({ sessionId: 's', taskId: 't2' });
    probe('engine releaseTask removes the entry', store.get({ sessionId: 's', taskId: 't2' }) === undefined && store.stats().entries === 3, jsonOf(store.stats()));
    probe('engine releaseSession wipes the session', store.releaseSession('s') === 3 && store.stats().entries === 0 && store.stats().activeTasks === 0, jsonOf(store.stats()));
    store.record({ sessionId: 's', taskId: 'x' }, sel(1));
    probe('engine clear() empties everything', store.clear() === 1 && store.stats().entries === 0 && store.stats().activeTasks === 0, jsonOf(store.stats()));
    // Active-task pointer semantics (renderer binding).
    store.record({ sessionId: 's', taskId: 'a1' }, sel(1));
    store.record({ sessionId: 's', taskId: 'a2' }, sel(2));
    probe('engine active-task: last scoped select per session', store.activeTaskOf('s') === 'a2', 'active task must be the session\'s own last select');
    store.releaseTask({ sessionId: 's', taskId: 'a1' });
    probe('engine active-task: releasing a NON-active task keeps the pointer', store.activeTaskOf('s') === 'a2', 'older task release must not unset the newer active task');
    store.releaseTask({ sessionId: 's', taskId: 'a2' });
    probe('engine active-task: releasing the active task clears it (no fallback)', store.activeTaskOf('s') === undefined, 'no resurrection of older selections');
  } else {
    probe('engine: bounded SelectionStore present', false, 'missing on original code');
  }

  // v1.2 bounds at the engine level (untouched instinct gates).
  const notes = [
    { id: 'low', text: 'router scoring weights', tags: ['router'], priority: 90, confidence: 0.5, createdAt: 3, source: 'unit' },
    { id: 'rel', text: 'cost-first routing prefers free models', tags: ['router', 'cost'], priority: 40, confidence: 0.9, createdAt: 2, source: 'unit' },
    { id: 'p2', text: 'unrelated note about tests', tags: ['tests'], priority: 95, confidence: 0.9, createdAt: 1, source: 'unit' },
    { id: 'p3', text: 'another router note', tags: ['router'], priority: 20, confidence: 0.9, createdAt: 0, source: 'unit' },
    { id: 'p4', text: 'more router filler', tags: ['router'], priority: 10, confidence: 0.9, createdAt: 0, source: 'unit' },
    { id: 'p5', text: 'even more router filler', tags: ['router'], priority: 9, confidence: 0.9, createdAt: 0, source: 'unit' },
    { id: 'p6', text: 'router filler six', tags: ['router'], priority: 8, confidence: 0.9, createdAt: 0, source: 'unit' },
    { id: 'p7', text: 'router filler seven', tags: ['router'], priority: 7, confidence: 0.9, createdAt: 0, source: 'unit' },
  ];
  const instinct = engine.selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 6, relevanceRanking: true });
  probe('v1.2 bounds: minConfidence gate intact (0.5 note never injects)', !instinct.some((n) => n.id === 'low'), jsonOf(instinct.map((n) => n.id)));
  probe('v1.2 bounds: maxInjected cap intact (≤6)', instinct.length <= 6, String(instinct.length));
  probe('v1.2 bounds: relevance ranking intact (task-matching note first)', instinct[0]?.id === 'rel', String(instinct[0]?.id));
});

// ---------------------------------------------------------------------------
// [A] Adapter level — two interleaved sessions, exact ownership BOTH ways.
// ---------------------------------------------------------------------------
await runSection('[A] adapter: interleaved sessions receive ONLY their own selection', async () => {
  const host = await mkHost({});
  registerTaskProvider(host.service);
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });
  host.service.select({ taskText: 'beta', sessionId: 'session-B', taskId: 'task-B1' }); // interleaved
  const renderA = host.render(host.agentCtxOf('session-A'));
  const renderB = host.render(host.agentCtxOf('session-B'));
  probe('renderer(A) shows A\'s own selection', renderA.includes(contentOf('alpha')), renderA);
  probe('renderer(A) does NOT contain B\'s memory', !renderA.includes(contentOf('beta')), renderA);
  probe('renderer(B) shows B\'s own selection', renderB.includes(contentOf('beta')), renderB);
  probe('renderer(B) does NOT contain A\'s memory', !renderB.includes(contentOf('alpha')), renderB);
  probe('lookup(A,A1) returns exactly A\'s selection', host.service.lookup?.({ sessionId: 'session-A', taskId: 'task-A1' })?.selected?.[0]?.item?.text === contentOf('alpha'), 'A\'s own item missing');
  probe('lookup(B,B1) returns exactly B\'s selection', host.service.lookup?.({ sessionId: 'session-B', taskId: 'task-B1' })?.selected?.[0]?.item?.text === contentOf('beta'), 'B\'s own item missing');
  probe('cross-task lookup (A,B1) ⇒ null', host.service.lookup?.({ sessionId: 'session-A', taskId: 'task-B1' }) === null, 'must not return another task\'s selection');
  probe('cross-session lookup (B,A1) ⇒ null', host.service.lookup?.({ sessionId: 'session-B', taskId: 'task-A1' }) === null, 'must not return another session\'s selection');
  host.dispose();
});

// Successive selects for one session never disturb the other; releasing a
// task never resurrects an older selection of the same session.
await runSection('[A2] adapter: successive tasks stay isolated; release never resurrects', async () => {
  const host = await mkHost({});
  registerTaskProvider(host.service);
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });
  host.service.select({ taskText: 'beta', sessionId: 'session-B', taskId: 'task-B1' });
  host.service.select({ taskText: 'alpha-two', sessionId: 'session-A', taskId: 'task-A2' });
  probe('renderer(B) unaffected by A\'s second task', host.render(host.agentCtxOf('session-B')).includes(contentOf('beta')), 'B lost its own selection');
  probe('renderer(A) follows A\'s active task (A2)', host.render(host.agentCtxOf('session-A')).includes(contentOf('alpha-two')), 'A2 missing');
  const released = host.service.releaseTask?.({ sessionId: 'session-A', taskId: 'task-A1' });
  probe('releaseTask(old A1) removes exactly that entry', released === true && host.service.lookup?.({ sessionId: 'session-A', taskId: 'task-A1' }) === null, 'A1 still present');
  probe('releasing a NON-active task keeps the active render', host.render(host.agentCtxOf('session-A')).includes(contentOf('alpha-two')), 'active render lost');
  host.service.releaseTask?.({ sessionId: 'session-A', taskId: 'task-A2' });
  probe('releasing the ACTIVE task ⇒ empty render (no fallback to A1)', host.render(host.agentCtxOf('session-A')) === '', host.render(host.agentCtxOf('session-A')));
  probe('renderer(B) still owns its selection after A cleanup', host.render(host.agentCtxOf('session-B')).includes(contentOf('beta')), 'B lost its selection');
  host.dispose();
});

// ---------------------------------------------------------------------------
// [B] Unknown/missing identity ⇒ EMPTY (fail-closed), never stale state.
// ---------------------------------------------------------------------------
await runSection('[B] adapter: unknown/missing identity ⇒ empty, never the latest selection', async () => {
  const host = await mkHost({});
  registerTaskProvider(host.service);
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });
  probe('renderer with NO agent context ⇒ ""', host.render({}) === '', host.render({}));
  probe('renderer with undefined context ⇒ ""', host.render(undefined) === '', 'must not throw nor render');
  probe('renderer for a NEVER-SELECTED session ⇒ ""', host.render(host.agentCtxOf('session-C')) === '', host.render(host.agentCtxOf('session-C')));
  probe('renderer for diagnostics-style context (scope only) ⇒ ""', host.render({ scope: {} }) === '', host.render({ scope: {} }));
  probe('lookup(unknown) ⇒ null', host.service.lookup?.({ sessionId: 'session-X', taskId: 'task-X' }) === null, 'must not return stale state');
  const before = host.stats() ? host.stats().entries : -1;
  const transient = host.service.select({ taskText: 'gate-driver-style', budgetTokens: 400 });
  probe('select WITHOUT identity still returns a full selection (v1.2 contract)', Array.isArray(transient.selected) && typeof transient.budgetTokens === 'number' && transient.withinBudget === true, jsonOf(transient?.budgetTokens));
  probe('select WITHOUT identity stores NOTHING (entries unchanged)', host.stats() !== null && host.stats().entries === before, `before=${before} after=${host.stats()?.entries}`);
  probe('select WITHOUT identity changes NO session render', host.render(host.agentCtxOf('session-A')).includes(contentOf('alpha')) && host.render(host.agentCtxOf('session-Z')) === '', 'transient select leaked into a render');
  host.dispose();
});

// ---------------------------------------------------------------------------
// [C] Task with no memory ⇒ empty section, no error.
// ---------------------------------------------------------------------------
await runSection('[C] adapter: task with no memory ⇒ empty section, no error', async () => {
  const host = await mkHost({}); // no projectKnowledge, NO provider registered
  let threw = null;
  let emptySelection = null;
  try {
    emptySelection = host.service.select({ taskText: 'a real task with no candidates', sessionId: 'session-D', taskId: 'task-D1' });
  } catch (err) {
    threw = err;
  }
  probe('select with zero candidates does not throw', threw === null, String(threw));
  probe('selection is empty but well-formed', emptySelection?.selected?.length === 0 && emptySelection?.withinBudget === true, jsonOf(emptySelection));
  probe('renderer renders "" for the empty selection', host.render(host.agentCtxOf('session-D')) === '', host.render(host.agentCtxOf('session-D')));
  let threwEmptyTask = null;
  try {
    host.service.select({ taskText: '', sessionId: 'session-D', taskId: 'task-D2' }); // needsMemory ⇒ NO_TASK
  } catch (err) {
    threwEmptyTask = err;
  }
  probe('empty taskText (NO_TASK) does not throw', threwEmptyTask === null, String(threwEmptyTask));
  probe('NO_TASK selection renders ""', host.render(host.agentCtxOf('session-D')) === '', 'non-empty render for NO_TASK');
  host.dispose();
});

// ---------------------------------------------------------------------------
// [D] Cleanup: task end / cancel / session end / explicit releaseAll REALLY
//     empty the internal store (asserted via the ids/counts accessor).
// ---------------------------------------------------------------------------
await runSection('[D] adapter: cleanup empties internal state (task end / cancel / session end)', async () => {
  const host = await mkHost({});
  registerTaskProvider(host.service);
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });
  host.service.select({ taskText: 'beta', sessionId: 'session-B', taskId: 'task-B1' });
  const entriesBefore = host.stats().entries;
  probe('stats accessor exists (ids/counts only)', entriesBefore === 2 && host.stats().activeTasks === 2, jsonOf(host.stats()));

  // Task end (explicit releaseTask).
  const removedTask = host.service.releaseTask?.({ sessionId: 'session-A', taskId: 'task-A1' });
  probe('releaseTask(task end) returns true and empties that entry', removedTask === true && host.stats().entries === entriesBefore - 1 && host.service.lookup?.({ sessionId: 'session-A', taskId: 'task-A1' }) === null, jsonOf(host.stats()));
  probe('releaseTask is idempotent (second call ⇒ false)', host.service.releaseTask?.({ sessionId: 'session-A', taskId: 'task-A1' }) === false, 'double release must be a no-op');
  probe('render for the released task ⇒ ""', host.render(host.agentCtxOf('session-A')) === '', 'stale render after release');

  // Cancel = the same explicit release path (agent cancel ⇒ host releases).
  host.service.select({ taskText: 'alpha-cancelled', sessionId: 'session-A', taskId: 'task-A2' });
  const cancelled = host.service.releaseTask?.({ sessionId: 'session-A', taskId: 'task-A2' });
  probe('cancel path (releaseTask) empties the cancelled task', cancelled === true && host.service.lookup?.({ sessionId: 'session-A', taskId: 'task-A2' }) === null && host.render(host.agentCtxOf('session-A')) === '', jsonOf(host.stats()));

  // Session end via the REAL pinned session/disposed emit seam.
  host.emitSessionDisposed('session-B');
  probe('session/disposed releases the whole session', host.stats().entries === 0 && host.stats().activeTasks === 0, jsonOf(host.stats()));
  probe('render for the disposed session ⇒ ""', host.render(host.agentCtxOf('session-B')) === '', 'stale render after session disposal');
  probe('releaseSession after dispose is a 0-count no-op', host.service.releaseSession?.('session-B') === 0, 'nothing left to release');

  // Explicit releaseAll (host-invoked).
  host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A3' });
  host.service.select({ taskText: 'beta', sessionId: 'session-B', taskId: 'task-B2' });
  const removedAll = host.service.releaseAll?.();
  probe('releaseAll empties everything and returns the count', removedAll === 2 && host.stats().entries === 0 && host.stats().activeTasks === 0, jsonOf(host.stats()));
  host.dispose();
});

await runSection('[D2] adapter: plugin dispose clears the WHOLE map', async () => {
  const host = await mkHost({});
  registerTaskProvider(host.service);
  for (let i = 0; i < 5; i++) {
    host.service.select({ taskText: `t${i}`, sessionId: `session-${i}`, taskId: `task-${i}` });
  }
  probe('pre-dispose: 5 entries stored', host.stats().entries === 5, jsonOf(host.stats()));
  // REAL cordis fiber dispose → effect disposers unwind. Pinned-cordis
  // (vendor/cordis/src/fiber.ts) unwinds disposers ASYNCHRONOUSLY during the
  // unload it starts synchronously (async disposers are first-class: the
  // unload awaits them), so the post-dispose assertions below must observe
  // the store AFTER the REAL dispose settles — exactly how real/boot.mjs and
  // the other repo verifiers await ctx.fiber.dispose().
  await host.dispose();
  const after = host.stats();
  probe('post-dispose: internal map size 0 (entries=0, activeTasks=0)', after.entries === 0 && after.activeTasks === 0, jsonOf(after));
  probe('post-dispose: lookups stay empty', host.service.lookup?.({ sessionId: 'session-0', taskId: 'task-0' }) === null, 'stale state after dispose');
});

// ---------------------------------------------------------------------------
// [F] LRU cap enforced through the ADAPTER config (insert cap+5 ⇒ oldest out).
// ---------------------------------------------------------------------------
await runSection('[F] adapter: bounded store — insert cap+5, oldest evicted', async () => {
  const CAP = 8;
  const host = await mkHost({ selectionStoreCap: CAP });
  registerTaskProvider(host.service);
  for (let i = 0; i < CAP + 5; i++) {
    host.service.select({ taskText: `task-${i}`, sessionId: 'session-cap', taskId: `task-${i}` });
  }
  const stats = host.stats();
  probe(`store bounded at cap=${CAP} after ${CAP + 5} inserts`, stats.entries === CAP, jsonOf(stats));
  probe('evictions counted (≥5)', stats.evictions >= 5, jsonOf(stats));
  probe('OLDEST entries evicted (task-0 … task-4 gone)', [0, 1, 2, 3, 4].every((i) => host.service.lookup?.({ sessionId: 'session-cap', taskId: `task-${i}` }) === null), 'oldest not evicted');
  probe('NEWEST entries kept (task-5 … task-12 present)', [5, 6, 7, 8, 9, 10, 11, 12].every((i) => host.service.lookup?.({ sessionId: 'session-cap', taskId: `task-${i}` }) !== null), 'newest missing');
  probe('active-task map also bounded (≤ cap)', stats.activeTasks <= CAP, jsonOf(stats));
  host.dispose();
});

// ---------------------------------------------------------------------------
// [G] v1.2 bounds still respected through the scoped path.
// ---------------------------------------------------------------------------
await runSection('[G] adapter: v1.2 bounds intact (budget, secrets, render cap)', async () => {
  const host = await mkHost({ projectKnowledge: [{ id: 'proj:big', text: 'K'.repeat(9000), priority: 60 }] });
  host.service.registerLongTermProvider({
    name: 'bounds-provider',
    status: 'AVAILABLE',
    list: () => [
      { id: 'big-a', class: 'LONG_TERM', source: 'bounds', text: 'x'.repeat(240), estimatedTokens: 60, priority: 80 },
      { id: 'big-b', class: 'LONG_TERM', source: 'bounds', text: 'y'.repeat(240), estimatedTokens: 60, priority: 70 },
      { id: 'leak', class: 'LONG_TERM', source: 'bounds', text: 'api key: sk-abcdef1234567890', estimatedTokens: 8, priority: 99 },
    ],
  });
  // Budget + secret bounds (same as the v1.2 gate-driver gate, now scoped).
  const scoped = host.service.select({ taskText: 'bounds task', budgetTokens: 100, sessionId: 'session-G', taskId: 'task-G1' });
  probe('budget still enforced on a scoped selection (≤100 tokens)', scoped.totalEstimatedTokens <= 100 && scoped.withinBudget === true, jsonOf(scoped.totalEstimatedTokens));
  probe('secret exclusion still enforced (SECRET_CATEGORY)', scoped.excluded.some((e) => e.id === 'leak' && e.reason === 'SECRET_CATEGORY') && scoped.selected.every((s) => s.item.id !== 'leak'), jsonOf(scoped.excluded));
  const renderedBudget = host.render(host.agentCtxOf('session-G'));
  probe('render never carries the secret value', !renderedBudget.includes('sk-abcdef1234567890'), 'secret leaked into prompt section');
  // Render char cap (v1.2: defaultBudgetTokens * 4).
  host.service.select({ taskText: 'bounds task big', budgetTokens: 3000, sessionId: 'session-G', taskId: 'task-G2' });
  const renderedBig = host.render(host.agentCtxOf('session-G'));
  probe('render still capped at defaultBudgetTokens*4 chars', renderedBig.length > 0 && renderedBig.length <= 2048 * 4, String(renderedBig.length));
  host.dispose();
});

// ---------------------------------------------------------------------------
// [H] Shared project knowledge: opt-in namespace visible across sessions BY
//     DESIGN; task-specific items never cross. Audit events stay value-free.
// ---------------------------------------------------------------------------
await runSection('[H] shared project knowledge across sessions + value-free audit', async () => {
  const host = await mkHost({
    projectKnowledge: [{ id: 'proj:shared-1', text: SHARED_CANARY, priority: 60 }],
  });
  registerTaskProvider(host.service);
  const selA = host.service.select({ taskText: 'alpha', sessionId: 'session-A', taskId: 'task-A1' });
  const selB = host.service.select({ taskText: 'beta', sessionId: 'session-B', taskId: 'task-B1' });
  probe('shared knowledge present in A\'s OWN selection (by design)', selA.selected.some((s) => s.item.id === 'proj:shared-1'), jsonOf(selA.selected.map((s) => s.item.id)));
  probe('shared knowledge present in B\'s OWN selection (by design)', selB.selected.some((s) => s.item.id === 'proj:shared-1'), jsonOf(selB.selected.map((s) => s.item.id)));
  const renderA = host.render(host.agentCtxOf('session-A'));
  const renderB = host.render(host.agentCtxOf('session-B'));
  probe('renderer(A): shared canary + A item, NEVER B item', renderA.includes(SHARED_CANARY) && renderA.includes(contentOf('alpha')) && !renderA.includes(contentOf('beta')), renderA);
  probe('renderer(B): shared canary + B item, NEVER A item', renderB.includes(SHARED_CANARY) && renderB.includes(contentOf('beta')) && !renderB.includes(contentOf('alpha')), renderB);
  const shared = host.service.sharedKnowledge?.();
  probe('sharedKnowledge() exposes the explicit project namespace', shared?.length === 1 && shared[0].id === 'proj:shared-1' && shared[0].class === 'PROJECT_CONTEXT', jsonOf(shared?.map((s) => s.id)));
  probe('fresh session renders "" (shared ≠ bypass)', host.render(host.agentCtxOf('session-FRESH')) === '', 'shared knowledge must flow through the session\'s own select');
  const auditJson = jsonOf(host.auditEvents);
  probe('audit events exist (scoped lifecycle)', host.auditEvents.length > 0 && host.auditEvents.some((e) => e.event === 'memory_selection_scoped'), jsonOf(host.auditEvents.map((e) => e.event)));
  probe('audit events carry ids/counts ONLY — NO memory content', !auditJson.includes(SHARED_CANARY) && !auditJson.includes(contentOf('alpha')) && !auditJson.includes(contentOf('beta')), 'memory content leaked into audit');
  probe('audit events do carry the identity ids', auditJson.includes('session-A') && auditJson.includes('task-A1'), 'expected ids in audit detail');
  host.dispose();
});

// ---------------------------------------------------------------------------
// [S] Service surface — the v1.3.1 scoping APIs exist on the REAL service.
// ---------------------------------------------------------------------------
await runSection('[S] service surface: scoping + release + stats APIs present', async () => {
  const host = await mkHost({});
  const svc = host.service;
  probe('service.lookup is a function', typeof svc.lookup === 'function', String(typeof svc.lookup));
  probe('service.releaseTask is a function', typeof svc.releaseTask === 'function', String(typeof svc.releaseTask));
  probe('service.releaseSession is a function', typeof svc.releaseSession === 'function', String(typeof svc.releaseSession));
  probe('service.releaseAll is a function', typeof svc.releaseAll === 'function', String(typeof svc.releaseAll));
  probe('service.selectionStoreStats is a function (ids/counts only)', typeof svc.selectionStoreStats === 'function' && !('selected' in (svc.selectionStoreStats() ?? {})), String(typeof svc.selectionStoreStats));
  probe('service.sharedKnowledge is a function', typeof svc.sharedKnowledge === 'function', String(typeof svc.sharedKnowledge));
  probe('default cap wired to the documented 128', svc.selectionStoreStats().capacity === 128, jsonOf(svc.selectionStoreStats()));
  probe('v1.2 surface kept: select/ledger/ownership methods intact', typeof svc.ledgerSelect === 'function' && typeof svc.ledgerAppend === 'function' && svc.sessionHistoryOwner() === 'DSH_CTX_SESSIONS', 'v1.2 surface changed');
  host.dispose();
});

const total = checks.length;
const passed = countPassed();
console.log(`\n${passed}/${total} probes passed`);
if (passed !== total) {
  console.log('FAILED:');
  for (const c of checks.filter((x) => !x.ok)) console.log(`  - ${c.name}`);
  console.log('V131_MEMORY_FIX_NOT_VERIFIED');
  process.exit(1);
}
console.log('V131_MEMORY_FIX_VERIFIED');
process.exit(0);
