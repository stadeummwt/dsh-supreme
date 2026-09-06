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
  validatePolicyConfig,
  evaluateDelegationPolicy,
  evaluateRoutePolicy,
  verificationRequirement,
  type DelegationDecision,
  type PolicyDecision,
  type RiskClass,
  type RoutePolicyInput,
  type SupremePolicyConfig,
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
});

export type PolicyService = {
  readonly config: Readonly<SupremePolicyConfig>;
  evaluateRoute(input: RoutePolicyInput): PolicyDecision;
  evaluateDelegation(input: { depth: number; secretAccess: boolean }): DelegationDecision;
  verificationRequirement(input: { risk: RiskClass; costClass?: CostClass }): VerificationLevel;
  executionPolicy(): ReturnType<typeof executionPolicySummary>;
};

export function apply(ctx: Context, config: SupremePolicyConfig): void {
  // Deterministic guardrails beyond the schema (LAB-only overrides, UNKNOWN hard rule).
  const validated = validatePolicyConfig(config);
  const frozen = Object.freeze(validated);

  const service: PolicyService = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen),
  };

  // Register under the frozen Supreme service namespace (Spec §2 naming rule).
  ctx.provide('supremePolicy', Object.freeze(service));

  ctx.logger.info(
    'supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d',
    frozen.executionClass,
    String(frozen.allowPaid),
    String(frozen.allowTrial),
    frozen.maxDelegationDepth,
  );
}
