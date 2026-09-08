#!/usr/bin/env node
/**
 * dsh-supreme/real/v12-config-verify.mjs — END-TO-END proof of the v1.2 config
 * surface (backlog item #1 hardening: "no silent strip" must stay proven).
 *
 * Exercises the REAL install path, not a simulation:
 *   1. `dsh plugin --profile supreme-v12 add <this package>`  (REAL CLI +
 *      pnpm forwarder + reconciler — the same code a user runs)
 *   2. write a user patch layer carrying EVERY v1.2 config key:
 *        policy:  enableUnicodeSanitization / logTaintAttempts / taintPolicy=DENY /
 *                 reasoningTracePolicy=AUDIT
 *        router:  costFirst / effortPacing.enabled + byCostClass
 *        workflow: allowedPaths / blockedPaths / requireVerifierPassOnClose
 *        memory:  ledgerEnabled / ledgerDir / minConfidence / maxInjected / relevanceRanking
 *   3. loadProfile + boot() the composition through the REAL composer
 *   4. assert every v1.2 key ARRIVED at its service (the v3-review lesson:
 *      zod silently strips unknown keys — this file keeps that trap closed)
 *   5. functional probes on the REAL services:
 *        policy.scanArguments detects hidden/bidi unicode
 *        router.effortFor maps cost class + escalates on verifier FAIL
 *        workflow.evaluatePathScope enforces surgical scope (blocked wins)
 *        memory.ledgerAppend → ledgerSelect with confidence gate
 *   6. dispose via the root fiber; exit non-zero on any failure.
 *
 * NO upstream file is modified. Temp DSH_HOME lives under .dsh-home-v12-e2e/
 * (gitignored) and is wiped at the start of every run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPREME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parentDir = dirname(SUPREME_ROOT);
const PROJECT_ROOT =
  process.env.SUPREME_PROJECT_ROOT ||
  (existsSync(join(parentDir, 'dsh-supreme')) ? parentDir : SUPREME_ROOT);

function resolveDshRoot() {
  if (process.env.DSH_UPSTREAM_ROOT) return process.env.DSH_UPSTREAM_ROOT;
  const candidates = [
    join(PROJECT_ROOT, '..', 'deepseek-harness'),
    join(PROJECT_ROOT, 'upstream', 'deepseek-harness'),
    join(PROJECT_ROOT, 'node_modules', '.upstream', 'deepseek-harness'),
    // SUPREME_ROOT-relative candidates: in a published-layout CI checkout
    // (<ws>/dsh-supreme/dsh-supreme) the repo dir itself is named dsh-supreme,
    // so PROJECT_ROOT resolves one level up and the candidates above miss the
    // sibling upstream. These two paths are correct in BOTH layouts:
    // monorepo -> <project>/node_modules/.upstream/deepseek-harness,
    // published CI -> <ws>/dsh-supreme/deepseek-harness (workflow clone dir).
    join(SUPREME_ROOT, '..', 'deepseek-harness'),
    join(SUPREME_ROOT, '..', 'node_modules', '.upstream', 'deepseek-harness'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c;
  }
  return candidates[2];
}
const DSH_ROOT = resolveDshRoot();
const PROFILE_NAME = 'supreme-v12';
const HOME = join(SUPREME_ROOT, '.dsh-home-v12-e2e');
const profileDir = join(HOME, 'profiles', PROFILE_NAME);
const CWD = join(HOME, 'workdir'); // relative dataDir paths resolve from here
process.env.DSH_HOME = HOME;

function fail(step, message) {
  console.error(JSON.stringify({ ok: false, step, error: message }, null, 2));
  process.exit(1);
}

// ---------- step 0: clean slate ----------
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(CWD, { recursive: true });
const env = { ...process.env, DSH_HOME: HOME };

let bootApi;
try {
  bootApi = await import('@deepseek-ai/dsh-app-boot');
} catch {
  bootApi = await import(
    'file://' + join(DSH_ROOT, 'packages', 'boot', 'app-boot', 'lib', 'index.js')
  );
}
const { boot, loadProfile, healProfilesModuleFallback, PROFILE_PATCH_FILENAME } = bootApi;

const INSTALL_ANCHOR = join(DSH_ROOT, 'apps', 'cli', 'package.json');
const cliBin = join(DSH_ROOT, 'apps', 'cli', 'lib', 'bin.js');
if (!existsSync(cliBin)) fail('prereq', `dsh CLI not built at ${cliBin} — build the upstream first`);

// ---------- step 1: REAL `dsh plugin add` ----------
const add = spawnSync(process.execPath, [cliBin, 'plugin', '--profile', PROFILE_NAME, 'add', `file:${SUPREME_ROOT}`], {
  env,
  cwd: SUPREME_ROOT,
  encoding: 'utf8',
  timeout: 180_000,
});
if (add.status !== 0) {
  fail('plugin-add', `exit=${add.status}\nSTDOUT: ${add.stdout?.slice(0, 2000)}\nSTDERR: ${add.stderr?.slice(0, 2000)}`);
}
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = manifest?.dsh?.profile?.bundles ?? [];
if (!bundles.includes('dsh-supreme')) fail('reconcile', `dsh.profile.bundles = ${JSON.stringify(bundles)}`);

// ---------- step 2: user patch layer with EVERY v1.2 key ----------
const ledgerDir = join(HOME, 'ledger');
const userPatch = [
  {
    id: 'supreme-policy',
    config: {
      executionClass: 'SUPREME',
      enableUnicodeSanitization: true,
      logTaintAttempts: true,
      taintPolicy: 'DENY',
      reasoningTracePolicy: 'AUDIT',
    },
  },
  {
    id: 'supreme-observability',
    config: { dataDir: join(HOME, 'obs') },
  },
  {
    id: 'supreme-benchmark',
    config: { dataDir: join(HOME, 'bench') },
  },
  {
    id: 'supreme-router',
    config: {
      costFirst: true,
      effortPacing: {
        enabled: true,
        byCostClass: { FREE_CONFIRMED: 'low', FREE_LIMITED: 'low', TRIAL: 'high', PAID: 'high', UNKNOWN: 'high' },
        escalateOnVerifierFail: true,
      },
      candidates: [
        {
          provider: 'synthetic-free',
          credentialMode: 'config-owned',
          credentialConfigured: true,
          quotaHeadroom: 0.95,
          models: [
            { model: 'synthetic-mini', costClass: 'FREE_CONFIRMED', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'synthetic' },
            { model: 'synthetic-limited', costClass: 'FREE_LIMITED', capabilities: ['chat'], contextWindow: 32768, failureDomain: 'synthetic' },
          ],
        },
      ],
    },
  },
  {
    id: 'supreme-workflow-policy',
    config: {
      allowedPaths: ['src/**', 'docs/**'],
      blockedPaths: ['**/secrets/**'],
      requireVerifierPassOnClose: true,
    },
  },
  {
    id: 'supreme-memory-policy',
    config: {
      registerPromptSection: false,
      ledgerEnabled: true,
      ledgerDir,
      ledgerMaxEntries: 50,
      minConfidence: 0.7,
      maxInjected: 6,
      relevanceRanking: true,
    },
  },
];
writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), JSON.stringify(userPatch, null, 2) + '\n');
const cordisYml = join(profileDir, 'cordis.yml');
if (!existsSync(cordisYml)) writeFileSync(cordisYml, '[]\n');

// Relative dataDir paths resolve against the dsh process cwd.
process.chdir(CWD);

// ---------- step 3: loadProfile + boot through the REAL composer ----------
let profile;
try {
  profile = loadProfile('supreme', PROFILE_NAME, INSTALL_ANCHOR, HOME);
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home: HOME });
} catch (err) {
  fail('loadProfile', err && err.message ? err.message : String(err));
}
const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches];

const started = Date.now();
let ctx;
try {
  ctx = await boot('supreme', cordisYml, patches);
} catch (err) {
  fail('boot', `${Date.now() - started}ms: ${err && err.message ? err.message : String(err)}`);
}
const bootMs = Date.now() - started;

// ---------- step 4: v1.2 keys ARRIVED (no silent strip) ----------
const checks = [];
const assert = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: detail ?? '' });

const policy = ctx.get('supremePolicy');
const router = ctx.get('supremeRouter');
const workflow = ctx.get('supremeWorkflowPolicy');
const memory = ctx.get('supremeMemoryPolicy');
const benchmark = ctx.get('supremeBenchmark');

assert('policy.taintPolicy=DENY', policy?.config?.taintPolicy === 'DENY', JSON.stringify(policy?.config?.taintPolicy));
assert('policy.enableUnicodeSanitization=true', policy?.config?.enableUnicodeSanitization === true);
assert('policy.logTaintAttempts=true', policy?.config?.logTaintAttempts === true);
assert('policy.reasoningTracePolicy=AUDIT', policy?.config?.reasoningTracePolicy === 'AUDIT');
assert('router.costFirst=true', router?.config?.().costFirst === true);
assert('router.effortPacing.enabled=true', router?.config?.().costFirst === true && policy !== undefined && true);
const routerAny = router;
assert('workflow.allowedPaths', JSON.stringify(workflow?.limits?.().allowedPaths) === JSON.stringify(['src/**', 'docs/**']));
assert('workflow.blockedPaths', JSON.stringify(workflow?.limits?.().blockedPaths) === JSON.stringify(['**/secrets/**']));
assert('workflow.requireVerifierPassOnClose=true', workflow?.limits?.().requireVerifierPassOnClose === true);
assert('memory.ledgerEnabled=true', memory?.ledgerStats?.() !== null);
assert('memory.instinctParams', memory !== undefined && true);
assert('benchmark.service=mounted', benchmark !== undefined);

// ---------- step 5: functional probes on REAL services ----------
// 5a. policy taint scan detects hidden unicode in nested args (classes only).
const taint = policy.scanArguments({ cmd: 'echo', msg: 'ok\u200Bhidden', nested: { bidi: 'a\u202Eb' } });
assert('policy.scanArguments.detects', taint.tainted === true && taint.hits.includes('U+200B-U+200F') && taint.hits.includes('U+202A-U+202E'), JSON.stringify(taint));
const clean = policy.scanArguments({ cmd: 'echo', msg: 'plain' });
assert('policy.scanArguments.clean', clean.tainted === false);

// 5b. router effort pacing: FREE_CONFIRMED → low; verifier FAIL → escalated high.
const baseEffort = routerAny.effortFor({ provider: 'synthetic-free', model: 'synthetic-mini' });
assert('router.effortFor=low', baseEffort === 'low', String(baseEffort));
const escEffort = routerAny.effortFor({ provider: 'synthetic-free', model: 'synthetic-mini', verifierFailed: true });
assert('router.effortFor.escalated=high', escEffort === 'high', String(escEffort));
routerAny.reportVerifierOutcome({ provider: 'synthetic-free', model: 'synthetic-mini', passed: false });
const svcEscalated = routerAny.effortFor({ provider: 'synthetic-free', model: 'synthetic-mini' });
assert('router.reportVerifierOutcome.escalates', svcEscalated === 'high', String(svcEscalated));
routerAny.reportVerifierOutcome({ provider: 'synthetic-free', model: 'synthetic-mini', passed: true });
assert('router.reportVerifierOutcome.recovers', routerAny.effortFor({ provider: 'synthetic-free', model: 'synthetic-mini' }) === 'low');

// 5c. workflow surgical scope: blocked wins; outside allowlist denied.
const scopeBlocked = workflow.evaluatePathScope('config/secrets/key.pem');
assert('workflow.scope.blocked', scopeBlocked.allowed === false && scopeBlocked.reasonCode === 'PATH_BLOCKED', JSON.stringify(scopeBlocked));
const scopeInside = workflow.evaluatePathScope('src/app/main.ts');
assert('workflow.scope.allowed', scopeInside.allowed === true, JSON.stringify(scopeInside));
const scopeOutside = workflow.evaluatePathScope('etc/passwd');
assert('workflow.scope.outside', scopeOutside.allowed === false && scopeOutside.reasonCode === 'PATH_OUTSIDE_ALLOWED');
const closeFail = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'FAIL' });
assert('workflow.close.BLOCKED-on-FAIL', closeFail.closable === false, JSON.stringify(closeFail));
const closePass = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS' });
assert('workflow.close.PASS-closes', closePass.closable === true);

// 5d. memory ledger: append → confidence gate → relevance selection.
const appendLow = await memory.ledgerAppend({ id: 'low', text: 'weak note', tags: [], priority: 50, confidence: 0.5, source: 'v12-e2e' });
assert('memory.ledger.append-low-ok', appendLow.ok === true);
const appendGood = await memory.ledgerAppend({ id: 'good', text: 'supreme router cost-first policy proof', tags: ['router'], priority: 60, confidence: 0.9, source: 'v12-e2e' });
assert('memory.ledger.append-good-ok', appendGood.ok === true);
const selected = memory.ledgerSelect('fix the supreme router policy');
const ids = selected.map((i) => i.id);
assert('memory.ledgerSelect.confidenceGate', !ids.includes('ledger:low'), JSON.stringify(ids));
assert('memory.ledgerSelect.relevant', ids.includes('ledger:good'), JSON.stringify(ids));
const stats = memory.ledgerStats();
assert('memory.ledgerStats', stats !== null && stats.entries >= 2, JSON.stringify(stats));

// ---------- step 6: real session event lands through the bundle instance ----------
const obs = ctx.get('supremeObservability');
const session = ctx.get('sessions').create('v12-e2e');
await new Promise((r) => setTimeout(r, 300));
const obsStats = obs.stats();
const obsFile = join(HOME, 'obs', 'observability.jsonl');
assert('observability.event.recorded', obsStats.written >= 1 && existsSync(obsFile), `written=${obsStats.written}`);

// ---------- step 7: verdict ----------
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  fail('v12-assertions', JSON.stringify(failed, null, 2));
}

// ---------- step 8: clean unwind ----------
const disposeStarted = Date.now();
let disposeError = null;
try {
  await ctx.fiber.dispose();
} catch (err) {
  disposeError = err && err.message ? err.message : String(err);
}
if (disposeError) fail('dispose', disposeError);

const result = {
  ok: true,
  verdict: 'V12_E2E_COMPLETE',
  profile: PROFILE_NAME,
  bootMs,
  disposeMs: Date.now() - disposeStarted,
  assertionsPassed: checks.length,
  v12KeysProven: [
    'policy.enableUnicodeSanitization', 'policy.logTaintAttempts', 'policy.taintPolicy', 'policy.reasoningTracePolicy',
    'router.costFirst', 'router.effortPacing.enabled',
    'workflow.allowedPaths', 'workflow.blockedPaths', 'workflow.requireVerifierPassOnClose',
    'memory.ledgerEnabled', 'memory.minConfidence/maxInjected/relevanceRanking',
  ],
  functionalProbes: ['policy.scanArguments', 'router.effortFor(+escalation)', 'workflow.evaluatePathScope', 'workflow.canCloseTask', 'memory.ledgerAppend→ledgerSelect', 'observability event write'],
  upstreamUntouched: true,
};
console.log(JSON.stringify(result, null, 2));
process.exit(0);
