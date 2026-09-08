/**
 * dsh-supreme/suite/config-hygiene — v1.2 backlog #1 (v3-plan review).
 *
 * The silent-strip trap: zod z.object() strips unknown keys, so a config
 * typo boots fine, logs fine, and the intended governance layer simply does
 * not exist (proven live by real/v3-config-verify.mjs — 5/6 keys stripped).
 *
 * This check closes the trap: every `row.config` in every shipped YAML is
 * validated against the plugin's REAL Config schema (imported from the
 * adapter module — no drift possible):
 *   - unknown keys           → finding (they would be silently stripped),
 *   - value-level violations → finding (schema.safeParse),
 *   - unknown plugin ids     → finding unless explicitly allowlisted.
 *
 * The same module enforces the pinned-ref rule (v3 plan §4B): any external
 * URL/git reference inside shipped configs must carry a pinned commit sha or
 * semver tag — the same pinning discipline the suite applies to upstream.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import { Config as policyConfigSchema } from '../plugins/supreme-policy/index';
import { Config as observabilityConfigSchema } from '../plugins/supreme-observability/index';
import { Config as benchmarkConfigSchema } from '../plugins/supreme-benchmark/index';
import { Config as routerConfigSchema } from '../plugins/supreme-router/index';
import { Config as verifierConfigSchema } from '../plugins/supreme-verifier/index';
import { Config as memoryConfigSchema } from '../plugins/supreme-memory-policy/index';
import { Config as workflowConfigSchema } from '../plugins/supreme-workflow-policy/index';
import { Config as fakeLlmConfigSchema } from '../plugins/supreme-fake-llm/index';
import { Config as minimalProbeConfigSchema } from '../plugins/supreme-minimal-probe/index';
import { Config as bootProbeConfigSchema } from '../plugins/supreme-boot-probe/index';
import { Config as gateDriverConfigSchema } from '../plugins/supreme-gate-driver/index';

interface ZodLikeIssue {
  path: PropertyKey[];
  message: string;
}

interface ZodLikeSchema {
  shape: Record<string, unknown>;
  safeParse: (v: unknown) => { success: boolean; error?: { issues: ZodLikeIssue[] } };
}

const SCHEMAS_BY_ID: Record<string, ZodLikeSchema> = {
  'supreme-policy': policyConfigSchema as never,
  'supreme-observability': observabilityConfigSchema as never,
  'supreme-benchmark': benchmarkConfigSchema as never,
  'supreme-router': routerConfigSchema as never,
  'supreme-verifier': verifierConfigSchema as never,
  'supreme-memory-policy': memoryConfigSchema as never,
  'supreme-workflow-policy': workflowConfigSchema as never,
  'supreme-fake-llm': fakeLlmConfigSchema as never,
  'supreme-minimal-probe': minimalProbeConfigSchema as never,
  'supreme-boot-probe': bootProbeConfigSchema as never,
  'supreme-gate-driver': gateDriverConfigSchema as never,
};

/** Fixture/probe rows that may appear in shipped configs without a schema entry. */
const ID_ALLOWLIST = new Set(['dsh-base']);

export interface ConfigRowFinding {
  file: string;
  rowId: string;
  kind: 'UNKNOWN_KEY' | 'SCHEMA_VIOLATION' | 'UNKNOWN_PLUGIN_ID';
  detail: string;
}

export interface ConfigFileResult {
  file: string;
  rows: number;
  ok: boolean;
}

export interface ConfigHygieneResult {
  ok: boolean;
  files: ConfigFileResult[];
  findings: ConfigRowFinding[];
  scanned: string[];
}

function listYamlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith('.yml') || entry.endsWith('.yaml')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** All shipped YAML configs (bundle patch + compositions + profiles + examples). */
export function shippedConfigPaths(supremeRoot: string): string[] {
  const files = [join(supremeRoot, 'cordis.patch.yml'), ...listYamlFiles(join(supremeRoot, 'config'))];
  return files.filter((f) => existsSync(f)).sort();
}

function schemaKeys(schema: unknown): string[] {
  // ZodObject exposes its key set as `.shape` — no drift with the real schema.
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape) return [];
  return Object.keys(shape);
}

