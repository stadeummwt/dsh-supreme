/**
 * @dsh-supreme/policy — canonical types and deterministic engine.
 *
 * Pure, framework-free logic. The Cordis adapter lives in ./index.ts and
 * follows the exact pinned Cordis plugin conventions (name/inject/Config/apply)
 * verified against deepseek-harness @ d347e703908d0406b7a7ef80e3a0e594d86b2215
 * (vendor/cordis/src/registry.ts — Plugin.Object with apply(ctx, config)).
 */

export const EXECUTION_CLASSES = ['CORE', 'STANDARD', 'SUPREME', 'LAB'] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

export const COST_CLASSES = [
  'FREE_CONFIRMED',
  'FREE_LIMITED',
  'TRIAL',
  'PAID',
  'UNKNOWN',
] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const RISK_CLASSES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const VERIFICATION_LEVELS = ['NONE', 'BASIC', 'REQUIRED', 'STRICT'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

// v1.3 — CoT visibility classes (ASTRA-1 P1). Astra-class models legitimately
// produce empty/terse reasoning traces; per-route visibility lets the operator
// declare what each route is EXPECTED to expose so `cot_missing` only fires
// where talking is the contract (verbose/terse), never on `none` routes.
export const COT_VISIBILITIES = ['verbose', 'terse', 'none'] as const;
export type CotVisibility = (typeof COT_VISIBILITIES)[number];

// v1.3 — capability classes (ASTRA-1 P3, Daybreak analog). Routes/requests may
// carry a `capabilityClass` label under the EXACT shared field name; the union
// is open — any uppercase string is accepted and normalized at the seam.
export const CAPABILITY_CLASSES = ['ROUTINE', 'CYBER_OFFENSIVE', 'DESTRUCTIVE_OPS'] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number] | (string & {});

export const CAPABILITY_CLASS_GATES = ['OFF', 'AUDIT', 'ENFORCE'] as const;
export type CapabilityClassGate = (typeof CAPABILITY_CLASS_GATES)[number];

export interface SupremePolicyConfig {
  /** Execution profile this policy instance guards. */
  executionClass: ExecutionClass;
  /** Paid routes: production default DENY; explicit override allowed only in LAB. */
  allowPaid: boolean;
  /** Trial routes: production default DENY; explicit override allowed only in LAB. */
  allowTrial: boolean;
  /** Unknown cost classes are ALWAYS denied in v1 (hard rule). Must be false. */
  allowUnknownCost: false;
  /** HIGH risk requires verification. */
  requireVerificationForHighRisk: boolean;
  /** Delegation depth bound. Bounded 1..8. */
  maxDelegationDepth: number;
  /** v1.2: scan tool arguments for hidden/bidi Unicode (prompt-injection taint vector). */
  enableUnicodeSanitization: boolean;
  /** v1.2: record a taint_detected observability event when taint is found. */
  logTaintAttempts: boolean;
  /** v1.2: enforcement mode for tainted tool calls (DENY never inspects values). */
  taintPolicy: TaintPolicy;
  /** v1.2: chain-of-thought presence gate (audit event, never prompt injection). */
  reasoningTracePolicy: ReasoningTracePolicy;
  /** v1.3: routeId → expected CoT visibility; `none` routes never deny on cot_missing. */
  cotVisibilityProfiles: Record<string, CotVisibility>;
  /** v1.3: when true, ENFORCE for CoT applies only to HIGH-risk tool calls (others keep AUDIT). */
  riskGatedCoT: boolean;
  /**
   * v1.3: deny-retry detection. Default TRUE (deliberate): the guard fires only
   * on a same-shape retry of a call that was ALREADY denied on this session —
   * first-time calls are never affected, so the honest-traffic surface is
   * unchanged, while the Sol fail mode (retry-similar-command-after-deny) is
   * closed by default. Operators who need value-level retries can disable it.
   * Suite evidence: the full keyless suite stays green with the default.
   */
  denyCircumventionGuard: boolean;
  /**
   * v1.3: scan tool arguments for long base64/hex runs (steganographic
   * encoding blobs). Extension of the enableUnicodeSanitization surface —
   * same audit event shape (taint_detected), same taintPolicy enforcement.
   * Default false preserves v1.2 behavior exactly.
   */
  enableEncodingScan: boolean;
  /** v1.3: capability-class gate (OFF/AUDIT/ENFORCE) for requests carrying `capabilityClass`. */
  capabilityClassGate: CapabilityClassGate;
  /** v1.3: capability classes sanctioned for this profile (default [] = every labeled request flagged). */
  sanctionedCapabilityClasses: readonly string[];
  /** v1.3: additive sanction applied ONLY when executionClass=LAB. */
  labCapabilityClassAllowlist: readonly string[];
}

export const TAINT_POLICIES = ['LOG_ONLY', 'DENY'] as const;
export type TaintPolicy = (typeof TAINT_POLICIES)[number];

export const REASONING_TRACE_POLICIES = ['OFF', 'AUDIT', 'ENFORCE'] as const;
export type ReasoningTracePolicy = (typeof REASONING_TRACE_POLICIES)[number];

