#!/usr/bin/env bun
/**
 * dsh-supreme/real/bench-v131.mjs — v1.3.1 A/B/C benchmark runner (review §5).
 *
 * Measures the POLICY ENFORCEMENT DELTA between three trees on one synthetic
 * host — it does NOT measure model quality or "intelligence":
 *
 *   A = DSH harness WITHOUT Supreme plugins (same synthetic host, nothing
 *       mounted) — the enforcement baseline.
 *   B = Supreme BEFORE the review patches (v1.3.0 content).
 *   C = Supreme AFTER the patches (v1.3.1, current tree).
 *
 * (D = Astra reference: NOT_RUN — no valid Astra data exists in this repo or
 * environment; the label is reported exactly as NOT_RUN and never fabricated.)
 *
 * Mounting: the REAL plugin adapters (src/plugins/<name>/index.ts) of
 * supreme-observability, supreme-policy, supreme-verifier, supreme-router,
 * supreme-memory-policy and supreme-workflow-policy are mounted on the REAL
 * pinned cordis (@deepseek-ai/cordis) with the zod Config resolved BEFORE
 * apply — the identical mounting pattern to real/v131-*.mjs. For label A the
 * SAME host is built with NOTHING mounted.
 *
 * Version-stable surfaces ONLY (all verified present with identical shapes in
 * both the v1.3.0 and v1.3.1 trees):
 *   - ctx waterfalls: agent/request, llm/stream, tools/pre-execute
 *   - ctx emit:       subagent/start (identical DEFENSIVE detect-only handler in both trees)
 *   - service methods that exist in BOTH trees: verifier.register/run,
 *     memory.select/registerLongTermProvider (+ the 'supreme-memory-context'
 *     systemPrompt section; v1.3.0's text() ignores the identity argument,
 *     v1.3.1's uses it — the SAME call drives both),
 *     router/policy via the seams above.
 *   Anything uncertain is feature-detected with typeof guards and reported
 *   `n/a` instead of crashing.
 *
 * Scenario kinds (each = adversarial probe + benign sibling), driven from
 * datasets/bench/scenarios.{dev,heldout}.json — structural expectations only,
 * no per-tree verdicts are ever hardcoded:
 *   cost_enforcement   paid/unknown-model dispatch attempts -> BYPASS if the
 *                      adapter dispatch count > 0; benign free dispatch must
 *                      succeed on its FIRST attempt.
 *   memory_isolation   two interleaved sessions -> contamination event if the
 *                      OTHER session's marker is visible in a render; benign
 *                      own-selection render success. (A: service absent -> n/a.)
 *   verifier_symlink   out-of-root symlink verify -> ESCAPE if PASS verdict;
 *                      benign in-root file verify success. (A: n/a.)
 *   a2a_false_deny     benign copy_file {target} -> FALSE_DENY if denied;
 *                      benign in-graph agent contact success.
 *   schema_false_pass  extra-properties object vs additionalProperties:false
 *                      -> FALSE_PASS if PASS. (A: n/a.)
 *
 * Thresholds are read from benchmarks/THRESHOLDS-v1.3.1.json (written BEFORE
 * any run) and PASS/FAIL is printed per threshold. The noSafetyRegression
 * check compares this run's per-kind adversarial escape counts against a
 * previously saved run via --compare <json> (used for C vs B).
 *
 * CLI: bun real/bench-v131.mjs --label <A|B|C> --out <json-path> [--reps 3] [--compare <json>]
 *
 * Offline, deterministic, no network, no paid/model calls, synthetic fixtures
 * only, tempdirs cleaned up. NO upstream file is modified. No new dependencies.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RUNNER_VERSION = 'bench-v131-1';
const ROOT = new URL('..', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const LABEL = argOf('--label');
const OUT = argOf('--out');
const COMPARE = argOf('--compare');
const REPS = Math.max(1, Number.parseInt(argOf('--reps') ?? '3', 10) || 3);

if (LABEL !== 'A' && LABEL !== 'B' && LABEL !== 'C') {
  console.error('usage: bun real/bench-v131.mjs --label <A|B|C> --out <json-path> [--reps 3] [--compare <prev-json>]');
  process.exit(2);
}
if (!OUT) {
  console.error('--out <json-path> is required');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Datasets (identical across trees) + thresholds (written BEFORE any run)
// ---------------------------------------------------------------------------
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readDataset = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8'));

const DEV = readDataset('datasets/bench/scenarios.dev.json');
const HELD = readDataset('datasets/bench/scenarios.heldout.json');
if (DEV.datasetVersion !== HELD.datasetVersion) {
  throw new Error(`dataset version mismatch: dev=${DEV.datasetVersion} heldout=${HELD.datasetVersion}`);
}
if (DEV.split !== 'dev' || HELD.split !== 'heldout') {
  throw new Error(`dataset split fields wrong: dev=${DEV.split} heldout=${HELD.split}`);
}
const DATASET_VERSION = DEV.datasetVersion;
const SCENARIOS = [...DEV.scenarios, ...HELD.scenarios];

const THRESHOLDS_PATH = fileURLToPath(new URL('benchmarks/THRESHOLDS-v1.3.1.json', ROOT));
const THRESHOLDS = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8'));
const THRESHOLDS_SHA = sha256Bytes(readFileSync(THRESHOLDS_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Tree identity: git rev-parse of the tree the runner executes in
// ---------------------------------------------------------------------------
let treeSha = 'unknown';
try {
  treeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_PATH, encoding: 'utf8' }).trim();
} catch {
  treeSha = 'unknown (git unavailable)';
}

// ---------------------------------------------------------------------------
// REAL pinned cordis (node_modules resolution first, vendored pinned fallback —
// identical to the other v131 verifiers).
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
// REAL plugin adapters (imported directly by bun; only trees with the plugins
// mounted need them — label A imports nothing from src/plugins).
// ---------------------------------------------------------------------------
const PLUGIN_SPECS = {
  observability: ['src/plugins/supreme-observability/index.ts', 'supreme-observability'],
  policy: ['src/plugins/supreme-policy/index.ts', 'supreme-policy'],
  verifier: ['src/plugins/supreme-verifier/index.ts', 'supreme-verifier'],
  router: ['src/plugins/supreme-router/index.ts', 'supreme-router'],
  memory: ['src/plugins/supreme-memory-policy/index.ts', 'supreme-memory-policy'],
  workflow: ['src/plugins/supreme-workflow-policy/index.ts', 'supreme-workflow-policy'],
};
const plugins = {};
if (LABEL !== 'A') {
  for (const [key, [path, name]] of Object.entries(PLUGIN_SPECS)) {
    const mod = await import(new URL(path, ROOT).href);
    if (mod.name !== name) throw new Error(`adapter ${key}: module shape unexpected (name=${String(mod.name)})`);
    plugins[key] = mod;
  }
}

// ---------------------------------------------------------------------------
// configFingerprint: sha256 over the SHARED bench design (datasets +
// thresholds bytes + runner version + drivers + stub services). Identical
// across labels — proving the harness config is the same; only the mounted
// plugin code differs (recorded separately as mountedPlugins).
// ---------------------------------------------------------------------------
const configFingerprint = sha256Bytes(JSON.stringify({
  runnerVersion: RUNNER_VERSION,
  datasetVersion: DATASET_VERSION,
  scenarioIds: SCENARIOS.map((s) => s.id),
  thresholdsSha: THRESHOLDS_SHA,
  stubServices: ['llm', 'supremeBenchmark', 'sessions', 'systemPrompt', 'subagents', 'workflowEngine'],
  drivers: ['agent/request', 'llm/stream', 'tools/pre-execute', 'subagent/start', 'systemPrompt.section(text)'],
}));

// ---------------------------------------------------------------------------
// Harness host (mounting pattern identical to real/v131-failure-injection.mjs).
// Label A: NOTHING mounted — same stub DSH services, empty context.
// ---------------------------------------------------------------------------
const stubStream = async function* () {
  yield { type: 'text-start', index: 0 };
  yield { type: 'text-delta', index: 0, delta: 'ok' };
  yield { type: 'finish', reason: { kind: 'completed' } };
};

const mkHost = async ({ dataDir, llm, routerConfig = { candidates: [] }, memoryConfig = {}, verifierConfig = {}, workflowConfig = {} } = {}) => {
  const root = new Context();
  // Stub DSH services the plugins consume (structural views; same set as the
  // v131 verifiers use). Present in EVERY label so the DRIVERS are identical.
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

  if (LABEL !== 'A') {
    await root.plugin(plugins.observability, { enabled: true, dataDir, fileName: 'observability.jsonl' });
    await root.plugin(plugins.policy, {});
    await root.plugin(plugins.verifier, verifierConfig);
    await root.plugin(plugins.router, routerConfig);
    await root.plugin(plugins.memory, memoryConfig);
    await root.plugin(plugins.workflow, workflowConfig);
  }

  // Feature-detected services (typeof guards — absent on label A => n/a).
  const svc = (name) => {
    try {
      const s = root.get(name);
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  };
  const services = {
    verifier: svc('supremeVerifier'),
    memory: svc('supremeMemoryPolicy'),
    workflow: svc('supremeWorkflowPolicy'),
    router: svc('supremeRouter'),
    policy: svc('supremePolicy'),
  };
  const memorySection = sections.find((s) => s?.name === 'supreme-memory-context') ?? null;
  const renderMemory = (assemblyContext) =>
    memorySection && typeof memorySection.text === 'function' ? memorySection.text(assemblyContext) : null;

  return {
    root,
    services,
    renderMemory,
    agentCtxOf: (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } }, scope: {} }),
    dispose: async () => { await root.fiber.dispose(); },
  };
};

// --- pinned-seam drivers (identical to the v131 verifiers) -------------------
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

const fireLlmStream = async (root, options, counter) => {
  let error = null;
  let chunks = 0;
  let dispatched = false;
  try {
    const stream = await root.events.waterfall('llm/stream', options, () => {
      counter.total += 1; // the innermost next() IS the adapter dispatch
      dispatched = true;
      return stubStream();
    });
    for await (const chunk of stream) chunks += 1;
  } catch (caught) {
    error = caught;
  }
  return { error, chunks, dispatched };
};

const fireToolPreExecute = async (root, exec) => {
  let executed = 0;
  let decision = null;
  let error = null;
  try {
    decision = await root.events.waterfall('tools/pre-execute', exec, () => {
      executed += 1;
      return Promise.resolve({ kind: 'allow' });
    });
  } catch (caught) {
    error = caught;
  }
  return { decision, executed, error };
};

const sha256Of = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// Scenario runners — verdicts COMPUTED from observed behavior, never from
// per-tree expectations. Each returns:
//   { id, kind, split, applicable, adversarialEscapes, benignSuccess, notes }
// ---------------------------------------------------------------------------
const naResult = (sc, why) => ({
  id: sc.id, kind: sc.kind, split: sc.split,
  applicable: false, adversarialEscapes: 0, benignSuccess: null,
  notes: [`n/a: ${why}`],
});

const runCostScenario = async (sc, mk, baseDir) => {
  const inp = sc.input;
  const counter = { total: 0 };
  const host = await mk({
    dataDir: baseDir,
    routerConfig: JSON.parse(JSON.stringify({ candidates: inp.routerCandidates })),
    llm: {
      listProviders: () => [...inp.catalogProviders],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, context: { contextWindow: 32768 } }),
    },
  });
  try {
    // BENIGN sibling FIRST: free dispatch must succeed on its FIRST attempt.
    let benignSuccess = false;
    const benignNote = [];
    if (inp.benign.via === 'agent/request') {
      const r = await fireAgentRequest(host.root, inp.benign.seed, 'bench-benign-session');
      benignSuccess = r.dispatched === true && r.loopError === null
        && r.result.provider === inp.benign.seed.provider && r.result.model === inp.benign.seed.model;
      if (!benignSuccess) benignNote.push(`benign agent/request: dispatched=${r.dispatched} err=${r.loopError?.message ?? 'none'}`);
    } else {
      const r = await fireLlmStream(host.root, { ...inp.benign.seed, messages: [], sessionId: 'bench-benign-session', signal: new AbortController().signal }, counter);
      benignSuccess = r.error === null && r.dispatched === true && r.chunks > 0;
      if (!benignSuccess) benignNote.push(`benign llm/stream: err=${r.error?.message ?? 'none'} dispatched=${r.dispatched}`);
    }

    // ADVERSARIAL: paid/unknown-model attempts — BYPASS iff the adapter
    // dispatch happens (dispatch counter > 0 or the stream receiver ran).
    let bypasses = 0;
    const bypassNotes = [];
    for (const adv of inp.adversarial) {
      if (adv.via === 'agent/request') {
        const r = await fireAgentRequest(host.root, adv.seed, 'bench-adv-session');
        if (r.dispatched) {
          bypasses += 1;
          bypassNotes.push(`${adv.seed.provider}/${adv.seed.model} via agent/request DISPATCHED`);
        }
      } else {
        const r = await fireLlmStream(host.root, { ...adv.seed, messages: [], sessionId: 'bench-adv-session', signal: new AbortController().signal }, counter);
        if (r.dispatched) {
          bypasses += 1;
          bypassNotes.push(`${adv.seed.provider}/${adv.seed.model} via llm/stream DISPATCHED`);
        }
      }
    }
    return {
      id: sc.id, kind: sc.kind, split: sc.split,
      applicable: true,
      adversarialEscapes: bypasses,
      benignSuccess,
      notes: [...benignNote, ...bypassNotes],
    };
  } finally {
    await host.dispose();
  }
};

const runMemoryScenario = async (sc, mk, baseDir) => {
  const inp = sc.input;
  const host = await mk({
    dataDir: baseDir,
    memoryConfig: { projectKnowledge: [], registerPromptSection: true },
    routerConfig: { candidates: [] },
  });
  try {
    const mem = host.services.memory;
    if (!mem || typeof mem.select !== 'function' || typeof mem.registerLongTermProvider !== 'function') {
      return naResult(sc, 'supremeMemoryPolicy service absent (label A: plugins not mounted)');
    }
    if (host.renderMemory(host.agentCtxOf('__probe__')) === null) {
      return naResult(sc, 'supreme-memory-context systemPrompt section not registered');
    }
    // Long-term provider built from the DATASET items (deterministic).
    const items = inp.longTermItems;
    mem.registerLongTermProvider({
      name: 'bench-longterm-provider',
      status: 'AVAILABLE',
      list: ({ taskText, limit }) => items
        .filter((it) => it.matchTaskText === taskText)
        .map((it) => ({
          id: `bench:${it.matchTaskText.length}:${it.matchTaskText.slice(0, 24)}`,
          class: 'LONG_TERM',
          source: 'bench-longterm-provider',
          text: it.text,
          estimatedTokens: 16,
          priority: 80,
        }))
        .slice(0, limit),
    });

    const [s0, s1] = inp.sessions;
    const notes = [];
    // select s0 -> own render (benign), select s1 -> own render (benign),
    // re-render s0 -> contamination iff s1's marker appears.
    mem.select({ taskText: s0.taskText, sessionId: s0.sessionId, taskId: s0.taskId });
    const own0 = host.renderMemory(host.agentCtxOf(s0.sessionId)) ?? '';
    const benign0 = typeof own0 === 'string' && own0.includes(s0.marker);
    mem.select({ taskText: s1.taskText, sessionId: s1.sessionId, taskId: s1.taskId });
    const own1 = host.renderMemory(host.agentCtxOf(s1.sessionId)) ?? '';
    const benign1 = typeof own1 === 'string' && own1.includes(s1.marker);
    const cross0 = host.renderMemory(host.agentCtxOf(s0.sessionId)) ?? '';
    const cross1 = host.renderMemory(host.agentCtxOf(s1.sessionId)) ?? '';
    const contamination = (typeof cross0 === 'string' && cross0.includes(s1.marker))
      || (typeof cross1 === 'string' && cross1.includes(s0.marker));
    if (contamination) notes.push(`contamination: render(s0) has s1 marker=${cross0.includes(s1.marker)}, render(s1) has s0 marker=${cross1.includes(s0.marker)}`);
    if (!benign0 || !benign1) notes.push(`benign own-render miss: own0=${JSON.stringify(own0.slice(0, 60))} own1=${JSON.stringify(own1.slice(0, 60))}`);
    return {
      id: sc.id, kind: sc.kind, split: sc.split,
      applicable: true,
      adversarialEscapes: contamination ? 1 : 0,
      benignSuccess: benign0 && benign1,
      notes,
    };
  } finally {
    await host.dispose();
  }
};

const runSymlinkScenario = async (sc, mk, baseDir) => {
  const inp = sc.input;
  const host = await mk({
    dataDir: baseDir,
    verifierConfig: { allowCommands: false, allowNetwork: false, allowedRoots: [join(baseDir, 'root')], commandTimeoutMs: 1000 },
    routerConfig: { candidates: [] },
  });
  try {
    const verifier = host.services.verifier;
    if (!verifier || typeof verifier.register !== 'function' || typeof verifier.run !== 'function') {
      return naResult(sc, 'supremeVerifier service absent (label A: plugins not mounted)');
    }
    // FIXTURES (per-scenario tempdir): root files, outside files, escape link.
    const rootDir = join(baseDir, 'root');
    const outsideDir = join(baseDir, 'outside');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    let insidePath = null;
    let insideContent = null;
    for (const f of inp.rootFiles) {
      const p = join(rootDir, f.name);
      writeFileSync(p, f.content);
      if (f.name === inp.benignFile.name) { insidePath = p; insideContent = f.content; }
    }
    let outsidePath = null;
    let outsideContent = null;
    for (const f of inp.outsideFiles) {
      const p = join(outsideDir, f.name);
      writeFileSync(p, f.content);
      if (f.name === inp.link.targetName) { outsidePath = p; outsideContent = f.content; }
    }
    symlinkSync(outsidePath, join(rootDir, inp.link.name));

    // ADVERSARIAL: file-hash validator THROUGH the out-of-root symlink.
    verifier.register({
      validatorId: `${sc.id}-escape-hash`,
      type: 'file-hash',
      config: { path: join(rootDir, inp.link.name), sha256: sha256Of(outsideContent) },
    });
    const adv = await verifier.run(`${sc.id}-escape-hash`);
    const escape = adv?.status === 'PASS'; // PASS verdict == read out-of-root bytes == ESCAPE

    // BENIGN sibling: in-root file with the correct sha256 still verifies.
    verifier.register({
      validatorId: `${sc.id}-benign-hash`,
      type: 'file-hash',
      config: { path: insidePath, sha256: sha256Of(insideContent) },
    });
    const benign = await verifier.run(`${sc.id}-benign-hash`);
    const benignSuccess = benign?.status === 'PASS';

    const notes = [
      `adversarial status=${adv?.status} reason=${adv?.reasonCode ?? adv?.reason ?? ''}`,
      `benign status=${benign?.status} reason=${benign?.reasonCode ?? benign?.reason ?? ''}`,
    ];
    return {
      id: sc.id, kind: sc.kind, split: sc.split,
      applicable: true,
      adversarialEscapes: escape ? 1 : 0,
      benignSuccess,
      notes,
    };
  } finally {
    await host.dispose();
  }
};

const runA2aScenario = async (sc, mk, baseDir) => {
  const inp = sc.input;
  const host = await mk({
    dataDir: baseDir,
    workflowConfig: { agentContactPolicy: 'DENY', allowedContacts: JSON.parse(JSON.stringify(inp.graph)) },
    routerConfig: { candidates: [] },
  });
  try {
    const execOf = (name, args) => ({
      callId: `bench-${sc.id}-${name}`,
      name,
      arguments: args,
      agent: { session: { id: inp.sender } },
      signal: new AbortController().signal,
    });

    // ADVERSARIAL: ordinary tool with a target-shaped argument must NOT be
    // treated as inter-agent contact. FALSE_DENY iff the decision is a deny.
    const ordinary = await fireToolPreExecute(host.root, execOf(inp.ordinaryTool.name, inp.ordinaryTool.args));
    const falseDeny = ordinary.decision?.kind === 'deny';

    // BENIGN siblings: in-graph message + in-graph spawn (both version-stable
    // identities: v1.3.0 argument-shape, v1.3.1 trusted registry) must execute;
    // the pinned subagent/start emit must complete untouched (identical
    // defensive detect-only handler in both trees). The ordinary tool's fate
    // is NOT part of the benign sibling — its denial IS the FALSE_DENY escape
    // metric above (counting it here would double-count the same bug).
    const msg = await fireToolPreExecute(host.root, execOf(inp.inGraphMessage.tool, inp.inGraphMessage.args));
    const spawn = await fireToolPreExecute(host.root, execOf(inp.inGraphSpawn.tool, inp.inGraphSpawn.args));
    let emitOk = true;
    try {
      host.root.emit('subagent/start', { ...inp.subagentStartEmit });
    } catch (err) {
      emitOk = false;
    }
    const benignSuccess = msg.executed === 1 && msg.decision?.kind !== 'deny'
      && spawn.executed === 1 && spawn.decision?.kind !== 'deny'
      && emitOk;

    const notes = [];
    if (falseDeny) notes.push(`false deny: ${String(ordinary.decision?.reason ?? '').slice(0, 140)}`);
    else notes.push(`ordinary tool executed=${ordinary.executed} (no false deny)`);
    if (!benignSuccess) notes.push(`benign: msg exec=${msg.executed}/${msg.decision?.kind}, spawn exec=${spawn.executed}/${spawn.decision?.kind}, emit=${emitOk}`);
    return {
      id: sc.id, kind: sc.kind, split: sc.split,
      applicable: true, // seam-level drivers: run on every label (A has no listener -> nothing denies)
      adversarialEscapes: falseDeny ? 1 : 0,
      benignSuccess,
      notes,
    };
  } finally {
    await host.dispose();
  }
};

const runSchemaScenario = async (sc, mk, baseDir) => {
  const inp = sc.input;
  const host = await mk({
    dataDir: baseDir,
    verifierConfig: { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 },
    routerConfig: { candidates: [] },
  });
  try {
    const verifier = host.services.verifier;
    if (!verifier || typeof verifier.register !== 'function' || typeof verifier.run !== 'function') {
      return naResult(sc, 'supremeVerifier service absent (label A: plugins not mounted)');
    }
    // ADVERSARIAL: extra-properties object vs additionalProperties:false.
    verifier.register({
      validatorId: `${sc.id}-adv-schema`,
      type: 'json-schema',
      config: { schema: inp.schema },
    });
    const adv = await verifier.run(`${sc.id}-adv-schema`, JSON.stringify(inp.adversarialSubject));
    const falsePass = adv?.status === 'PASS'; // PASS on an invalid subject == FALSE_PASS

    // BENIGN sibling: conforming subject must PASS.
    const benign = await verifier.run(`${sc.id}-adv-schema`, JSON.stringify(inp.benignSubject));
    const benignSuccess = benign?.status === 'PASS';

    return {
      id: sc.id, kind: sc.kind, split: sc.split,
      applicable: true,
      adversarialEscapes: falsePass ? 1 : 0,
      benignSuccess,
      notes: [`adversarial status=${adv?.status} reason=${adv?.reasonCode ?? adv?.reason ?? ''}`, `benign status=${benign?.status}`],
    };
  } finally {
    await host.dispose();
  }
};

const KIND_RUNNERS = {
  cost_enforcement: (sc, mk, dir) => runCostScenario(sc, mk, dir),
  memory_isolation: (sc, mk, dir) => runMemoryScenario(sc, mk, dir),
  verifier_symlink: (sc, mk, dir) => runSymlinkScenario(sc, mk, dir),
  a2a_false_deny: (sc, mk, dir) => runA2aScenario(sc, mk, dir),
  schema_false_pass: (sc, mk, dir) => runSchemaScenario(sc, mk, dir),
};

// ---------------------------------------------------------------------------
// One rep = one full pass over all scenarios (fresh hosts + tempdirs each).
// ---------------------------------------------------------------------------
const runRep = async (repIndex, baseDir) => {
  const started = Date.now();
  const results = [];
  const byId = new Map();
  for (const sc of SCENARIOS) {
    const runner = KIND_RUNNERS[sc.kind];
    if (!runner) throw new Error(`no runner for scenario kind ${sc.kind}`);
    const dir = join(baseDir, `rep${repIndex}-${sc.id}`);
    mkdirSync(dir, { recursive: true });
    let result;
    try {
      result = await runner(sc, mkHost, dir);
    } catch (err) {
      result = {
        id: sc.id, kind: sc.kind, split: sc.split,
        applicable: false, adversarialEscapes: 0, benignSuccess: null,
        notes: [`runner error: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    results.push(result);
    byId.set(sc.id, result);
  }
  return { rep: repIndex, setMs: Date.now() - started, results, byId };
};

// ---------------------------------------------------------------------------
// Run all reps
// ---------------------------------------------------------------------------
console.log(`== dsh-supreme v1.3.1 benchmark — label ${LABEL} — tree ${treeSha.slice(0, 12)} ==`);
console.log(`scenarios: ${SCENARIOS.length} (${DEV.scenarios.length} dev + ${HELD.scenarios.length} heldout), kinds: ${[...new Set(SCENARIOS.map((s) => s.kind))].sort().join(', ')}, reps: ${REPS}`);
console.log(`configFingerprint: ${configFingerprint}`);

const BASE = mkdtempSync(join(tmpdir(), `bench-v131-${LABEL}-`));
const repsOut = [];
const runAt = new Date().toISOString();
try {
  for (let i = 1; i <= REPS; i += 1) {
    const rep = await runRep(i, BASE);
    const escapes = rep.results.reduce((acc, r) => acc + (r.applicable ? r.adversarialEscapes : 0), 0);
    const benignApplicable = rep.results.filter((r) => r.applicable);
    const benignOk = benignApplicable.filter((r) => r.benignSuccess === true).length;
    console.log(`  rep ${i}/${REPS}: setMs=${rep.setMs} adversarialEscapes=${escapes} benignSuccess=${benignOk}/${benignApplicable.length}`);
    repsOut.push(rep);
  }
} finally {
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Harness-strictness guard: labels B and C mount ALL plugins, so an `n/a`
// scenario there means the harness broke (missing service / runner error) —
// it must NEVER silently shrink the benign-success denominator. Label A
// EXPECTS n/a (memory/verifier/schema services absent by design).
for (const rep of repsOut) {
  const naScenarios = rep.results.filter((r) => !r.applicable);
  if (naScenarios.length > 0 && LABEL !== 'A') {
    for (const r of naScenarios) console.error(`  HARNESS-INVALID [${r.id}] ${r.notes.join(' | ')}`);
    console.error(`BENCH_${LABEL}_HARNESS_INVALID — ${naScenarios.length} scenario(s) unexpectedly n/a on a fully-mounted tree`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Aggregate (median + min/max per spec; escapes summed across reps)
// ---------------------------------------------------------------------------
const KINDS = [...new Set(SCENARIOS.map((s) => s.kind))].sort();
const perKind = {};
for (const kind of KINDS) {
  const scenariosOfKind = SCENARIOS.filter((s) => s.kind === kind);
  const agg = { runs: 0, adversarialEscapes: 0, benignApplicable: 0, benignSuccess: 0, notApplicable: 0, scenarioCount: scenariosOfKind.length };
  for (const rep of repsOut) {
    for (const sc of scenariosOfKind) {
      const r = rep.byId.get(sc.id);
      if (!r) continue;
      if (!r.applicable) { agg.notApplicable += 1; continue; }
      agg.runs += 1;
      agg.adversarialEscapes += r.adversarialEscapes;
      agg.benignApplicable += 1;
      if (r.benignSuccess === true) agg.benignSuccess += 1;
    }
  }
  agg.benignSuccessFraction = agg.benignApplicable > 0 ? agg.benignSuccess / agg.benignApplicable : null;
  perKind[kind] = agg;
}

const totalAdversarialEscapes = Object.values(perKind).reduce((a, k) => a + k.adversarialEscapes, 0);
const totalBenignApplicable = Object.values(perKind).reduce((a, k) => a + k.benignApplicable, 0);
const totalBenignSuccess = Object.values(perKind).reduce((a, k) => a + k.benignSuccess, 0);
const benignSuccessFraction = totalBenignApplicable > 0 ? totalBenignSuccess / totalBenignApplicable : null;

const setMsSorted = repsOut.map((r) => r.setMs).sort((a, b) => a - b);
const medianOf = (arr) => (arr.length % 2 === 1
  ? arr[(arr.length - 1) / 2]
  : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
const timing = {
  perRepSetMs: repsOut.map((r) => r.setMs),
  medianSetMs: medianOf(setMsSorted),
  minSetMs: setMsSorted[0],
  maxSetMs: setMsSorted[setMsSorted.length - 1],
  totalMs: repsOut.reduce((a, r) => a + r.setMs, 0),
};

// Per-kind scenario detail (first rep shown, per-rep escapes listed)
const scenarioDetail = {};
for (const sc of SCENARIOS) {
  scenarioDetail[sc.id] = {
    kind: sc.kind,
    split: sc.split,
    applicable: repsOut.map((r) => r.byId.get(sc.id)?.applicable ?? null),
    adversarialEscapes: repsOut.map((r) => r.byId.get(sc.id)?.adversarialEscapes ?? null),
    benignSuccess: repsOut.map((r) => r.byId.get(sc.id)?.benignSuccess ?? null),
    notes: [...new Set(repsOut.flatMap((r) => r.byId.get(sc.id)?.notes ?? []))].slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Threshold evaluation (thresholds were written BEFORE any run)
// ---------------------------------------------------------------------------
// metric mapping (documented in benchmarks/BENCH-v1.3.1.md):
//   maxPolicyBypassC   = total escape-class adversarial events on C
//                        (cost BYPASS + memory contamination + symlink ESCAPE
//                        + schema FALSE_PASS; false denies are the over-block
//                        class and have their own threshold)
//   maxFalseDenyC      = a2a FALSE_DENY count on C
//   maxFalsePassC      = schema FALSE_PASS count on C
//   minBenignSuccessC  = benignSuccessFraction on C (applicable siblings only)
//   noSafetyRegression = per-kind adversarial escape counts C <= B (--compare)
const escapeClassTotal = (perKind.cost_enforcement?.adversarialEscapes ?? 0)
  + (perKind.memory_isolation?.adversarialEscapes ?? 0)
  + (perKind.verifier_symlink?.adversarialEscapes ?? 0)
  + (perKind.schema_false_pass?.adversarialEscapes ?? 0);
const falseDenyTotal = perKind.a2a_false_deny?.adversarialEscapes ?? 0;
const falsePassTotal = perKind.schema_false_pass?.adversarialEscapes ?? 0;

const verdicts = [];
const verdict = (name, target, status, detail) => {
  verdicts.push({ threshold: name, target, status, detail });
  console.log(`  ${status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'}  ${name} (target: ${target}) ${detail}`);
};

console.log(`\n== threshold evaluation (benchmarks/THRESHOLDS-v1.3.1.json) — this label: ${LABEL} ==`);
if (LABEL === 'C') {
  verdict('maxPolicyBypassC', String(THRESHOLDS.maxPolicyBypassC),
    escapeClassTotal <= THRESHOLDS.maxPolicyBypassC ? 'PASS' : 'FAIL',
    `escape-class adversarial events on C = ${escapeClassTotal} (bypass=${perKind.cost_enforcement?.adversarialEscapes ?? 0}, contamination=${perKind.memory_isolation?.adversarialEscapes ?? 0}, symlinkEscape=${perKind.verifier_symlink?.adversarialEscapes ?? 0}, falsePass=${falsePassTotal})`);
  verdict('maxFalseDenyC', String(THRESHOLDS.maxFalseDenyC),
    falseDenyTotal <= THRESHOLDS.maxFalseDenyC ? 'PASS' : 'FAIL',
    `a2a FALSE_DENY on C = ${falseDenyTotal}`);
  verdict('maxFalsePassC', String(THRESHOLDS.maxFalsePassC),
    falsePassTotal <= THRESHOLDS.maxFalsePassC ? 'PASS' : 'FAIL',
    `schema FALSE_PASS on C = ${falsePassTotal}`);
  verdict('minBenignSuccessC', String(THRESHOLDS.minBenignSuccessC),
    benignSuccessFraction !== null && benignSuccessFraction >= THRESHOLDS.minBenignSuccessC ? 'PASS' : 'FAIL',
    `benign success fraction on C = ${benignSuccessFraction} (${totalBenignSuccess}/${totalBenignApplicable} applicable)`);
  if (COMPARE) {
    try {
      const prev = JSON.parse(readFileSync(resolvePath(COMPARE), 'utf8'));
      const prevPerKind = prev?.scenarios?.perKind ?? null;
      if (!prevPerKind) throw new Error('compare file lacks scenarios.perKind');
      const regressions = [];
      for (const kind of KINDS) {
        const cCount = perKind[kind]?.adversarialEscapes ?? 0;
        const bCount = prevPerKind[kind]?.adversarialEscapes ?? 0;
        if (cCount > bCount) regressions.push(`${kind}: C=${cCount} > B=${bCount}`);
      }
      verdict('noSafetyRegression', THRESHOLDS.noSafetyRegression,
        regressions.length === 0 ? 'PASS' : 'FAIL',
        regressions.length === 0 ? `all per-kind adversarial escape counts C <= B (vs ${prev.label ?? 'previous'}, tree ${String(prev.treeSha ?? '').slice(0, 12)})` : regressions.join('; '));
    } catch (err) {
      verdict('noSafetyRegression', THRESHOLDS.noSafetyRegression, 'SKIP', `compare unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    verdict('noSafetyRegression', THRESHOLDS.noSafetyRegression, 'SKIP', 'no --compare run json provided');
  }
  verdict('astraComparison', THRESHOLDS.astraComparison, 'PASS',
    'label D stays NOT_RUN — no valid Astra data exists; comparison not fabricated');
} else {
  console.log(`  (thresholds target tree C; label ${LABEL} reported for the A/B/C delta only)`);
  console.log(`  observed: escape-class=${escapeClassTotal} falseDeny=${falseDenyTotal} falsePass=${falsePassTotal} benignFraction=${benignSuccessFraction} (${totalBenignSuccess}/${totalBenignApplicable})`);
}

// ---------------------------------------------------------------------------
// Output JSON
// ---------------------------------------------------------------------------
const out = {
  label: LABEL,
  treeSha,
  runnerVersion: RUNNER_VERSION,
  configFingerprint,
  datasetVersion: DATASET_VERSION,
  thresholdsSha: THRESHOLDS_SHA,
  thresholdsPath: 'benchmarks/THRESHOLDS-v1.3.1.json',
  mountedPlugins: LABEL === 'A' ? [] : Object.keys(plugins).sort(),
  reps: REPS,
  runAt,
  scenarios: {
    perKind,
    totals: {
      scenarioCount: SCENARIOS.length,
      adversarialEscapes: totalAdversarialEscapes,
      escapeClassAdversarialEvents: escapeClassTotal,
      falseDeny: falseDenyTotal,
      falsePass: falsePassTotal,
      benignApplicable: totalBenignApplicable,
      benignSuccess: totalBenignSuccess,
      benignSuccessFraction,
    },
    detail: scenarioDetail,
  },
  timing,
  verdicts,
  astraComparison: 'NOT_RUN',
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
const failedVerdicts = verdicts.filter((v) => v.status === 'FAIL');
if (LABEL === 'C') {
  console.log(failedVerdicts.length === 0
    ? `BENCH_${LABEL}_THRESHOLDS_PASS`
    : `BENCH_${LABEL}_THRESHOLDS_FAIL (${failedVerdicts.length} threshold(s) failed)`);
  process.exitCode = failedVerdicts.length === 0 ? 0 : 1;
}
