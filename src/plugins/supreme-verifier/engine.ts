/**
 * @dsh-supreme/verifier — validator registry engine.
 *
 * Principle (Spec §12 original): DETERMINISTIC EVIDENCE > MODEL SELF-CONFIDENCE.
 *
 * Security boundary:
 *  - never bypasses DSH sandbox/permissions/approval; command execution is
 *    opt-in (allowCommands) AND requires executionClass=LAB policy evidence;
 *  - file validators are path-confined to configured allowedRoots — v1.3.1:
 *    confinement is enforced on REAL paths (fs.realpath), not lexically.
 *    A symlink inside a root pointing outside the root is rejected BEFORE any
 *    content read; missing files produce an explicit FAIL (no bypass, no
 *    crash); content reads additionally cross-check the pre-open stat identity
 *    (dev/ino) against the open-handle (fstat) identity to REDUCE (not
 *    eliminate) the check-vs-open race. Residual risk: an adversary with
 *    local filesystem write access can still swap paths/inodes between the
 *    realpath/stat window and the open, or rewrite content in place under a
 *    stable inode. This is hardening, not a race-proof guarantee. Windows
 *    junction/symlink semantics are delegated to node fs realpath but were
 *    NOT tested in this environment (Linux only).
 *  - json-schema validation implements a bounded deterministic subset; any
 *    keyword or dialect feature outside the subset yields UNAVAILABLE (with
 *    the keyword named) — never a silent downgrade to PASS. Invalid schemas
 *    yield ERROR, distinct from subject violations (FAIL).
 *  - unsupported capability → UNAVAILABLE, never a fabricated PASS;
 *  - validator exceptions → ERROR (fail visible), not crashes;
 *  - evidence is bounded and secret-sentinel scrubbed; it carries paths as
 *    given, statuses, reason codes and hash prefixes — never file content.
 *  - v1.3.1 evidence binding (§3A): verification records bind taskId +
 *    attempt + the sha-256 of the verified artifact bytes; a record whose
 *    hash differs from the CURRENT artifact is STALE (isEvidenceCurrent
 *    false; the workflow close gate treats a stale PASS as no-PASS). Model
 *    confidence and reasoning traces are structurally excluded
 *    (FORBIDDEN_EVIDENCE_FIELDS) — no code path promotes them into PASS.
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
/** Hard read bound for file-hash content reads (no full-file read beyond it). */
export const DEFAULT_MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
/**
 * Deterministic resource bounds for JSON Schema validation (v1.3.1).
 * Exceeding a SUBJECT bound → FAIL (conservative, never PASS); exceeding a
 * SCHEMA bound → ERROR (SCHEMA_TOO_LARGE / SCHEMA_INVALID).
 */
