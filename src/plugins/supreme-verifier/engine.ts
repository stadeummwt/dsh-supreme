/**
 * @dsh-supreme/verifier — validator registry engine.
 *
 * Principle (Spec §12 original): DETERMINISTIC EVIDENCE > MODEL SELF-CONFIDENCE.
 *
 * Security boundary:
 *  - never bypasses DSH sandbox/permissions/approval; command execution is
 *    opt-in (allowCommands) AND requires executionClass=LAB policy evidence;
 *  - file validators are path-confined to configured allowedRoots;
 *  - unsupported capability → UNAVAILABLE, never a fabricated PASS;
 *  - validator exceptions → ERROR (fail visible), not crashes;
 *  - evidence is bounded and secret-sentinel scrubbed.
 */

export const VALIDATOR_TYPES = [
  'exact-text',
  'regex',
  'json-parse',
  'json-schema',
  'file-exists',
  'file-hash',
  'command-exit',
  'test-suite',
] as const;
export type ValidatorType = (typeof VALIDATOR_TYPES)[number];

export const VERIFIER_STATUSES = ['PASS', 'FAIL', 'ERROR', 'UNAVAILABLE'] as const;
export type VerifierStatus = (typeof VERIFIER_STATUSES)[number];

export const MAX_EVIDENCE_CHARS = 512;

export interface VerifierConfig {
  /** Command execution is disabled by default and only honored for LAB policy. */
  allowCommands: boolean;
  /** Network-backed validators are disabled by default. */
  allowNetwork: boolean;
  /** Path confinement for file validators (absolute paths). */
  allowedRoots: string[];
  commandTimeoutMs: number;
}

export const VERIFIER_DEFAULTS: VerifierConfig = {
  allowCommands: false,
  allowNetwork: false,
  allowedRoots: [],
  commandTimeoutMs: 30_000,
};

export interface VerifierResult {
  validatorId: string;
  type: ValidatorType;
  status: VerifierStatus;
  evidence: string;
  durationMs: number;
  reasonCode: string;
}

export interface VerifierSpec {
  validatorId: string;
  type: ValidatorType;
  config: Record<string, unknown>;
}

