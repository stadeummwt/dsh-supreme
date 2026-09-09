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
  /** v1.3: A2A contact policy — LOG_ONLY audits out-of-graph contacts, DENY blocks them. */
  agentContactPolicy: AgentContactPolicy;
  /** v1.3: declared inter-agent contact graph (directed edges). Empty = policy inert. */
  allowedContacts: AgentContactEdge[];
  /** v1.3: overreach ceiling — requests above this risk level are audited. Default HIGH = unchanged. */
  maxRiskLevel: RiskLevel;
  /** v1.3: task classes that require an approval flag on the delegation request. */
  approvalRequiredFor: string[];
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
  agentContactPolicy: 'LOG_ONLY',
  allowedContacts: [],
  maxRiskLevel: 'HIGH',
  approvalRequiredFor: [],
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
  if (!(AGENT_CONTACT_POLICIES as readonly string[]).includes(limits.agentContactPolicy)) {
    issues.push(`agentContactPolicy must be one of ${AGENT_CONTACT_POLICIES.join('|')}, got ${String(limits.agentContactPolicy)}`);
  }
  if (
    !Array.isArray(limits.allowedContacts)
    || limits.allowedContacts.some(
      (edge) =>
        edge === null
        || typeof edge !== 'object'
        || typeof edge.from !== 'string'
        || edge.from.trim().length === 0
        || edge.from.length > 512
        || typeof edge.to !== 'string'
        || edge.to.trim().length === 0
        || edge.to.length > 512,
    )
  ) {
    issues.push('allowedContacts must be an array of { from, to } non-empty strings (≤512 chars)');
  }
  if (!(RISK_LEVELS as readonly string[]).includes(limits.maxRiskLevel)) {
    issues.push(`maxRiskLevel must be one of ${RISK_LEVELS.join('|')}, got ${String(limits.maxRiskLevel)}`);
  }
  if (!Array.isArray(limits.approvalRequiredFor) || limits.approvalRequiredFor.some((c) => typeof c !== 'string' || c.trim().length === 0 || c.length > 128)) {
    issues.push('approvalRequiredFor must be an array of non-empty strings (≤128 chars)');
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

// ---------------------------------------------------------------------------
// v1.3 — Agent-to-agent (A2A) contact policy (ASTRA-1 P2; research/
// gpt6-astra-2026-09.md §7). New risk class: proactive agents contacting
// OTHER agents outside the declared workflow graph (the Hugging Face
// incident pattern).
//
// The DECLARED graph is the config's `allowedContacts` edge list (directed
// `from → to` pairs of agent ids/roles). Matching is pure pair equality on
// trimmed ids — no heuristics, no ML, no content inspection. An empty graph
// means "nothing declared" and the policy stays INERT (behavior-preserving
// default), mirroring the v1.2 path-scope convention (empty allowlist = no
// restriction).
// ---------------------------------------------------------------------------

export const AGENT_CONTACT_POLICIES = ['LOG_ONLY', 'DENY'] as const;
export type AgentContactPolicy = (typeof AGENT_CONTACT_POLICIES)[number];

/** Inter-agent channel kind: a spawn (new agent) or a message (steer an existing one). */
export type AgentContactChannel = 'spawn' | 'message';

/** One declared directed edge of the contact graph. */
export interface AgentContactEdge {
  from: string;
  to: string;
}

/** One observed (or candidate) inter-agent contact. */
export interface AgentContact {
  from: string;
  to: string;
  channel?: AgentContactChannel;
}

/** Observability event name for out-of-graph contacts (names/ids only, never content). */
export const A2A_CONTACT_EVENT = 'a2a_contact';
/** Deny reason code used when agentContactPolicy=DENY blocks the channel. */
export const A2A_CONTACT_DENIED_REASON = 'a2a_contact_denied';

export type AgentContactReason =
  | 'NO_CONTACT_GRAPH'
  | 'NOT_INTER_AGENT'
  | 'CONTACT_IN_GRAPH'
  | 'CONTACT_OUTSIDE_GRAPH';

export interface AgentContactDecision {
  channel: AgentContactChannel;
  flagged: boolean;
  blocked: boolean;
  reasonCode: AgentContactReason;
}

/** Deterministic id normalization for graph matching (trim + bound; ids/roles only). */
export function normalizeContactId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 512) : '';
}