export const SCHEMA_LIMITS = {
  /** JSON.stringify(schema).length budget for the whole schema document. */
  MAX_SCHEMA_BYTES: 65_536,
  /** Schema object nodes walked during compilation. */
  MAX_SCHEMA_NODES: 512,
  /** Instance nesting depth (objects/arrays/$ref hops included). */
  MAX_INSTANCE_DEPTH: 64,
  /** Property/item/enum/uniqueItems comparisons per validation. */
  MAX_INSTANCE_SCANS: 10_000,
  /** $ref resolutions per validation (kills pathological self-reference). */
  MAX_REF_HOPS: 256,
} as const;
export interface VerifierConfig {
  /** Command execution is disabled by default and only honored for LAB policy. */
  allowCommands: boolean;
  /** Network-backed validators are disabled by default. */
  allowNetwork: boolean;
  /** Path confinement for file validators (absolute paths). */
  allowedRoots: string[];
  commandTimeoutMs: number;
  /** Optional bound for file-hash reads (default DEFAULT_MAX_FILE_READ_BYTES). */
  maxFileReadBytes?: number;
}
export const VERIFIER_DEFAULTS: VerifierConfig = {
  allowCommands: false,
  allowNetwork: false,
  allowedRoots: [],
  commandTimeoutMs: 30_000,
  maxFileReadBytes: DEFAULT_MAX_FILE_READ_BYTES,
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
/**
 * Path helpers the host must supply. `resolve` is the lexical baseline;
 * `relative`/`isAbsolute` are required for REAL-path containment checks.
 * (The suite passes a resolve-only shim; real-path mode simply stays off.)
 */
export interface VerifierPathMod {
  resolve(...p: string[]): string;
  relative?(from: string, to: string): string;
  isAbsolute?(p: string): boolean;
}
export interface VerifierRuntime {
  fsExists(path: string): Promise<boolean>;
  fsRead(path: string): Promise<string | null>;
  /** Legacy whole-path hash. file-hash no longer uses it: content reads now
   *  REQUIRE the real-path members below (see CONFINEMENT_UNVERIFIABLE). */
  sha256(path: string): Promise<string | null>;
  exec(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Optional real-path resolution (node fs.realpath; throws on ENOENT/ELOOP/…).
   * When provided (with pathMod.relative/isAbsolute), file validators enforce
   * REAL-path confinement: allowedRoots AND the target are resolved through
   * symlinks, and the target's real path must remain inside a real root.
   * Handles symlinks and Windows junctions via realpath (Windows untested).
   */
  realpath?(path: string): Promise<string>;
  /** Optional stat; null when absent. Used for the dev/ino identity check. */
  stat?(path: string): Promise<{ dev: number; ino: number; size: number } | null>;
  /** Optional fused open+read+fstat: bytes plus the identity of the OPEN file
   *  handle (fstat), for the check-vs-open race-window reduction. */
  readBytesWithFstat?(path: string): Promise<{ bytes: Uint8Array; dev: number; ino: number; size: number } | null>;
  /** Optional sha256 over in-memory bytes (pairs with readBytesWithFstat). */
  hashBytes?(bytes: Uint8Array): Promise<string | null>;
}
/** Lexical confinement helper (kept for deterministic unit checks): resolved
 *  path must live inside one of the allowed roots by string prefix. This is
 *  the CHEAP pre-filter; the real confinement is resolveRealConfinement. */
export function pathIsAllowed(path: string, allowedRoots: string[], pathMod: VerifierPathMod): boolean {
  if (allowedRoots.length === 0) return false;
  const resolved = pathMod.resolve(path);
  return allowedRoots.some((root) => {
    const r = pathMod.resolve(root);
    return resolved === r || resolved.startsWith(r.endsWith('/') ? r : r + '/');
  });
}
/** True when a path.relative() result means "outside the root". Rejects
 *  `..`, `../…` and `..\…` escapes plus absolute leftovers — this is what
 *  kills sibling-prefix roots (/root vs /root-evil) on real paths too. */
function relativeEscapesRoot(rel: string, isAbsolute: (p: string) => boolean): boolean {
  if (rel.length === 0) return false; // identical path
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return true;
  return isAbsolute(rel);
}
export type RealConfinement =
  | { kind: 'ok'; realTarget: string; realRoots: string[] }
  | { kind: 'missing'; detail: string }
  | { kind: 'outside'; detail: string }
  | { kind: 'unresolvable'; detail: string };
/**
 * REAL-path confinement (v1.3.1, Issue B fix): resolve the allowedRoots AND
 * the target through the filesystem (fs.realpath), then require the target's
 * real path to be inside one of the real roots (path.relative + reject '../'
 * escapes). Symlinks and Windows junctions are resolved by realpath, so a
 * link inside a root pointing outside is rejected BEFORE any content read.
 * Callers must map the outcome: missing → explicit FAIL, outside →
 * UNAVAILABLE (confinement), unresolvable → ERROR (fail visible).
 */
export async function resolveRealConfinement(
  target: string,
  allowedRoots: string[],
  pathMod: VerifierPathMod,
  realpath: (p: string) => Promise<string>,
): Promise<RealConfinement> {
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing', detail: `${target.slice(0, 48)} does not exist (realpath ${code})` };
    }
    return { kind: 'unresolvable', detail: `realpath failed for ${target.slice(0, 48)} (${code ?? 'error'})` };
  }
  const realRoots: string[] = [];
  for (const root of allowedRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A missing/unreadable root contributes nothing to real confinement.
    }
  }
  if (realRoots.length === 0) {
    return { kind: 'outside', detail: 'no allowedRoot could be resolved (missing or unreadable)' };
  }
  if (typeof pathMod.relative !== 'function' || typeof pathMod.isAbsolute !== 'function') {
    return { kind: 'unresolvable', detail: 'pathMod.relative/isAbsolute unavailable; real containment not computable' };
  }
  const isAbs = pathMod.isAbsolute.bind(pathMod) as (p: string) => boolean;
  const contained = realRoots.some((rr) => {
    if (realTarget === rr) return true;
    return !relativeEscapesRoot(pathMod.relative!(rr, realTarget), isAbs);
  });
  if (!contained) {
    return { kind: 'outside', detail: 'real path escapes every allowed root (symlink/junction boundary)' };
  }
  return { kind: 'ok', realTarget, realRoots };
}
// ---------------------------------------------------------------------------
// JSON Schema validation (v1.3.1, Issue E fix) — bounded deterministic subset.
//
// Three-outcome taxonomy, enforced end to end:
//   invalid SUBJECT      → FAIL       (SCHEMA_VIOLATION)
//   invalid SCHEMA       → ERROR      (SCHEMA_INVALID)
//   unsupported keyword/ → UNAVAILABLE(SCHEMA_UNSUPPORTED / dialect / $ref)
//   dialect/capability
// Never a silent downgrade to PASS.
//
// Supported keywords: type (string|array), enum, const, properties, required,
// additionalProperties (boolean AND schema form), patternProperties,
// propertyNames, items (schema AND array/tuple form), minimum, maximum,
// exclusiveMinimum/Maximum (numeric), minLength, maxLength, pattern, minItems,
// maxItems, uniqueItems, minProperties, maxProperties, allOf, anyOf, oneOf,
// not, $ref (LOCAL "#/…" pointers only — remote/network refs are NEVER
// fetched), $defs, definitions, plus ignored annotations (title, description,
// default, examples, $comment) and $schema restricted to known draft URIs.
// Boolean schemas (true/false) are supported everywhere schemas appear.
//
// NOT supported (→ UNAVAILABLE, keyword named): if/then/else, $anchor, $id,
// $dynamicRef/$recursiveRef, format, contentEncoding/MediaType, prefixItems,
// additionalItems, contains/minContains/maxContains, dependentRequired/
// dependencies, multipleOf, readOnly/writeOnly, and any other unknown key.
//
// Bounds (SCHEMA_LIMITS): schema ≤ 65 536 JSON bytes and ≤ 512 nodes; instance
// depth ≤ 64 (→ FAIL INSTANCE_DEPTH_EXCEEDED); ≤ 10 000 property/item/enum/
// uniqueItems scans per validation (→ FAIL INSTANCE_SCAN_LIMIT_EXCEEDED);
// ≤ 256 $ref hops (→ FAIL REF_LIMIT_EXCEEDED). minLength/maxLength count UTF-16
// code units (JS .length); pattern uses ECMAScript RegExp semantics.
// ---------------------------------------------------------------------------
const TYPE_NAMES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_DIALECTS = new Set([
  'http://json-schema.org/draft-06/schema#',
  'http://json-schema.org/draft-06/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2019-09/schema#',
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
]);
/** Annotations carried but never validated (instance VALUES, not schemas). */
const IGNORED_ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$comment']);
const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'items',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  ...IGNORED_ANNOTATIONS,
]);
export type SchemaValidation =
  | { outcome: 'valid' }
  | { outcome: 'invalid'; issues: string[] }
  | { outcome: 'schema-invalid'; reason: string }
  | { outcome: 'unsupported'; reason: string };
type CompileResult =
  | { ok: true }
  | { ok: false; status: 'schema-invalid'; reason: string }
  | { ok: false; status: 'unsupported'; reason: string };
