/**
 * @dsh-supreme/workflow-policy — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeWorkflowPolicy
 * INJECTED DSH SERVICES = ['supremePolicy', 'supremeObservability', 'supremeVerifier', 'subagents', 'workflowEngine']
 *
 * Verified against pinned upstream:
 *   - ctx.subagents:      packages/subagent/subagent/src/index.ts:137 (SubagentRuntime)
 *   - ctx.workflowEngine: packages/workflow/workflow/src/index.ts:33 (abstract seam)
 *   - tools/pre-execute:  packages/core/tools/src/index.ts:144 (PreToolDecision waterfall — deny materializes an error result)
 *   - subagent/start:     packages/subagent/subagent/src/index.ts:163 (emit; payload SubagentRunInfo — runId/provider/id/local, NO parent)
 *   - workflow/agent-start: packages/workflow/workflow/src/index.ts:68 (emit; WorkflowRunInfo + WorkflowAgentInfo{seq,label,phase?,childId})
 *
 * The plugin never starts subagents/workflows itself; it decides and exposes
 * the typed policy the host consults before using the official services.
 *
 * v1.3 (ASTRA-1 hardening), deterministic, value-free in audits:
 *   - P2 A2A contact policy: inter-agent channels (spawn/message) outside the
 *     DECLARED contact graph (config `allowedContacts` directed edges) are
 *     audited as `a2a_contact`; under `agentContactPolicy: 'DENY'` the
 *     pre-fact `tools/pre-execute` waterfall refuses the call with reason
 *     code `a2a_contact_denied`. Emit-mode lifecycle events
 *     (`subagent/start`, `workflow/agent-start`) are post-fact and therefore
 *     DETECT-only — enforcement is pre-fact at the waterfall and via the
 *     host's `evaluateContact()` admission check.
 *   - P3 Overreach audit: delegation requests above `maxRiskLevel`, or with a
 *     task class listed in `approvalRequiredFor` but no approval flag, or
 *     touching paths outside the v1.2 path scope, are recorded as
 *     `overreach_suspected` (labels, levels, flags, counts — never content).
 *
 * v1.3.1 (FIX-D — A2A false-positive fix):
 *   - Tool identity FIRST: a call is treated as inter-agent communication
 *     only if its tool NAME is in the TRUSTED comms-tool registry
 *     (`DEFAULT_COMMS_TOOL_REGISTRY`, extended by the `commsToolNames`
 *     config key). Recipient extraction from the fixed argument allowlist
 *     (`agent_id`/`to`/`target`) happens ONLY after registry identification
 *     — never from argument names alone, and never from model-provided
 *     labels. Ordinary tools (e.g. `copy_file { target: 'b.txt' }`) are never
 *     inspected for recipients.
 *   - Malformed communication calls (registry-identified message tool with a
 *     missing/empty recipient) are audited explicitly with reason code
 *     `a2a_recipient_unresolvable` and refused pre-fact under DENY (fail-
 *     closed) — no crash, no silent pass. A spawn call without a declared
 *     target is its normal pinned shape (the childId is assigned post-fact),
 *     so it is not malformed; the post-fact DETECT-only emit audit covers
 *     spawns.
 *
 * v1.3.1 (IMP-V — evidence-bound close, Improvement §3A):
 *   - `canCloseTask` accepts a bound VerificationEvidence (supremeVerifier
 *     `runAndRecord`) plus the CURRENT artifact identity. A HIGH-risk close
 *     under `requireVerifierPassOnClose` then requires a structurally bound
 *     PASS whose artifact sha-256 (and revision, when both sides carry one)
 *     matches the current artifact: stale/unbound/contradicted evidence
 *     blocks with a clear reason code (EVIDENCE_STALE / EVIDENCE_UNBOUND /
 *     EVIDENCE_STATUS_CONFLICT / EVIDENCE_CURRENCY_UNVERIFIED). The v1.2
 *     status-only path is retained unchanged.
 *   - Close-gate verdicts under an ACTIVE gate are audited as `close_gate`
 *     events — ids, hash prefixes and reason codes ONLY, never content.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  A2A_CONTACT_DENIED_REASON,
  A2A_CONTACT_EVENT,
  A2A_RECIPIENT_UNRESOLVABLE_REASON,
  CLOSE_GATE_EVENT,
  OVERREACH_EVENT,
  buildCommsToolRegistry,
  buildDelegationScope,
  canCloseTask,
  commsChannelOf,
  decideWorkflow,
  evaluateAgentContact,
  evaluateOverreach,
  evaluatePathScope,
  isCommunicationTool,
  normalizeContactId,
  normalizeTaskClass,
  unresolvableRecipientDecision,
  validateCloseEvidenceRecord,
  validateWorkflowLimits,
  type AgentContact,
  type AgentContactChannel,
  type AgentContactDecision,
  type CloseArtifactIdentity,
  type CloseDecision,
  type CloseVerifierStatus,
  type CommsToolRegistry,
  type DelegationOverreachRequest,
  type DelegationScope,
  type OverreachDecision,
  type PathScopeDecision,
  type WorkflowDecisionInput,
  type WorkflowDecisionResult,
  type WorkflowLimitsConfig,
} from './engine';
import '../context-types';

export const name = 'supreme-workflow-policy';

/**
 * v1.3 P2 seam — REAL pinned workflow event, registered as a string literal.
 *
 *   'workflow/agent-start' — packages/workflow/workflow/src/index.ts:68
 *   `(info: WorkflowRunInfo, agent: WorkflowAgentInfo)` @mode emit — the one
 *   `agent()` call inside a workflow run that established a published child
 *   (seq, label, phase?, childId). Verified against the pin d347e703.
 *
 * The seam is now a documented official entry in BOTH integration registries
 * (v1.3 sync by V13-D):
 *   - src/suite/surface-audit.ts OFFICIAL_SEAMS (hooks surface allowlist);
 *   - src/plugins/supreme-observability/event-map.ts (pinned-event table).
 * Until that sync landed, this registration went through a cited constant
 * (`WORKFLOW_AGENT_START`) to keep the v1.2 surface-audit allowlist from
 * false-positiving an invented-seam finding on a pinned-verified event.
 */

