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
 * v1.3 (ASTRA-1 hardening): CoT visibility profiles + risk-gated CoT (P1),
 * deny-circumvention guard (P1), encoding-layer taint scan (P2),
 * capability-class gating (P3) — all deterministic, all value-free in audits.
 *
 * SERVICE = supremePolicy
 * INJECTED DSH SERVICES = none (deterministic policy is self-contained)
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  ENCODING_BLOB_CLASS,
  executionPolicySummary,
  evaluateCapabilityGate,
  evaluateCoTEnforcement,
  evaluateCoTGate,
  extractCapabilitySignal,
  formatTaintEventDetail,
  classifyToolRisk,
  inspectTaint,
  resolveCotVisibility,
  scanToolArguments,
  validatePolicyConfig,
  evaluateDelegationPolicy,
  evaluateRoutePolicy,
  verificationRequirement,
  DenyCircumventionGuard,
  type CapabilityGateDecision,
  type CapabilityGateInput,
  type CapabilitySignal,
  type CoTEnforcementInput,
  type CoTGateInput,
  type CoTGateDecision,
  type CotVisibility,
  type DelegationDecision,
  type DenyRetryCheck,
  type PolicyDecision,
  type RiskClass,
  type RoutePolicyInput,
  type ScanFindings,
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
  /** v1.2: scan tool arguments for hidden/bidi Unicode taint (deterministic). */
  enableUnicodeSanitization: z.boolean().default(true),
  /** v1.2: record taint_detected audit events (metadata only — never values). */
  logTaintAttempts: z.boolean().default(true),
  /** v1.2: LOG_ONLY audits; DENY refuses the call via tools/pre-execute. */
  taintPolicy: z.enum(['LOG_ONLY', 'DENY']).default('LOG_ONLY'),
  /** v1.2: chain-of-thought presence gate (audit event, never prompt injection). */
  reasoningTracePolicy: z.enum(['OFF', 'AUDIT', 'ENFORCE']).default('OFF'),
  /** v1.3: routeId → expected CoT visibility ('verbose'|'terse'|'none'); 'none' routes never deny on cot_missing. */
  cotVisibilityProfiles: z.record(z.string(), z.enum(['verbose', 'terse', 'none'])).default({}),
  /** v1.3: ENFORCE for CoT applies only to HIGH-risk (command/network/write) tool calls. */
  riskGatedCoT: z.boolean().default(false),
  /** v1.3: deny same-shape retries of already-denied calls (deny_retry). Default true — see engine doc. */
  denyCircumventionGuard: z.boolean().default(true),
  /** v1.3: scan tool arguments for long base64/hex runs (encoding_blob). Extension of enableUnicodeSanitization. */
  enableEncodingScan: z.boolean().default(false),
  /** v1.3: capability-class gate for requests carrying the shared `capabilityClass` field. */
  capabilityClassGate: z.enum(['OFF', 'AUDIT', 'ENFORCE']).default('OFF'),
  /** v1.3: capability classes sanctioned for this profile (default [] — every labeled request flagged). */
  sanctionedCapabilityClasses: z.array(z.string()).default([]),
  /** v1.3: additive sanction ONLY when executionClass=LAB. */
  labCapabilityClassAllowlist: z.array(z.string()).default([]),
});

