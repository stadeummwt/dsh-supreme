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
}

/** Production defaults (Spec §9). LAB never leaks into production implicitly. */
export const PRODUCTION_DEFAULTS: Readonly<SupremePolicyConfig> = Object.freeze({
  executionClass: 'STANDARD',
  allowPaid: false,
  allowTrial: false,
  allowUnknownCost: false,
  requireVerificationForHighRisk: true,
  maxDelegationDepth: 3,
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
  };
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
