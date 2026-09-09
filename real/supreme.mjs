#!/usr/bin/env node
/**
 * real/supreme.mjs — DSH SUPREME plug-and-play CLI (zero dependencies).
 *
 * ONE command experience, three verbs:
 *
 *   node real/bundle-verify.mjs        (maintainer e2e — unchanged)
 *   node real/supreme.mjs doctor       → diagnose the environment, print FIX hints
 *   node real/supreme.mjs setup        → EVERYTHING: build what's missing, install
 *                                        the bundle into a profile, apply a
 *                                        composition fragment, boot-probe it,
 *                                        print "SUPREME READY"
 *   node real/supreme.mjs verify       → run the verification ladder (gates)
 *
 * Setup is idempotent and never touches the upstream checkout (clone/pin only;
 * builds go through the official batched script). Default composition is
 * `standard` (production-conservative). See `--help` for flags.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPREME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parentDir = dirname(SUPREME_ROOT);
const PROJECT_ROOT =
  process.env.SUPREME_PROJECT_ROOT ||
  (existsSync(join(parentDir, 'dsh-supreme')) ? parentDir : SUPREME_ROOT);
const PIN = 'd347e703908d0406b7a7ef80e3a0e594d86b2215';
const COMPOSITIONS = ['core', 'standard', 'supreme', 'lab'];
const PLUGINS = [
  'supreme-policy', 'supreme-observability', 'supreme-benchmark', 'supreme-router',
  'supreme-verifier', 'supreme-memory-policy', 'supreme-workflow-policy',
  'supreme-minimal-probe', 'supreme-boot-probe', 'supreme-gate-driver', 'supreme-fake-llm',
];

// ---------- tiny UX helpers -------------------------------------------------
const useColor = !process.env.NO_COLOR && !process.argv.includes('--no-color');
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const amber = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (f) => process.argv.includes(f);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd ?? SUPREME_ROOT,
    env: opts.env ?? process.env,
    shell: opts.shell ?? false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    error: r.error?.message ?? null,
  };
}

function runner() {
  // The gate scripts are plain ESM — whatever launched THIS file can run them.
  return process.execPath;
}

// ---------- DSH root + boot api resolution (same contract as the verifiers) --
export function resolveDshRoot() {
  if (process.env.DSH_UPSTREAM_ROOT) return process.env.DSH_UPSTREAM_ROOT;
  const candidates = [
    join(PROJECT_ROOT, '..', 'deepseek-harness'),
    join(PROJECT_ROOT, 'upstream', 'deepseek-harness'),
    join(PROJECT_ROOT, 'node_modules', '.upstream', 'deepseek-harness'),
    join(SUPREME_ROOT, '..', 'deepseek-harness'),
    join(SUPREME_ROOT, '..', 'node_modules', '.upstream', 'deepseek-harness'),
  ];
  for (const cand of candidates) {
    if (existsSync(join(cand, 'package.json'))) return cand;
  }
  return null;
}

async function bootApi() {
  try {
    return await import('@deepseek-ai/dsh-app-boot');
  } catch {
    const root = resolveDshRoot();
    if (!root) throw new Error('upstream not found');
    return await import('file://' + join(root, 'packages', 'boot', 'app-boot', 'lib', 'index.js'));
  }
}

function dshHome(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  return join(homedir(), '.dsh');
}

// ---------- doctor -----------------------------------------------------------
async function doctor({ home, json } = {}) {
  const HOME = dshHome(home);
  const DSH = resolveDshRoot();
  /** @type {Array<{id:string,status:'PASS'|'FAIL'|'WARN',detail:string,fix?:string}>} */
  const checks = [];
  const add = (id, status, detail, fix) => checks.push({ id, status, detail, ...(fix ? { fix } : {}) });

  // 1. runtime
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 24 ? 'PASS' : 'WARN',
    `${process.versions.node}${nodeMajor >= 24 ? '' : ' (engines want >=24)'}`,
    nodeMajor >= 24 ? undefined : 'upgrade Node to >= 24 (dsh itself requires it)');

  const bun = run('bun', ['--version']);
  add('bun', bun.ok ? 'PASS' : 'WARN', bun.ok ? bun.stdout : 'not found',
    bun.ok ? undefined : 'install bun (https://bun.sh) — used for the suite + dist rebuild');

  const pnpm = run('pnpm', ['--version']);
  add('pnpm', pnpm.ok ? 'PASS' : 'FAIL', pnpm.ok ? pnpm.stdout : 'not found',
    pnpm.ok ? undefined : 'corepack enable && corepack prepare pnpm@11.7.0 --activate');

  // 2. upstream
  if (!DSH) {
    add('upstream', 'FAIL', 'pinned DSH checkout not found',
      'setup --with-upstream (clones + pins d347e703908d) or: git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness && git -C ../deepseek-harness checkout ' + PIN);
  } else {
    add('upstream', 'PASS', DSH);
    const commit = run('git', ['-C', DSH, 'rev-parse', 'HEAD']);
    const pinned = commit.stdout === PIN;
    add('upstream-pin', pinned ? 'PASS' : 'FAIL',
      pinned ? `${commit.stdout.slice(0, 12)} (pinned)` : `${commit.stdout.slice(0, 12) || 'unknown'} != ${PIN.slice(0, 12)}`,
      pinned ? undefined : `git -C ${DSH} checkout ${PIN}`);
    const cliBuilt = existsSync(join(DSH, 'apps', 'cli', 'lib', 'bin.js'));
    add('dsh-cli', cliBuilt ? 'PASS' : 'FAIL',
      cliBuilt ? 'apps/cli/lib/bin.js present' : 'dsh CLI not built',
      cliBuilt ? undefined : 'run: node real/supreme.mjs setup (builds the upstream via the official batched script)');
    const bootLib = existsSync(join(DSH, 'packages', 'boot', 'app-boot', 'lib', 'index.js'));
    add('dsh-lib', bootLib ? 'PASS' : 'FAIL', bootLib ? 'app-boot lib present' : 'lib not built',
      bootLib ? undefined : 'run: node real/supreme.mjs setup');
  }

  // 3. our side
  const distMissing = PLUGINS.filter((p) => !existsSync(join(SUPREME_ROOT, 'dist', 'plugins', p, 'index.mjs')));
  add('dist', distMissing.length === 0 ? 'PASS' : 'FAIL',
    distMissing.length === 0 ? `${PLUGINS.length}/${PLUGINS.length} plugins bundled` : `missing: ${distMissing.join(', ')}`,
    distMissing.length === 0 ? undefined : 'run: node real/supreme.mjs setup (rebuilds dist with bun)');

  const bootImportable = await (async () => {
    try { await import('@deepseek-ai/dsh-app-boot'); return true; } catch { return false; }
  })();
  add('boot-import', bootImportable ? 'PASS' : 'WARN',
    bootImportable ? '@deepseek-ai/dsh-app-boot resolves' : 'node_modules/@deepseek-ai links missing (verifiers fall back to file: paths)',
    bootImportable ? undefined : 'run: node real/supreme.mjs setup (creates the two symlinks)');

  // 4. profiles + bundle registration
  const profilesDir = join(HOME, 'profiles');
  let profiles = [];
  if (existsSync(profilesDir)) {
    try {
      profiles = readdirSync(profilesDir).filter((p) => {
        try { return statSync(join(profilesDir, p)).isDirectory(); } catch { return false; }
      });
    } catch { profiles = []; }
  }
  const supremeProfiles = [];
  for (const p of profiles) {
    try {
      const manifest = JSON.parse(readFileSync(join(profilesDir, p, 'package.json'), 'utf8'));
      const bundles = manifest?.dsh?.profile?.bundles ?? [];
      if (bundles.includes('dsh-supreme')) supremeProfiles.push(p);
    } catch { /* unreadable profile — skip */ }
  }
  add('profiles', supremeProfiles.length > 0 ? 'PASS' : 'WARN',
    supremeProfiles.length > 0 ? `dsh-supreme installed in: ${supremeProfiles.join(', ')}` : profiles.length ? `profiles exist but none has dsh-supreme: ${profiles.join(', ')}` : `no profiles under ${profilesDir}`,
    supremeProfiles.length > 0 ? undefined : 'run: node real/supreme.mjs setup --profile <name>');

  // 5. write probe in DSH_HOME (records/observability need it)
  try {
    const probe = join(HOME, `.write-probe-${Date.now()}`);
    mkdirSync(HOME, { recursive: true });
    writeFileSync(probe, 'ok\n');
    rmSync(probe);
    add('home-writable', 'PASS', HOME);
  } catch (err) {
    add('home-writable', 'FAIL', `${HOME}: ${err?.message ?? err}`,
      'fix permissions or pass --home <dir> / set DSH_HOME');
  }

  const criticalFail = checks.filter((k) => k.status === 'FAIL');
  const verdict = criticalFail.length === 0 ? 'READY' : 'ACTION-NEEDED';

  if (json) {
    console.log(JSON.stringify({ verdict, home: HOME, upstream: DSH, checks }, null, 2));
  } else {
    console.log(bold('DSH SUPREME — doctor'));
    console.log(dim(`  home=${HOME}`));
    console.log(dim(`  upstream=${DSH ?? 'NOT FOUND'}`));
    for (const k of checks) {
      const tag = k.status === 'PASS' ? green('PASS') : k.status === 'WARN' ? amber('WARN') : red('FAIL');
      console.log(`  ${tag}  ${k.id.padEnd(14)} ${k.detail}`);
      if (k.fix) console.log(`        ${amber('↳ fix:')} ${k.fix}`);
    }
    console.log('');
    console.log(verdict === 'READY'
      ? `${green(bold('READY'))} — ${dim('next: node real/supreme.mjs setup')}`
      : `${red(bold('ACTION-NEEDED'))} — ${dim('run: node real/supreme.mjs setup  (it auto-fixes everything above)')}`);
  }
  return { verdict, checks };
}

