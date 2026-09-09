/**
 * dsh-supreme/suite/surface-audit — v1.2 (ECC AgentShield analogue, KEPT
 * OFFLINE + DETERMINISTIC — no network, no LLM, pure file scanning).
 *
 * Six audited surfaces (ECC AgentShield: prompts, hooks, MCP, permissions,
 * secrets, agent files), adapted to the Supreme architecture:
 *
 *  1. prompts       — every string that can reach model context from shipped
 *                     configs (projectKnowledge, examples) is secret-free.
 *  2. hooks         — every event seam registered via ctx.on(...) in plugin
 *                     sources belongs to the OFFICIAL pinned upstream Events
 *                     map (no invented seams).
 *  3. mcp           — shipped configs declare NO MCP server rows (Supreme
 *                     ships none; one appearing is a finding).
 *  4. permissions   — production configs never enable paid/trial/commands/
 *                     network/LAB execution class (lab files are exempt).
 *  5. secrets       — sentinel + credential-pattern scan over generated
 *                     artifacts (data/, dist/) and shipped configs.
 *  6. agent files   — every delegation scope in plugin sources pins
 *                     secretPolicy: 'DENY_ALL' (engine also hard-throws).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SIX_SURFACE_NAMES, type SixSurfaceName } from './schema-contract';

export interface SurfaceResult {
  surface: SixSurfaceName;
  label: string;
  status: 'PASS' | 'FAIL';
  findings: string[];
  scanned: number;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['secret-sentinel', /SECRET_SENTINEL[A-Z0-9_]*/],
  ['api-key-literal', /sk-[A-Za-z0-9]{8,}/],
  ['private-key-block', /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
  ['bearer-header', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8,}/],
  ['password-assignment', /password\s*[:=]\s*['"]?[^\s'"]{4,}/i],
  ['api-key-assignment', /api[-_]?key\s*[:=]\s*['"]?[^\s'"]{4,}/i],
];

/**
 * Strict variants for scanning CODE (dist bundles): a bare `[:=]` + value
 * pattern would match the detector regex literals themselves (e.g.
 * `/password\s*[:=]/i`), so code is scanned for quoted values only.
 */
const SECRET_PATTERNS_STRICT: Array<[string, RegExp]> = [
  ['api-key-literal', /sk-[A-Za-z0-9]{8,}/],
  ['private-key-block', /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
  ['bearer-header', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{8,}/],
  ['password-assignment', /password\s*[:=]\s*['"][^\s'"]{4,}['"]/i],
  ['api-key-assignment', /api[-_]?key\s*[:=]\s*['"][^\s'"]{4,}['"]/i],
];

/** Official pinned upstream event seams (Events declarations in upstream packages). */
const OFFICIAL_SEAMS = new Set([
  'session/created',
  'session/disposed',
  'session/event',
  'agent/request',
  'agent/request-error',
  'agent/assistant-stream',
  'tools/execute',
  'tools/pre-execute',
  'subagent/start',
  'subagent/end',
  'workflow/start',
  'workflow/end',
  // workflow/agent-start (V13-B) — emit site
  // packages/workflow/workflow/src/index.ts:68, pin d347e703
  // (WorkflowRunInfo + WorkflowAgentInfo{seq,label,phase?,childId}).
  'workflow/agent-start',
  // v1.3.1: pinned-verified llm stream waterfall (FIX-A) — declared around
  // EVERY adapter stream: packages/llm/llm/src/index.ts:58-74 (dispatch site
  // :1097-1107); upstream binds it itself in packages/llm/llm/src/invariant.ts:88
  // and packages/core/agent-loop/src/invariant.ts:21, pin d347e703.
  'llm/stream',
]);

const PRODUCTION_CONFIGS = [
  'cordis.patch.yml',
  'config/core.cordis.yml',
  'config/standard.cordis.yml',
  'config/supreme.cordis.yml',
  'config/compositions/core.patch.yml',
  'config/compositions/standard.patch.yml',
  'config/compositions/supreme.patch.yml',
];

const FORBIDDEN_PRODUCTION_PATTERNS: Array<[string, RegExp]> = [
  ['allowPaid=true in production config', /allowPaid:\s*true/],
  ['allowTrial=true in production config', /allowTrial:\s*true/],
  ['allowCommands=true in production config', /allowCommands:\s*true/],
  ['allowNetwork=true in production config', /allowNetwork:\s*true/],
  ['executionClass=LAB in production config', /executionClass:\s*LAB/],
];

function walkFiles(root: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (filter(p)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

function scanTextForSecrets(where: string, text: string, findings: string[], mode: 'runtime' | 'code' = 'runtime'): void {
  // runtime mode: full patterns (incl. sentinel) — data files never contain
  // detector code, so broad matching is safe there.
  // code mode (dist): strict quoted-value patterns only — the sentinel literal
  // lives inside the scrubber regex by design (defense, not a leak) and the
  // bare assignment patterns would match the detector regex literals.
  const patterns = mode === 'runtime' ? SECRET_PATTERNS : SECRET_PATTERNS_STRICT;
  for (const [name, re] of patterns) {
    const m = text.match(re);
    if (m) findings.push(`${where}: ${name} pattern detected (${m[0].slice(0, 24)}…)`);
  }
}

export function runSurfaceAudit(supremeRoot: string): SurfaceResult[] {
  const results: SurfaceResult[] = [];

  // ---- 1. prompts ----------------------------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    const configFiles = [
      join(supremeRoot, 'cordis.patch.yml'),
      ...walkFiles(join(supremeRoot, 'config'), (p) => p.endsWith('.yml')),
    ].filter((p) => existsSync(p));
    for (const file of configFiles) {
      scanned++;
      scanTextForSecrets(rel(supremeRoot, file), readFileSync(file, 'utf8'), findings, 'runtime');
    }
    results.push({ surface: 'prompts', label: 'config-provided model-facing text is secret-free', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  // ---- 2. hooks (event seams) ----------------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    const seamRe = /ctx\.on\(\s*'([^']+)'/g;
    const sources = walkFiles(join(supremeRoot, 'src', 'plugins'), (p) => p.endsWith('.ts'));
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(seamRe)) {
        scanned++;
        const seam = m[1];
        if (!OFFICIAL_SEAMS.has(seam)) {
          findings.push(`${rel(supremeRoot, file)}: seam "${seam}" is not in the official pinned Events map`);
        }
      }
    }
    results.push({ surface: 'hooks', label: 'all ctx.on seams are official pinned upstream events', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  // ---- 3. mcp ---------------------------------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    const configFiles = [
      join(supremeRoot, 'cordis.patch.yml'),
      ...walkFiles(join(supremeRoot, 'config'), (p) => p.endsWith('.yml')),
    ].filter((p) => existsSync(p));
    const mcpRow = /(^|\s)(mcp|McpServers|mcpServers|servers):\s*(\[[^\]]*\]|\{)?/m;
    for (const file of configFiles) {
      scanned++;
      const text = readFileSync(file, 'utf8');
      const m = text.match(mcpRow);
      if (m) findings.push(`${rel(supremeRoot, file)}: MCP/server row present (Supreme ships none): "${m[0].trim().slice(0, 40)}"`);
    }
    results.push({ surface: 'mcp', label: 'shipped configs declare no MCP servers', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  // ---- 4. permissions --------------------------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    for (const relPath of PRODUCTION_CONFIGS) {
      const file = join(supremeRoot, relPath);
      if (!existsSync(file)) continue;
      scanned++;
      const text = readFileSync(file, 'utf8');
      for (const [label, re] of FORBIDDEN_PRODUCTION_PATTERNS) {
        if (re.test(text)) findings.push(`${relPath}: ${label}`);
      }
    }
    results.push({ surface: 'permissions', label: 'production configs never enable paid/trial/commands/network/LAB', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  // ---- 5. secrets ------------------------------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    const artifactFiles = walkFiles(join(supremeRoot, 'data'), (p) => p.endsWith('.jsonl') || p.endsWith('.json') || p.endsWith('.log'));
    for (const file of artifactFiles) {
      scanned++;
      scanTextForSecrets(rel(supremeRoot, file), readFileSync(file, 'utf8'), findings, 'runtime');
    }
    const distFiles = walkFiles(join(supremeRoot, 'dist'), (p) => p.endsWith('.mjs'));
    for (const file of distFiles) {
      scanned++;
      // dist: strict code mode — see scanTextForSecrets.
      scanTextForSecrets(rel(supremeRoot, file), readFileSync(file, 'utf8'), findings, 'code');
    }
    results.push({ surface: 'secrets', label: 'generated artifacts + dist are sentinel/credential-free', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  // ---- 6. agent files (delegation scopes) -------------------------------------
  {
    const findings: string[] = [];
    let scanned = 0;
    const sources = walkFiles(join(supremeRoot, 'src', 'plugins'), (p) => p.endsWith('.ts'));
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/secretPolicy\s*:\s*(?:'([^']+)'|\.default\('([^']+)'\))/g)) {
        scanned++;
        const value = m[1] ?? m[2];
        if (value !== 'DENY_ALL') {
          findings.push(`${rel(supremeRoot, file)}: secretPolicy "${value}" — must be DENY_ALL`);
        }
      }
      for (const m of text.matchAll(/secretPolicy[^,\n}]{0,80}/g)) scanned++;
    }
    results.push({ surface: 'agent_files', label: 'every delegation scope pins secretPolicy=DENY_ALL', status: findings.length === 0 ? 'PASS' : 'FAIL', findings, scanned });
  }

  if (results.length !== SIX_SURFACE_NAMES.length) {
    throw new Error(`surface audit incomplete: expected ${SIX_SURFACE_NAMES.length}, got ${results.length}`);
  }
  return results;
}