function validateRow(file: string, row: unknown): ConfigRowFinding[] {
  const findings: ConfigRowFinding[] = [];
  if (!row || typeof row !== 'object') return findings;
  const rec = row as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id : '(no-id)';
  const schema = SCHEMAS_BY_ID[id];
  if (!schema) {
    if (!ID_ALLOWLIST.has(id) && rec.config !== undefined) {
      findings.push({ file, rowId: id, kind: 'UNKNOWN_PLUGIN_ID', detail: 'row carries config but the plugin id has no known schema' });
    }
    return findings;
  }
  const config = rec.config ?? {};
  if (typeof config !== 'object' || config === null) {
    findings.push({ file, rowId: id, kind: 'SCHEMA_VIOLATION', detail: 'config must be an object' });
    return findings;
  }
  const known = new Set(schemaKeys(schema));
  for (const key of Object.keys(config as Record<string, unknown>)) {
    if (!known.has(key)) {
      findings.push({
        file,
        rowId: id,
        kind: 'UNKNOWN_KEY',
        detail: `key "${key}" is not in the ${id} Config schema — zod would silently strip it`,
      });
    }
  }
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const detail = (parsed.error?.issues ?? [])
      .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    findings.push({ file, rowId: id, kind: 'SCHEMA_VIOLATION', detail: detail || 'schema parse failed' });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Pinned-ref enforcement (v3 plan §4B): every external reference in shipped
// configs must be pinned to a commit sha or a semver tag.
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"')\]]+/g;
const GITHUB_SPEC_RE = /github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s"')\]]*)?/g;
const SHA_RE = /[a-f0-9]{40}/;
const SEMVER_RE = /@v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export interface PinnedRefFinding {
  where: string;
  ref: string;
  detail: string;
}

export interface PinnedRefsResult {
  ok: boolean;
  refs: Array<{ where: string; ref: string; pinned: boolean }>;
  findings: PinnedRefFinding[];
}

export function scanPinnedRefs(supremeRoot: string, files: string[]): PinnedRefsResult {
  const refs: PinnedRefsResult['refs'] = [];
  const findings: PinnedRefFinding[] = [];
  for (const file of files) {
    const rel = file.startsWith(supremeRoot) ? file.slice(supremeRoot.length + 1) : file;
    const content = readFileSync(file, 'utf8');
    const found = new Set<string>([...(content.match(URL_RE) ?? []), ...(content.match(GITHUB_SPEC_RE) ?? [])]);
    for (const raw of found) {
      const ref = raw.replace(/[.,;]+$/, '');
      // Self-references to the Supreme repo (docs/comments) are exempt — the
      // repo itself is the artifact being distributed.
      const selfRef = ref.includes('stadeummwt/dsh-supreme');
      const pinned = SHA_RE.test(ref) || SEMVER_RE.test(ref);
      refs.push({ where: rel, ref, pinned: pinned || selfRef });
      if (!pinned && !selfRef) {
        findings.push({ where: rel, ref, detail: 'external reference is not pinned (needs 40-hex sha or @semver tag)' });
      }
    }
  }
  return { ok: findings.length === 0, refs, findings };
}

/** Full config-key hygiene pass over every shipped YAML config. */
export function runConfigHygiene(supremeRoot: string): ConfigHygieneResult {
  const files = shippedConfigPaths(supremeRoot);
  const allFindings: ConfigRowFinding[] = [];
  const fileResults: ConfigFileResult[] = [];
  const scanned: string[] = [];
  for (const file of files) {
    const rel = file.startsWith(supremeRoot) ? file.slice(supremeRoot.length + 1) : file;
    scanned.push(rel);
    let rows: unknown[] = [];
    try {
      const parsed = parse(readFileSync(file, 'utf8'));
      rows = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed];
    } catch (err) {
      allFindings.push({ file: rel, rowId: '(parse)', kind: 'SCHEMA_VIOLATION', detail: `unparseable YAML: ${String(err)}` });
      fileResults.push({ file: rel, rows: 0, ok: false });
      continue;
    }
    let fileOk = true;
    for (const row of rows) {
      const findings = validateRow(rel, row);
      if (findings.length > 0) fileOk = false;
      allFindings.push(...findings);
    }
    fileResults.push({ file: rel, rows: rows.length, ok: fileOk });
  }
  return { ok: allFindings.length === 0, files: fileResults, findings: allFindings, scanned };
}