export type PolicyService = {
  readonly config: Readonly<SupremePolicyConfig>;
  evaluateRoute(input: RoutePolicyInput): PolicyDecision;
  evaluateDelegation(input: { depth: number; secretAccess: boolean }): DelegationDecision;
  verificationRequirement(input: { risk: RiskClass; costClass?: CostClass }): VerificationLevel;
  executionPolicy(): ReturnType<typeof executionPolicySummary>;
  /** v1.2/v1.3: deterministic taint scan — Unicode classes + encoding blobs (class names/arg names/lengths only, never values). */
  scanArguments(value: unknown): ScanFindings;
  /** v1.2: deterministic chain-of-thought presence gate. */
  cotGate(input: CoTGateInput): CoTGateDecision;
  /** v1.3: CoT enforcement pipeline (visibility profile + risk gate). */
  cotEnforcement(input: CoTEnforcementInput): CoTGateDecision;
  /** v1.3: resolve route CoT visibility (explicit > profile > 'verbose'). */
  resolveCotVisibility(input: { explicit?: unknown; routeId?: string }): CotVisibility;
  /** v1.3: deterministic HIGH-risk classification for command/network/write tool names. */
  classifyToolRisk(toolName: string): RiskClass;
  /** v1.3: capability-class gate (OFF/AUDIT/ENFORCE). */
  capabilityGate(input: CapabilityGateInput): CapabilityGateDecision;
  /** v1.3: record a denied call signature (tool name + arg SHAPE, never values) for a session. */
  recordDeny(sessionId: string, toolName: string, args: unknown): void;
  /** v1.3: read-only deny-retry check for a pending call. */
  denyCircumventionCheck(sessionId: string, toolName: string, args: unknown): DenyRetryCheck;
  /** v1.3: clear recorded deny signatures for a session (operator escape hatch). */
  resetDenyCircumvention(sessionId: string): void;
  /** v1.3: extract the shared CapabilitySignal (exact field names) from a payload. */
  extractSignal(payload: unknown): CapabilitySignal;
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

  // v1.3: session-scoped deny-signature memory (deny-circumvention guard).
  // Argument VALUES never enter signatures (tool name + argument shape only).
  const denyGuard = new DenyCircumventionGuard();

  const service: PolicyService = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen),
    scanArguments: (value) => scanToolArguments(value, {
      unicode: frozen.enableUnicodeSanitization,
      encoding: frozen.enableEncodingScan,
    }),
    cotGate: (input) => evaluateCoTGate(frozen.reasoningTracePolicy, input),
    cotEnforcement: (input) => evaluateCoTEnforcement(frozen.reasoningTracePolicy, input),
    resolveCotVisibility: (input) => resolveCotVisibility({
      explicit: input.explicit,
      profile: input.routeId !== undefined ? frozen.cotVisibilityProfiles[input.routeId] : undefined,
    }),
    classifyToolRisk: (toolName) => classifyToolRisk(toolName),
    capabilityGate: (input) => evaluateCapabilityGate(frozen, input),
    recordDeny: (sessionId, toolName, args) => denyGuard.recordDeny(sessionId, toolName, args),
    denyCircumventionCheck: (sessionId, toolName, args) => denyGuard.check(sessionId, toolName, args),
    resetDenyCircumvention: (sessionId) => denyGuard.resetDenyCircumvention(sessionId),
    extractSignal: (payload) => extractCapabilitySignal(payload),
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

  // --- v1.2/v1.3: tools/pre-execute enforcement (pinned PreToolDecision seam) -
  // Deny materializes an upstream error result — { kind: 'deny', reason } —
  // so policy refusal never fabricates tool output. Reasons carry taint CLASS
  // names only; argument values are never echoed (Spec §10).
  //
  // v1.3 pipeline order (deterministic; first match wins):
  //   1. deny-circumvention guard  (same-shape retry of an already-denied call)
  //   2. capability-class gate     (shared `capabilityClass` field)
  //   3. Unicode taint scan        (v1.2 surface, unchanged)
  //   4. encoding-layer taint scan (v1.3 extension of the taint surface)
  //   5. CoT gate                  (v1.3: visibility profile + risk gating)
  // Every deny this listener returns records the call signature BEFORE
  // returning; a pass-through call records the signature when the REMAINING
  // waterfall (other listeners / downstream approval gate) denies — so any
  // {kind:'deny'} decision on this seam feeds the circumvention guard.
  disposers.push(
    ctx.on('tools/pre-execute', async (exec, next) => {
      const obs = ctx.get('supremeObservability') as
        | { record(event: string, fields: Record<string, unknown>): void }
        | undefined;
      const audit = obs ?? observability;
      const sessionKey = exec.agent?.id !== undefined ? String(exec.agent.id) : undefined;
      const recordDeny = (): void => {
        if (sessionKey !== undefined) denyGuard.recordDeny(sessionKey, exec.name, exec.arguments);
      };
      // Shared signal contract (EXACT field names `capabilityClass`/`cotVisibility`):
      // exec-level payload keys win; delegation-style payloads may instead carry
      // them as top-level keys of the parsed arguments.
      const execSignal = extractCapabilitySignal(exec);
      const argsSignal = extractCapabilitySignal(exec.arguments);
      const capabilityLabel = execSignal.capabilityClass ?? argsSignal.capabilityClass;
      const explicitVisibility = execSignal.cotVisibility ?? argsSignal.cotVisibility;

      // 1. v1.3 deny-circumvention guard: a same-shape retry after a deny is
      //    always flagged (reason code `deny_retry`), regardless of which check
      //    produced the original denial. Other tools/shapes unaffected.
      if (frozen.denyCircumventionGuard && sessionKey !== undefined) {
        const retry = denyGuard.check(sessionKey, exec.name, exec.arguments);
        if (retry.denied) {
          audit?.record('deny_retry', { tool: exec.name, detail: retry.reasonCodes.join('+') });
          return {
            kind: 'deny' as const,
            reason: 'supreme-policy: repeat of a previously denied call shape (deny_retry)',
          };
        }
      }

      // 2. v1.3 capability-class gate (requests WITHOUT a class pass untouched).
      if (capabilityLabel !== undefined && frozen.capabilityClassGate !== 'OFF') {
        const gate = evaluateCapabilityGate(frozen, { capabilityClass: capabilityLabel });
        if (gate.decision === 'DENY') {
          audit?.record('capability_class_unsanctioned', {
            tool: exec.name,
            detail: `class:${gate.capabilityClass};mode:ENFORCE`,
          });
          recordDeny();
          return {
            kind: 'deny' as const,
            reason: `supreme-policy: capability class not sanctioned (${gate.capabilityClass}; capability_class_unsanctioned)`,
          };
        }
        if (gate.decision === 'AUDIT') {
          audit?.record('capability_class_unsanctioned', {
            tool: exec.name,
            detail: `class:${gate.capabilityClass};mode:AUDIT`,
          });
        }
      }

      // 3. v1.2 Unicode taint (unchanged surface, unchanged detail format).
      if (frozen.enableUnicodeSanitization) {
        const findings = inspectTaint(exec.arguments);
        if (findings.tainted) {
          if (frozen.logTaintAttempts) {
            audit?.record('taint_detected', {
              tool: exec.name,
              detail: `classes:${findings.hits.join('+')};count:${findings.count}`,
            });
          }
          if (frozen.taintPolicy === 'DENY') {
            recordDeny();
            return {
              kind: 'deny' as const,
              reason: `supreme-policy: tool arguments rejected (unicode taint: ${findings.hits.join(', ')})`,
            };
          }
        }
      }

      // 4. v1.3 encoding-layer taint scan (class + arg NAME + run LENGTH only — never values).
      if (frozen.enableEncodingScan) {
        const findings = scanToolArguments(exec.arguments, { unicode: false, encoding: true });
        if (findings.tainted) {
          if (frozen.logTaintAttempts) {
            audit?.record('taint_detected', { tool: exec.name, detail: formatTaintEventDetail(findings) });
          }
          if (frozen.taintPolicy === 'DENY') {
            recordDeny();
            return {
              kind: 'deny' as const,
              reason: `supreme-policy: tool arguments rejected (encoding taint: ${ENCODING_BLOB_CLASS})`,
            };
          }
        }
      }

      // 5. CoT gate — v1.3 visibility + risk gating. Resolution order:
      //    (a) explicit `cotVisibility` on the call/request payload,
      //    (b) cotVisibilityProfiles[routeId] — routeId is the executing agent's
      //        id at this seam (tool name for agent-less dispatches),
      //    (c) default 'verbose' (v1.2 behavior — every route expected to talk).
      //    riskGatedCoT downgrades ENFORCE to AUDIT for non-HIGH tools; a
      //    resolved visibility of 'none' NEVER denies on cot_missing.
      if (frozen.reasoningTracePolicy !== 'OFF') {
        const routeId = sessionKey ?? exec.name;
        const visibility = resolveCotVisibility({
          explicit: explicitVisibility,
          profile: frozen.cotVisibilityProfiles[routeId],
        });
        const gate = evaluateCoTEnforcement(frozen.reasoningTracePolicy, {
          reasoningTracePresent: sessionKey !== undefined ? lastTracePresent.get(sessionKey) : undefined,
          tool: exec.name,
          visibility,
          riskGated: frozen.riskGatedCoT,
          toolRisk: classifyToolRisk(exec.name),
        });
        if (gate.decision === 'DENY') {
          audit?.record('cot_missing', { tool: exec.name, detail: 'ENFORCE' });
          recordDeny();
          return {
            kind: 'deny' as const,
            reason: 'supreme-policy: no reasoning trace observed this turn (cot_missing)',
          };
        }
        if (gate.decision === 'AUDIT') {
          audit?.record('cot_missing', { tool: exec.name, detail: gate.reasonCodes.join('+') });
        }
      }

      // Pass-through: inspect the remaining waterfall's decision so denies from
      // other listeners (or the downstream approval gate) also feed the guard.
      const result = await next();
      if (
        frozen.denyCircumventionGuard
        && sessionKey !== undefined
        && result
        && typeof result === 'object'
        && (result as { kind?: string }).kind === 'deny'
      ) {
        denyGuard.recordDeny(sessionKey, exec.name, exec.arguments);
      }
      return result;
    }),
  );
  // All v1.2/v1.3 effects unwind with the fiber (reverse-order dispose).
  ctx.effect(() => () => {
    for (const d of disposers.reverse()) d();
    lastTracePresent.clear();
    denyGuard.dispose();
  }, 'supreme-policy.v13-effects');

  ctx.logger.info(
    'supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d taint=%s cot=%s encodingScan=%s denyRetry=%s capabilityGate=%s',
    frozen.executionClass,
    String(frozen.allowPaid),
    String(frozen.allowTrial),
    frozen.maxDelegationDepth,
    frozen.taintPolicy,
    frozen.reasoningTracePolicy,
    String(frozen.enableEncodingScan),
    String(frozen.denyCircumventionGuard),
    frozen.capabilityClassGate,
  );
}