interface CompileCtx {
  root: unknown;
  nodes: number;
  stack: Set<string>;
}
interface ValidateState {
  root: unknown;
  scans: number;
  refHops: number;
  exhausted: boolean;
}
const badSchema = (reason: string): CompileResult => ({ ok: false, status: 'schema-invalid', reason });
const unsupportedSchema = (reason: string): CompileResult => ({ ok: false, status: 'unsupported', reason });
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** JSON-value deep equality (key-order-insensitive objects) for enum/const/uniqueItems. */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonDeepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false; // unknown names rejected at compile time
  }
}
/** Resolve a LOCAL "#/…" JSON-pointer $ref against the root schema document. */
function resolveLocalRef(root: unknown, ref: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (ref === '#' || ref === '#/') return { ok: true, value: root };
  if (!ref.startsWith('#/')) return { ok: false, reason: `unresolvable local $ref: ${ref}` };
  const segments = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const seg of segments) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { ok: false, reason: `unresolvable local $ref: ${ref}` };
    }
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}
function compileSchemaNode(schema: unknown, ctx: CompileCtx, ptr: string): CompileResult {
  if (ctx.stack.has(ptr)) return { ok: true }; // recursive $ref — bounded at validation
  ctx.stack.add(ptr);
  try {
    ctx.nodes++;
    if (ctx.nodes > SCHEMA_LIMITS.MAX_SCHEMA_NODES) {
      return badSchema(`SCHEMA_TOO_LARGE: schema exceeds ${SCHEMA_LIMITS.MAX_SCHEMA_NODES} nodes`);
    }
    if (schema === true || schema === false) return { ok: true }; // boolean schemas
    if (!isPlainObject(schema)) return badSchema('schema must be an object or boolean');
    // Keyword allowlist first: anything unknown → UNAVAILABLE, keyword named.
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        return unsupportedSchema(
          `SCHEMA_UNSUPPORTED_KEYWORD: "${key}" (validator implements a fixed deterministic subset; refusing silent downgrade)`,
        );
      }
    }
    const compileEntry = (value: unknown, childPtr: string): CompileResult => compileSchemaNode(value, ctx, childPtr);
    if (schema.$schema !== undefined) {
      if (typeof schema.$schema !== 'string') return badSchema('$schema must be a string URI');
      if (!ALLOWED_DIALECTS.has(schema.$schema)) {
        return unsupportedSchema(`SCHEMA_DIALECT_UNSUPPORTED: ${schema.$schema}`);
      }
    }
    if (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (typeof ref !== 'string') return badSchema('$ref must be a string');
      if (!ref.startsWith('#')) {
        return unsupportedSchema(`SCHEMA_REF_UNSUPPORTED: ${ref} (only local "#/…" refs are supported; remote/network refs are never accessed)`);
      }
      const resolved = resolveLocalRef(ctx.root, ref);
      if (!resolved.ok) return badSchema(resolved.reason);
      const sub = compileSchemaNode(resolved.value, ctx, ref);
      if (!sub.ok) return sub;
    }
    for (const defsKey of ['$defs', 'definitions'] as const) {
      const defs = schema[defsKey];
      if (defs === undefined) continue;
      if (!isPlainObject(defs)) return badSchema(`${defsKey} must be an object`);
      for (const [name, entry] of Object.entries(defs)) {
        const sub = compileEntry(entry, `${ptr}/${defsKey}/${name}`);
        if (!sub.ok) return sub;
      }
    }
    if (schema.type !== undefined) {
      const t = schema.type;
      const names = Array.isArray(t) ? t : [t];
      if (names.length === 0 || !names.every((n) => typeof n === 'string' && TYPE_NAMES.has(n))) {
        return badSchema(`invalid type keyword: ${JSON.stringify(t)}`);
      }
    }
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
      return badSchema('enum must be a non-empty array');
    }
    if (schema.properties !== undefined) {
      if (!isPlainObject(schema.properties)) return badSchema('properties must be an object');
      for (const [key, sub] of Object.entries(schema.properties)) {
        const r = compileEntry(sub, `${ptr}/properties/${key}`);
        if (!r.ok) return r;
      }
    }
    if (schema.patternProperties !== undefined) {
      if (!isPlainObject(schema.patternProperties)) return badSchema('patternProperties must be an object');
      for (const [pat, sub] of Object.entries(schema.patternProperties)) {
        try {
          new RegExp(pat);
        } catch {
          return badSchema(`invalid patternProperties regex: ${pat}`);
        }
        const r = compileEntry(sub, `${ptr}/patternProperties/${pat}`);
        if (!r.ok) return r;
      }
    }
    if (schema.propertyNames !== undefined) {
      const r = compileEntry(schema.propertyNames, `${ptr}/propertyNames`);
      if (!r.ok) return r;
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      const r = compileEntry(schema.additionalProperties, `${ptr}/additionalProperties`);
      if (!r.ok) return r;
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        for (let i = 0; i < schema.items.length; i++) {
          const r = compileEntry(schema.items[i], `${ptr}/items/${i}`);
          if (!r.ok) return r;
        }
      } else {
        const r = compileEntry(schema.items, `${ptr}/items`);
        if (!r.ok) return r;
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === 'string')) {
        return badSchema('required must be an array of strings');
      }
    }
    for (const bound of ['minimum', 'maximum'] as const) {
      if (schema[bound] !== undefined && (typeof schema[bound] !== 'number' || !Number.isFinite(schema[bound]))) {
        return badSchema(`${bound} must be a finite number`);
      }
    }
    for (const bound of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
      const v = schema[bound];
      if (v === undefined) continue;
      if (typeof v === 'boolean') {
        return unsupportedSchema(`SCHEMA_UNSUPPORTED: draft-04 boolean ${bound} (numeric form supported)`);
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) return badSchema(`${bound} must be a finite number`);
    }
    for (const bound of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const) {
      const v = schema[bound];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return badSchema(`${bound} must be a non-negative integer`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string') return badSchema('pattern must be a string');
      try {
        new RegExp(schema.pattern);
      } catch {
        return badSchema(`invalid pattern regex: ${schema.pattern}`);
      }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
      return badSchema('uniqueItems must be a boolean');
    }
    for (const comp of ['allOf', 'anyOf', 'oneOf'] as const) {
      const v = schema[comp];
      if (v === undefined) continue;
      if (!Array.isArray(v)) return badSchema(`${comp} must be an array`);
      for (let i = 0; i < v.length; i++) {
        const r = compileEntry(v[i], `${ptr}/${comp}/${i}`);
        if (!r.ok) return r;
      }
    }
    if (schema.not !== undefined) {
      const r = compileEntry(schema.not, `${ptr}/not`);
      if (!r.ok) return r;
    }
    return { ok: true };
  } finally {
    ctx.stack.delete(ptr);
  }
}
/** Compile-time pass: structure, keyword allowlist, local $ref targets, bounds. */
export function compileJsonSchema(schema: unknown): CompileResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema) ?? '';
  } catch {
    return badSchema('SCHEMA_UNSERIALIZABLE: circular or non-JSON structure');
  }
  if (serialized.length > SCHEMA_LIMITS.MAX_SCHEMA_BYTES) {
    return badSchema(`SCHEMA_TOO_LARGE: ${serialized.length} > ${SCHEMA_LIMITS.MAX_SCHEMA_BYTES} bytes`);
  }
  return compileSchemaNode(schema, { root: schema, nodes: 0, stack: new Set() }, '#');
}
const at = (path: string, msg: string): string => (path ? `${path}: ${msg}` : msg);
const childPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const itemPath = (path: string, i: number): string => (path ? `${path}[${i}]` : `[${i}]`);
function validateNode(schema: unknown, instance: unknown, issues: string[], path: string, depth: number, st: ValidateState): void {
  if (st.exhausted) return;
  if (depth > SCHEMA_LIMITS.MAX_INSTANCE_DEPTH) {
    st.exhausted = true;
    issues.push(at(path, `INSTANCE_DEPTH_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_DEPTH})`));
    return;
  }
  if (st.scans > SCHEMA_LIMITS.MAX_INSTANCE_SCANS) {
    st.exhausted = true;
    issues.push(at(path, `INSTANCE_SCAN_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_SCANS})`));
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    issues.push(at(path, 'schema false'));
    return;
  }
  if (!isPlainObject(schema)) return; // unreachable post-compile; defensive
  // $ref — local pointer, resolved against the root document (2020-12 style:
  // sibling keywords still apply). Hops re-validate the SAME instance
  // position, so they consume the ref budget, not instance depth.
  if (typeof schema.$ref === 'string') {
    st.refHops++;
    if (st.refHops > SCHEMA_LIMITS.MAX_REF_HOPS) {
      st.exhausted = true;
      issues.push(at(path, `REF_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_REF_HOPS})`));
      return;
    }
    const resolved = resolveLocalRef(st.root, schema.$ref);
    if (!resolved.ok) {
      st.exhausted = true;
      issues.push(at(path, resolved.reason));
      return;
    }
    validateNode(resolved.value, instance, issues, path, depth, st);
    if (st.exhausted) return;
  }
  // type (string or array form)
  const t = schema.type;
  if (typeof t === 'string') {
    if (!typeMatches(t, instance)) issues.push(at(path, `type expected ${t}`));
  } else if (Array.isArray(t)) {
    if (!t.some((n) => typeof n === 'string' && typeMatches(n, instance))) {
      issues.push(at(path, `type expected one of ${t.join('|')}`));
    }
  }
  // enum / const
  if (Array.isArray(schema.enum)) {
    st.scans += schema.enum.length;
    if (!schema.enum.some((v) => jsonDeepEqual(v, instance))) issues.push(at(path, 'value not in enum'));
  }
  if (schema.const !== undefined && !jsonDeepEqual(schema.const, instance)) {
    issues.push(at(path, 'value not equal to const'));
  }
  // composition — branches re-validate the same instance position, so they
  // do not consume instance depth (pathological self-reference is bounded by
  // MAX_REF_HOPS + the scan budget instead).
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateNode(sub, instance, issues, path, depth, st);
      if (st.exhausted) return;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    st.scans += schema.anyOf.length;
    const matched = schema.anyOf.some((sub) => {
      const tmp: string[] = [];
      validateNode(sub, instance, tmp, path, depth, st);
      return tmp.length === 0;
    });
    if (!matched) issues.push(at(path, 'anyOf: no branch matched'));
  }
  if (Array.isArray(schema.oneOf)) {
    st.scans += schema.oneOf.length;
    let matched = 0;
    for (const sub of schema.oneOf) {
      const tmp: string[] = [];
      validateNode(sub, instance, tmp, path, depth, st);
      if (tmp.length === 0) matched++;
    }
    if (matched !== 1) issues.push(at(path, `oneOf matched ${matched} branches (need exactly 1)`));
  }
  if (schema.not !== undefined) {
    const tmp: string[] = [];
    validateNode(schema.not, instance, tmp, path, depth, st);
    if (tmp.length === 0) issues.push(at(path, 'not: inner schema must not match'));
  }
  if (st.exhausted) return;
  // strings (minLength/maxLength count UTF-16 code units — deterministic)
  if (typeof instance === 'string') {
    if (typeof schema.minLength === 'number' && instance.length < schema.minLength) {
      issues.push(at(path, `minLength ${schema.minLength}`));
    }
    if (typeof schema.maxLength === 'number' && instance.length > schema.maxLength) {
      issues.push(at(path, `maxLength ${schema.maxLength}`));
    }
    if (typeof schema.pattern === 'string') {
      st.scans++;
      try {
        if (!new RegExp(schema.pattern).test(instance)) issues.push(at(path, 'pattern mismatch'));
      } catch {
        issues.push(at(path, 'pattern mismatch (invalid regex)')); // defensive; compile already rejected
      }
    }
  }
  // numbers
  if (typeof instance === 'number' && Number.isFinite(instance)) {
    if (typeof schema.minimum === 'number' && instance < schema.minimum) issues.push(at(path, `minimum ${schema.minimum}`));
    if (typeof schema.maximum === 'number' && instance > schema.maximum) issues.push(at(path, `maximum ${schema.maximum}`));
    if (typeof schema.exclusiveMinimum === 'number' && instance <= schema.exclusiveMinimum) {
      issues.push(at(path, `exclusiveMinimum ${schema.exclusiveMinimum}`));
    }
    if (typeof schema.exclusiveMaximum === 'number' && instance >= schema.exclusiveMaximum) {
      issues.push(at(path, `exclusiveMaximum ${schema.exclusiveMaximum}`));
    }
  }
  // arrays
  if (Array.isArray(instance)) {
    if (typeof schema.minItems === 'number' && instance.length < schema.minItems) {
      issues.push(at(path, `minItems ${schema.minItems}`));
    }
    if (typeof schema.maxItems === 'number' && instance.length > schema.maxItems) {
      issues.push(at(path, `maxItems ${schema.maxItems}`));
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      // tuple form: element i validated against items[i]; extra elements are
      // unconstrained (additionalItems is not supported → its presence makes
      // the whole schema UNAVAILABLE at compile time).
      const n = Math.min(items.length, instance.length);
      for (let i = 0; i < n; i++) {
        st.scans++;
        validateNode(items[i], instance[i], issues, itemPath(path, i), depth + 1, st);
        if (st.exhausted) return;
      }
    } else if (items !== undefined) {
      for (let i = 0; i < instance.length; i++) {
        st.scans++;
        validateNode(items, instance[i], issues, itemPath(path, i), depth + 1, st);
        if (st.exhausted) return;
      }
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < instance.length; i++) {
        for (let j = i + 1; j < instance.length; j++) {
          st.scans++;
          if (st.scans > SCHEMA_LIMITS.MAX_INSTANCE_SCANS) {
            st.exhausted = true;
            issues.push(at(path, `INSTANCE_SCAN_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_SCANS})`));
            return;
          }
          if (jsonDeepEqual(instance[i], instance[j])) {
            issues.push(at(itemPath(path, j), 'duplicate item (uniqueItems)'));
          }
        }
      }
    }
  }
  // objects
  if (isPlainObject(instance)) {
    const keys = Object.keys(instance);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      issues.push(at(path, `minProperties ${schema.minProperties}`));
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      issues.push(at(path, `maxProperties ${schema.maxProperties}`));
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in instance)) issues.push(at(path, `missing required: ${key}`));
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        st.scans++;
        validateNode(schema.propertyNames, key, issues, childPath(path, `<key:${key}>`), depth + 1, st);
        if (st.exhausted) return;
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProps: Array<{ re: RegExp; schema: unknown }> = [];
    if (isPlainObject(schema.patternProperties)) {
      for (const [pat, sub] of Object.entries(schema.patternProperties)) {
        try {
          patternProps.push({ re: new RegExp(pat), schema: sub });
        } catch {
          // defensive; compile already rejected
        }
      }
    }
    const handled = new Set<string>();
    for (const [key, sub] of Object.entries(properties)) {
      if (key in instance) {
        handled.add(key);
        st.scans++;
        validateNode(sub, instance[key], issues, childPath(path, key), depth + 1, st);
        if (st.exhausted) return;
      }
    }
    for (const { re, schema: sub } of patternProps) {
      for (const key of keys) {
        if (re.test(key)) {
          handled.add(key);
          st.scans++;
          validateNode(sub, instance[key], issues, childPath(path, key), depth + 1, st);
          if (st.exhausted) return;
        }
      }
    }
    const ap = schema.additionalProperties;
    if (ap === false) {
      for (const key of keys) {
        if (!handled.has(key)) issues.push(at(path, `additional property not allowed: ${key}`));
      }
    } else if (ap !== undefined && ap !== true) {
      for (const key of keys) {
        if (handled.has(key)) continue;
        st.scans++;
        validateNode(ap, instance[key], issues, childPath(path, key), depth + 1, st);
        if (st.exhausted) return;
      }
    }
  }
}
/**
 * Full deterministic JSON Schema validation (bounded subset — see header).
 * Outcome mapping: valid | invalid(subject) | schema-invalid | unsupported.
 */