/** Production defaults (Spec §9). LAB never leaks into production implicitly. */
export const PRODUCTION_DEFAULTS: Readonly<SupremePolicyConfig> = Object.freeze({
  executionClass: 'STANDARD',
  allowPaid: false,
  allowTrial: false,
  allowUnknownCost: false,
  requireVerificationForHighRisk: true,
  maxDelegationDepth: 3,
  enableUnicodeSanitization: true,
  logTaintAttempts: true,
  taintPolicy: 'LOG_ONLY',
  reasoningTracePolicy: 'OFF',
  // v1.3 — behavior-preserving defaults: all new layers are OFF by default
  // except denyCircumventionGuard (see its doc comment for the rationale).
  cotVisibilityProfiles: Object.freeze({}) as Record<string, CotVisibility>,
  riskGatedCoT: false,
  denyCircumventionGuard: true,
  enableEncodingScan: false,
  capabilityClassGate: 'OFF',
  sanctionedCapabilityClasses: Object.freeze([] as string[]),
  labCapabilityClassAllowlist: Object.freeze([] as string[]),
});

export class PolicyConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid supreme-policy config: ${issues.join('; ')}`);
    this.name = 'PolicyConfigError';
  }
}

function isExecutionClass(v: unknown): v is ExecutionClass {
  return typeof v === 'string' && (EXECUTION_CLASSES as readonly string[]).includes(v);
}

/**
 * Deterministic config validation. Enforces:
 * - enum/bound checks,
 * - allowPaid/allowTrial overrides are LAB-only (production must never
 *   silently inherit LAB permissions),
 * - allowUnknownCost must be false (UNKNOWN → DENY hard rule).
 */
export function validatePolicyConfig(raw: Partial<SupremePolicyConfig>): SupremePolicyConfig {
  const issues: string[] = [];
  const executionClass = raw.executionClass ?? PRODUCTION_DEFAULTS.executionClass;
  if (!isExecutionClass(executionClass)) issues.push(`executionClass "${String(executionClass)}" is not one of ${EXECUTION_CLASSES.join('|')}`);

  const allowPaid = raw.allowPaid ?? false;
  const allowTrial = raw.allowTrial ?? false;
  const allowUnknownCost = raw.allowUnknownCost ?? false;
  const requireVerificationForHighRisk =
    raw.requireVerificationForHighRisk ?? PRODUCTION_DEFAULTS.requireVerificationForHighRisk;
  const maxDelegationDepth = raw.maxDelegationDepth ?? PRODUCTION_DEFAULTS.maxDelegationDepth;
  const enableUnicodeSanitization =
    raw.enableUnicodeSanitization ?? PRODUCTION_DEFAULTS.enableUnicodeSanitization;
  const logTaintAttempts = raw.logTaintAttempts ?? PRODUCTION_DEFAULTS.logTaintAttempts;
  const taintPolicy = raw.taintPolicy ?? PRODUCTION_DEFAULTS.taintPolicy;
  const reasoningTracePolicy = raw.reasoningTracePolicy ?? PRODUCTION_DEFAULTS.reasoningTracePolicy;
  // v1.3 fields — every default is behavior-preserving for v1.2 configs.
  const cotVisibilityProfiles: Record<string, CotVisibility> = { ...(raw.cotVisibilityProfiles ?? {}) };
  for (const [routeId, visibility] of Object.entries(cotVisibilityProfiles)) {
    if (!(COT_VISIBILITIES as readonly string[]).includes(visibility)) {
      issues.push(`cotVisibilityProfiles["${routeId}"] must be one of ${COT_VISIBILITIES.join('|')}, got "${String(visibility)}"`);
    }
  }
  const riskGatedCoT = raw.riskGatedCoT ?? PRODUCTION_DEFAULTS.riskGatedCoT;
  const denyCircumventionGuard = raw.denyCircumventionGuard ?? PRODUCTION_DEFAULTS.denyCircumventionGuard;
  const enableEncodingScan = raw.enableEncodingScan ?? PRODUCTION_DEFAULTS.enableEncodingScan;
  const capabilityClassGate = raw.capabilityClassGate ?? PRODUCTION_DEFAULTS.capabilityClassGate;
  if (!(CAPABILITY_CLASS_GATES as readonly string[]).includes(capabilityClassGate)) {
    issues.push(`capabilityClassGate "${String(capabilityClassGate)}" is not one of ${CAPABILITY_CLASS_GATES.join('|')}`);
  }
  const stringList = (value: unknown, field: string): readonly string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push(`${field} must be an array of non-empty strings`);
      return [];
    }
    return [...(value as string[])];
  };
  const sanctionedCapabilityClasses = stringList(raw.sanctionedCapabilityClasses, 'sanctionedCapabilityClasses');
  const labCapabilityClassAllowlist = stringList(raw.labCapabilityClassAllowlist, 'labCapabilityClassAllowlist');
  if (!(TAINT_POLICIES as readonly string[]).includes(taintPolicy)) {
    issues.push(`taintPolicy "${String(taintPolicy)}" is not one of ${TAINT_POLICIES.join('|')}`);
  }
  if (!(REASONING_TRACE_POLICIES as readonly string[]).includes(reasoningTracePolicy)) {
    issues.push(`reasoningTracePolicy "${String(reasoningTracePolicy)}" is not one of ${REASONING_TRACE_POLICIES.join('|')}`);
  }
  if (reasoningTracePolicy === 'ENFORCE' && executionClass === 'CORE') {
    issues.push('reasoningTracePolicy=ENFORCE is not permitted on the CORE composition floor');
  }

  if (allowPaid && executionClass !== 'LAB') {
    issues.push('allowPaid=true is only permitted with executionClass=LAB');
  }
  if (allowTrial && executionClass !== 'LAB') {
    issues.push('allowTrial=true is only permitted with executionClass=LAB');
  }
  if (allowUnknownCost !== false) {
    issues.push('allowUnknownCost must be false; UNKNOWN cost is always denied in v1');
  }
  if (!Number.isInteger(maxDelegationDepth) || maxDelegationDepth < 1 || maxDelegationDepth > 8) {
    issues.push(`maxDelegationDepth must be an integer in [1,8], got ${String(maxDelegationDepth)}`);
  }
  if (issues.length > 0) throw new PolicyConfigError(issues);

  return {
    executionClass,
    allowPaid,
    allowTrial,
    allowUnknownCost: false,
    requireVerificationForHighRisk,
    maxDelegationDepth,
    enableUnicodeSanitization,
    logTaintAttempts,
    taintPolicy: (TAINT_POLICIES as readonly string[]).includes(taintPolicy) ? taintPolicy : PRODUCTION_DEFAULTS.taintPolicy,
    reasoningTracePolicy: (REASONING_TRACE_POLICIES as readonly string[]).includes(reasoningTracePolicy)
      ? reasoningTracePolicy
      : PRODUCTION_DEFAULTS.reasoningTracePolicy,
    cotVisibilityProfiles,
    riskGatedCoT,
    denyCircumventionGuard,
    enableEncodingScan,
    capabilityClassGate: (CAPABILITY_CLASS_GATES as readonly string[]).includes(capabilityClassGate)
      ? capabilityClassGate
      : PRODUCTION_DEFAULTS.capabilityClassGate,
    sanctionedCapabilityClasses,
    labCapabilityClassAllowlist,
  };
}

// ---------------------------------------------------------------------------
// v1.2 — Unicode taint scanning (deterministic, values are NEVER reported).
//
// Upstream contract (pinned packages/core/tools/src/index.ts): tool arguments
// cross one lossless-JSON materialization boundary, are deep-frozen, and
// wrappers may change only `exec.signal` — input REWRITING is excluded
// upstream by design. Therefore the enforceable host-side posture is
// DETECT + AUDIT + DENY (pre-execute deny materializes an upstream error
// result); scrubbing-in-place would violate the pinned seam contract.
// ---------------------------------------------------------------------------

/** Hidden/bidi Unicode classes treated as taint (v3 plan §1A + Unicode TR51 tags). */
export const TAINT_CODEPOINTS: ReadonlyArray<{ name: string; description: string; re: RegExp }> = Object.freeze([
  { name: 'U+200B-U+200F', description: 'zero-width/joiner/marks', re: /[\u200B-\u200F]/g },
  { name: 'U+202A-U+202E', description: 'bidi embedding/overrides', re: /[\u202A-\u202E]/g },
  { name: 'U+2060-U+206F', description: 'invisible operators/bidi isolates', re: /[\u2060-\u206F]/g },
  { name: 'U+FEFF', description: 'zero-width no-break space (BOM)', re: /\uFEFF/g },
  { name: 'U+E0000-U+E007F', description: 'Unicode tag characters', re: /[\u{E0000}-\u{E007F}]/gu },
]);

export interface TaintFindings {
  tainted: boolean;
  /** Unique taint class names, deterministic order (TAINT_CODEPOINTS order). */
  hits: string[];
  /** Total number of tainted codepoints found (bounded scan). */
  count: number;
}

const TAINT_SCAN_LIMITS = Object.freeze({ maxNodes: 512, maxStringLength: 100_000 });

/**
 * Deterministic bounded scan of a JSON-serializable tool-arguments value.
 * Object keys are visited in sorted order; array items in index order.
 * Only class names are reported — never the carrying values (Spec §10 rule).
 */
export function inspectTaint(value: unknown, limits = TAINT_SCAN_LIMITS): TaintFindings {
  const hits = new Set<string>();
  let count = 0;
  let nodes = 0;
  const visit = (node: unknown): void => {
    if (nodes >= limits.maxNodes || count >= limits.maxStringLength) return;
    nodes++;
    if (typeof node === 'string') {
      const scan = node.length > limits.maxStringLength ? node.slice(0, limits.maxStringLength) : node;
      for (const { name, re } of TAINT_CODEPOINTS) {
        re.lastIndex = 0;
        const matches = scan.match(re);
        if (matches && matches.length > 0) {
          hits.add(name);
          count += matches.length;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        visit((node as Record<string, unknown>)[key]);
      }
    }
  };
  visit(value);
  return { tainted: hits.size > 0, hits: [...hits], count };
}

// ---------------------------------------------------------------------------
// v1.3 — Encoding-layer taint scan (ASTRA-1 P2). Extension of the
// enableUnicodeSanitization surface: same audit event shape (taint_detected),
// same taintPolicy (LOG_ONLY/DENY) enforcement, same no-value rule — audit
// records carry the argument NAME and run LENGTH only, never the value.
//
// Detection is purely shape-based: a ≥256-char contiguous run of hex digits
// or of base64 characters ([A-Za-z0-9+/=]) inside a tool-argument string
// value. The hex alphabet is a SUBSET of the base64 alphabet, so each string
// is classified once, most specific first: a pure-hex qualifying run reports
// kind 'hex', any other qualifying run reports kind 'base64' — one class per
// string keeps the report deterministic and non-duplicated. Both rules map to
// the same taint class `encoding_blob`. False positives are possible (e.g. a
// 256+ digit numeric literal) and accepted: the default posture is
// audit-only, and DENY is an explicit operator choice.
// ---------------------------------------------------------------------------

export const ENCODING_BLOB_CLASS = 'encoding_blob';

export const ENCODING_SCAN_LIMITS = Object.freeze({
  /** Minimum contiguous run length that qualifies as an encoding blob. */
  minRunLength: 256,
  /** Maximum reported hits per scan (bounded, deterministic order). */
  maxHits: 32,
  maxNodes: 512,
  maxStringLength: 100_000,
});

const BASE64_RUN_RE = /[A-Za-z0-9+/=]+/g;
const HEX_RUN_RE = /[0-9a-fA-F]+/g;

export interface EncodingHit {
  /** Argument path carrying the blob (dotted keys, array indexes in brackets); '(root)' for a top-level string. */
  arg: string;
  kind: 'base64' | 'hex';
  /** Length of the longest qualifying run. */
  length: number;
}

export interface EncodingFindings {
  tainted: boolean;
  /** Deterministic order: walk order (sorted keys / index order), one hit per string value. */
  hits: EncodingHit[];
}

function longestRun(text: string, re: RegExp, minLength: number): number {
  re.lastIndex = 0;
  let longest = 0;
  for (const match of text.matchAll(re)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return longest >= minLength ? longest : 0;
}

/**
 * Deterministic bounded scan for long base64/hex runs in string values.
 * Object keys visited in sorted order, array items in index order — identical
 * inputs always yield identical findings. Values are never reported.
 */
export function inspectEncodingTaint(value: unknown, limits = ENCODING_SCAN_LIMITS): EncodingFindings {
  const hits: EncodingHit[] = [];
  let nodes = 0;
  const visit = (node: unknown, path: string): void => {
    if (nodes >= limits.maxNodes || hits.length >= limits.maxHits) return;
    nodes++;
    if (typeof node === 'string') {
      const scan = node.length > limits.maxStringLength ? node.slice(0, limits.maxStringLength) : node;
      // Most specific first: a pure-hex qualifying run reports 'hex'; the hex
      // alphabet is a subset of the base64 alphabet, so this also keeps the
      // report to exactly one class per string value.
      const hex = longestRun(scan, HEX_RUN_RE, limits.minRunLength);
      if (hex > 0) {
        hits.push({ arg: path, kind: 'hex', length: hex });
        return;
      }
      const b64 = longestRun(scan, BASE64_RUN_RE, limits.minRunLength);
      if (b64 > 0) hits.push({ arg: path, kind: 'base64', length: b64 });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        visit((node as Record<string, unknown>)[key], path === '(root)' ? key : `${path}.${key}`);
      }
    }
  };
  visit(value, '(root)');
  return { tainted: hits.length > 0, hits };
}

/** Findings from the full v1.3 scan surface: unicode taint + encoding blobs. */
export interface ScanFindings extends TaintFindings {
  /** Encoding-blob hits (empty when enableEncodingScan is off or nothing found). */
  encoding: EncodingHit[];
}

/**
 * Combined deterministic scan of tool arguments. `unicode` maps to the v1.2
 * `enableUnicodeSanitization` toggle, `encoding` to the v1.3 `enableEncodingScan`
 * toggle. `hits` carries taint CLASS names only ('encoding_blob' for encoding).
 */
export function scanToolArguments(
  value: unknown,
  options: { unicode: boolean; encoding: boolean },
  limits = TAINT_SCAN_LIMITS,
): ScanFindings {
  const unicode = options.unicode
    ? inspectTaint(value, limits)
    : { tainted: false, hits: [] as string[], count: 0 };
  const encoding = options.encoding
    ? inspectEncodingTaint(value, ENCODING_SCAN_LIMITS)
    : { tainted: false, hits: [] as EncodingHit[] };
  const hits = [...unicode.hits];
  if (encoding.tainted) hits.push(ENCODING_BLOB_CLASS);
  return { tainted: hits.length > 0, hits, count: unicode.count, encoding: encoding.hits };
}

/**
 * Shared taint_detected detail builder — the ONLY place that formats taint
 * audit metadata. Emits class names, tainted-codepoint counts, and for
 * encoding hits the argument NAME + run LENGTH. Never a value.
 * Without encoding hits the output is byte-identical to the v1.2 format.
 */
export function formatTaintEventDetail(findings: ScanFindings): string {
  const parts: string[] = [];
  if (findings.hits.length > 0) parts.push(`classes:${findings.hits.join('+')}`);
  if (findings.count > 0) parts.push(`count:${findings.count}`);
  for (const hit of findings.encoding) parts.push(`arg:${hit.arg};kind:${hit.kind};len:${hit.length}`);
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// v1.2 — Chain-of-thought presence gate (deterministic audit, NOT prompt
// injection). Evidence source: pinned SessionEventMap 'assistant/message'
// data carries message.content ReasoningBlocks (type 'reasoning') and the
// timed stream records (type 'reasoning-chunks') — both observable by any
// session/event listener. Absence of a trace is an AUDIT fact; ENFORCE
// additionally denies subsequent tool calls for that session.
// ---------------------------------------------------------------------------

export interface CoTGateInput {
  /** true/false from the last assistant message; undefined = no evidence yet. */
  reasoningTracePresent: boolean | undefined;
  tool: string;
}

export interface CoTGateDecision {
  decision: 'ALLOW' | 'AUDIT' | 'DENY';
  reasonCodes: string[];
}

/** Deterministic CoT presence gate. OFF<AUDIT<ENFORCE; undefined evidence is never DENIED. */
export function evaluateCoTGate(mode: ReasoningTracePolicy, input: CoTGateInput): CoTGateDecision {
  if (mode === 'OFF') return { decision: 'ALLOW', reasonCodes: ['COT_GATE_OFF'] };
  if (input.reasoningTracePresent === true) return { decision: 'ALLOW', reasonCodes: ['COT_TRACE_PRESENT'] };
  if (input.reasoningTracePresent === undefined) {
    // No assistant message observed yet — enforcement without evidence would
    // guess. Audit only (fail-open for unknown, fail-closed for known absence).
    return mode === 'ENFORCE'
      ? { decision: 'AUDIT', reasonCodes: ['COT_TRACE_UNKNOWN'] }
      : { decision: 'AUDIT', reasonCodes: ['COT_TRACE_MISSING'] };
  }
  return mode === 'ENFORCE'
    ? { decision: 'DENY', reasonCodes: ['COT_TRACE_MISSING', 'COT_ENFORCED'] }
    : { decision: 'AUDIT', reasonCodes: ['COT_TRACE_MISSING'] };
}

// ---------------------------------------------------------------------------
// v1.3 — CoT visibility profile + risk-gated CoT requirement (ASTRA-1 P1).
//
// Astra-class models legitimately produce empty reasoning traces. When a
// route's CoT visibility is declared `none`, `cot_missing` must NEVER deny —
// it downgrades to audit-only. With `riskGatedCoT`, ENFORCE additionally
// applies only to HIGH-risk tool calls (command/network/write per the
// deterministic classifier below); non-HIGH tools keep AUDIT behavior.
// ---------------------------------------------------------------------------

/**
 * Shared signal contract for the router agent (EXACT field names). Any
 * request/decision payload the adapter already receives may carry these keys
 * at its top level; the policy consumes them verbatim:
 *   - `capabilityClass` — capability-class gating (feature P3);
 *   - `cotVisibility`   — explicit CoT visibility, highest precedence (P1).
 */
export interface CapabilitySignal {
  capabilityClass?: string;
  cotVisibility?: CotVisibility;
}

/**
 * Deterministic extraction of the shared signal fields (EXACT names
 * `capabilityClass` / `cotVisibility`) from a request/decision payload's top
 * level. Non-strings or unknown visibility values are ignored (absent
 * signal ⇒ policy falls through to profiles/default). Never echoes values
 * into reasons — the extracted class label is a contract name, not a value.
 */
export function extractCapabilitySignal(payload: unknown): CapabilitySignal {
  const out: CapabilitySignal = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const rec = payload as Record<string, unknown>;
  const cc = rec.capabilityClass;
  if (typeof cc === 'string' && cc.trim() !== '') {
    out.capabilityClass = cc.trim().toUpperCase();
  }
  const cv = rec.cotVisibility;
  if (typeof cv === 'string' && (COT_VISIBILITIES as readonly string[]).includes(cv)) {
    out.cotVisibility = cv as CotVisibility;
  }
  return out;
}

/**
 * Resolve the effective CoT visibility for a route (deterministic order):
 * (a) explicit `cotVisibility` on the call/request input if present,
 * (b) `cotVisibilityProfiles[routeId]`,
 * (c) default 'verbose' (v1.2 behavior — every route is expected to talk).
 */
export function resolveCotVisibility(input: {
  explicit?: unknown;
  profile?: unknown;
}): CotVisibility {
  if (typeof input.explicit === 'string' && (COT_VISIBILITIES as readonly string[]).includes(input.explicit)) {
    return input.explicit as CotVisibility;
  }
  if (typeof input.profile === 'string' && (COT_VISIBILITIES as readonly string[]).includes(input.profile)) {
    return input.profile as CotVisibility;
  }
  return 'verbose';
}

export interface CoTEnforcementInput extends CoTGateInput {
  /** Resolved route visibility (resolveCotVisibility). Absent ⇒ 'verbose'. */
  visibility?: CotVisibility;
  /** Config `riskGatedCoT`: ENFORCE only for HIGH-risk tools. */
  riskGated?: boolean;
  /** Deterministic risk of the called tool (classifyToolRisk). */
  toolRisk?: RiskClass;
}

/**
 * v1.3 CoT enforcement pipeline. Order (deterministic):
 *   1. OFF ⇒ allow.
 *   2. riskGatedCoT + non-HIGH tool ⇒ ENFORCE downgrades to AUDIT.
 *   3. visibility 'none' ⇒ ENFORCE never denies on cot_missing (audit-only):
 *      an empty-CoT model cannot be coerced into producing a trace, and
 *      denying every call would be a self-inflicted denial of service.
 *   4. Base presence gate (evaluateCoTGate) for the effective mode.
 */
export function evaluateCoTEnforcement(
  mode: ReasoningTracePolicy,
  input: CoTEnforcementInput,
): CoTGateDecision {
  if (mode === 'OFF') return { decision: 'ALLOW', reasonCodes: ['COT_GATE_OFF'] };
  let effective = mode;
  if (mode === 'ENFORCE' && input.riskGated === true && input.toolRisk !== 'HIGH') {
    effective = 'AUDIT';
  }
  if (effective === 'ENFORCE' && input.visibility === 'none' && input.reasoningTracePresent === false) {
    return { decision: 'AUDIT', reasonCodes: ['COT_TRACE_MISSING', 'COT_VISIBILITY_NONE_DOWNGRADED'] };
  }
  return evaluateCoTGate(effective, {
    reasoningTracePresent: input.reasoningTracePresent,
    tool: input.tool,
  });
}

// ---------------------------------------------------------------------------
// v1.3 — Deterministic tool-risk classifier (command / network / write).
//
// Keyed by tool NAME tokens only (split on non-alphanumerics, lowercase) —
// no argument inspection, no ML. Used by riskGatedCoT. Token matching avoids
// substring false hits (e.g. "notebook" does not contain the token "note").
// Read-only names (read/list/search/…) match no set and classify LOW.
// ---------------------------------------------------------------------------

const HIGH_RISK_TOOL_TOKENS: ReadonlyArray<{ kind: string; tokens: ReadonlySet<string> }> = Object.freeze([
  { kind: 'command', tokens: new Set(['bash', 'sh', 'zsh', 'shell', 'cmd', 'command', 'powershell', 'pwsh', 'exec', 'execute', 'terminal', 'console', 'process', 'spawn', 'run']) },
  { kind: 'network', tokens: new Set(['fetch', 'curl', 'wget', 'http', 'https', 'net', 'network', 'socket', 'ftp', 'upload', 'download', 'request', 'web', 'browser', 'browse', 'url']) },
  { kind: 'write', tokens: new Set(['write', 'edit', 'delete', 'remove', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'move', 'copy', 'rename', 'patch', 'apply', 'create', 'unlink', 'truncate', 'chmod', 'chown', 'save']) },
]);

/** Deterministic HIGH-risk classification for command/network/write tool names; everything else is LOW. */
export function classifyToolRisk(toolName: string): RiskClass {
  const tokens = String(toolName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    for (const group of HIGH_RISK_TOOL_TOKENS) {
      if (group.tokens.has(token)) return 'HIGH'; // command/network/write are the HIGH-risk surface (ASTRA-1 P1)
    }
  }
  return 'LOW';
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCodes: string[];
  verificationRequired: VerificationLevel;
}

export interface RoutePolicyInput {
  costClass: CostClass;
  risk: RiskClass;
}

/**
 * Route admission. Hard rule: UNKNOWN cost → DENY regardless of config
 * (missing metadata must never become permission).
 */
export function evaluateRoutePolicy(
  config: SupremePolicyConfig,
  input: RoutePolicyInput,
): PolicyDecision {
  const reasonCodes: string[] = [];
  let allowed = true;

  switch (input.costClass) {
    case 'FREE_CONFIRMED':
      reasonCodes.push('COST_FREE_CONFIRMED');
      break;
    case 'FREE_LIMITED':
      allowed = true;
      reasonCodes.push('COST_FREE_LIMITED_RATE_LIMITED_POSSIBLE');
      break;
    case 'TRIAL':
      allowed = config.allowTrial;
      reasonCodes.push(allowed ? 'COST_TRIAL_ALLOWED_LAB' : 'COST_TRIAL_DENIED');
      break;
    case 'PAID':
      allowed = config.allowPaid;
      reasonCodes.push(allowed ? 'COST_PAID_ALLOWED_LAB' : 'COST_PAID_DENIED');
      break;
    case 'UNKNOWN':
    default:
      allowed = false;
      reasonCodes.push('COST_UNKNOWN_DENIED');
      break;
  }

  const verificationRequired = verificationRequirement(config, input);
  if (verificationRequired !== 'NONE') reasonCodes.push(`VERIFICATION_${verificationRequired}`);
  if (allowed) reasonCodes.push('OK');
  return { allowed, reasonCodes, verificationRequired };
}

/** Verification level demanded for a route/task. */
export function verificationRequirement(
  config: SupremePolicyConfig,
  input: { risk: RiskClass; costClass?: CostClass },
): VerificationLevel {
  if (input.risk === 'HIGH') {
    return config.requireVerificationForHighRisk ? 'REQUIRED' : 'BASIC';
  }
  if (input.risk === 'MEDIUM') return 'BASIC';
  if (input.costClass === 'PAID' && config.allowPaid) return 'STRICT';
  return 'NONE';
}

export interface DelegationDecision {
  allowed: boolean;
  reasonCodes: string[];
}

/** Delegation admission: bounded depth; credential/secret inspection never delegates. */
export function evaluateDelegationPolicy(
  config: SupremePolicyConfig,
  input: { depth: number; secretAccess: boolean },
): DelegationDecision {
  const reasonCodes: string[] = [];
  if (input.secretAccess) {
    return { allowed: false, reasonCodes: ['SECRET_ACCESS_DELEGATION_DENIED'] };
  }
  if (input.depth > config.maxDelegationDepth) {
    return { allowed: false, reasonCodes: ['DELEGATION_DEPTH_EXCEEDED'] };
  }
  reasonCodes.push('OK');
  return { allowed: true, reasonCodes };
}

/** Compact derived state safe for system-prompt contribution (Spec §18). */
export function executionPolicySummary(config: SupremePolicyConfig): {
  executionClass: ExecutionClass;
  paidRoutes: 'DENY' | 'ALLOW_LAB_ONLY';
  unknownCost: 'DENY';
  trialRoutes: 'DENY' | 'ALLOW_LAB_ONLY';
  highRiskVerification: VerificationLevel;
  maxDelegationDepth: number;
} {
  return {
    executionClass: config.executionClass,
    paidRoutes: config.allowPaid ? 'ALLOW_LAB_ONLY' : 'DENY',
    unknownCost: 'DENY',
    trialRoutes: config.allowTrial ? 'ALLOW_LAB_ONLY' : 'DENY',
    highRiskVerification: config.requireVerificationForHighRisk ? 'REQUIRED' : 'BASIC',
    maxDelegationDepth: config.maxDelegationDepth,
  };
}

// ---------------------------------------------------------------------------
// v1.3 — Deny-circumvention guard (ASTRA-1 P1, Sol fail mode #1: retry a
// similar command after a deny). Deterministic, counting-only:
//   - after a {kind:'deny'} decision on the tools/pre-execute seam, the call's
//     NORMALIZED SIGNATURE (tool name + argument SHAPE = argument names +
//     primitive types — NEVER values) is recorded in a session-scoped set;
//   - a later call with the SAME signature ⇒ DENY with reason code
//     `deny_retry` + audit event; other tools and other shapes are unaffected.
//
// Why shape-level: the Spec §10 rule forbids echoing/storing argument values,
// so similarity can only be measured structurally. A value-corrected retry is
// therefore still flagged — the operator's escape hatch is the documented
// `resetDenyCircumvention(sessionId)` (e.g. after manual approval).
// ---------------------------------------------------------------------------

export const DENY_RETRY_REASON_CODE = 'deny_retry';

const SHAPE_LIMITS = Object.freeze({ maxDepth: 8, maxKeysPerNode: 64, maxLength: 4096 });

function shapeOf(value: unknown, depth: number): string {
  if (depth > SHAPE_LIMITS.maxDepth) return '(depth)';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'undefined':
      return 'undefined';
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, SHAPE_LIMITS.maxKeysPerNode).map((item) => shapeOf(item, depth + 1));
    return `[${items.join(',')}${value.length > SHAPE_LIMITS.maxKeysPerNode ? ',…' : ''}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, SHAPE_LIMITS.maxKeysPerNode);
    const body = keys
      .map((key) => `${key}:${shapeOf((value as Record<string, unknown>)[key], depth + 1)}`)
      .join(',');
    return `{${body}}`;
  }
  return 'unknown';
}

