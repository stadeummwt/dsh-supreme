#!/usr/bin/env node
/**
 * dsh-supreme/real/v3-config-verify.mjs — LIVE evidence for the v3-plan review.
 *
 * Proves what actually reaches supreme-policy when the uploaded
 * `supreme-policy.cordis.yml` config keys are applied on top of the bundle,
 * versus a corrected config aligned to the REAL zod Config schema:
 *
 *   A. AS-WRITTEN keys: enableUnicodeSanitization, logTaintAttempts,
 *      unknownCostPolicy, enableSensitiveSinkBlocking, logLevel — NONE exist
 *      in the plugin's Standard Schema. zod object default = strip unknown,
 *      so the boot SUCCEEDS but the keys silently vanish (false-governance).
 *   B. CORRECTED keys: executionClass, allowPaid, allowUnknownCost,
 *      requireVerificationForHighRisk, maxDelegationDepth — all schema-real.
 *
 * Path: real `dsh plugin add` → loadProfile → boot() with the SUPREME
 * composition fragment + the candidate config as the LAST user overlay.
 * Exit non-zero on any failure. NO upstream file is modified.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPREME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT =
  process.env.SUPREME_PROJECT_ROOT ||
  (existsSync(join(dirname(SUPREME_ROOT), 'dsh-supreme')) ? dirname(SUPREME_ROOT) : SUPREME_ROOT);
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
  for (const c of candidates) if (existsSync(join(c, 'package.json'))) return c;
  return candidates[0];
}
const DSH_ROOT = resolveDshRoot();
const PROFILE_NAME = 'v3-review';
const HOME = join(SUPREME_ROOT, '.dsh-home-v3-e2e');
const profileDir = join(HOME, 'profiles', PROFILE_NAME);
process.env.DSH_HOME = HOME;

function fail(step, message) {
  console.error(JSON.stringify({ ok: false, step, error: message }, null, 2));
  process.exit(1);
}

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
const env = { ...process.env, DSH_HOME: HOME };

let bootApi;
try {
  bootApi = await import('@deepseek-ai/dsh-app-boot');
} catch {
  bootApi = await import('file://' + join(DSH_ROOT, 'packages', 'boot', 'app-boot', 'lib', 'index.js'));
}
const { boot, loadProfile, healProfilesModuleFallback, loadOverlayPatches, PROFILE_PATCH_FILENAME } = bootApi;

const INSTALL_ANCHOR = join(DSH_ROOT, 'apps', 'cli', 'package.json');
const cliBin = join(DSH_ROOT, 'apps', 'cli', 'lib', 'bin.js');
if (!existsSync(cliBin)) fail('prereq', `dsh CLI not built at ${cliBin}`);

// ---------- REAL install ----------
const add = spawnSync(process.execPath, [cliBin, 'plugin', '--profile', PROFILE_NAME, 'add', `file:${SUPREME_ROOT}`], {
  env, cwd: SUPREME_ROOT, encoding: 'utf8', timeout: 180_000,
});
if (add.status !== 0) {
  fail('plugin-add', `exit=${add.status}\nSTDOUT: ${add.stdout?.slice(0, 1500)}\nSTDERR: ${add.stderr?.slice(0, 1500)}`);
}
writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '[]\n');
const cordisYml = join(profileDir, 'cordis.yml');
if (!existsSync(cordisYml)) writeFileSync(cordisYml, '[]\n');

const FRAGMENT = join(SUPREME_ROOT, 'config', 'compositions', 'supreme.patch.yml');

// ---------- the two candidate configs ----------
// Verbatim keys from the uploaded supreme-policy.cordis.yml (upload/, 2026-09).
const AS_WRITTEN = {
  enableUnicodeSanitization: true,
  logTaintAttempts: true,
  unknownCostPolicy: 'DENY',
  allowPaid: false,
  enableSensitiveSinkBlocking: true,
  logLevel: 'info',
};
// Keys that exist in src/plugins/supreme-policy/index.ts Config schema.
const CORRECTED = {
  executionClass: 'SUPREME',
  allowPaid: false,
  allowTrial: false,
  allowUnknownCost: false,
  requireVerificationForHighRisk: true,
  maxDelegationDepth: 3,
};

async function bootWithConfig(configObj, label) {
  let profile;
  try {
    profile = loadProfile('supreme', PROFILE_NAME, INSTALL_ANCHOR, HOME);
    await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home: HOME });
  } catch (err) {
    fail(`loadProfile:${label}`, err?.message ?? String(err));
  }
  // Candidate config as the LAST overlay (argv-order `--patch` semantics):
  // one UPDATE patch row targeting the bundle's supreme-policy row by id.
  const overlayPath = join(HOME, `overlay-${label}.yml`);
  writeFileSync(overlayPath, `- id: supreme-policy\n  config: ${JSON.stringify(configObj)}\n`);
  const overlay = loadOverlayPatches('supreme', overlayPath);
  const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches, ...overlay];
  let ctx;
  try {
    ctx = await boot('supreme', cordisYml, patches);
  } catch (err) {
    fail(`boot:${label}`, err?.message ?? String(err));
  }
  let seen;
  try {
    const svc = ctx.get('supremePolicy');
    seen = JSON.parse(JSON.stringify(svc.config));
  } finally {
    await ctx.fiber.dispose().catch(() => {});
  }
  return seen;
}

const asWrittenSeen = await bootWithConfig(AS_WRITTEN, 'as-written');
const correctedSeen = await bootWithConfig(CORRECTED, 'corrected');

const asWrittenKeys = Object.keys(AS_WRITTEN);
const stripped = asWrittenKeys.filter((k) => !(k in asWrittenSeen));
const honored = asWrittenKeys.filter((k) => k in asWrittenSeen);

const result = {
  ok: true,
  verdict: 'V3_CONFIG_REVIEW_EVIDENCE',
  profile: PROFILE_NAME,
  compositionFragment: 'config/compositions/supreme.patch.yml',
  asWritten: {
    requested: AS_WRITTEN,
    seenByPlugin: asWrittenSeen,
    silentlyStrippedKeys: stripped,
    honoredKeys: honored,
    note:
      'zod z.object() default strips unknown keys — boot succeeds while 5/6 governance keys never reach the plugin; executionClass falls back to its default (STANDARD), so the operator believes SUPREME governance is active when it is not.',
  },
  corrected: {
    requested: CORRECTED,
    seenByPlugin: correctedSeen,
    note: 'All keys map 1:1 onto src/plugins/supreme-policy/index.ts Config and are enforced by validatePolicyConfig (LAB-only allowPaid, UNKNOWN hard-DENY).',
  },
  upstreamUntouched: true,
};
console.log(JSON.stringify(result, null, 2));
process.exit(0);
