/**
 * @dsh-supreme/workflow-policy — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeWorkflowPolicy
 * INJECTED DSH SERVICES = ['supremePolicy', 'supremeObservability', 'supremeVerifier', 'subagents', 'workflowEngine']
 *
 * Verified against pinned upstream:
 *   - ctx.subagents:      packages/subagent/subagent/src/index.ts:137 (SubagentRuntime)
 *   - ctx.workflowEngine: packages/workflow/workflow/src/index.ts:33 (abstract seam)
 *
 * The plugin never starts subagents/workflows itself; it decides and exposes
 * the typed policy the host consults before using the official services.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  buildDelegationScope,
  canCloseTask,
  decideWorkflow,
  evaluatePathScope,
  validateWorkflowLimits,
  type CloseDecision,
  type CloseVerifierStatus,
  type DelegationScope,
  type PathScopeDecision,
  type WorkflowDecisionInput,
  type WorkflowDecisionResult,
  type WorkflowLimitsConfig,
} from './engine';

export const name = 'supreme-workflow-policy';

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
});

export type WorkflowPolicyService = {
  decide(input: WorkflowDecisionInput): WorkflowDecisionResult;
  buildDelegationScope(scope: DelegationScope): Readonly<DelegationScope>;
  limits(): WorkflowLimitsConfig;
  /** v1.2: deterministic surgical path scope (blockedPaths win). */
  evaluatePathScope(path: string): PathScopeDecision;
  /** v1.2: deterministic verifier-gated close decision. */
  canCloseTask(input: { risk: 'LOW' | 'MEDIUM' | 'HIGH'; verifierStatus: CloseVerifierStatus }): CloseDecision;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const limits = validateWorkflowLimits(config as Partial<WorkflowLimitsConfig>);
  const observability = ctx.supremeObservability;

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
    canCloseTask: (input) => canCloseTask(limits, input),
  };

  ctx.provide('supremeWorkflowPolicy', Object.freeze(service));
  ctx.logger.info(
    'supreme-workflow-policy active (maxConcurrent=%d maxTotal=%d maxDepth=%d)',
    limits.maxConcurrentAgents,
    limits.maxTotalAgents,
    limits.maxDepth,
  );
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