// ---------- setup ------------------------------------------------------------
function rebuildDist() {
  console.log(bold('▸ rebuilding dist/ (bun)'));
  for (const p of PLUGINS) {
    const r = run('bun', ['build', `src/plugins/${p}/index.ts`, '--outfile', `dist/plugins/${p}/index.mjs`, '--format', 'esm', '--target', 'node', '--external', 'zod']);
    if (!r.ok) return { ok: false, plugin: p, stderr: r.stderr || r.error };
  }
  return { ok: true };
}

function ensureLinks() {
  const DSH = resolveDshRoot();
  if (!DSH) return { ok: false, reason: 'no upstream' };
  const dir = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai');
  mkdirSync(dir, { recursive: true });
  const links = [
    ['dsh-app-boot', join(DSH, 'packages', 'boot', 'app-boot')],
    ['cordis', join(DSH, 'vendor', 'cordis')],
  ];
  const made = [];
  for (const [name, target] of links) {
    const dest = join(dir, name);
    if (!existsSync(dest) && existsSync(target)) {
      try { symlinkSync(target, dest, 'dir'); made.push(name); } catch { /* junction on win via fs.symlink needs perms; non-fatal (file: fallback exists) */ }
    }
  }
  return { ok: true, made };
}

function buildUpstream(DSH) {
  console.log(bold('▸ building pinned upstream (official batched build — this can take several minutes)'));
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  const nodeModules = join(DSH, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.log(dim('  pnpm install …'));
    let r = run('pnpm', ['install'], { cwd: DSH, env, timeout: 600_000 });
    if (!r.ok) r = run('corepack', ['pnpm', 'install'], { cwd: DSH, env, timeout: 600_000 });
    if (!r.ok) return { ok: false, step: 'pnpm install', stderr: r.stderr || r.error };
  }
  console.log(dim('  tsc (batched) + tsdown host/client …'));
  const r = run('bun', ['run', 'build:upstream'], { cwd: SUPREME_ROOT, env, timeout: 3_600_000 });
  if (!r.ok) return { ok: false, step: 'build:upstream', stderr: (r.stderr || r.error || '').slice(-2000) };
  return { ok: true };
}

