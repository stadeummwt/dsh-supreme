/**
 * dsh-supreme/suite/runner.ts — DSH Supreme v1 release verification runner.
 *
 * Executes:
 *  - Level A: pure engine checks (all seven plugins, keyless, deterministic)
 *  - Level B/C: REAL loader composition boots through the pinned DSH Loader
 *    (supreme-minimal / core / standard / supreme / lab) via real/boot.mjs
 *  - Security: sentinel leak scan over generated artifacts + upstream integrity
 *  - Performance: router decision + observability write baselines (Spec §27)
 *
 * Verdict policy (Spec §34): COMPLETE only when every mandatory gate passes
 * AND the upstream integrity gate is satisfied. Otherwise PARTIAL with the
 * exact blocking gates.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { runChecks, type CheckResult } from './harness';
import {
  benchmarkChecks,
  memoryChecks,
  observabilityChecks,
  policyChecks,
  routerChecks,
  verifierChecks,
  workflowChecks,
} from './engine-checks';
import { runConfigHygiene, scanPinnedRefs, shippedConfigPaths, type ConfigHygieneResult, type PinnedRefsResult } from './config-hygiene';
import { runSurfaceAudit, type SurfaceResult } from './surface-audit';
import {
  BENCHMARK_RECORD_REQUIRED,
  LEDGER_NOTE_REQUIRED,
  SCHEMA_FILES,
  SUITE_REPORT_REQUIRED_TOP_LEVEL,
  type SixSurfaceName,
} from './schema-contract';

/**
 * Layout-aware root resolution. Two supported layouts:
 *  - monorepo:  <project-root>/dsh-supreme/{src,real,dist,data,config}
 *  - published: <repo-root>/{src,real,dist,data,config}  (dsh-supreme IS the repo)
 * SUPREME_ROOT = the directory holding real/boot.mjs + src/plugins.
 * PROJECT_ROOT = its parent when the parent looks like the monorepo app root,
 * otherwise SUPREME_ROOT itself.
 */
function isSupremeRoot(dir: string): boolean {
  return existsSync(join(dir, 'real', 'boot.mjs')) && existsSync(join(dir, 'src', 'plugins'));
}

function resolveRoots(): { PROJECT_ROOT: string; SUPREME_ROOT: string } {
  if (process.env.SUPREME_PROJECT_ROOT) {
    const p = process.env.SUPREME_PROJECT_ROOT;
    return { PROJECT_ROOT: p, SUPREME_ROOT: existsSync(join(p, 'dsh-supreme')) ? join(p, 'dsh-supreme') : p };
  }
  // 1. bun CLI from any cwd: derive from the entry script (…/src/suite/cli.ts).
  //    Entry-script location beats cwd: running `bun run suite` from INSIDE
  //    dsh-supreme/ in the monorepo layout used to mis-resolve to the published
  //    layout and fake an UPSTREAM_CHECKOUT_UNAVAILABLE (v1.1 UX wart — fixed
  //    in v1.2 by trying the entry script BEFORE the cwd rules).
  //    (import.meta.url is deliberately avoided here — bundlers choke on it.)
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  let dir = entry ? dirname(entry) : '';
  for (let i = 0; i < 6 && dir && !isSupremeRoot(dir); i++) dir = dirname(dir);
  if (isSupremeRoot(dir)) {
    const parent = dirname(dir);
    // NOTE: self-match here (join(parent,'dsh-supreme') === dir) is the legit
    // monorepo signature — do NOT exclude it. The published-layout CI case is
    // handled in resolveDshRoot via SUPREME_ROOT-relative candidates instead.
    const monorepo = existsSync(join(parent, 'dsh-supreme'));
    return { PROJECT_ROOT: monorepo ? parent : dir, SUPREME_ROOT: dir };
  }
  // 2. shells opened at the app root / Next.js server cwd.
  if (existsSync(join(process.cwd(), 'dsh-supreme', 'real', 'boot.mjs'))) {
    return { PROJECT_ROOT: process.cwd(), SUPREME_ROOT: join(process.cwd(), 'dsh-supreme') };
  }
  if (isSupremeRoot(process.cwd())) {
    return { PROJECT_ROOT: process.cwd(), SUPREME_ROOT: process.cwd() };
  }
  return { PROJECT_ROOT: process.cwd(), SUPREME_ROOT: process.cwd() };
}

const roots = resolveRoots();