export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidation {
  const compiled = compileJsonSchema(schema);
  if (!compiled.ok) {
    return compiled.status === 'unsupported'
      ? { outcome: 'unsupported', reason: compiled.reason }
      : { outcome: 'schema-invalid', reason: compiled.reason };
  }
  const issues: string[] = [];
  const st: ValidateState = { root: schema, scans: 0, refHops: 0, exhausted: false };
  validateNode(schema, value, issues, '', 0, st);
  if (issues.length === 0) return { outcome: 'valid' };
  return { outcome: 'invalid', issues };
}
/**
 * Back-compat wrapper over validateJsonSchema (suite contract): returns a
 * non-empty issue list for subject violations AND for schema-invalid /
 * unsupported schemas (a broken schema can never yield a silent empty list).
 */
export function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>): string[] {
  const result = validateJsonSchema(value, schema);
  switch (result.outcome) {
    case 'valid':
      return [];
    case 'invalid':
      return result.issues;
    case 'schema-invalid':
      return [`SCHEMA_INVALID: ${result.reason}`];
    case 'unsupported':
      return [`SCHEMA_UNSUPPORTED: ${result.reason}`];
  }
}
export interface RunValidatorInput {
  spec: VerifierSpec;
  config: VerifierConfig;
  runtime: VerifierRuntime;
  pathMod: VerifierPathMod;
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
        const rawSchema = spec.config.schema;
        if (rawSchema === undefined || rawSchema === null) return finish('ERROR', 'SPEC_INVALID', 'missing schema');
        const compiled = compileJsonSchema(rawSchema);
        if (!compiled.ok) {
          return compiled.status === 'unsupported'
            ? finish('UNAVAILABLE', 'SCHEMA_UNSUPPORTED', compiled.reason)
            : finish('ERROR', 'SCHEMA_INVALID', compiled.reason);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(input.subject ?? '') as unknown;
        } catch (err) {
          return finish('FAIL', 'JSON_PARSE_FAILED', err instanceof Error ? err.message.slice(0, 64) : 'parse error');
        }
        const result = validateJsonSchema(parsed, rawSchema);
        if (result.outcome === 'valid') return finish('PASS', 'OK', 'schema ok (bounded deterministic subset)');
        if (result.outcome === 'schema-invalid') return finish('ERROR', 'SCHEMA_INVALID', result.reason);
        if (result.outcome === 'unsupported') return finish('UNAVAILABLE', 'SCHEMA_UNSUPPORTED', result.reason);
        return finish('FAIL', 'SCHEMA_VIOLATION', result.issues.slice(0, 3).join('; '));
      }
      case 'file-exists': {
        const p = String(spec.config.path ?? '');
        if (!p) return finish('ERROR', 'SPEC_INVALID', 'missing path');
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', p.slice(0, 64));
        }
        if (
          typeof runtime.realpath === 'function' &&
          typeof pathMod.relative === 'function' &&
          typeof pathMod.isAbsolute === 'function'
        ) {
          // REAL-path confinement: symlink/junction escapes are rejected here,
          // BEFORE any existence answer is derived from the linked target.
          const conf = await resolveRealConfinement(p, config.allowedRoots, pathMod, runtime.realpath);
          if (conf.kind === 'missing') return finish('FAIL', 'FILE_MISSING', conf.detail);
          if (conf.kind === 'unresolvable') return finish('ERROR', 'PATH_UNRESOLVABLE', conf.detail);
          if (conf.kind === 'outside') return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', conf.detail);
          return finish('PASS', 'OK', `${p.slice(0, 48)} exists (realpath-verified)`);
        }
        // Runtime without real-path capability: lexical confinement only.
        const exists = await runtime.fsExists(p);
        return exists
          ? finish('PASS', 'OK', `${p.slice(0, 48)} exists (lexical confinement; runtime lacks realpath)`)
          : finish('FAIL', 'FILE_MISSING', p.slice(0, 64));
      }
      case 'file-hash': {
        const p = String(spec.config.path ?? '');
        const expected = String(spec.config.sha256 ?? '');
        if (!p || !/^[0-9a-f]{64}$/i.test(expected)) return finish('ERROR', 'SPEC_INVALID', 'path/sha256 invalid');
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', p.slice(0, 64));
        }
        if (
          typeof runtime.realpath !== 'function' ||
          typeof runtime.stat !== 'function' ||
          typeof runtime.readBytesWithFstat !== 'function' ||
          typeof runtime.hashBytes !== 'function' ||
          typeof pathMod.relative !== 'function' ||
          typeof pathMod.isAbsolute !== 'function'
        ) {
          // Content reads REQUIRE real-path confinement. No capability →
          // refuse loudly; never silently fall back to a lexical-only read.
          return finish('ERROR', 'CONFINEMENT_UNVERIFIABLE', 'runtime lacks realpath/stat/open-fstat capability; content read refused');
        }
        const conf = await resolveRealConfinement(p, config.allowedRoots, pathMod, runtime.realpath);
        if (conf.kind === 'missing') return finish('FAIL', 'FILE_MISSING', conf.detail);
        if (conf.kind === 'unresolvable') return finish('ERROR', 'PATH_UNRESOLVABLE', conf.detail);
        if (conf.kind === 'outside') return finish('UNAVAILABLE', 'PATH_OUTSIDE_ALLOWED_ROOTS', conf.detail);
        const maxBytes = config.maxFileReadBytes ?? DEFAULT_MAX_FILE_READ_BYTES;
        const statBefore = await runtime.stat(conf.realTarget);
        if (statBefore === null) return finish('FAIL', 'FILE_MISSING', `${p.slice(0, 48)} vanished before read (stat ENOENT)`);
        if (!Number.isFinite(statBefore.size) || statBefore.size > maxBytes) {
          return finish('FAIL', 'FILE_TOO_LARGE', `size exceeds maxFileReadBytes (${maxBytes}); hash comparison refused`);
        }
        const read = await runtime.readBytesWithFstat(conf.realTarget);
        if (read === null) return finish('FAIL', 'FILE_MISSING', `${p.slice(0, 48)} unreadable at open time`);
        // Race-window REDUCTION (not elimination): the pre-open stat identity
        // must match the open-handle (fstat) identity. Swaps that change
        // dev/ino between stat and open are detected; same-inode in-place
        // rewrites are NOT. Documented residual risk — see header.
        if (read.dev !== statBefore.dev || read.ino !== statBefore.ino) {
          return finish('ERROR', 'PATH_SWAPPED_DURING_READ', 'file identity (dev/ino) changed between stat and open; refusing hash');
        }
        const hash = await runtime.hashBytes(read.bytes);
        if (hash === null) return finish('ERROR', 'HASH_UNAVAILABLE', 'hashBytes failed');
        return hash.toLowerCase() === expected.toLowerCase()
          ? finish('PASS', 'OK', `sha256 ${hash.slice(0, 12)}… (real-path confined)`)
          : finish('FAIL', 'HASH_MISMATCH', `sha256 ${hash.slice(0, 12)}… (real-path confined)`);
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