function cloneUpstream() {
  const target = join(PROJECT_ROOT, '..', 'deepseek-harness');
  console.log(bold(`▸ cloning pinned upstream → ${target}`));
  let r = run('git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', target], { timeout: 600_000 });
  if (!r.ok) return { ok: false, step: 'clone', stderr: r.stderr || r.error };
  r = run('git', ['-C', target, 'checkout', PIN], { timeout: 120_000 });
  if (!r.ok) return { ok: false, step: 'pin', stderr: r.stderr || r.error };
  return { ok: true, target };
}

async function setup({ profile = 'supreme', composition = 'standard', home, force, json } = {}) {
  if (!COMPOSITIONS.includes(composition)) {
    console.error(red(`unknown composition '${composition}' — choose one of: ${COMPOSITIONS.join(', ')}`));
    process.exit(2);
  }
  const HOME = dshHome(home);
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? green('OK') : red('FAIL')}  ${name}${detail ? dim(` — ${detail}`) : ''}`);
  };

  console.log(bold(`DSH SUPREME — setup (profile=${profile}, composition=${composition})`));

  // 1. upstream present + built?
  let DSH = resolveDshRoot();
  if (!DSH && !hasFlag('--no-upstream-build')) {
    const cloned = cloneUpstream();
    step('upstream-clone', cloned.ok, cloned.ok ? cloned.target : cloned.stderr);
    if (!cloned.ok) return finishSetup(false, steps, json);
    DSH = resolveDshRoot();
  }
  if (!DSH) return finishSetup(false, [...steps, { name: 'upstream', ok: false, detail: 'not found and --no-upstream-build set' }], json);

  const cliBuilt = existsSync(join(DSH, 'apps', 'cli', 'lib', 'bin.js'));
  if (!cliBuilt && !hasFlag('--no-upstream-build')) {
    const built = buildUpstream(DSH);
    step('upstream-build', built.ok, built.ok ? 'tsdown host+client complete' : `${built.step}: ${built.stderr ?? ''}`.trim());
    if (!built.ok) return finishSetup(false, steps, json);
  } else {
    step('upstream-build', cliBuilt, cliBuilt ? 'already built' : 'skipped (--no-upstream-build)');
  }
  const cliBin = join(DSH, 'apps', 'cli', 'lib', 'bin.js');
  if (!existsSync(cliBin)) return finishSetup(false, steps, json);

  // 2. our dist + links
  const distMissing = PLUGINS.filter((p) => !existsSync(join(SUPREME_ROOT, 'dist', 'plugins', p, 'index.mjs')));
  if (distMissing.length > 0) {
    const r = rebuildDist();
    step('dist-build', r.ok, r.ok ? `${PLUGINS.length} plugins bundled` : `${r.plugin}: ${r.stderr?.slice(0, 200)}`);
    if (!r.ok) return finishSetup(false, steps, json);
  } else {
    step('dist-build', true, 'already bundled');
  }
  const links = ensureLinks();
  step('links', links.ok, links.ok ? (links.made?.length ? `created: ${links.made.join(', ')}` : 'present') : links.reason);

  // 3. REAL `dsh plugin add` into the profile
  mkdirSync(HOME, { recursive: true });
  const env = { ...process.env, DSH_HOME: HOME };
  const anchor = join(DSH, 'apps', 'cli', 'package.json');
  const add = run(process.execPath, [cliBin, 'plugin', '--profile', profile, 'add', `file:${SUPREME_ROOT}`], { env, cwd: SUPREME_ROOT, timeout: 300_000 });
  step('plugin-add', add.ok, add.ok ? `dsh-supreme → profile '${profile}'` : (add.stderr || add.error || `exit ${add.status}`).slice(0, 300));
  if (!add.ok) return finishSetup(false, steps, json);

  const profileDir = join(HOME, 'profiles', profile);

  // 4. composition fragment as the profile patch layer (never clobber)
  const { PROFILE_PATCH_FILENAME } = await bootApi();
  const patchFile = join(profileDir, PROFILE_PATCH_FILENAME || 'cordis.patch.yml');
  const fragment = readFileSync(join(SUPREME_ROOT, 'config', 'compositions', `${composition}.patch.yml`), 'utf8');
  let patchState = 'written';
  let patchConflict = false;
  if (existsSync(patchFile) && !force) {
    const current = readFileSync(patchFile, 'utf8');
    if (current === fragment) {
      patchState = 'already-applied';
    } else {
      patchState = 'kept-yours';
      patchConflict = true;
    }
  } else {
    writeFileSync(patchFile, fragment.endsWith('\n') ? fragment : fragment + '\n');
  }
  step('composition', true, `${composition} → ${PROFILE_PATCH_FILENAME || 'cordis.patch.yml'} (${patchState}${patchConflict ? '; YOUR existing patch layer was kept — the requested composition is NOT applied until you merge it or re-run with --force' : ''})`);

  // 5. cordis.yml seed (boot requires a root config)
  const cordisYml = join(profileDir, 'cordis.yml');
  if (!existsSync(cordisYml)) writeFileSync(cordisYml, '[]\n');

  // 6. REAL boot probe through the installed bundle: mount, record, drain, dispose
  console.log(bold('▸ boot probe (real loader, real bundle instance)'));
  const probe = await bootProbe({ HOME, anchor, profileDir, profile, patchFile });
  const effective = effectiveComposition(probe.mounted ?? []);
  if (probe.ok && patchConflict && effective !== composition) {
    console.log(amber(`  ⚠  effective composition is '${effective}' (your kept patch layer), not the requested '${composition}' — re-run with --force to apply it`));
  }
  step('boot-probe', probe.ok, probe.detail);
  if (!probe.ok) return finishSetup(false, steps, json);

  return finishSetup(true, steps, json, { profile, composition, home: HOME, probe });
}

async function bootProbe({ HOME, anchor, profileDir, profile, patchFile }) {
  let api;
  try { api = await bootApi(); } catch (err) { return { ok: false, detail: `boot api import: ${err.message}` }; }
  const { boot, loadProfile, healProfilesModuleFallback } = api;
  let profileObj;
  try {
    profileObj = loadProfile('supreme', profile, anchor, HOME);
    await healProfilesModuleFallback({ installAnchor: anchor, profile: profileObj, home: HOME });
  } catch (err) { return { ok: false, detail: `loadProfile: ${err.message ?? err}` }; }
  const { loadOverlayPatches } = api;
  let patches = [...profileObj.layers.flatMap((l) => l.patches), ...profileObj.patches];
  try {
    if (loadOverlayPatches && patchFile) patches = [...patches, ...loadOverlayPatches('supreme', patchFile)];
  } catch { /* patch layer is optional at probe time */ }

  const started = Date.now();
  let ctx;
  try {
    ctx = await boot('supreme', join(profileDir, 'cordis.yml'), patches);
  } catch (err) { return { ok: false, detail: `boot: ${err.message ?? err}` }; }
  try {
    const all = ['supremePolicy', 'supremeObservability', 'supremeBenchmark', 'supremeRouter', 'supremeVerifier', 'supremeMemoryPolicy', 'supremeWorkflowPolicy'];
    const mounted = all.filter((s) => { try { return ctx.get(s) !== undefined; } catch { return false; } });
    if (mounted.length === 0) return { ok: false, detail: 'no supreme services mounted' };
    const obs = ctx.get('supremeObservability');
    const session = ctx.get('sessions')?.create?.('supreme-setup-probe');
    let final = null;
    if (obs && session) {
      const { awaitObsRecord, fileHasLines: fhl } = await import('./lib/obs-proof.mjs');
      final = await awaitObsRecord(obs, { timeoutMs: 10_000 });
      if (final.written < 1) return { ok: false, detail: `no observability record landed (dropped=${final.dropped}, lastWriteError=${JSON.stringify(final.lastWriteError)}) — see real/bundle-verify.mjs diagnosis` };
    }
    await ctx.fiber.dispose();
    return {
      ok: true,
      detail: `${mounted.length}/7 supreme services · obs written=${final ? final.written : 'n/a'} · boot=${Date.now() - started}ms`,
      mounted,
    };
  } catch (err) {
    try { await ctx.fiber.dispose(); } catch { /* ignore */ }
    return { ok: false, detail: err.message ?? String(err) };
  }
}

/** Map the mounted supreme services back to a composition name (best effort). */
function effectiveComposition(mounted) {
  const n = mounted.length;
  if (n >= 7) return 'supreme';
  if (n >= 4) return 'standard';
  if (n >= 1) return 'core';
  return 'none';
}

function finishSetup(ok, steps, json, extra = {}) {
  if (json) {
    console.log(JSON.stringify({ ok, steps, ...extra }, null, 2));
  } else {
    console.log('');
    if (ok) {
      console.log(green(bold('SUPREME READY')) + dim(` — profile '${extra.profile}' (${extra.composition}) at ${extra.home}`));
      console.log('');
      console.log('  Run your governed harness with:');
      console.log(`    ${bold(`dsh --profile ${extra.profile}`)}`);
      console.log(dim('  (all seven plugins mount automatically from the bundle layer;'));
      console.log(dim(`   recompose anytime: node real/supreme.mjs setup --composition core|standard|supreme|lab)`));
    } else {
      console.log(red(bold('SETUP INCOMPLETE')) + dim(' — fix the failing step above, then re-run (idempotent).'));
    }
  }
  process.exit(ok ? 0 : 1);
}

// ---------- verify -----------------------------------------------------------
// Runner contract mirrors package.json: v13/v131/suite import TypeScript
// directly and MUST run under bun; the four node-native gates run under node
// (bun's transpiler has been observed crashing on upstream TS sources).
const GATES = {
  bundle: { args: ['real/bundle-verify.mjs'], marker: 'BUNDLE_E2E_COMPLETE', needs: 'node' },
  composition: { args: ['real/composition-verify.mjs'], marker: 'COMPOSITIONS_E2E_COMPLETE', needs: 'node' },
  v3: { args: ['real/v3-config-verify.mjs'], marker: 'V3_CONFIG_REVIEW_EVIDENCE', needs: 'node' },
  v12: { args: ['real/v12-config-verify.mjs'], marker: 'V12_E2E_COMPLETE', needs: 'node' },
  'v13:policy': { args: ['real/v13-policy-verify.mjs'], marker: 'V13_POLICY_E2E_COMPLETE', needs: 'bun' },
  'v13:workflow': { args: ['real/v13-workflow-verify.mjs'], marker: 'V13_WORKFLOW_E2E_COMPLETE', needs: 'bun' },
  'v13:routing': { args: ['real/v13-routing-verify.mjs'], marker: 'V13_ROUTING_E2E_COMPLETE', needs: 'bun' },
  'v131:cost': { args: ['real/v131-cost-enforce.mjs', 'verify'], marker: 'V131_COST_FIX_VERIFIED', needs: 'bun' },
  'v131:verifier': { args: ['real/v131-verifier-hardening.mjs', 'verify'], marker: 'V131_VERIFIER_FIX_VERIFIED', needs: 'bun' },
  'v131:memory': { args: ['real/v131-memory-isolation.mjs', 'verify'], marker: 'V131_MEMORY_FIX_VERIFIED', needs: 'bun' },
  'v131:a2a': { args: ['real/v131-a2a-falsepositive.mjs', 'verify'], marker: 'V131_A2A_FIX_VERIFIED', needs: 'bun' },
  'v131:evidence': { args: ['real/v131-evidence-binding.mjs', 'verify'], marker: 'V131_EVIDENCE_BINDING_VERIFIED', needs: 'bun' },
  'v131:outcome': { args: ['real/v131-outcome-routing.mjs', 'verify'], marker: 'V131_OUTCOME_ROUTING_VERIFIED', needs: 'bun' },
  'v131:failure': { args: ['real/v131-failure-injection.mjs', 'verify'], marker: 'V131_FAILURE_INJECTION_VERIFIED', needs: 'bun' },
  suite: { args: ['run', 'suite:keyless:ci'], marker: 'VERDICT', needs: 'bun' },
};
const QUICK = ['bundle', 'composition'];
const FULL = Object.keys(GATES);

async function verify({ gates, json } = {}) {
  const list = gates ?? FULL;
  const unknown = list.filter((g) => !GATES[g]);
  if (unknown.length > 0) {
    console.error(red(`unknown gate(s): ${unknown.join(', ')} — available: ${FULL.join(', ')}`));
    process.exit(2);
  }
  const bunOk = run('bun', ['--version']).ok;
  const nodeOk = run('node', ['--version']).ok;
  const results = [];
  for (const g of list) {
    const gate = GATES[g];
    // node gates: prefer the real node binary (bun's transpiler has been
    // observed crashing on upstream TS sources — v12 e2e); bun gates MUST bun.
    const nodeCmd = nodeOk ? 'node' : process.execPath;
    const cmd = gate.needs === 'bun' ? 'bun' : nodeCmd;
    if (gate.needs === 'bun' && !bunOk) {
      results.push({ gate: g, ok: false, ms: 0, marker: gate.marker, exit: -1, tail: 'requires bun (install https://bun.sh) — this gate imports TypeScript directly' });
      if (!json) console.log(`  ${red('FAIL')}  ${g.padEnd(16)} ${amber('requires bun — install https://bun.sh')}`);
      continue;
    }
    const started = Date.now();
    const out = run(cmd, gate.args, { timeout: 900_000 });
    const ms = Date.now() - started;
    const markerFound = gate.marker === 'VERDICT'
      ? /VERDICT\s+(COMPLETE|PARTIAL)/.test(out.stdout)
      : out.stdout.includes(gate.marker);
    const ok = out.ok && markerFound;
    results.push({ gate: g, ok, ms, marker: gate.marker, exit: out.status, tail: (out.stderr || out.stdout).slice(-400) });
    if (json) continue;
    console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${g.padEnd(16)} ${dim(`${ms}ms · ${markerFound ? gate.marker : 'marker missing'}`)}`);
    if (!ok) console.log(dim((out.stderr || out.stdout || '').split('\n').slice(-8).join('\n')));
  }
  const allOk = results.every((r) => r.ok);
  if (json) console.log(JSON.stringify({ ok: allOk, results }, null, 2));
  else {
    console.log('');
    console.log(allOk
      ? `${green(bold('ALL GATES PASS'))} — ${results.length}/${results.length}`
      : `${red(bold('GATES FAILED'))} — ${results.filter((r) => !r.ok).length}/${results.length} failing`);
  }
  process.exit(allOk ? 0 : 1);
}