/**
 * Deterministic A2A contact evaluation:
 *   1. no declared edges ⇒ policy inert (NO_CONTACT_GRAPH, never flagged);
 *   2. either endpoint missing ⇒ not an inter-agent contact (NOT_INTER_AGENT);
 *   3. directed edge declared for the (from, to) pair ⇒ CONTACT_IN_GRAPH;
 *   4. otherwise CONTACT_OUTSIDE_GRAPH — flagged always, blocked iff DENY.
 */
export function evaluateAgentContact(
  limits: Pick<WorkflowLimitsConfig, 'agentContactPolicy' | 'allowedContacts'>,
  contact: AgentContact,
): AgentContactDecision {
  const channel: AgentContactChannel = contact.channel === 'spawn' ? 'spawn' : 'message';
  const graph = Array.isArray(limits.allowedContacts) ? limits.allowedContacts : [];
  if (graph.length === 0) {
    return { channel, flagged: false, blocked: false, reasonCode: 'NO_CONTACT_GRAPH' };
  }
  const from = normalizeContactId(contact.from);
  const to = normalizeContactId(contact.to);
  if (from === '' || to === '') {
    return { channel, flagged: false, blocked: false, reasonCode: 'NOT_INTER_AGENT' };
  }
  const inGraph = graph.some(
    (edge) => normalizeContactId(edge?.from) === from && normalizeContactId(edge?.to) === to,
  );
  if (inGraph) {
    return { channel, flagged: false, blocked: false, reasonCode: 'CONTACT_IN_GRAPH' };
  }
  return {
    channel,
    flagged: true,
    blocked: limits.agentContactPolicy === 'DENY',
    reasonCode: 'CONTACT_OUTSIDE_GRAPH',
  };
}

// ---------------------------------------------------------------------------
// v1.3 — Overreach audit (ASTRA-1 P3; Astra's residual failure: "broader
// permissions than the task requires"). AUDIT-only: a delegation whose
// requested risk exceeds the configured ceiling, whose task class requires
// approval but carries no approval flag, or whose requested paths fall
// outside the v1.2 path scope is recorded as `overreach_suspected` — labels,
// levels, flags and counts only, never content values.
// ---------------------------------------------------------------------------

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Observability event name for suspected overreach (value-free). */
export const OVERREACH_EVENT = 'overreach_suspected';

export type OverreachReason = 'RISK_ABOVE_MAX' | 'APPROVAL_REQUIRED' | 'PATH_SCOPE_EXCEEDED';

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

// Local mirror of the supreme-policy v1.3 classifier's HIGH-risk token sets
// (command / network / write) — same tokenization (split on non-alphanumerics,
// lowercase) and same labels, so both plugins classify identically without a
// runtime coupling (a type-only import of CapabilitySignal is the only cross-
// plugin surface). Token matching avoids substring false hits ("notebook" has
// no "note" token).
const HIGH_RISK_TOOL_TOKENS: ReadonlyArray<{ kind: string; tokens: ReadonlySet<string> }> = Object.freeze([
  { kind: 'command', tokens: new Set(['bash', 'sh', 'zsh', 'shell', 'cmd', 'command', 'powershell', 'pwsh', 'exec', 'execute', 'terminal', 'console', 'process', 'spawn', 'run']) },
  { kind: 'network', tokens: new Set(['fetch', 'curl', 'wget', 'http', 'https', 'net', 'network', 'socket', 'ftp', 'upload', 'download', 'request', 'web', 'browser', 'browse', 'url']) },
  { kind: 'write', tokens: new Set(['write', 'edit', 'delete', 'remove', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'move', 'copy', 'rename', 'patch', 'apply', 'create', 'unlink', 'truncate', 'chmod', 'chown', 'save']) },
]);

// v1.3 MEDIUM tier: the delegation/orchestration surface — tools whose whole
// job is creating or steering other agents. Read-only names match nothing and
// stay LOW, exactly like the policy plugin's classifier.
const DELEGATION_MEDIUM_TOOL_TOKENS: ReadonlySet<string> = new Set([
  'delegate', 'delegation', 'subagent', 'agent', 'workflow', 'orchestrate', 'orchestration', 'schedule', 'send', 'message', 'notify',
]);

/**
 * Deterministic 3-level tool-name classifier for delegation risk:
 * command/network/write ⇒ HIGH (mirrors supreme-policy classifyToolRisk),
 * delegation/orchestration ⇒ MEDIUM, everything else ⇒ LOW.
 */
export function classifyDelegationToolRisk(toolName: string): RiskLevel {
  const tokens = String(toolName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    for (const group of HIGH_RISK_TOOL_TOKENS) {
      if (group.tokens.has(token)) return 'HIGH';
    }
  }
  for (const token of tokens) {
    if (DELEGATION_MEDIUM_TOOL_TOKENS.has(token)) return 'MEDIUM';
  }
  return 'LOW';
}