export class VerifierConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid verifier config/spec: ${issues.join('; ')}`);
    this.name = 'VerifierConfigError';
  }
}

/** Scrub synthetic sentinels + bound length. Deterministic. */
export function sanitizeEvidence(evidence: string, max = MAX_EVIDENCE_CHARS): string {
  const scrubbed = evidence.replace(/SECRET_SENTINEL[A-Z0-9_]*/g, '[REDACTED]');
  return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
}

export interface VerifierRuntime {
  fsExists(path: string): Promise<boolean>;
  fsRead(path: string): Promise<string | null>;
  sha256(path: string): Promise<string | null>;
  exec(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Path confinement: resolved path must live inside one of the allowed roots. */
export function pathIsAllowed(path: string, allowedRoots: string[], pathMod: { resolve(...p: string[]): string }): boolean {
  if (allowedRoots.length === 0) return false;
  const resolved = pathMod.resolve(path);
  return allowedRoots.some((root) => {
    const r = pathMod.resolve(root);
    return resolved === r || resolved.startsWith(r.endsWith('/') ? r : r + '/');
  });
}

/** Minimal JSON-Schema subset: type/enum/required/properties/items/min/max bounds. */
export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const type = schema.type;
  if (typeof type === 'string') {
    const ok =
      (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'null' && value === null);
    if (!ok) issues.push(`type expected ${type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`value not in enum`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push('minLength');
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push('maxLength');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) issues.push('pattern');
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push('minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push('maximum');
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, i) => {
      for (const sub of validateJsonSchemaSubset(item, schema.items as Record<string, unknown>)) {
        issues.push(`items[${i}]: ${sub}`);
      }
    });
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) issues.push(`missing required: ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in obj) {
        for (const subIssue of validateJsonSchemaSubset(obj[key], sub)) {
          issues.push(`${key}: ${subIssue}`);
        }
      }
    }
  }
  return issues;
}

export interface RunValidatorInput {
  spec: VerifierSpec;
  config: VerifierConfig;
  runtime: VerifierRuntime;
  pathMod: { resolve(...p: string[]): string };
  /** Evidence of LAB policy for command validators (from supremePolicy). */
  labPolicyConfirmed: boolean;
  /** Actual output under verification (for text/json validators). */
  subject?: string;
}

/** Single validator execution. Never throws. */
export async function runValidator(input: RunValidatorInput): Promise<VerifierResult> {
  const started = Date.now();
  const { spec, config, runtime, pathMod } = input;
  const base = { validatorId: spec.validatorId, type: spec.type };
  const finish = (status: VerifierStatus, reasonCode: string, evidence: string): VerifierResult => ({
    ...base,
    status,
    reasonCode,
    evidence: sanitizeEvidence(evidence),
    durationMs: Date.now() - started,
  });

  try {
    switch (spec.type) {
      case 'exact-text': {
        const expected = String(spec.config.expected ?? '');
        const actual = input.subject ?? '';
        return actual === expected
          ? finish('PASS', 'OK', 'exact match')
          : finish('FAIL', 'EXACT_MISMATCH', `expected ${JSON.stringify(expected.slice(0, 64))}`);
      }
      case 'regex': {
        const pattern = String(spec.config.pattern ?? '');
        if (!pattern) return finish('ERROR', 'SPEC_INVALID', 'missing pattern');
        const re = new RegExp(pattern);
        const actual = input.subject ?? '';
        return re.test(actual)
          ? finish('PASS', 'OK', `matched /${pattern.slice(0, 64)}/`)
          : finish('FAIL', 'REGEX_MISMATCH', `no match for /${pattern.slice(0, 64)}/`);
      }
      case 'json-parse': {
        const actual = input.subject ?? '';
        try {
          const parsed = JSON.parse(actual) as unknown;
          return finish('PASS', 'OK', `json ok (${Array.isArray(parsed) ? 'array' : typeof parsed})`);
        } catch (err) {
          return finish('FAIL', 'JSON_PARSE_FAILED', err instanceof Error ? err.message.slice(0, 64) : 'parse error');
        }
      }
      case 'json-schema': {
        const schema = spec.config.schema;
        if (!schema || typeof schema !== 'object') return finish('ERROR', 'SPEC_INVALID', 'missing schema');
        try {
          const parsed = JSON.parse(input.subject ?? '') as unknown;
          const issues = validateJsonSchemaSubset(parsed, schema as Record<string, unknown>);
          return issues.length === 0
            ? finish('PASS', 'OK', 'schema subset ok')
            : finish('FAIL', 'SCHEMA_VIOLATION', issues.slice(0, 3).join('; '));
        } catch (err) {
          return finish('FAIL', 'JSON_PARSE_FAILED', err instanceof Error ? err.message.slice(0, 64) : 'parse error');
        }
      }
      case 'file-exists': {
        const p = String(spec.config.path ?? '');
        if (!p) return finish('ERROR', 'SPEC_INVALID', 'missing path');
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', p.slice(0, 64));
        }
        const exists = await runtime.fsExists(p);
        return exists ? finish('PASS', 'OK', p.slice(0, 64)) : finish('FAIL', 'FILE_MISSING', p.slice(0, 64));
      }
      case 'file-hash': {
        const p = String(spec.config.path ?? '');
        const expected = String(spec.config.sha256 ?? '');
        if (!p || !/^[0-9a-f]{64}$/i.test(expected)) return finish('ERROR', 'SPEC_INVALID', 'path/sha256 invalid');
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', p.slice(0, 64));
        }
        const hash = await runtime.sha256(p);
        if (hash === null) return finish('FAIL', 'FILE_MISSING', p.slice(0, 64));
        return hash.toLowerCase() === expected.toLowerCase()
          ? finish('PASS', 'OK', `sha256 ${hash.slice(0, 12)}…`)
          : finish('FAIL', 'HASH_MISMATCH', `sha256 ${hash.slice(0, 12)}…`);
      }
      case 'command-exit':
      case 'test-suite': {
        if (!config.allowCommands || !input.labPolicyConfirmed) {
          return finish('UNAVAILABLE', 'COMMAND_EXECUTION_DISABLED', 'requires allowCommands + LAB policy');
        }
        const command = String(spec.config.command ?? '');
        const args = Array.isArray(spec.config.args) ? (spec.config.args as string[]).map(String) : [];
        const cwd = String(spec.config.cwd ?? '.');
        if (!command) return finish('ERROR', 'SPEC_INVALID', 'missing command');
        const res = await runtime.exec(command, args, cwd, config.commandTimeoutMs);
        const expectedCode = spec.config.expectedExit;
        const pass = typeof expectedCode === 'number' ? res.code === expectedCode : res.code === 0;
        return pass
          ? finish('PASS', 'OK', `exit=${res.code}`)
          : finish('FAIL', 'EXIT_MISMATCH', `exit=${res.code} stderr=${res.stderr.slice(0, 64)}`);
      }
      default:
        return finish('UNAVAILABLE', 'VALIDATOR_TYPE_UNSUPPORTED', String((spec as { type?: string }).type));
    }
  } catch (err) {
    return finish('ERROR', 'VALIDATOR_EXCEPTION', err instanceof Error ? err.message.slice(0, 64) : String(err));
  }
}