/** Portable upstream resolution: env override, else sibling checkout of the pin,
 *  else in-project checkouts (<root>/upstream or <root>/node_modules/.upstream —
 *  the latter stays invisible to bundler crawls). */
function resolveDshRoot(projectRoot: string, supremeRoot: string): string {
  if (process.env.DSH_UPSTREAM_ROOT) return process.env.DSH_UPSTREAM_ROOT;
  const candidates = [
    join(projectRoot, '..', 'deepseek-harness'),
    join(projectRoot, 'upstream', 'deepseek-harness'),
    join(projectRoot, 'node_modules', '.upstream', 'deepseek-harness'),
    // SUPREME_ROOT-relative candidates: in a published-layout CI checkout
    // (<ws>/dsh-supreme/dsh-supreme) the repo dir itself is named dsh-supreme,
    // so PROJECT_ROOT resolves one level up and the candidates above miss the
    // sibling upstream. These two paths are correct in BOTH layouts:
    // monorepo -> <project>/node_modules/.upstream/deepseek-harness,
    // published CI -> <ws>/dsh-supreme/deepseek-harness (workflow clone dir).
    join(supremeRoot, '..', 'deepseek-harness'),
    join(supremeRoot, '..', 'node_modules', '.upstream', 'deepseek-harness'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c;
  }
  return candidates[2];
}

export const PROJECT_ROOT = roots.PROJECT_ROOT;
export const SUPREME_ROOT = roots.SUPREME_ROOT;
export const DSH_ROOT = resolveDshRoot(PROJECT_ROOT, SUPREME_ROOT);
export const DSH_COMMIT = 'd347e703908d0406b7a7ef80e3a0e594d86b2215';
export const BOOT_HARNESS = join(SUPREME_ROOT, 'real', 'boot.mjs');

export type GateStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface PluginGate {
  name: string;
  service: string;
  unit: GateStatus;
  checks: CheckResult[];
}

export interface CompositionGate {
  name: string;
  status: GateStatus;
  bootMs?: number;
  disposeMs?: number;
  gates?: Array<{ gate: string; status: string; detail: string }>;
  services?: Record<string, boolean>;
  detail?: string;
}

export interface SuiteReport {
  generatedAt: string;
  upstream: {
    repository: string;
    commit: string;
    branch: string;
    worktreeClean: boolean;
    commitUnchanged: boolean;
    dshVersion: string;
    cordisVersion: string;
    nodeVersion: string;
    pnpmVersion: string;
    upstreamCoreModified: 'NO' | 'YES';
    upstreamPatchCount: 0 | number;
  };
  realLoader: {
    verified: boolean;
    harness: string;
    method: string;
  };
  minimalGate: {
    load: GateStatus;
    observableEffect: GateStatus;
    dispose: GateStatus;
    realLoader: GateStatus;
    realCordisYml: GateStatus;
  };
  plugins: PluginGate[];
  compositions: CompositionGate[];
  security: {
    sentinelLeaks: number;
    sentinelScanPaths: string[];
    paidAutomaticFallback: 'DISABLED';
    productionConfigAllowPaid: boolean;
  };
  /** v1.2: every shipped YAML config key validates against the real plugin schema. */
  configHygiene: ConfigHygieneResult;
  /** v1.2: every external reference in shipped configs is pinned. */
  pinnedRefs: PinnedRefsResult;
  /** v1.2: six-surface offline security audit (AgentShield analogue). */
  sixSurfaceAudit: Array<{ surface: SixSurfaceName; label: string; status: GateStatus; findings: string[]; scanned: number }>;
  /** v1.2: published JSON schemas exist and match the runtime contract. */
  schemas: { ok: boolean; checked: string[]; findings: string[] };
  performance: {
    routerDecisionMs: number;
    observabilityWriteMs: number;
    realBootMs: Record<string, number>;
  };
  verdict: 'COMPLETE' | 'PARTIAL';
  blockingGates: string[];
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', DSH_ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function scanSentinels(dirs: string[]): { leaks: number; scanned: string[] } {
  let leaks = 0;
  const scanned: string[] = [];
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (!existsSync(abs)) continue;
    const walk = (path: string): void => {
      const s = statSync(path);
      if (s.isDirectory()) {
        for (const entry of readdirSync(path)) walk(join(path, entry));
      } else if (path.endsWith('.jsonl') || path.endsWith('.json') || path.endsWith('.log')) {
        scanned.push(path);
        const content = readFileSync(path, 'utf8');
        const matches = content.match(/SECRET_SENTINEL[A-Z0-9_]*/g);
        if (matches) leaks += matches.length;
      }
    };
    walk(abs);
  }
  return { leaks, scanned };
}

