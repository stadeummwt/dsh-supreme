/**
 * @dsh-supreme/policy — Cordis adapter (REAL pinned plugin shape).
 *
 * Plugin object conventions verified against the pinned upstream
 * (deepseek-harness @ d347e703908d0406b7a7ef80e3a0e594d86b2215):
 *   - Plugin shape:  vendor/cordis/src/registry.ts:91-146 (Object plugin: apply(ctx, config))
 *   - inject:        vendor/cordis/src/registry.ts:19 (Inject = array | object)
 *   - Config:        vendor/cordis/src/fiber.ts:50-62 (StandardSchemaV1 — zod 4 compliant)
 *   - provide:       vendor/cordis/src/reflect.ts (ctx.provide(name, value))
 *   - cleanup:       effects (ctx.on / ctx.effect) unwind on fiber unload
 *
 * SERVICE = supremePolicy
 * INJECTED DSH SERVICES = none (deterministic policy is self-contained)
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  executionPolicySummary,
  evaluateCoTGate,
  inspectTaint,
  validatePolicyConfig,
  evaluateDelegationPolicy,
  evaluateRoutePolicy,
  verificationRequirement,
  type CoTGateInput,
  type CoTGateDecision,
  type DelegationDecision,
  type PolicyDecision,
  type RiskClass,
  type RoutePolicyInput,
  type SupremePolicyConfig,
  type TaintFindings,
  type VerificationLevel,
  type CostClass,
} from './engine';

export const name = 'supreme-policy';

/** No DSH service dependencies. */
export const inject: string[] = [];

/** Schemastery-compatible Standard Schema (resolved by vendored Cordis before apply). */
export const Config = z.object({
  executionClass: z.enum(['CORE', 'STANDARD', 'SUPREME', 'LAB']).default('STANDARD'),
  allowPaid: z.boolean().default(false),
  allowTrial: z.boolean().default(false),
  allowUnknownCost: z.literal(false).default(false),
  requireVerificationForHighRisk: z.boolean().default(true),
  maxDelegationDepth: z.number().int().min(1).max(8).default(3),
  /** v1.2: scan tool arguments for hidden/bidi Unicode taint (deterministic). */
  enableUnicodeSanitization: z.boolean().default(true),
  /** v1.2: record taint_detected audit events (metadata only — never values). */
  logTaintAttempts: z.boolean().default(true),
  /** v1.2: LOG_ONLY audits; DENY refuses the call via tools/pre-execute. */
  taintPolicy: z.enum(['LOG_ONLY', 'DENY']).default('LOG_ONLY'),
  /** v1.2: chain-of-thought presence gate (audit event, never prompt injection). */
  reasoningTracePolicy: z.enum(['OFF', 'AUDIT', 'ENFORCE']).default('OFF'),
});

export type PolicyService = {
  readonly config: Readonly<SupremePolicyConfig>;
  evaluateRoute(input: RoutePolicyInput): PolicyDecision;
  evaluateDelegation(input: { depth: number; secretAccess: boolean }): DelegationDecision;
  verificationRequirement(input: { risk: RiskClass; costClass?: CostClass }): VerificationLevel;
  executionPolicy(): ReturnType<typeof executionPolicySummary>;
  /** v1.2: deterministic Unicode taint scan (class names only, never values). */
  scanArguments(value: unknown): TaintFindings;
  /** v1.2: deterministic chain-of-thought presence gate. */
  cotGate(input: CoTGateInput): CoTGateDecision;
};