export const inject = ['supremePolicy', 'supremeObservability', 'supremeVerifier', 'subagents', 'workflowEngine'];

export const Config = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  maxTotalAgents: z.number().int().min(1).max(32).default(12),
  maxDepth: z.number().int().min(0).max(4).default(2),
  workflowTimeoutMs: z.number().int().min(1000).default(600_000),
  subagentTimeoutMs: z.number().int().min(1000).default(120_000),
  allowedSubagentProviders: z.array(z.string()).default(['in-process']),
  /** v1.2: surgical scope — delegation paths must match these globs (empty = no allowlist). */
  allowedPaths: z.array(z.string().min(1).max(512)).default([]),
  /** v1.2: surgical scope — paths matching these globs are always refused (wins). */
  blockedPaths: z.array(z.string().min(1).max(512)).default([]),
  /** v1.2: HIGH-risk tasks close only with recorded verifier PASS evidence. */
  requireVerifierPassOnClose: z.boolean().default(false),
  /** v1.3: A2A contact policy — LOG_ONLY audits out-of-graph contacts, DENY blocks them pre-fact. */
  agentContactPolicy: z.enum(['LOG_ONLY', 'DENY']).default('LOG_ONLY'),
  /** v1.3: declared inter-agent contact graph — directed { from, to } edges (empty = policy inert). */
  allowedContacts: z
    .array(
      z.object({
        from: z.string().min(1).max(512),
        to: z.string().min(1).max(512),
      }),
    )
    .default([]),
  /** v1.3: overreach ceiling — requested risk above this level is audited (default HIGH = unchanged). */
  maxRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('HIGH'),
  /** v1.3: task classes that require an approval flag on the delegation request. */
  approvalRequiredFor: z.array(z.string().min(1).max(128)).default([]),
  /**
   * v1.3.1 (FIX-D): extra tool names treated as communication/delegation tools
   * — EXTENDS the trusted DEFAULT_COMMS_TOOL_REGISTRY (cannot remove or shadow
   * a default entry). Registry identity, never argument names or model labels.
   */
  commsToolNames: z.array(z.string().min(1).max(128)).default([]),
});

