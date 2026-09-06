#!/usr/bin/env node
/**
 * dsh-supreme/real/boot.mjs — project-owned REAL DSH boot harness.
 *
 * Boots a Supreme composition through the REAL pinned DSH Loader
 * (boot() from @deepseek-ai/dsh-app-boot, the same call apps/cli makes),
 * waits for gate markers, then disposes via the root fiber exactly like
 * apps/cli/src/profile-boot.ts does. NO upstream file is modified.
 *
 * Usage: node dsh-supreme/real/boot.mjs --profile <name> [--setup] [--timeout 45000]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = process.env.SUPREME_PROJECT_ROOT || '/home/z/my-project';
const DSH_ROOT = process.env.DSH_UPSTREAM_ROOT || '/home/z/deepseek-harness';
process.env.DSH_HOME = process.env.DSH_HOME || join(PROJECT_ROOT, '.dsh-home');

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : fallback;
}
const profileName = argOf('--profile', 'supreme');
const timeoutMs = Number(argOf('--timeout', '45000'));
const doSetup = argv.includes('--setup');

const { boot, loadProfile, healProfilesModuleFallback, PROFILE_PATCH_FILENAME } = await import(
  '@deepseek-ai/dsh-app-boot'
);

const INSTALL_ANCHOR = join(DSH_ROOT, 'apps', 'cli', 'package.json');
const profileDir = join(process.env.DSH_HOME, 'profiles', profileName);
const distDir = join(PROJECT_ROOT, 'dsh-supreme', 'dist', 'plugins');
const dataReal = join(PROJECT_ROOT, 'dsh-supreme', 'data', 'real');

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function setupProfile(name) {
  const templatePath = join(PROJECT_ROOT, 'dsh-supreme', 'config', `${name}.cordis.yml`);
  if (!existsSync(templatePath)) fail(`no composition template for profile "${name}"`);
  const template = readFileSync(templatePath, 'utf8')
    .replaceAll('__SUPREME_DIST__', distDir)
    .replaceAll('__PROJECT_ROOT__', PROJECT_ROOT);

  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: `supreme-profile-${name}`,
        private: true,
        dsh: { profile: { bundles: name === 'supreme-minimal' ? [] : ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), template);
  return template;
}

if (doSetup) setupProfile(profileName);

function markerLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

const dataRealFiles = ['minimal-probe', 'boot-probe-core', 'boot-probe-standard', 'gates-supreme', 'gates-lab'];
const markerStateBefore = new Map();
for (const name of dataRealFiles) {
  const p = join(dataReal, `${name}.markers.jsonl`);
  markerStateBefore.set(p, markerLines(p).length);
}

let profile;
try {
  profile = loadProfile('supreme', profileName, INSTALL_ANCHOR, process.env.DSH_HOME);
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile });
} catch (err) {
  fail(`loadProfile failed: ${err && err.message ? err.message : String(err)}`);
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
  fail(`boot failed after ${Date.now() - started}ms: ${err && err.message ? err.message : String(err)}`);
}

const bootMs = Date.now() - started;

const SERVICE_NAMES = [
  'llm', 'sessions', 'systemPrompt', 'tokenMeter', 'credentials', 'subagents', 'workflowEngine',
  'supremePolicy', 'supremeObservability', 'supremeBenchmark', 'supremeRouter',
  'supremeVerifier', 'supremeMemoryPolicy', 'supremeWorkflowPolicy',
];
const serviceProbe = {};
for (const service of SERVICE_NAMES) {
  try {
    serviceProbe[service] = ctx.get(service) !== undefined;
  } catch {
    serviceProbe[service] = false;
  }
}

async function waitForMarker(suffix, minimumNewLines, deadline) {
  const path = join(dataReal, suffix);
  while (Date.now() < deadline) {
    const lines = markerLines(path);
    const before = markerStateBefore.get(path) ?? 0;
    if (lines.length >= before + minimumNewLines) return lines.slice(before);
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const expectsGates = serviceProbe.supremeWorkflowPolicy === true;
const deadline = Date.now() + timeoutMs;
const gateLines = expectsGates
  ? await waitForMarker(profileName === 'lab' ? 'gates-lab.markers.jsonl' : 'gates-supreme.markers.jsonl', 1, deadline)
  : await waitForMarker(
      profileName === 'standard' ? 'boot-probe-standard.markers.jsonl' : 'boot-probe-core.markers.jsonl',
      1,
      deadline,
    );

// Snapshot AFTER boot settles: load markers = (run start -> now),
// dispose markers = (now -> after dispose).
const minimalPath = join(dataReal, 'minimal-probe.markers.jsonl');
const minimalAtBootSettled = markerLines(minimalPath);
const minimalMarkerBefore = markerStateBefore.get(minimalPath) ?? 0;

const disposeStarted = Date.now();
let disposeError = null;
try {
  await ctx.fiber.dispose();
} catch (err) {
  disposeError = err && err.message ? err.message : String(err);
}
const disposeMs = Date.now() - disposeStarted;

const minimalAfter = markerLines(join(dataReal, 'minimal-probe.markers.jsonl'));
const newDisposeMarkers = minimalAfter.slice(minimalMarkerBefore).filter((l) => l.includes('MINIMAL_PLUGIN_DISPOSE')).length;
const newLoadMarkers = minimalAfter.slice(minimalMarkerBefore).filter((l) => l.includes('MINIMAL_PLUGIN_LOAD')).length;

const result = {
  ok: true,
  profile: profileName,
  bootMs,
  disposeMs,
  disposeError,
  services: serviceProbe,
  minimalPlugin: { load: newLoadMarkers > 0, dispose: newDisposeMarkers > 0 },
  gates: gateLines
    ? gateLines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      })
    : null,
};

console.log(JSON.stringify(result, null, 2));
const ok =
  !disposeError &&
  (profileName === 'supreme-minimal' ? result.minimalPlugin.load && result.minimalPlugin.dispose : true) &&
  (expectsGates || profileName === 'core' || profileName === 'standard'
    ? Array.isArray(result.gates) && result.gates.length > 0
    : true);
process.exit(ok ? 0 : 1);