export function apply(ctx: Context, config: SupremePolicyConfig): void {
  // Deterministic guardrails beyond the schema (LAB-only overrides, UNKNOWN hard rule).
  const validated = validatePolicyConfig(config);
  const frozen = Object.freeze(validated);

  // Optional observability (never injected — CORE composition mounts policy
  // alone; audit events are recorded only when the service exists).
  const observability = ctx.get('supremeObservability') as
    | { record(event: string, fields: Record<string, unknown>): void }
    | undefined;

  const service: PolicyService = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen),
    scanArguments: (value) => inspectTaint(value),
    cotGate: (input) => evaluateCoTGate(frozen.reasoningTracePolicy, input),
  };

  // Register under the frozen Supreme service namespace (Spec §2 naming rule).
  ctx.provide('supremePolicy', Object.freeze(service));

  // --- v1.2: chain-of-thought evidence tracker -----------------------------
  // Evidence source (pinned SessionEventMap): 'assistant/message' data carries
  // message.content ReasoningBlocks (type 'reasoning') and the timed stream
  // records (type 'reasoning-chunks'). We track ONLY a boolean per session.
  const lastTracePresent = new Map<string, boolean>();
  const TRACE_MAP_LIMIT = 256; // bounded; insertion-order eviction (deterministic)
  const disposers: Array<() => void> = [];
  disposers.push(
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const d = event.data as {
        message?: { content?: Array<{ type?: string }> };
        stream?: Array<{ type?: string }>;
      };
      const contentHasReasoning = Array.isArray(d.message?.content)
        && d.message.content.some((b) => b?.type === 'reasoning');
      const streamHasReasoning = Array.isArray(d.stream)
        && d.stream.some((r) => r?.type === 'reasoning-chunks');
      const key = String(session.id);
      if (lastTracePresent.size >= TRACE_MAP_LIMIT && !lastTracePresent.has(key)) {
        const oldest = lastTracePresent.keys().next().value;
        if (oldest !== undefined) lastTracePresent.delete(oldest);
      }
      lastTracePresent.set(key, contentHasReasoning || streamHasReasoning);
    }),
  );

  // --- v1.2: tools/pre-execute enforcement (pinned PreToolDecision seam) ----
  // Deny materializes an upstream error result — { kind: 'deny', reason } —
  // so policy refusal never fabricates tool output. Reasons carry taint CLASS
  // names only; argument values are never echoed (Spec §10).
  disposers.push(
    ctx.on('tools/pre-execute', async (exec, next) => {
      const obs = ctx.get('supremeObservability') as
        | { record(event: string, fields: Record<string, unknown>): void }
        | undefined;
      if (frozen.enableUnicodeSanitization) {
        const findings = inspectTaint(exec.arguments);
        if (findings.tainted) {
          const audit = obs ?? observability;
          if (frozen.logTaintAttempts) {
            audit?.record('taint_detected', {
              tool: exec.name,
              detail: `classes:${findings.hits.join('+')};count:${findings.count}`,
            });
          }
          if (frozen.taintPolicy === 'DENY') {
            return {
              kind: 'deny' as const,
              reason: `supreme-policy: tool arguments rejected (unicode taint: ${findings.hits.join(', ')})`,
            };
          }
        }
      }
      if (frozen.reasoningTracePolicy !== 'OFF') {
        const sessionKey = exec.agent?.id !== undefined ? String(exec.agent.id) : undefined;
        const gate = evaluateCoTGate(frozen.reasoningTracePolicy, {
          reasoningTracePresent: sessionKey !== undefined ? lastTracePresent.get(sessionKey) : undefined,
          tool: exec.name,
        });
        const audit = obs ?? observability;
        if (gate.decision === 'DENY') {
          audit?.record('cot_missing', { tool: exec.name, detail: 'ENFORCE' });
          return {
            kind: 'deny' as const,
            reason: 'supreme-policy: no reasoning trace observed this turn (cot_missing)',
          };
        }
        if (gate.decision === 'AUDIT') {
          audit?.record('cot_missing', { tool: exec.name, detail: gate.reasonCodes.join('+') });
        }
      }
      return next();
    }),
  );
  // All v1.2 effects unwind with the fiber (reverse-order dispose).
  ctx.effect(() => () => { for (const d of disposers.reverse()) d(); }, 'supreme-policy.v12-effects');

  ctx.logger.info(
    'supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d taint=%s cot=%s',
    frozen.executionClass,
    String(frozen.allowPaid),
    String(frozen.allowTrial),
    frozen.maxDelegationDepth,
    frozen.taintPolicy,
    frozen.reasoningTracePolicy,
  );
}