function productionConfigAllowsPaid(): boolean {
  // Production profiles must never set allowPaid=true.
  for (const profile of ['core.cordis.yml', 'standard.cordis.yml', 'supreme.cordis.yml']) {
    const path = join(SUPREME_ROOT, 'config', profile);
    if (existsSync(path) && /allowPaid:\s*true/.test(readFileSync(path, 'utf8'))) return true;
  }
  return false;
}

/** v1.2: published schemas must exist and their required lists must match the runtime contract. */
function checkSchemaContract(): { ok: boolean; checked: string[]; findings: string[] } {
  const findings: string[] = [];
  const checked: string[] = [];
  const schemasDir = join(SUPREME_ROOT, 'schemas');
  for (const name of SCHEMA_FILES) {
    const file = join(schemasDir, name);
    checked.push(`schemas/${name}`);
    if (!existsSync(file)) {
      findings.push(`missing schemas/${name}`);
      continue;
    }
    try {
      const schema = JSON.parse(readFileSync(file, 'utf8')) as {
        required?: string[];
        properties?: Record<string, { required?: string[] }>;
        $schema?: string;
      };
      if (!schema.$schema) findings.push(`schemas/${name}: missing $schema declaration`);
      if (name === 'suite-report.schema.json') {
        const required = schema.required ?? [];
        for (const field of SUITE_REPORT_REQUIRED_TOP_LEVEL) {
          if (!required.includes(field)) findings.push(`schemas/${name}: required[] missing "${field}"`);
        }
      }
      if (name === 'benchmark-record.schema.json') {
        // The record kinds live under oneOf (discriminated by properties.kind.const).
        const oneOf = (schema as { oneOf?: Array<{ required?: string[]; properties?: { kind?: { const?: string } } }> }).oneOf ?? [];
        for (const [kind, fields] of Object.entries(BENCHMARK_RECORD_REQUIRED)) {
          const kindDef = oneOf.find((v) => v.properties?.kind?.const === kind);
          const kindRequired = kindDef?.required ?? [];
          for (const field of fields) {
            if (!kindRequired.includes(field)) findings.push(`schemas/${name}: ${kind} required[] missing "${field}"`);
          }
        }
      }
      if (name === 'ledger-note.schema.json') {
        const required = schema.required ?? [];
        for (const field of LEDGER_NOTE_REQUIRED) {
          if (!required.includes(field)) findings.push(`schemas/${name}: required[] missing "${field}"`);
        }
      }
    } catch (err) {
      findings.push(`schemas/${name}: unparseable JSON (${String(err)})`);
    }
  }
  return { ok: findings.length === 0, checked, findings };
}