// ---------------------------------------------------------------------------
// v1.3.1 — Evidence-bound verification (Improvement §3A).
//
// A verifier status alone is replayable and unattributable: a PASS from an
// earlier artifact revision must never clear a task whose artifact changed.
// Evidence records therefore BIND every verification to an identity:
//
//   { taskId, attempt, artifact: { sha256 (mandatory), revision?, path? },
//     validatorId, validatorType, status, reasonCode, recordedAt }
//
// Rules enforced here (all deterministic, no ML, no network):
//   1. The recorded status comes ONLY from a real VerifierResult produced by
//      runValidator. There is no parameter — and no code path — that can
//      promote model confidence, a reasoning trace, its presence or its
//      length into PASS: recordEvidence REFUSES inputs carrying such fields
//      (FORBIDDEN_EVIDENCE_FIELDS) instead of silently ignoring them.
//   2. Every record carries the sha-256 of the artifact bytes that were
//      verified (host-supplied, or computed from bytes via the runtime's
//      hashBytes). No hash ⇒ no record (EvidenceError), even for FAIL.
//   3. Staleness: a record whose bound hash (or revision, when both sides
//      carry one) differs from the CURRENT artifact is STALE — stale PASS is
//      treated as no-PASS by the close gate (isEvidenceCurrent false).
//   4. Verifier unavailability is recorded verbatim as UNAVAILABLE (or ERROR
//      for validator exceptions) — never rewritten into PASS.
//
// Audit/event boundary: records carry ids, statuses, reason codes, hashes and
// bounded paths ONLY — never artifact content, credentials, or hidden
// reasoning. Verification consumes artifacts, test results, and reviewable
// result summaries ONLY (see README "Evidence-bound verification").
// ---------------------------------------------------------------------------

