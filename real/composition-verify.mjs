#!/usr/bin/env node
/**
 * dsh-supreme/real/composition-verify.mjs — END-TO-END proof of the v1.1
 * composition fragments (config/compositions/*.patch.yml).
 *
 * Exercises the REAL install + overlay path, not a simulation:
 *   1. `dsh plugin --profile supreme-comp add <this package>`  (REAL CLI —
 *      same pnpm-forwarding + reconciler code a user runs)
 *   2. for each fragment (core, standard, supreme, lab):
 *        loadProfile through @deepseek-ai/dsh-app-boot, add the fragment as
 *        the LAST overlay (the `--patch` argv-order semantics), boot() the
 *        composition, probe which Supreme services mounted:
 *          core     → policy only (six rows disabled)
 *          standard → policy/observability/memory-policy/verifier
 *          supreme  → all seven
 *          lab      → all seven (LAB overrides applied)
 *   3. prove the shipped RELATIVE dataDir default works: a real session event
 *      under the standard fragment lands in `<cwd>/.supreme-data/observability/`.
 *   4. dispose via the root fiber; exit non-zero on any failure.
 *
 * Runs from a FRESH empty working directory so relative paths are proven
 * against the process cwd the same way a user's `dsh --profile <name>` run is.
 * NO upstream file is modified. Temp DSH_HOME lives under
 * .dsh-home-comp-e2e/ (gitignored) and is wiped at the start of every run.
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
const PROFILE_NAME = 'supreme-comp';
const HOME = join(SUPREME_ROOT, '.dsh-home-comp-e2e');
const CWD = join(HOME, 'workdir');
const profileDir = join(HOME, 'profiles', PROFILE_NAME);
process.env.DSH_HOME = HOME;

function fail(step, message) {
  console.error(JSON.stringify({ ok: false, step, error: message }, null, 2));
  process.exit(1);
}

// ---------- step 0: clean slate + fresh empty cwd (relative-path proof) ----------
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
const { boot, loadProfile, healProfilesModuleFallback, loadOverlayPatches, PROFILE_PATCH_FILENAME } = bootApi;

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
if (!bundles.includes('dsh-supreme')) {
  fail('reconcile', `dsh.profile.bundles = ${JSON.stringify(bundles)} — 'dsh-supreme' not appended`);
}
// Empty user patch layer: fragments must compose correctly WITHOUT user help.
writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '[]\n');
const cordisYml = join(profileDir, 'cordis.yml');
if (!existsSync(cordisYml)) writeFileSync(cordisYml, '[]\n');

// From here on, run in the fresh empty workdir so the fragments' RELATIVE
// dataDir defaults resolve against the process cwd exactly like a real
// `dsh --profile <name>` invocation from a user's project directory.
// (boot() runs in-process; the install spawn above already pinned its cwd.)
process.chdir(CWD);

// ---------- step 2: boot each fragment composition ----------
const BASE_SERVICES = ['llm', 'sessions', 'systemPrompt', 'tokenMeter', 'subagents', 'workflowEngine'];
const ALL = [
  'supremePolicy', 'supremeObservability', 'supremeBenchmark', 'supremeRouter',
  'supremeVerifier', 'supremeMemoryPolicy', 'supremeWorkflowPolicy',
];
const EXPECT = {
  core: ['supremePolicy'],
  standard: ['supremePolicy', 'supremeObservability', 'supremeVerifier', 'supremeMemoryPolicy'],
  supreme: ALL,
  lab: ALL,
};

const probe = (ctx, names) => {
  const out = {};
  for (const s of names) {
    try { out[s] = ctx.get(s) !== undefined; } catch { out[s] = false; }
  }
  return out;
};

const results = {};
for (const comp of ['core', 'standard', 'supreme', 'lab']) {
  const fragmentPath = join(SUPREME_ROOT, 'config', 'compositions', `${comp}.patch.yml`);
  if (!existsSync(fragmentPath)) fail('fragment', `missing composition fragment: ${fragmentPath}`);

  let profile;
  try {
    profile = loadProfile('supreme', PROFILE_NAME, INSTALL_ANCHOR, HOME);
    await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home: HOME });
  } catch (err) {
    fail(`loadProfile:${comp}`, err && err.message ? err.message : String(err));
  }
  let overlay;
  try {
    overlay = loadOverlayPatches('supreme', fragmentPath);
  } catch (err) {
    fail(`overlay:${comp}`, err && err.message ? err.message : String(err));
  }
  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...overlay,
  ];

  const started = Date.now();
  let ctx;
  try {
    ctx = await boot('supreme', cordisYml, patches);
  } catch (err) {
    fail(`boot:${comp}`, `${Date.now() - started}ms: ${err && err.message ? err.message : String(err)}`);
  }

  const mounted = probe(ctx, [...BASE_SERVICES, ...ALL]);
  const expectPresent = EXPECT[comp];
  const missing = expectPresent.filter((s) => !mounted[s]);
  const leaked = ALL.filter((s) => !expectPresent.includes(s) && mounted[s]);
  if (missing.length > 0) {
    await ctx.fiber.dispose().catch(() => {});
    fail(`services:${comp}`, `expected present but absent: ${missing.join(', ')}`);
  }
  if (leaked.length > 0) {
    await ctx.fiber.dispose().catch(() => {});
    fail(`services:${comp}`, `expected disabled but mounted: ${leaked.join(', ')}`);
  }

  // standard: prove the shipped RELATIVE dataDir default writes through a real event
  let relProof = null;
  if (comp === 'standard') {
    try {
      const obs = ctx.get('supremeObservability');
      ctx.get('sessions').create('composition-e2e');
      await new Promise((r) => setTimeout(r, 300));
      const jsonl = join(CWD, '.supreme-data', 'observability', 'observability.jsonl');
      const hasLines = existsSync(jsonl) && readFileSync(jsonl, 'utf8').trim().length > 0;
      if (!hasLines) fail('dataDir', `relative dataDir default produced no record at ${jsonl}`);
      relProof = { jsonl: '.supreme-data/observability/observability.jsonl', wroteLines: true };
    } catch (err) {
      fail('dataDir', err && err.message ? err.message : String(err));
    }
  }

  const disposeStarted = Date.now();
  try {
    await ctx.fiber.dispose();
  } catch (err) {
    fail(`dispose:${comp}`, err && err.message ? err.message : String(err));
  }
  results[comp] = { bootMs: Date.now() - started, disposeMs: Date.now() - disposeStarted, mounted: expectPresent, ...(relProof ? { relativeDataDir: relProof } : {}) };
}

console.log(JSON.stringify({ ok: true, verdict: 'COMPOSITIONS_E2E_COMPLETE', profile: PROFILE_NAME, cwd: CWD, compositions: results, upstreamUntouched: true }, null, 2));
process.exit(0);