// ---------- CLI surface ------------------------------------------------------
function help() {
  console.log(`DSH SUPREME plug-and-play CLI

  node real/supreme.mjs doctor                       diagnose environment (prints fixes)
  node real/supreme.mjs setup    [flags]             one command → SUPREME READY
      --profile <name>          (default: supreme)
      --composition <c>         core | standard | supreme | lab   (default: standard)
      --home <dir>              DSH_HOME override (default: env DSH_HOME or ~/.dsh)
      --force                   overwrite an existing profile patch layer
      --no-upstream-build       never clone/build the upstream (use what's there)
  node real/supreme.mjs verify   [flags|gates...]    run verification gates
      (no gates = full ladder; --quick = bundle + composition)
      gates: ${FULL.join(' ')}
  flags: --json  --no-color`);
}

const cmd = process.argv[2];
const json = hasFlag('--json');
const common = { home: arg('--home'), json };
switch (cmd) {
  case 'doctor': await doctor(common); break;
  case 'setup':
    await setup({
      ...common,
      profile: arg('--profile') ?? 'supreme',
      composition: arg('--composition') ?? 'standard',
      force: hasFlag('--force'),
    });
    break;
  case 'verify': {
    const rest = process.argv.slice(3).filter((a) => !a.startsWith('--'));
    const gates = hasFlag('--quick') ? QUICK : rest.length > 0 ? rest : FULL;
    await verify({ gates, json });
    break;
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    help();
    process.exit(0);
    break;
  default:
    console.error(red(`unknown command '${cmd}'`));
    help();
    process.exit(2);
}