export const EVIDENCE_SCHEMA_VERSION = 'dsh-supreme/evidence@1';
export const EVIDENCE_HASH_ALGORITHM = 'sha256';
/** Bound for identity strings (taskId, revision) — ids, never content. */
export const MAX_EVIDENCE_ID_CHARS = 256;
/** Attempt is a small positive integer. */
export const MAX_EVIDENCE_ATTEMPT = 1_000_000;
/** Bounded path-as-given on evidence records (path only, never content). */
export const MAX_EVIDENCE_PATH_CHARS = 512;

/**
 * Model self-report fields that must NEVER reach the evidence pipeline. Their
 * presence in a recordEvidence input is rejected outright: confidence or
 * reasoning-trace presence/length can never substitute for deterministic
 * evidence (Improvement §3A requirement 4).
 */
export const FORBIDDEN_EVIDENCE_FIELDS: readonly string[] = Object.freeze([
  'confidence',
  'confidenceScore',
  'selfReported',
  'selfConfidence',
  'modelConfidence',
  'reasoningTrace',
  'reasoning',
  'trace',
  'cot',
  'chainOfThought',
  'hiddenReasoning',
]);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Identity of the artifact a verification was run against. */
export interface ArtifactIdentity {
  /** Path as given (bounded; ids/paths only — content is never recorded). */
  path?: string;
  /** Deterministic sha-256 hex of the artifact bytes (64 hex chars). Required
   *  on PASS records; optional (but recommended) on FAIL/ERROR/UNAVAILABLE. */
  sha256?: string;
  /** Revision/etag when the host tracks one (informational; compared when both sides carry it). */
  revision?: string;
}