/** Task-class label normalization (trim + uppercase; labels are contract names, not values). */
export function normalizeTaskClass(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed === '' ? undefined : trimmed;
}

export interface DelegationOverreachRequest {
  /** Requested task/capability class label (e.g. 'CYBER_OFFENSIVE'). */
  taskClass?: string;
  /** Tool names the delegation would use (risk derived from names only). */
  requestedTools?: string[];
  /** Paths the delegation would touch (checked against allowedPaths/blockedPaths). */
  requestedPaths?: string[];
  /** Explicit host-supplied risk level (wins over the tool-name derivation). */
  riskLevel?: string;
  /** Approval flag carried by the request (satisfies approvalRequiredFor). */
  approvalGranted?: boolean;
}

export interface OverreachDecision {
  overreach: boolean;
  /** Effective requested risk (explicit input, else max over requested tools). */
  riskLevel: RiskLevel;
  maxRiskLevel: RiskLevel;
  approvalRequired: boolean;
  /** Normalized task class label when one was requested (name only). */
  matchedTaskClass?: string;
  /** Config globs matched by out-of-scope paths (pattern names, never path values). */
  matchedGlobs: string[];
  reasonCodes: OverreachReason[];
}

/**
 * Deterministic overreach evaluation. Order is fixed and independent of
 * config: risk ceiling → approval gate → path scope (v1.2 machinery reused;
 * blockedPaths win, empty allowedPaths = no allowlist, NO_PATH_RULES never
 * flags).
 */
export function evaluateOverreach(
  limits: Pick<WorkflowLimitsConfig, 'maxRiskLevel' | 'approvalRequiredFor' | 'allowedPaths' | 'blockedPaths'>,
  request: DelegationOverreachRequest,
): OverreachDecision {
  const maxRiskLevel: RiskLevel = (RISK_LEVELS as readonly string[]).includes(limits.maxRiskLevel)
    ? limits.maxRiskLevel
    : 'HIGH';
  const reasons = new Set<OverreachReason>();

  // 1. Risk ceiling: explicit valid level wins, else the max over requested
  //    tool names; neither present ⇒ LOW (no overreach by construction).
  let riskLevel: RiskLevel = 'LOW';
  const explicit = normalizeTaskClass(request.riskLevel) ?? ''; // same trim+upper normalization
  if ((RISK_LEVELS as readonly string[]).includes(explicit)) {
    riskLevel = explicit as RiskLevel;
  } else {
    for (const tool of Array.isArray(request.requestedTools) ? request.requestedTools : []) {
      const derived = classifyDelegationToolRisk(String(tool));
      if (riskRank(derived) > riskRank(riskLevel)) riskLevel = derived;
    }
  }
  if (riskRank(riskLevel) > riskRank(maxRiskLevel)) reasons.add('RISK_ABOVE_MAX');

  // 2. Approval gate: requested class ∈ approvalRequiredFor without a flag.
  const taskClass = normalizeTaskClass(request.taskClass);
  const approvalSet = new Set(
    (Array.isArray(limits.approvalRequiredFor) ? limits.approvalRequiredFor : [])
      .map((c) => normalizeTaskClass(c))
      .filter((c): c is string => c !== undefined),
  );
  const approvalRequired = taskClass !== undefined && approvalSet.has(taskClass) && request.approvalGranted !== true;
  if (approvalRequired) reasons.add('APPROVAL_REQUIRED');

  // 3. Path scope: exactly the v1.2 surgical scope (blocked wins; empty
  //    allowlist unrestricted). Only the matched CONFIG glob is reported.
  const matchedGlobs: string[] = [];
  for (const path of Array.isArray(request.requestedPaths) ? request.requestedPaths : []) {
    if (typeof path !== 'string' || path.trim() === '') continue;
    const scope = evaluatePathScope(limits, path);
    if (!scope.allowed && scope.reasonCode !== 'NO_PATH_RULES') {
      reasons.add('PATH_SCOPE_EXCEEDED');
      if (scope.matchedBlocked !== undefined) matchedGlobs.push(scope.matchedBlocked);
    }
  }

  const reasonCodes = [...reasons];
  return {
    overreach: reasonCodes.length > 0,
    riskLevel,
    maxRiskLevel,
    approvalRequired,
    matchedTaskClass: taskClass,
    matchedGlobs: [...new Set(matchedGlobs)],
    reasonCodes,
  };
}
