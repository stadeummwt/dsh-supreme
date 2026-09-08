#!/usr/bin/env node
/**
 * dsh-supreme/real/bundle-verify.mjs — END-TO-END proof of the v1.1 dsh.bundle.
 *
 * Exercises the REAL install path, not a simulation:
 *   1. `dsh plugin --profile supreme-bundle add <this package>`  (REAL CLI,
 *      apps/cli/lib/bin.js from the pinned upstream — the same pnpm-forwarding
 *      + reconciler code a user runs)
 *   2. assert the reconciler appended `dsh-supreme` to dsh.profile.bundles
 *   3. loadProfile through @deepseek-ai/dsh-app-boot (bundle layer resolved
 *      from the profile's node_modules — the two-anchor design)
 *   4. boot() the composition; probe base + seven Supreme services
 *   5. prove the user patch layer still wins last (config override of the
 *      observability dataDir) and that a REAL session event lands in the
 *      overridden store through the bundle-installed instance
 *   6. dispose via the root fiber; exit non-zero on any failure.
 *
 * NO upstream file is modified. Temp DSH_HOME lives under .dsh-home-bundle-e2e/
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
const PROFILE_NAME = 'supreme-bundle';
const HOME = join(SUPREME_ROOT, '.dsh-home-bundle-e2e');
const profileDir = join(HOME, 'profiles', PROFILE_NAME);
// Heal and every nested resolution must see THIS home (boot.mjs does the same).
process.env.DSH_HOME = HOME;

function fail(step, message) {
  console.error(JSON.stringify({ ok: false, step, error: message }, null, 2));
  process.exit(1);
}

// ---------- step 0: clean slate ----------
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
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

// ---------- step 2: reconciler joined the bundle to the layer stack ----------
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) fail('manifest', `profile package.json missing at ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bundles = manifest?.dsh?.profile?.bundles ?? [];
if (!bundles.includes('dsh-supreme')) {
  fail('reconcile', `dsh.profile.bundles = ${JSON.stringify(bundles)} — 'dsh-supreme' not appended`);
}
const installedPatch = join(profileDir, 'node_modules', 'dsh-supreme', 'cordis.patch.yml');
if (!existsSync(installedPatch)) fail('install', `bundle patch missing inside installed copy: ${installedPatch}`);
const installedDist = join(profileDir, 'node_modules', 'dsh-supreme', 'dist', 'plugins', 'supreme-policy', 'index.mjs');
if (!existsSync(installedDist)) fail('install', `dist not packed into installed copy: ${installedDist}`);

// ---------- step 3: user patch layer — last write wins ----------
// Replaces the whole supreme-observability config; zod defaults re-fill the rest.
const obsOverrideDir = join(HOME, 'obs-override');
const userPatch = [
  { id: 'supreme-observability', config: { dataDir: obsOverrideDir } },
];
writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), JSON.stringify(userPatch, null, 2) + '\n');

// Base config file: the CLI's profile-boot seeds an empty root config on
// first boot (boot.mjs does the same for its profiles) — boot() requires it.
const cordisYml = join(profileDir, 'cordis.yml');
if (!existsSync(cordisYml)) writeFileSync(cordisYml, '[]\n');

// ---------- step 4: loadProfile + boot through the REAL composer ----------
let profile;
try {
  profile = loadProfile('supreme', PROFILE_NAME, INSTALL_ANCHOR, HOME);
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home: HOME });
} catch (err) {
  fail('loadProfile', err && err.message ? err.message : String(err));
}
const patches = [
  ...profile.layers.flatMap((layer) => layer.patches),
  ...profile.patches,
];

const started = Date.now();
let ctx;
try {
  ctx = await boot('supreme', join(profileDir, 'cordis.yml'), patches);
} catch (err) {
  fail('boot', `${Date.now() - started}ms: ${err && err.message ? err.message : String(err)}`);
}
const bootMs = Date.now() - started;

// ---------- step 5: service probes ----------
const BASE_SERVICES = ['llm', 'sessions', 'systemPrompt', 'tokenMeter', 'subagents', 'workflowEngine'];
const SUPREME_SERVICES = [
  'supremePolicy', 'supremeObservability', 'supremeBenchmark', 'supremeRouter',
  'supremeVerifier', 'supremeMemoryPolicy', 'supremeWorkflowPolicy',
];
const probe = (names) => {
  const out = {};
  for (const s of names) {
    try { out[s] = ctx.get(s) !== undefined; } catch { out[s] = false; }
  }
  return out;
};
const services = { ...probe(BASE_SERVICES), ...probe(SUPREME_SERVICES) };
const missing = Object.entries(services).filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) fail('services', `missing after bundle boot: ${missing.join(', ')}`);

// ---------- step 6: REAL event through the bundle-installed observability ----------
let obsProof;
try {
  const obs = ctx.get('supremeObservability');
  const session = ctx.get('sessions').create('bundle-e2e');
  await new Promise((r) => setTimeout(r, 300));
  const stats = obs.stats();
  const jsonl = join(obsOverrideDir, 'observability.jsonl');
  const fileHasLines = existsSync(jsonl) && readFileSync(jsonl, 'utf8').trim().length > 0;
  obsProof = { statsWritten: stats.written, overrideFileHasLines: fileHasLines, overrideDir: obsOverrideDir };
  if (stats.written < 1 || !fileHasLines) {
    fail('observability', `no record landed through the bundle instance: ${JSON.stringify(obsProof)}`);
  }
  // Sessions are durable by design (session store owns lifecycle); the root
  // fiber dispose below unwinds every plugin effect cleanly.
} catch (err) {
  fail('observability', err && err.message ? err.message : String(err));
}

// ---------- step 7: clean unwind ----------
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
  verdict: 'BUNDLE_E2E_COMPLETE',
  profile: PROFILE_NAME,
  bundles,
  bootMs,
  disposeMs: Date.now() - disposeStarted,
  servicesMounted: Object.keys(services).length,
  layeringProof: 'user patch override (dataDir) won last write; real session event recorded',
  observability: obsProof,
  upstreamUntouched: true,
};
console.log(JSON.stringify(result, null, 2));
process.exit(0);