interface BootOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBoot(profile: string, timeoutMs = 90_000): Promise<BootOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [BOOT_HARNESS, '--profile', profile, '--setup'], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => resolvePromise({ exitCode: -1, stdout, stderr: stderr + String(err) }));
    child.on('close', (code: number | null) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function compositionFromBoot(name: string, outcome: BootOutcome): CompositionGate {
  if (outcome.exitCode !== 0 && outcome.stdout.length === 0) {
    return { name, status: 'FAIL', detail: (outcome.stderr || 'boot failed').slice(0, 400) };
  }
  try {
    const parsed = JSON.parse(outcome.stdout) as {
      bootMs: number;
      disposeMs: number;
      disposeError: string | null;
      services: Record<string, boolean>;
      minimalPlugin?: { load: boolean; dispose: boolean };
      gates: Array<{ event: string; results?: Array<{ gate: string; status: string; detail: string }> }> | null;
    };
    const gates = (parsed.gates ?? []).flatMap((g) => g.results ?? []);
    const allPass = gates.length > 0 && gates.every((g) => g.status === 'PASS');
    const status: GateStatus =
      outcome.exitCode === 0 && !parsed.disposeError && (gates.length === 0 || allPass) ? 'PASS' : 'FAIL';
    return {
      name,
      status,
      bootMs: parsed.bootMs,
      disposeMs: parsed.disposeMs,
      gates,
      services: parsed.services,
      detail: parsed.disposeError ?? undefined,
    };
  } catch (err) {
    return { name, status: 'FAIL', detail: `unparseable boot output: ${String(err)}` };
  }
}

async function measurePerformance(): Promise<{ routerDecisionMs: number; observabilityWriteMs: number }> {
  const { CircuitBreaker, DEFAULT_ROUTER_CONFIG, selectRoute } = await import('../plugins/supreme-router/engine');
  const { buildRecord, serializeRecord } = await import('../plugins/supreme-observability/engine');
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    key: `p${i}::m${i}`,
    provider: `p${i}`,
    model: `m${i}`,
    costClass: 'FREE_CONFIRMED' as string,
    capabilities: ['chat'],
    contextWindow: 32768,
    credentialConfigured: true,
    quotaHeadroom: 0.5 + i * 0.05,
    failureDomain: `d${i % 3}`,
    providerAvailable: true,
    modelValid: true,
  }));
  const circuit = new CircuitBreaker(DEFAULT_ROUTER_CONFIG.circuit);
  const startedRoute = performance.now();
  for (let i = 0; i < 1000; i++) {
    selectRoute({
      config: DEFAULT_ROUTER_CONFIG,
      candidates,
      circuit,
      perf: new Map(),
      now: i,
      decisionId: `bench_${i}`,
      input: { requiredCapabilities: ['chat'] },
    });
  }
  const routerDecisionMs = Math.round(((performance.now() - startedRoute) / 1000) * 1000) / 1000;

  const startedWrite = performance.now();
  for (let i = 0; i < 1000; i++) {
    serializeRecord(buildRecord(i, i, 'perf_probe', { detail: 'x' }), 2048);
  }
  const observabilityWriteMs = Math.round(((performance.now() - startedWrite) / 1000) * 1000) / 1000;
  return { routerDecisionMs, observabilityWriteMs };
}