/**
 * Normalized call signature: `<tool>(<arg-shape>)`. The shape encodes argument
 * NAMES and primitive TYPES only (sorted keys, bounded depth/width) — no
 * values can ever enter the signature, so the deny set can never leak them.
 */
export function denySignature(toolName: string, args: unknown): string {
  const sig = `${String(toolName)}(${shapeOf(args, 0)})`;
  return sig.length > SHAPE_LIMITS.maxLength ? sig.slice(0, SHAPE_LIMITS.maxLength) : sig;
}

export interface DenyRetryCheck {
  denied: boolean;
  reasonCodes: string[];
}

export interface DenyGuardLimits {
  /** Tracked sessions before the oldest session is evicted (insertion order). */
  maxSessions: number;
  /** Tracked signatures per session before the oldest signature is evicted. */
  maxSignaturesPerSession: number;
}

/**
 * Session-scoped deny-signature memory. Purely deterministic: Map/Set
 * insertion order eviction, no timers, no persistence. `check` never mutates;
 * `recordDeny` deduplicates via Set semantics.
 */
export class DenyCircumventionGuard {
  private readonly sessions = new Map<string, Set<string>>();
  private readonly limits: DenyGuardLimits;

  constructor(limits: Partial<DenyGuardLimits> = {}) {
    this.limits = {
      maxSessions: limits.maxSessions ?? 256,
      maxSignaturesPerSession: limits.maxSignaturesPerSession ?? 64,
    };
  }