export type WorkflowPolicyService = {
  decide(input: WorkflowDecisionInput): WorkflowDecisionResult;
  buildDelegationScope(scope: DelegationScope): Readonly<DelegationScope>;
  limits(): WorkflowLimitsConfig;
  /** v1.2: deterministic surgical path scope (blockedPaths win). */
  evaluatePathScope(path: string): PathScopeDecision;
  /** v1.2: deterministic verifier-gated close decision.
   *  v1.3.1 (IMP-V): pass `evidence` (a bound VerificationEvidence from
   *  supremeVerifier.runAndRecord) and `artifact` (the CURRENT artifact
   *  identity) to enforce evidence currency — stale PASS ⇒ no-PASS. */
  canCloseTask(input: {
    risk: 'LOW' | 'MEDIUM' | 'HIGH';
    verifierStatus: CloseVerifierStatus;
    evidence?: unknown;
    artifact?: CloseArtifactIdentity | null;
  }): CloseDecision;
  /** v1.3 P2: deterministic A2A contact-graph evaluation (host admission check). */
  evaluateContact(contact: AgentContact): AgentContactDecision;
  /** v1.3 P3: deterministic overreach evaluation; records `overreach_suspected` when overreach. */
  evaluateDelegation(request: DelegationOverreachRequest): OverreachDecision;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const limits = validateWorkflowLimits(config as Partial<WorkflowLimitsConfig>);
  const observability = ctx.supremeObservability;
  // v1.3.1 (FIX-D): trusted communication/delegation registry, built once —
  // default set + the host's `commsToolNames` extension. The ONLY authority
  // for whether a tool call is subject to A2A contact inspection.
  const commsTools: CommsToolRegistry = buildCommsToolRegistry(limits.commsToolNames);

  // --- v1.3 deterministic helpers (ids/roles/labels only — never content) ---

  const clip = (value: string): string => value.slice(0, 96);

  /** Audit one flagged contact. Graph ids and reason codes only, bounded. */
  const auditContact = (
    decision: AgentContactDecision,
    from: string,
    to: string,
    origin: string,
    extra?: { tool?: string; subagent?: string; workflow?: string; outcome?: 'DENIED' | 'LOGGED' | 'DETECTED' },
  ): void => {
    if (!decision.flagged) return;
    observability.record(A2A_CONTACT_EVENT, {
      ...(extra?.tool !== undefined ? { tool: clip(extra.tool) } : {}),
      ...(extra?.subagent !== undefined ? { subagent: clip(extra.subagent) } : {}),
      ...(extra?.workflow !== undefined ? { workflow: clip(extra.workflow) } : {}),
      detail: [
        `channel:${decision.channel}`,
        `from:${clip(from)}`,
        `to:${clip(to)}`,
        `reason:${decision.reasonCode}`,
        `outcome:${extra?.outcome ?? (decision.blocked ? 'DENIED' : 'LOGGED')}`,
        `mode:${limits.agentContactPolicy}`,
        `origin:${origin}`,
      ].join(':'),
    });
  };

  /** Audit one overreach verdict (labels, levels, flags, counts only). */
  const auditOverreach = (verdict: OverreachDecision, origin: string, tool?: string): void => {
    if (!verdict.overreach) return;
    observability.record(OVERREACH_EVENT, {
      ...(tool !== undefined && tool !== '' ? { tool: clip(tool) } : {}),
      detail: [
        `risk:${verdict.riskLevel}`,
        `max:${verdict.maxRiskLevel}`,
        `class:${verdict.matchedTaskClass ?? 'UNSPECIFIED'}`,
        `approval:${verdict.approvalRequired ? 'REQUIRED' : 'NOT_REQUIRED'}`,
        `reasons:${verdict.reasonCodes.join('+')}`,
        ...(verdict.matchedGlobs.length > 0 ? [`globs:${verdict.matchedGlobs.map((g) => clip(g)).join('|')}`] : []),
        `origin:${origin}`,
      ].join(':'),
    });
  };

  // Sender id: the pinned exec carries the calling Agent (`agent.session.id`
  // is the durable agent id; a plain `agent.id` is accepted defensively).
  const senderOf = (exec: unknown): string => {
    if (!exec || typeof exec !== 'object') return '';
    const agent = (exec as Record<string, unknown>).agent;
    if (!agent || typeof agent !== 'object') return '';
    const rec = agent as Record<string, unknown>;
    const session = rec.session;
    if (session && typeof session === 'object') {
      const sid = (session as Record<string, unknown>).id;
      if (typeof sid === 'string' && sid.trim() !== '') return normalizeContactId(sid);
    }
    return typeof rec.id === 'string' && rec.id.trim() !== '' ? normalizeContactId(rec.id) : '';
  };

  // Recipient extraction contract (v1.3.1 FIX-D): the inter-agent TARGET is
  // read from the call's TOP-LEVEL arguments under these names only — the
  // pinned `send_message` tool carries `agent_id` (tool-subagent-control);
  // `to`/`target` are the declared delegation-style spellings. This map runs
  // ONLY for registry-identified communication tools — never as a heuristic
  // over arbitrary tools (an argument named `target` on `copy_file` is a file
  // name, not an agent id). Values are used solely as bounded graph ids for
  // matching/audit.
  const CONTACT_TARGET_ARG_NAMES = ['agent_id', 'to', 'target'] as const;
  // Pinned model-facing spawn tool name (tool-subagent default `toolName`)
  // — still used to recognize delegation-shaped calls for the P3 audit.
  const SPAWN_TOOL_NAMES = new Set(['subagent']);

  const firstContactTarget = (args: unknown): string => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const rec = args as Record<string, unknown>;
    for (const argName of CONTACT_TARGET_ARG_NAMES) {
      const value = rec[argName];
      if (typeof value === 'string' && value.trim() !== '') return normalizeContactId(value);
    }
    return '';
  };

  // Delegation-parameter extraction (documented contract, top-level only):
  //   capabilityClass  — the shared v1.3 signal field (policy plugin contract);
  //   requestedTools / requestedPaths — string[] delegation parameters;
  //   riskLevel — explicit LOW|MEDIUM|HIGH; approvalGranted — approval flag.
  // The check fires only for delegation-shaped calls (pinned spawn tool name
  // or at least one declared parameter) — ordinary calls pass untouched.
  const delegationRequestOf = (exec: unknown): { request: DelegationOverreachRequest; toolName: string } | undefined => {
    if (!exec || typeof exec !== 'object') return undefined;
    const rec = exec as Record<string, unknown>;
    const toolName = typeof rec.name === 'string' ? rec.name : '';
    const args = rec.arguments;
    const argsRec =
      args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const stringList = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
        ? (value as string[])
        : undefined;
    const requestedTools = stringList(argsRec.requestedTools);
    const requestedPaths = stringList(argsRec.requestedPaths);
    const riskLevel = typeof argsRec.riskLevel === 'string' ? argsRec.riskLevel : undefined;
    const taskClass =
      normalizeTaskClass(argsRec.capabilityClass) ?? normalizeTaskClass(rec.capabilityClass);
    const approvalGranted = typeof argsRec.approvalGranted === 'boolean' ? argsRec.approvalGranted : undefined;
    const delegationShaped =
      SPAWN_TOOL_NAMES.has(toolName) ||
      requestedTools !== undefined ||
      requestedPaths !== undefined ||
      riskLevel !== undefined ||
      taskClass !== undefined ||
      approvalGranted !== undefined;
    if (!delegationShaped) return undefined;
    return {
      toolName,
      request: {
        taskClass,
        requestedTools: [toolName, ...(requestedTools ?? [])],
        requestedPaths,
        riskLevel,
        approvalGranted,
      },
    };
  };

  const service: WorkflowPolicyService = {
    decide(input) {
      const result = decideWorkflow(limits, input);
      observability.record('workflow_decision', {
        workflowDecisionId: genId('wfdec'),
        detail: `${result.decision}${result.degradedFrom ? `:from:${result.degradedFrom}` : ''}:${result.closeGate}`,
      });
      return result;
    },
    buildDelegationScope: (scope) => buildDelegationScope(scope),
    limits: () => limits,
    evaluatePathScope: (path) => evaluatePathScope(limits, path),
    canCloseTask: (input) => {
      const decision = canCloseTask(limits, input);
      // v1.3.1 (IMP-V): audit close-gate verdicts ONLY under an ACTIVE gate
      // (requireVerifierPassOnClose + HIGH risk). Value-free by contract:
      // task id, artifact hash PREFIX and reason codes — never artifact
      // content, prompts or reasoning.
      if (limits.requireVerifierPassOnClose && input.risk === 'HIGH') {
        const bound = validateCloseEvidenceRecord(input.evidence);
        const artifactSha = input.artifact && typeof input.artifact.sha256 === 'string' ? input.artifact.sha256 : undefined;
        observability.record(CLOSE_GATE_EVENT, {
          ...(bound !== null ? { task: clip(bound.taskId) } : {}),
          ...(artifactSha !== undefined ? { artifact: artifactSha.slice(0, 12) } : {}),
          detail: `risk:${input.risk}:outcome:${decision.closable ? 'ALLOWED' : 'BLOCKED'}:reason:${decision.reasonCode}`,
        });
      }
      return decision;
    },
    evaluateContact: (contact) => evaluateAgentContact(limits, contact),
    evaluateDelegation: (request) => {
      const verdict = evaluateOverreach(limits, request);
      auditOverreach(verdict, 'service');
      return verdict;
    },
  };

  // --- v1.3 P2: pre-fact inter-agent channel gate (REAL deny seam) + P3 overreach audit.
  // Waterfall listener: next() called exactly once on the allow path; a deny
  // returns the pinned PreToolDecision deny shape without calling next().
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = typeof exec?.name === 'string' ? exec.name : '';

    // P2 — tool identity FIRST (v1.3.1 FIX-D): only registry-identified
    // communication/delegation tools are A2A-inspected. Ordinary tools are
    // never touched, whatever their argument names happen to be.
    if (isCommunicationTool(commsTools, toolName)) {
      const sender = senderOf(exec);
      const channel: AgentContactChannel = commsChannelOf(commsTools, toolName);
      // Recipient extraction happens ONLY after registry identification,
      // through the fixed argument-name allowlist above.
      const target = firstContactTarget(exec?.arguments);
      if (target === '' && channel === 'message') {
        // Malformed communication call: a message-channel tool carries its
        // recipient by contract — a missing/empty recipient cannot be checked
        // against the declared graph. Explicit audit (never a silent pass);
        // refused pre-fact under DENY (fail-closed). Spawn tools are exempt:
        // a spawn without a declared target is its normal pinned shape (the
        // childId is assigned post-fact) and is covered by the DETECT-only
        // subagent/start audit below.
        const malformed = unresolvableRecipientDecision(limits, channel);
        auditContact(malformed, sender, '', 'tools_pre_execute', { tool: toolName });
        if (malformed.blocked) {
          return {
            kind: 'deny' as const,
            reason: `supreme-workflow-policy: inter-agent ${channel} recipient unresolvable (${A2A_RECIPIENT_UNRESOLVABLE_REASON})`,
          };
        }
      } else if (target !== '') {
        const decision = evaluateAgentContact(limits, {
          from: sender,
          to: target,
          channel,
        });
        if (decision.flagged) {
          auditContact(decision, sender, target, 'tools_pre_execute', { tool: toolName });
          if (decision.blocked) {
            return {
              kind: 'deny' as const,
              reason: `supreme-workflow-policy: inter-agent ${decision.channel} outside the declared contact graph (${A2A_CONTACT_DENIED_REASON})`,
            };
          }
        }
      }
    }

    // P3 — overreach audit for delegation-shaped calls (audit-only; never denies).
    const delegation = delegationRequestOf(exec);
    if (delegation !== undefined) {
      auditOverreach(evaluateOverreach(limits, delegation.request), 'tools_pre_execute', delegation.toolName);
    }

    return next();
  });

  // --- v1.3 P2: post-fact detection on the pinned emit-mode lifecycle events.
  // These seams cannot block (emit mode) — flagged contacts are audited with
  // outcome DETECTED; enforcement is pre-fact at tools/pre-execute above and
  // via the host's evaluateContact() admission check.
  ctx.on('subagent/start', (info) => {
    const childId = typeof info?.id === 'string' ? normalizeContactId(info.id) : '';
    if (childId === '') return;
    const provider = typeof info?.provider === 'string' ? info.provider : 'unknown';
    const decision = evaluateAgentContact(limits, {
      from: `provider:${provider}`,
      to: childId,
      channel: 'spawn',
    });
    auditContact(decision, `provider:${provider}`, childId, 'subagent_start', {
      subagent: childId,
      outcome: 'DETECTED',
    });
  });

  ctx.on('workflow/agent-start', (info, agent) => {
    const metaName = typeof info?.meta?.name === 'string' ? info.meta.name : undefined;
    const from = `workflow:${metaName ?? (typeof info?.id === 'string' ? info.id : 'unknown')}`;
    const childId =
      typeof agent?.childId === 'string'
        ? normalizeContactId(agent.childId)
        : typeof agent?.label === 'string'
          ? normalizeContactId(agent.label)
          : '';
    if (childId === '') return;
    const decision = evaluateAgentContact(limits, { from, to: childId, channel: 'spawn' });
    auditContact(decision, from, childId, 'workflow_agent_start', {
      workflow: metaName,
      outcome: 'DETECTED',
    });
  });

  ctx.provide('supremeWorkflowPolicy', Object.freeze(service));
  ctx.logger.info(
    'supreme-workflow-policy active (maxConcurrent=%d maxTotal=%d maxDepth=%d a2a=%s contacts=%d maxRisk=%s approvalFor=%d)',
    limits.maxConcurrentAgents,
    limits.maxTotalAgents,
    limits.maxDepth,
    limits.agentContactPolicy,
    limits.allowedContacts.length,
    limits.maxRiskLevel,
    limits.approvalRequiredFor.length,
  );
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
