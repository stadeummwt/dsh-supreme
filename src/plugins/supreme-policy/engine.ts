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