/** Identity of the CURRENT artifact an evidence record is checked against. */
export interface CurrentArtifactIdentity {
  /** Deterministic sha-256 hex of the current artifact bytes (64 hex chars). */
  sha256: string;
  revision?: string;
  path?: string;
}

/** A verification record bound to task identity + artifact bytes (v1.3.1). */
export interface VerificationEvidence {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly artifact: Readonly<ArtifactIdentity>;
  readonly validatorId: string;
  readonly validatorType: ValidatorType;
  /** Status AT VERIFICATION TIME — copied verbatim from the VerifierResult. */
  readonly status: VerifierStatus;
  readonly reasonCode: string;
  readonly recordedAt: number;
}

/** Fail-visible construction error (no silent downgrade, no partial record). */
export class EvidenceError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid evidence record input: ${issues.join('; ')}`);
    this.name = 'EvidenceError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reject any input that tries to smuggle model self-reports into evidence. */
function rejectForbiddenFields(obj: unknown, label: string, issues: string[]): void {
  if (!isRecord(obj)) return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_EVIDENCE_FIELDS.includes(key)) {
      issues.push(`${label} carries forbidden self-report field "${key}" — confidence/reasoning traces can never influence verification evidence`);
    }
  }
}

/** Validate + normalize a sha-256 hex string (lower-cased). */
function normalizeSha256(value: unknown, issues: string[]): string | undefined {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    issues.push('artifact.sha256 must be a 64-char hex sha-256 of the artifact bytes');
    return undefined;
  }
  return value.toLowerCase();
}

export interface RecordEvidenceInput {
  /** The REAL validator result (from runValidator) — the ONLY source of status. */
  result: VerifierResult;
  /** Bound task identity (non-empty, ≤ MAX_EVIDENCE_ID_CHARS). */
  taskId: string;
  /** Attempt number, integer ≥ 1. */
  attempt: number;
  /** Artifact identity: sha256, or bytes + a hashBytes runtime member. */
  artifact: { path?: string; sha256?: string; revision?: string; bytes?: Uint8Array };
  /** Runtime hash member; REQUIRED when artifact.bytes is given. */
  hashBytes?: (bytes: Uint8Array) => Promise<string | null>;
  /** Deterministic override for tests; defaults to Date.now(). */
  recordedAt?: number;
}

/**
 * Build a VerificationEvidence from a REAL VerifierResult + identity. Never
 * throws anything but EvidenceError. The status is copied verbatim from
 * `result.status` — a FAIL/ERROR/UNAVAILABLE run records exactly that (an
 * unavailable verifier yields an explicit UNAVAILABLE record, never a PASS).
 */
export async function recordEvidence(input: RecordEvidenceInput): Promise<VerificationEvidence> {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new EvidenceError(['recordEvidence requires an input object']);
  }
  rejectForbiddenFields(input, 'input', issues);
  if (!isRecord(input.result)) {
    throw new EvidenceError(['result must be a VerifierResult produced by runValidator']);
  }
  rejectForbiddenFields(input.result, 'result', issues);
  const result = input.result as unknown as {
    validatorId?: unknown; type?: unknown; status?: unknown; reasonCode?: unknown; durationMs?: unknown; evidence?: unknown;
  };
  const validatorId = typeof result.validatorId === 'string' && result.validatorId.length > 0 ? result.validatorId : undefined;
  const validatorType = VALIDATOR_TYPES.includes(result.type as ValidatorType) ? (result.type as ValidatorType) : undefined;
  const status = VERIFIER_STATUSES.includes(result.status as VerifierStatus) ? (result.status as VerifierStatus) : undefined;
  if (validatorId === undefined) issues.push('result.validatorId must be a non-empty string (run a registered validator first)');
  if (validatorType === undefined) issues.push('result.type must be a known validator type');
  if (status === undefined) issues.push('result.status must be one of PASS|FAIL|ERROR|UNAVAILABLE (from runValidator)');
  if (typeof result.reasonCode !== 'string' || result.reasonCode.length === 0) issues.push('result.reasonCode must be a non-empty string');
  if (typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0) issues.push('result.durationMs must be a non-negative number');

  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  if (taskId.length === 0 || taskId.length > MAX_EVIDENCE_ID_CHARS) {
    issues.push(`taskId must be a non-empty string of at most ${MAX_EVIDENCE_ID_CHARS} chars`);
  }
  const attempt = input.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_EVIDENCE_ATTEMPT) {
    issues.push(`attempt must be an integer in [1, ${MAX_EVIDENCE_ATTEMPT}]`);
  }
  if (!isRecord(input.artifact)) {
    issues.push('artifact must be an object ({ sha256 } or { bytes } + hashBytes)');
  }
  let sha256: string | undefined;
  let path: string | undefined;
  let revision: string | undefined;
  if (isRecord(input.artifact)) {
    rejectForbiddenFields(input.artifact, 'artifact', issues);
    if (input.artifact.sha256 !== undefined) {
      sha256 = normalizeSha256(input.artifact.sha256, issues);
    } else if (input.artifact.bytes instanceof Uint8Array) {
      if (typeof input.hashBytes !== 'function') {
        issues.push('artifact.bytes requires a hashBytes runtime member (deterministic sha-256 over bytes)');
      } else {
        const computed = await input.hashBytes(input.artifact.bytes);
        if (computed === null || !SHA256_HEX_RE.test(computed)) {
          issues.push('hashBytes failed to produce a 64-char hex sha-256 for artifact.bytes');
        } else {
          sha256 = computed.toLowerCase();
        }
      }
    } else {
      // A PASS can never be bound without the hash of the bytes it verified;
      // FAIL/ERROR/UNAVAILABLE records may carry path/revision only (they
      // block close regardless — the hash is what makes a PASS checkable).
      if (status === 'PASS') {
        issues.push('a PASS record requires artifact.sha256 (or bytes + hashBytes) — a PASS without the verified artifact hash is not recordable');
      }
    }
    if (input.artifact.path !== undefined) {
      if (typeof input.artifact.path !== 'string' || input.artifact.path.length === 0 || input.artifact.path.length > MAX_EVIDENCE_PATH_CHARS) {
        issues.push(`artifact.path must be a non-empty string of at most ${MAX_EVIDENCE_PATH_CHARS} chars`);
      } else {
        path = input.artifact.path;
      }
    }
    if (input.artifact.revision !== undefined) {
      if (typeof input.artifact.revision !== 'string' || input.artifact.revision.length === 0 || input.artifact.revision.length > MAX_EVIDENCE_ID_CHARS) {
        issues.push(`artifact.revision must be a non-empty string of at most ${MAX_EVIDENCE_ID_CHARS} chars`);
      } else {
        revision = input.artifact.revision;
      }
    }
  }
  if (issues.length > 0) throw new EvidenceError(issues);
  const recordedAt = input.recordedAt ?? Date.now();
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt) || recordedAt < 0) {
    throw new EvidenceError(['recordedAt must be a non-negative finite number']);
  }
  const evidence: VerificationEvidence = Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId,
    attempt,
    artifact: Object.freeze({ ...(path !== undefined ? { path } : {}), sha256: sha256!, ...(revision !== undefined ? { revision } : {}) }),
    validatorId: validatorId!,
    validatorType: validatorType!,
    status: status!,
    reasonCode: result.reasonCode as string,
    recordedAt,
  });
  return evidence;
}

export interface EvidenceCloseEvaluation {
  ok: boolean;
  reasonCode:
    | 'EVIDENCE_CURRENT_PASS'
    | 'EVIDENCE_NOT_PASS'
    | 'EVIDENCE_UNBOUND'
    | 'EVIDENCE_STALE';
}

/**
 * Structural + staleness evaluation of an evidence record for close-gate use.
 *   malformed / unbound record   → EVIDENCE_UNBOUND  (a PASS without taskId,
 *                                  attempt and the artifact hash is no evidence)
 *   status ≠ PASS                → EVIDENCE_NOT_PASS (FAIL/ERROR/UNAVAILABLE
 *                                  records are recorded honestly, never pass)
 *   hash/revision ≠ CURRENT      → EVIDENCE_STALE (stale PASS = no-PASS)
 *   otherwise                    → EVIDENCE_CURRENT_PASS
 * The close-gate consumer (supreme-workflow-policy canCloseTask) maps these
 * verdicts 1:1 and adds the fail-closed case "currency unknowable" when no
 * current artifact identity is supplied.
 */
export function evaluateEvidenceForClose(evidence: unknown, currentArtifact: CurrentArtifactIdentity): EvidenceCloseEvaluation {
  if (!isRecord(evidence)) return { ok: false, reasonCode: 'EVIDENCE_UNBOUND' };
  const ev = evidence as unknown as VerificationEvidence;
  const bound =
    ev.schemaVersion === EVIDENCE_SCHEMA_VERSION
    && typeof ev.taskId === 'string' && ev.taskId.length > 0 && ev.taskId.length <= MAX_EVIDENCE_ID_CHARS
    && typeof ev.attempt === 'number' && Number.isInteger(ev.attempt) && ev.attempt >= 1
    && isRecord(ev.artifact)
    && typeof ev.artifact.sha256 === 'string' && SHA256_HEX_RE.test(ev.artifact.sha256)
    && typeof ev.validatorId === 'string' && ev.validatorId.length > 0
    && VALIDATOR_TYPES.includes(ev.validatorType)
    && VERIFIER_STATUSES.includes(ev.status)
    && typeof ev.reasonCode === 'string'
    && typeof ev.recordedAt === 'number' && Number.isFinite(ev.recordedAt);
  if (!bound) return { ok: false, reasonCode: 'EVIDENCE_UNBOUND' };
  if (ev.status !== 'PASS') return { ok: false, reasonCode: 'EVIDENCE_NOT_PASS' };
  const stale =
    ev.artifact.sha256.toLowerCase() !== currentArtifact.sha256.toLowerCase()
    || (ev.artifact.revision !== undefined && currentArtifact.revision !== undefined && ev.artifact.revision !== currentArtifact.revision);
  return stale ? { ok: false, reasonCode: 'EVIDENCE_STALE' } : { ok: true, reasonCode: 'EVIDENCE_CURRENT_PASS' };
}

/**
 * Staleness predicate (Improvement §3A requirement 2): TRUE only when the
 * record is a structurally bound PASS whose artifact hash — and revision,
 * when both sides carry one — matches the CURRENT artifact. A PASS whose
 * bound hash differs from the current artifact bytes is INVALID (stale) and
 * returns false; non-PASS records are never "current evidence".
 */
export function isEvidenceCurrent(evidence: unknown, currentArtifact: CurrentArtifactIdentity): boolean {
  return evaluateEvidenceForClose(evidence, currentArtifact).ok;
}