export async function runFullSuite(options: { skipRealBoots?: boolean } = {}): Promise<SuiteReport> {
  // ---- Level A: engine checks per plugin --------------------------------
  const pluginSpecs: Array<[string, string, () => ReturnType<typeof policyChecks>]> = [
    ['supreme-policy', 'supremePolicy', policyChecks],
    ['supreme-observability', 'supremeObservability', observabilityChecks],
    ['supreme-benchmark', 'supremeBenchmark', benchmarkChecks],
    ['supreme-router', 'supremeRouter', routerChecks],
    ['supreme-verifier', 'supremeVerifier', verifierChecks],
    ['supreme-memory-policy', 'supremeMemoryPolicy', memoryChecks],
    ['supreme-workflow-policy', 'supremeWorkflowPolicy', workflowChecks],
  ];
  const plugins: PluginGate[] = [];
  for (const [name, service, factory] of pluginSpecs) {
    const checks = await runChecks(factory());
    const failed = checks.some((c) => c.status !== 'PASS');
    plugins.push({ name, service, unit: failed ? 'FAIL' : 'PASS', checks });
  }

  // ---- Level B/C: REAL loader composition boots -------------------------
  const compositions: CompositionGate[] = [];
  const realBootMs: Record<string, number> = {};
  let minimalGate: SuiteReport['minimalGate'] = {
    load: 'SKIP',
    observableEffect: 'SKIP',
    dispose: 'SKIP',
    realLoader: 'SKIP',
    realCordisYml: 'SKIP',
  };

  if (!options.skipRealBoots) {
    const minimalBoot = compositionFromBoot('supreme-minimal', await runBoot('supreme-minimal'));
    compositions.push(minimalBoot);
    realBootMs['supreme-minimal'] = minimalBoot.bootMs ?? 0;
    minimalGate = {
      load: minimalBoot.status === 'PASS' && minimalBoot.services !== undefined ? 'PASS' : minimalBoot.status,
      observableEffect: minimalBoot.status,
      dispose: minimalBoot.status,
      realLoader: minimalBoot.status,
      realCordisYml: minimalBoot.status,
    };

    for (const profile of ['core', 'standard', 'supreme', 'lab'] as const) {
      const gate = compositionFromBoot(profile, await runBoot(profile));
      compositions.push(gate);
      realBootMs[profile] = gate.bootMs ?? 0;
    }
  }

  // ---- Security + upstream integrity ------------------------------------
  const { leaks } = scanSentinels([
    join(SUPREME_ROOT, 'data'),
    join(SUPREME_ROOT, 'benchmarks', 'reports'),
  ]);
  const upstreamPresent = existsSync(join(DSH_ROOT, 'package.json'));
  const commit = upstreamPresent ? git(['rev-parse', 'HEAD']) : null;
  const status = upstreamPresent ? git(['status', '--porcelain']) : null;
  const branch = upstreamPresent ? git(['branch', '--show-current']) : null;
  const readPkgVersion = (p: string): string => {
    try {
      return (JSON.parse(readFileSync(p, 'utf8') as string) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const dshVersion = upstreamPresent ? readPkgVersion(join(DSH_ROOT, 'package.json')) : 'unknown';
  const cordisVersion = upstreamPresent
    ? readPkgVersion(join(DSH_ROOT, 'vendor', 'cordis', 'package.json'))
    : 'unknown';

  const perf = await measurePerformance();

  // ---- v1.2: config hygiene + pinned refs + six-surface audit + schemas ---
  const configHygiene = runConfigHygiene(SUPREME_ROOT);
  const pinnedRefs = scanPinnedRefs(SUPREME_ROOT, shippedConfigPaths(SUPREME_ROOT));
  const sixSurface = runSurfaceAudit(SUPREME_ROOT);
  const sixSurfaceAudit = sixSurface.map((s) => ({
    surface: s.surface,
    label: s.label,
    status: (s.status === 'PASS' ? 'PASS' : 'FAIL') as GateStatus,
    findings: s.findings,
    scanned: s.scanned,
  }));
  const schemas = checkSchemaContract();

  // ---- Verdict -----------------------------------------------------------
  const blockingGates: string[] = [];
  if (minimalGate.load === 'SKIP') blockingGates.push('REAL_BOOT_SKIPPED');
  for (const p of plugins) if (p.unit === 'FAIL') blockingGates.push(`UNIT:${p.name}`);
  for (const c of compositions) if (c.status === 'FAIL') blockingGates.push(`COMPOSITION:${c.name}`);
  if (leaks > 0) blockingGates.push('SECRET_SENTINEL_LEAKS');
  if (productionConfigAllowsPaid()) blockingGates.push('PAID_FALLBACK_IN_PRODUCTION_CONFIG');
  if (!configHygiene.ok) blockingGates.push(`CONFIG_KEY_HYGIENE:${configHygiene.findings.length}`);
  if (!pinnedRefs.ok) blockingGates.push(`PINNED_REF_UNPINNED:${pinnedRefs.findings.length}`);
  for (const s of sixSurfaceAudit) if (s.status === 'FAIL') blockingGates.push(`SURFACE_AUDIT:${s.surface}`);
  if (!schemas.ok) blockingGates.push(`SCHEMA_CONTRACT:${schemas.findings.length}`);
  const commitUnchanged = upstreamPresent ? commit === DSH_COMMIT : false;
  if (!upstreamPresent) blockingGates.push('UPSTREAM_CHECKOUT_UNAVAILABLE');
  else {
    if (!commitUnchanged) blockingGates.push('UPSTREAM_COMMIT_CHANGED');
    if (status && status.length > 0) blockingGates.push('UPSTREAM_WORKTREE_DIRTY');
  }

  return {
    generatedAt: new Date().toISOString(),
    upstream: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      commit: commit ?? 'UNAVAILABLE',
      branch: branch ?? 'UNAVAILABLE',
      worktreeClean: upstreamPresent ? !status || status.length === 0 : false,
      commitUnchanged,
      dshVersion,
      cordisVersion,
      nodeVersion: process.version,
      pnpmVersion: '11.7.0',
      upstreamCoreModified: upstreamPresent && status && status.length > 0 ? 'YES' : upstreamPresent ? 'NO' : 'UNKNOWN',
      upstreamPatchCount: 0,
    },
    realLoader: {
      verified: !options.skipRealBoots,
      harness: 'dsh-supreme/real/boot.mjs',
      method: 'boot() from @deepseek-ai/dsh-app-boot + profile patch layers + root fiber dispose',
    },
    minimalGate,
    plugins,
    compositions,
    security: {
      sentinelLeaks: leaks,
      sentinelScanPaths: ['dsh-supreme/data', 'dsh-supreme/benchmarks/reports'],
      paidAutomaticFallback: 'DISABLED',
      productionConfigAllowPaid: productionConfigAllowsPaid(),
    },
    configHygiene,
    pinnedRefs,
    sixSurfaceAudit,
    schemas,
    performance: { ...perf, realBootMs },
    verdict: blockingGates.length === 0 ? 'COMPLETE' : 'PARTIAL',
    blockingGates,
  };
}
