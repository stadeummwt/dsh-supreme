/**
 * @dsh-supreme/workflow-policy — decision engine.
 *
 * Owns WHEN and HOW the official ctx.subagents / ctx.workflowEngine are used
 * (Spec §14 original). It is NOT another subagent registry or workflow engine.
 *
 * Degradation ladder (subject to task requirements):
 *   SUPREME_WORKFLOW → WORKFLOW → SUBAGENT → DIRECT → DENY
 * Never increases fan-out after failure. Never delegates credential/secret
 * inspection.
 */

export const WORKFLOW_DECISIONS = ['DIRECT', 'SUBAGENT', 'WORKFLOW', 'SUPREME_WORKFLOW', 'DENY'] as const;
export type WorkflowDecision = (typeof WORKFLOW_DECISIONS)[number];

export const COMPLEXITIES = ['simple', 'moderate', 'complex', 'multi_stage'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export interface WorkflowLimitsConfig {
  maxConcurrentAgents: number;
  maxTotalAgents: number;
  maxDepth: number;
  workflowTimeoutMs: number;
  subagentTimeoutMs: number;
  allowedSubagentProviders: string[];
  /** v1.2: surgical scope — globs a delegation path MUST match (empty = no allowlist). */
  allowedPaths: string[];
  /** v1.2: surgical scope — globs a delegation path must NEVER match (wins over allowedPaths). */
  blockedPaths: string[];
  /** v1.2: HIGH-risk tasks may only close with recorded verifier PASS evidence. */
  requireVerifierPassOnClose: boolean;
}

export const WORKFLOW_LIMIT_DEFAULTS: Readonly<WorkflowLimitsConfig> = Object.freeze({
  maxConcurrentAgents: 3,
  maxTotalAgents: 12,
  maxDepth: 2,
  workflowTimeoutMs: 600_000,
  subagentTimeoutMs: 120_000,
  allowedSubagentProviders: ['spawn'],
  allowedPaths: [],
  blockedPaths: [],
  requireVerifierPassOnClose: false,
});

export class WorkflowConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid workflow-policy config: ${issues.join('; ')}`);
    this.name = 'WorkflowConfigError';
  }
}

export function validateWorkflowLimits(raw: Partial<WorkflowLimitsConfig>): WorkflowLimitsConfig {
  const issues: string[] = [];
  const limits: WorkflowLimitsConfig = { ...WORKFLOW_LIMIT_DEFAULTS, ...raw };
  const bounded: Array<[string, number, number, number]> = [
    ['maxConcurrentAgents', limits.maxConcurrentAgents, 1, 8],
    ['maxTotalAgents', limits.maxTotalAgents, 1, 32],
    ['maxDepth', limits.maxDepth, 0, 4],
  ];
  for (const [name, value, min, max] of bounded) {
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(`${name} must be an integer in [${min},${max}], got ${String(value)}`);
    }
  }
  if (!Number.isFinite(limits.workflowTimeoutMs) || limits.workflowTimeoutMs < 1000) {
    issues.push('workflowTimeoutMs must be >= 1000');
  }
  if (!Number.isFinite(limits.subagentTimeoutMs) || limits.subagentTimeoutMs < 1000) {
    issues.push('subagentTimeoutMs must be >= 1000');
  }
  if (!Array.isArray(limits.allowedSubagentProviders) || limits.allowedSubagentProviders.length === 0) {
    issues.push('allowedSubagentProviders must be a non-empty array');
  }
  for (const key of ['allowedPaths', 'blockedPaths'] as const) {
    const list = limits[key];
    if (!Array.isArray(list) || list.some((g) => typeof g !== 'string' || g.length === 0 || g.length > 512)) {
      issues.push(`${key} must be an array of non-empty glob strings (≤512 chars)`);
    }
  }
  if (typeof limits.requireVerifierPassOnClose !== 'boolean') {
    issues.push('requireVerifierPassOnClose must be a boolean');
  }
  if (issues.length > 0) throw new WorkflowConfigError(issues);
  return limits;
}

export interface WorkflowDecisionInput {
  complexity: Complexity;
  parallelizable: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresCapabilities: string[];
  availableCapabilities: string[];
  availableProviders: string[];
  depth: number;
  activeAgents: number;
  totalAgentsUsed: number;
  tokenPressure?: number;
  secretAccessRequested?: boolean;
}

export interface WorkflowDecisionResult {
  decision: WorkflowDecision;
  reasonCodes: string[];
  degradedFrom?: WorkflowDecision;
  limits: WorkflowLimitsConfig;
  expectedVerification: 'NONE' | 'BASIC' | 'REQUIRED';
  /** v1.2: close condition for the task (HIGH risk + requireVerifierPassOnClose). */
  closeGate: 'NONE' | 'VERIFIER_PASS_REQUIRED';
}

const DEGRADE_ORDER: WorkflowDecision[] = ['SUPREME_WORKFLOW', 'WORKFLOW', 'SUBAGENT', 'DIRECT'];

/**
 * Deterministic decision procedure:
 *  1. hard DENY: secret access requested, missing required capabilities,
 *     depth beyond bound, saturation beyond total-agent bound;
 *  2. pick the baseline decision from task shape;
 *  3. degrade through the ladder while constraints (concurrency, providers,
 *     token pressure, depth) are violated.
 */
export function decideWorkflow(
  limits: WorkflowLimitsConfig,
  input: WorkflowDecisionInput,
): WorkflowDecisionResult {
  const reasonCodes: string[] = [];

  if (input.secretAccessRequested) {
    return {
      decision: 'DENY',
      reasonCodes: ['SECRET_ACCESS_DELEGATION_DENIED'],
      limits,
      expectedVerification: 'REQUIRED',
      closeGate: 'VERIFIER_PASS_REQUIRED',
    };
  }

  const missingCaps = input.requiresCapabilities.filter(
    (cap) => !input.availableCapabilities.includes(cap),
  );
  if (missingCaps.length > 0) {
    return {
      decision: 'DENY',
      reasonCodes: [`MISSING_CAPABILITY:${missingCaps.join('+')}`],
      limits,
      expectedVerification: 'NONE',
      closeGate: 'NONE',
    };
  }

  if (input.depth > limits.maxDepth) {
    return {
      decision: 'DENY',
      reasonCodes: ['DELEGATION_DEPTH_EXCEEDED'],
      limits,
      expectedVerification: 'NONE',
      closeGate: 'NONE',
    };
  }

  if (input.totalAgentsUsed >= limits.maxTotalAgents) {
    return {
      decision: 'DIRECT',
      reasonCodes: ['TOTAL_AGENT_BUDGET_EXHAUSTED'],
      limits,
      expectedVerification: 'BASIC',
      closeGate: input.risk === 'HIGH' && limits.requireVerifierPassOnClose ? 'VERIFIER_PASS_REQUIRED' : 'NONE',
    };
  }

  const eligibleProviders = input.availableProviders.filter((p) =>
    limits.allowedSubagentProviders.includes(p),
  );
  const providersUsable = eligibleProviders.length > 0;

  // Baseline by task shape.
  let decision: WorkflowDecision;
  if (input.complexity === 'simple' && !input.parallelizable) {
    decision = 'DIRECT';
    reasonCodes.push('SIMPLE_TASK_DIRECT');
  } else if (input.parallelizable && input.complexity !== 'simple') {
    decision = 'WORKFLOW';
    reasonCodes.push('PARALLELIZABLE_TASK');
  } else if (input.complexity === 'multi_stage') {
    decision = 'WORKFLOW';
    reasonCodes.push('MULTI_STAGE_TASK');
  } else {
    decision = 'SUBAGENT';
    reasonCodes.push('DELEGATABLE_TASK');
  }

  // SUPREME_WORKFLOW: complex + high-risk, only with providers and bounded load.
  if (
    decision === 'WORKFLOW' &&
    input.risk === 'HIGH' &&
    providersUsable &&
    input.depth < limits.maxDepth &&
    input.activeAgents + 2 <= limits.maxConcurrentAgents
  ) {
    decision = 'SUPREME_WORKFLOW';
    reasonCodes.push('HIGH_RISK_SUPREME_ORCHESTRATION');
  }

  const expectedVerification = input.risk === 'HIGH' ? 'REQUIRED' : input.risk === 'MEDIUM' ? 'BASIC' : 'NONE';

  // Degradation ladder.
  let degradedFrom: WorkflowDecision | undefined;
  const degrade = (): void => {
    const idx = DEGRADE_ORDER.indexOf(decision);
    if (idx >= 0 && idx < DEGRADE_ORDER.length - 1) {
      degradedFrom = degradedFrom ?? decision;
      decision = DEGRADE_ORDER[idx + 1];
      reasonCodes.push(`DEGRADED_TO_${decision}`);
    }
  };

  let guard = 0;
  while (guard++ < 8) {
    if (input.activeAgents >= limits.maxConcurrentAgents && decision !== 'DIRECT') {
      reasonCodes.push('CONCURRENCY_LIMIT');
      degrade();
      continue;
    }
    if ((decision === 'WORKFLOW' || decision === 'SUPREME_WORKFLOW' || decision === 'SUBAGENT') && !providersUsable) {
      reasonCodes.push('NO_ELIGIBLE_PROVIDER');
      degrade();
      continue;
    }
    if ((input.tokenPressure ?? 0) > 0.85 && decision !== 'DIRECT') {
      reasonCodes.push('TOKEN_PRESSURE_HIGH');
      degrade();
      continue;
    }
    break;
  }

  return { decision, reasonCodes, degradedFrom, limits, expectedVerification, closeGate: input.risk === 'HIGH' && limits.requireVerifierPassOnClose ? 'VERIFIER_PASS_REQUIRED' : 'NONE' };
}

// ---------------------------------------------------------------------------
// v1.2 — Surgical path scope (v3 plan §4A). Deterministic glob matching with
// zero dependencies: ** crosses '/', * and ? stay within one segment.
// blockedPaths WIN over allowedPaths (explicit prohibition beats permission).
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

/** Deterministic glob → RegExp (** crosses segments; * / ? stay in-segment). */
export function pathMatchesGlob(path: string, pattern: string): boolean {
  const key = pattern;
  let re = globCache.get(key);
  if (!re) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') {
        if (pattern[i + 1] === '*') {
          out += '.*';
          i++;
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    re = new RegExp(`^${out}$`);
    if (globCache.size < 256) globCache.set(key, re);
  }
  return re.test(path);
}

export type PathScopeReason =
  | 'NO_PATH_RULES'
  | 'PATH_ALLOWED'
  | 'PATH_BLOCKED'
  | 'PATH_OUTSIDE_ALLOWED';

export interface PathScopeDecision {
  allowed: boolean;
  reasonCode: PathScopeReason;
  matchedBlocked?: string;
}

/** Deterministic surgical scope: blockedPaths win; empty allowedPaths = no allowlist. */
export function evaluatePathScope(
  limits: Pick<WorkflowLimitsConfig, 'allowedPaths' | 'blockedPaths'>,
  path: string,
): PathScopeDecision {
  for (const pattern of limits.blockedPaths) {
    if (pathMatchesGlob(path, pattern)) {
      return { allowed: false, reasonCode: 'PATH_BLOCKED', matchedBlocked: pattern };
    }
  }
  if (limits.allowedPaths.length > 0 && !limits.allowedPaths.some((p) => pathMatchesGlob(path, p))) {
    return { allowed: false, reasonCode: 'PATH_OUTSIDE_ALLOWED' };
  }
  return {
    allowed: true,
    reasonCode: limits.allowedPaths.length === 0 && limits.blockedPaths.length === 0 ? 'NO_PATH_RULES' : 'PATH_ALLOWED',
  };
}

// ---------------------------------------------------------------------------
// v1.2 — Verifier-gated close (v3 plan §4A/§4B). Honest posture: in STANDARD
// (allowCommands=false) the verifier cannot EXECUTE tests, so HIGH-risk tasks
// must carry RECORDED verifier PASS evidence to close; LAB can run real ones.
// ---------------------------------------------------------------------------

export type CloseVerifierStatus = 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE' | 'MISSING';

export interface CloseDecision {
  closable: boolean;
  reasonCode: string;
}

/** Deterministic close gate: HIGH risk closes only with recorded verifier PASS when enabled. */
export function canCloseTask(
  limits: Pick<WorkflowLimitsConfig, 'requireVerifierPassOnClose'>,
  input: { risk: 'LOW' | 'MEDIUM' | 'HIGH'; verifierStatus: CloseVerifierStatus },
): CloseDecision {
  if (!limits.requireVerifierPassOnClose || input.risk !== 'HIGH') {
    return { closable: true, reasonCode: 'CLOSE_UNRESTRICTED' };
  }
  if (input.verifierStatus === 'PASS') return { closable: true, reasonCode: 'VERIFIER_PASS_RECORDED' };
  return { closable: false, reasonCode: `VERIFIER_${input.verifierStatus}_BLOCKS_CLOSE` };
}

export interface DelegationScope {
  task: string;
  allowedCapabilities: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  writePermission: boolean;
  secretPolicy: 'DENY_ALL';
  expectedOutput: string;
  verificationRequirement: 'NONE' | 'BASIC' | 'REQUIRED';
  stopCondition: string;
}

/**
 * Explicit delegation scope builder. Every field is mandatory — a delegation
 * without a stated stop condition or secret policy is rejected (type error).
 */
export function buildDelegationScope(scope: DelegationScope): Readonly<DelegationScope> {
  if (scope.secretPolicy !== 'DENY_ALL') {
    throw new WorkflowConfigError(['secretPolicy must be DENY_ALL — never delegate credential inspection']);
  }
  if (scope.task.length === 0 || scope.stopCondition.length === 0 || scope.expectedOutput.length === 0) {
    throw new WorkflowConfigError(['task, expectedOutput and stopCondition are mandatory']);
  }
  return Object.freeze({ ...scope, secretPolicy: 'DENY_ALL' as const });
}