  /** Record the signature of a denied call for `sessionId`. */
  recordDeny(sessionId: string, toolName: string, args: unknown): void {
    const key = String(sessionId);
    let signatures = this.sessions.get(key);
    if (!signatures) {
      if (this.sessions.size >= this.limits.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      signatures = new Set<string>();
      this.sessions.set(key, signatures);
    }
    if (signatures.size >= this.limits.maxSignaturesPerSession && !signatures.has(denySignature(toolName, args))) {
      const oldest = signatures.values().next().value;
      if (oldest !== undefined) signatures.delete(oldest);
    }
    signatures.add(denySignature(toolName, args));
  }

  /** Check a pending call against the session's deny set (read-only). */
  check(sessionId: string, toolName: string, args: unknown): DenyRetryCheck {
    const signatures = this.sessions.get(String(sessionId));
    if (!signatures || signatures.size === 0) return { denied: false, reasonCodes: [] };
    if (signatures.has(denySignature(toolName, args))) {
      return { denied: true, reasonCodes: [DENY_RETRY_REASON_CODE] };
    }
    return { denied: false, reasonCodes: [] };
  }

  /** Clear all recorded signatures for `sessionId` (operator escape hatch). */
  resetDenyCircumvention(sessionId: string): void {
    this.sessions.delete(String(sessionId));
  }

  /** Number of recorded signatures for `sessionId` (0 when untracked). */
  signatureCount(sessionId: string): number {
    return this.sessions.get(String(sessionId))?.size ?? 0;
  }

  /** Clear every tracked session (fiber dispose). */
  dispose(): void {
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// v1.3 — Capability-class gating (ASTRA-1 P3, Daybreak analog). Requests
// carrying `capabilityClass` (shared contract, EXACT field name) are gated:
//   - OFF   ⇒ untouched (default; v1.2 posture).
//   - AUDIT ⇒ `capability_class_unsanctioned` audit event when unsanctioned.
//   - ENFORCE ⇒ DENY when unsanctioned.
// Requests WITHOUT a class pass untouched (the UNKNOWN-cost hard rule is
// unaffected). Sanctions come from `sanctionedCapabilityClasses`;
// `labCapabilityClassAllowlist` adds sanctions ONLY when executionClass=LAB.
// There is NO implicit 'ROUTINE' exemption: with the default empty sanction
// list every labeled request is flagged — labeling can only RESTRICT, never
// grant, so a self-declared label cannot buy permission the operator did not
// sanction.
// ---------------------------------------------------------------------------

/** Normalize a capability-class label (trim + uppercase) for deterministic comparisons. */
export function normalizeCapabilityClass(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed === '' ? undefined : trimmed;
}

function sanctionListContains(list: readonly string[], capabilityClass: string): boolean {
  return list.some((entry) => normalizeCapabilityClass(entry) === capabilityClass);
}

/**
 * Sanction test for one normalized capability class under `config`.
 * LAB allowlist is ADDITIVE and only on the LAB execution floor.
 */
export function isCapabilityClassSanctioned(config: SupremePolicyConfig, capabilityClass: string): boolean {
  const cls = normalizeCapabilityClass(capabilityClass);
  if (cls === undefined) return true; // no class ⇒ nothing to gate
  if (sanctionListContains(config.sanctionedCapabilityClasses, cls)) return true;
  if (config.executionClass === 'LAB' && sanctionListContains(config.labCapabilityClassAllowlist, cls)) return true;
  return false;
}

export interface CapabilityGateInput {
  /** Raw class label from the request payload (undefined = absent). */
  capabilityClass?: unknown;
}

export interface CapabilityGateDecision {
  decision: 'ALLOW' | 'AUDIT' | 'DENY';
  reasonCodes: string[];
  /** Normalized class label (name only, safe for audit); undefined when absent. */
  capabilityClass?: string;
}

/** Deterministic capability-class gate (OFF < AUDIT < ENFORCE). */
export function evaluateCapabilityGate(
  config: SupremePolicyConfig,
  input: CapabilityGateInput,
): CapabilityGateDecision {
  const capabilityClass = normalizeCapabilityClass(input.capabilityClass);
  if (capabilityClass === undefined) {
    // Requests without a class pass untouched — existing UNKNOWN-cost posture unchanged.
    return { decision: 'ALLOW', reasonCodes: ['CAPABILITY_CLASS_ABSENT'] };
  }
  if (config.capabilityClassGate === 'OFF') {
    return { decision: 'ALLOW', reasonCodes: ['CAPABILITY_GATE_OFF'], capabilityClass };
  }
  if (isCapabilityClassSanctioned(config, capabilityClass)) {
    return { decision: 'ALLOW', reasonCodes: ['CAPABILITY_CLASS_SANCTIONED'], capabilityClass };
  }
  return config.capabilityClassGate === 'ENFORCE'
    ? { decision: 'DENY', reasonCodes: ['CAPABILITY_CLASS_UNSANCTIONED', 'CAPABILITY_ENFORCED'], capabilityClass }
    : { decision: 'AUDIT', reasonCodes: ['CAPABILITY_CLASS_UNSANCTIONED'], capabilityClass };
}
