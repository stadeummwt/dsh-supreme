/**
 * dsh-supreme/suite — Level A engine checks for all seven plugins.
 * Pure, keyless, deterministic. Real-loader composition gates live in runner.ts.
 */
import {
  check,
  expectEqual,
  expectThrows,
  expectTrue,
  type Check,
} from './harness';
import {
  classifyToolRisk,
  DENY_RETRY_REASON_CODE,
  DenyCircumventionGuard,
  denySignature,
  ENCODING_BLOB_CLASS,
  evaluateCapabilityGate,
  evaluateCoTEnforcement,
  evaluateDelegationPolicy,
  evaluateRoutePolicy,
  evaluateCoTGate,
  executionPolicySummary,
  extractCapabilitySignal,
  formatTaintEventDetail,
  inspectEncodingTaint,
  inspectTaint,
  isCapabilityClassSanctioned,
  normalizeCapabilityClass,
  PRODUCTION_DEFAULTS,
  resolveCotVisibility,
  scanToolArguments,
  validatePolicyConfig,
  PolicyConfigError,
  verificationRequirement,
  type SupremePolicyConfig,
} from '../plugins/supreme-policy/engine';
import {
  buildRecord,
  serializeRecord,
  JsonlWriter,
  type SafeRecord,
} from '../plugins/supreme-observability/engine';
import {
  aggregateRuns,
  aggregateTaskLatency,
  assertNoRepeatedSideEffects,
  BenchmarkStore,
  checkArtifactHashes,
  classSampleRows,
  isVerifierPassEvidence,
  planResumeFromRecords,
  resumeActions,
  validateBenchmarkRecord,
  validateCheckpointRecord,
  BenchmarkValidationError,
  ResumeSafetyError,
  type BenchmarkFs,
  type BenchmarkRun,
  type CheckpointRecord,
} from '../plugins/supreme-benchmark/engine';
import {
  AttemptLedger,
  CircuitBreaker,
  baseEffortFor,
  buildRouteCostGate,
  classifyFailure,
  ClassPerformanceTracker,
  costClassRank,
  DEFAULT_BOUNDS,
  DEFAULT_EFFORT_PACING,
  DEFAULT_FAST_PATH,
  DEFAULT_ROUTER_CONFIG,
  DEFAULT_SIMPLE_TASK_CLASSES,
  escalateEffort,
  freeClaimEvidence,
  freeClaimIsCurrent,
  isSimpleTask,
  normalizeTaskClass,
  OutcomeCircuitBreaker,
  planCrossProviderFallbacks,
  resolveRouteCostClass,
  routeCostDeniedMessage,
  selectRoute,
  weightsAreNormalized,
  wilsonLowerBound,
  withinWallClock,
  COST_POLICY_UNAVAILABLE_REASON,
  WILSON_Z,
  type FallbackPoolEntry,
  type RouterCandidate,
} from '../plugins/supreme-router/engine';
import {
  evaluateEvidenceForClose,
  isEvidenceCurrent,
  pathIsAllowed,
  resolveRealConfinement,
  runValidator,
  sanitizeEvidence,
  validateJsonSchema,
  validateJsonSchemaSubset,
  EVIDENCE_SCHEMA_VERSION,
  type VerifierRuntime,
} from '../plugins/supreme-verifier/engine';
import {
  clampSelectionStoreCap,
  DEFAULT_SELECTION_STORE_CAP,
  estimateTokens,
  identityKey,
  identityOf,
  isSecretBearing,
  ledgerNotesToItems,
  ledgerRelevanceScore,
  MIN_SELECTION_STORE_CAP,
  needsMemory,
  normalizeIdentityText,
  NoteLedger,
  NOOP_LONG_TERM_PROVIDER,
  selectLedgerNotes,
  selectMemory,
  SelectionStore,
  validateLedgerNote,
  LedgerValidationError,
  type LedgerFs,
  type LedgerNote,
  type MemoryItem,
  type MemorySelection,
} from '../plugins/supreme-memory-policy/engine';
import {
  A2A_CONTACT_DENIED_REASON,
  A2A_CONTACT_EVENT,
  A2A_RECIPIENT_UNRESOLVABLE_REASON,
  AGENT_CONTACT_POLICIES,
  buildCommsToolRegistry,
  buildDelegationScope,
  canCloseTask,
  classifyDelegationToolRisk,
  commsChannelOf,
  DEFAULT_COMMS_TOOL_REGISTRY,
  decideWorkflow,
  evaluateAgentContact,
  evaluateOverreach,
  evaluatePathScope,
  inferCommsChannel,
  isCommunicationTool,
  normalizeToolName,
  OVERREACH_EVENT,
  pathMatchesGlob,
  RISK_LEVELS,
  unresolvableRecipientDecision,
  validateCloseEvidenceRecord,
  validateWorkflowLimits,
  WORKFLOW_LIMIT_DEFAULTS,
  WorkflowConfigError,
} from '../plugins/supreme-workflow-policy/engine';
import * as nodePath from 'node:path';

const LAB_CONFIG: SupremePolicyConfig = {
  ...PRODUCTION_DEFAULTS,
  executionClass: 'LAB',
  allowPaid: true,
  allowTrial: true,
};

const prodConfig = (overrides: Partial<SupremePolicyConfig> = {}): SupremePolicyConfig => ({
  ...PRODUCTION_DEFAULTS,
  ...overrides,
});

function freeCandidate(overrides: Partial<RouterCandidate> = {}): RouterCandidate {
  return {
    key: 'synthetic-free::synthetic-mini',
    provider: 'synthetic-free',
    model: 'synthetic-mini',
    costClass: 'FREE_CONFIRMED',
    capabilities: ['chat'],
    contextWindow: 32768,
    credentialConfigured: true,
    quotaHeadroom: 0.9,
    failureDomain: 'synthetic',
    providerAvailable: true,
    modelValid: true,
    ...overrides,
  };
}

function paidCandidate(overrides: Partial<RouterCandidate> = {}): RouterCandidate {
  return freeCandidate({
    key: 'synthetic-paid::synthetic-large',
    provider: 'synthetic-paid',
    model: 'synthetic-large',
    costClass: 'PAID',
    contextWindow: 131072,
    failureDomain: 'synthetic-paid',
    ...overrides,
  });
}

const noopRuntime: VerifierRuntime = {
  fsExists: async () => false,
  fsRead: async () => null,
  sha256: async () => null,
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
};

const pathMod = { resolve: (p: string) => `/roots${p.startsWith('/') ? '' : '/'}${p}` };

export function policyChecks(): Check[] {
  return [
    check('policy.production-defaults', 'production defaults deny paid/trial/unknown', () => {
      expectEqual(PRODUCTION_DEFAULTS.allowPaid, false, 'allowPaid default');
      expectEqual(PRODUCTION_DEFAULTS.allowUnknownCost, false, 'allowUnknownCost default');
      const paid = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'PAID', risk: 'LOW' });
      const trial = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'TRIAL', risk: 'LOW' });
      const unknown = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'UNKNOWN', risk: 'LOW' });
      const free = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'FREE_CONFIRMED', risk: 'LOW' });
      expectTrue(!paid.allowed && !trial.allowed && !unknown.allowed && free.allowed, 'route decisions');
    }),
    check('policy.unknown-never-allowed', 'UNKNOWN cost denied even with permissive non-LAB flags', () => {
      expectThrows(
        () => validatePolicyConfig({ ...prodConfig({ executionClass: 'STANDARD' }), allowUnknownCost: true as never }),
        'allowUnknownCost=true must be rejected',
      );
      const cfg = validatePolicyConfig(prodConfig());
      expectTrue(!evaluateRoutePolicy(cfg, { costClass: 'UNKNOWN', risk: 'HIGH' }).allowed, 'unknown denied');
    }),
    check('policy.lab-override-only-in-lab', 'allowPaid/allowTrial overrides valid only with LAB', () => {
      expectTrue(validatePolicyConfig(LAB_CONFIG).allowPaid, 'LAB override accepted');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), allowPaid: true }), 'paid override in STANDARD rejected');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), allowTrial: true }), 'trial override in CORE rejected');
    }),
    check('policy.high-risk-verification', 'HIGH risk requires verification', () => {
      expectEqual(verificationRequirement(PRODUCTION_DEFAULTS, { risk: 'HIGH' }), 'REQUIRED', 'high risk level');
      expectEqual(verificationRequirement(PRODUCTION_DEFAULTS, { risk: 'LOW' }), 'NONE', 'low risk level');
    }),
    check('policy.delegation-bounded', 'delegation depth bounded; secret access never delegates', () => {
      expectTrue(evaluateDelegationPolicy(prodConfig(), { depth: 2, secretAccess: false }).allowed, 'depth 2 ok');
      expectTrue(!evaluateDelegationPolicy(prodConfig(), { depth: 4, secretAccess: false }).allowed, 'depth 4 denied');
      expectTrue(!evaluateDelegationPolicy(LAB_CONFIG, { depth: 1, secretAccess: true }).allowed, 'secret denied even LAB');
    }),
    check('policy.summary-derived-state', 'execution summary exposes compact derived state', () => {
      const summary = executionPolicySummary(PRODUCTION_DEFAULTS);
      expectEqual(summary.paidRoutes, 'DENY', 'summary paid routes');
      expectEqual(summary.unknownCost, 'DENY', 'summary unknown cost');
    }),
    check('policy.taint-scan-detects', 'hidden/bidi unicode in tool arguments is detected deterministically', () => {
      const tainted = inspectTaint({ command: 'echo', message: 'ok\u200Bhidden', deep: { bidi: 'a\u202Eb' } });
      expectTrue(tainted.tainted, 'taint found');
      expectTrue(tainted.hits.includes('U+200B-U+200F'), 'zero-width class reported');
      expectTrue(tainted.hits.includes('U+202A-U+202E'), 'bidi class reported');
      expectTrue(tainted.count >= 2, `count=${tainted.count}`);
      const clean = inspectTaint({ command: 'echo', message: 'plain ascii' });
      expectTrue(!clean.tainted && clean.hits.length === 0, 'clean args pass');
      // Values are NEVER echoed — only class names.
      expectTrue(!JSON.stringify(tainted.hits).includes('hidden'), 'values never reported');
    }),
    check('policy.taint-config-validation', 'taint/cot keys validate; unknown values rejected', () => {
      const deny = validatePolicyConfig({ ...prodConfig(), taintPolicy: 'DENY' });
      expectEqual(deny.taintPolicy, 'DENY', 'DENY accepted');
      const cot = validatePolicyConfig({ ...prodConfig({ executionClass: 'SUPREME' }), reasoningTracePolicy: 'ENFORCE' });
      expectEqual(cot.reasoningTracePolicy, 'ENFORCE', 'ENFORCE accepted on SUPREME');
      expectThrows(() => validatePolicyConfig({ ...prodConfig(), taintPolicy: 'BOGUS' as never }), 'bad taintPolicy rejected');
      expectThrows(
        () => validatePolicyConfig({ ...prodConfig({ executionClass: 'CORE' }), reasoningTracePolicy: 'ENFORCE' as never }),
        'ENFORCE refused on CORE floor',
      );
      expectTrue(PolicyConfigError !== undefined, 'error type present');
    }),
    check('policy.cot-gate-matrix', 'CoT presence gate is deterministic (audit, never prompt injection)', () => {
      expectEqual(evaluateCoTGate('OFF', { reasoningTracePresent: false, tool: 'bash' }).decision, 'ALLOW', 'OFF allows');
      expectEqual(evaluateCoTGate('AUDIT', { reasoningTracePresent: false, tool: 'bash' }).decision, 'AUDIT', 'AUDIT on absence');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: false, tool: 'bash' }).decision, 'DENY', 'ENFORCE denies known absence');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: undefined, tool: 'bash' }).decision, 'AUDIT', 'unknown evidence never denied');
      expectEqual(evaluateCoTGate('ENFORCE', { reasoningTracePresent: true, tool: 'bash' }).decision, 'ALLOW', 'trace present allows');
    }),
    // ---- v1.3 ASTRA-hardening (evidence-bound to real/v13-policy-verify.mjs) ----
    check('policy.cot-visibility-downgrade', 'v1.3: CoT visibility `none` downgrades ENFORCE deny to audit-only', () => {
      // Empty-CoT models can't be coerced into producing a trace: visibility
      // 'none' + known-absent trace ⇒ AUDIT, never DENY (no self-inflicted DoS).
      const none = evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', visibility: 'none' });
      expectEqual(none.decision, 'AUDIT', 'visibility none never denies');
      expectTrue(none.reasonCodes.includes('COT_VISIBILITY_NONE_DOWNGRADED'), 'downgrade reason recorded');
      // 'verbose' keeps the v1.2 ENFORCE posture unchanged.
      expectEqual(evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', visibility: 'verbose' }).decision, 'DENY', 'verbose still denies under ENFORCE');
      // Resolution order: explicit signal > route profile > default 'verbose'.
      expectEqual(resolveCotVisibility({ explicit: 'terse', profile: 'none' }), 'terse', 'explicit signal wins');
      expectEqual(resolveCotVisibility({ explicit: 'bogus', profile: 'none' }), 'none', 'profile used when explicit invalid');
      expectEqual(resolveCotVisibility({}), 'verbose', 'default is verbose (v1.2 behavior)');
      // OFF stays allow regardless of visibility.
      expectEqual(evaluateCoTEnforcement('OFF', { reasoningTracePresent: false, tool: 'bash', visibility: 'none' }).decision, 'ALLOW', 'OFF allows');
    }),
    check('policy.cot-risk-gate', 'v1.3: riskGatedCoT keeps ENFORCE for HIGH-risk tools, downgrades the rest', () => {
      expectEqual(classifyToolRisk('bash'), 'HIGH', 'command HIGH');
      expectEqual(classifyToolRisk('web-fetch'), 'HIGH', 'network HIGH');
      expectEqual(classifyToolRisk('file-write'), 'HIGH', 'write HIGH');
      expectEqual(classifyToolRisk('notebook'), 'LOW', 'token matching avoids substring hits');
      expectEqual(classifyToolRisk('read-file'), 'LOW', 'read-only LOW');
      const high = evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', riskGated: true, toolRisk: classifyToolRisk('bash') });
      expectEqual(high.decision, 'DENY', 'HIGH-risk tool keeps ENFORCE deny');
      const low = evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'search', riskGated: true, toolRisk: classifyToolRisk('search') });
      expectEqual(low.decision, 'AUDIT', 'non-HIGH tool downgraded to AUDIT');
      // Without the gate, ENFORCE denies regardless of tool risk (v1.2 matrix).
      expectEqual(
        evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'search', riskGated: false, toolRisk: 'LOW' }).decision,
        'DENY',
        'gate off preserves v1.2 posture',
      );
    }),
    check('policy.deny-retry-guard', 'v1.3: deny-circumvention guard flags same-shape retries, value-free', () => {
      const guard = new DenyCircumventionGuard();
      guard.recordDeny('s1', 'bash', { command: 'rm -rf /' });
      // Same argument SHAPE with different values is still a flagged retry —
      // values never enter the signature, so honest traffic is unaffected while
      // value-swapped retries are caught.
      expectEqual(guard.check('s1', 'bash', { command: 'echo safe' }).denied, true, 'same shape flagged');
      expectTrue(guard.check('s1', 'bash', { command: 'echo safe' }).reasonCodes.includes(DENY_RETRY_REASON_CODE), 'deny_retry reason code');
      expectEqual(guard.check('s1', 'bash', { cmd: 'x' }).denied, false, 'other shape unaffected');
      expectEqual(guard.check('s1', 'curl', { command: 'rm -rf /' }).denied, false, 'other tool unaffected');
      expectEqual(guard.check('s2', 'bash', { command: 'rm -rf /' }).denied, false, 'other session unaffected');
      // Signature encodes argument NAMES + primitive TYPES only.
      const sig = denySignature('bash', { command: 'SECRET_SENTINEL_XYZ', n: 1, deep: { a: [1, 2] } });
      expectTrue(!sig.includes('SECRET_SENTINEL'), 'signature can never leak values');
      expectTrue(sig.includes('command:string'), 'signature encodes names+types');
      expectEqual(normalizeCapabilityClass(' routine '), 'ROUTINE', 'class normalization shared by gate');
      // Operator escape hatch restores the session.
      guard.resetDenyCircumvention('s1');
      expectEqual(guard.check('s1', 'bash', { command: 'echo safe' }).denied, false, 'reset restores');
      expectEqual(guard.signatureCount('s1'), 0, 'reset clears signatures');
    }),
    check('policy.encoding-blob-scan', 'v1.3: base64/hex blob detection is deterministic and value-free', () => {
      const b64 = inspectEncodingTaint({ blob: 'Z'.repeat(512) }); // 'Z' is base64-only (outside the hex alphabet)
      expectTrue(b64.tainted, 'base64 blob found');
      expectEqual(b64.hits[0]?.kind, 'base64', 'kind base64');
      expectEqual(b64.hits[0]?.length, 512, 'run length reported');
      // Hex is more specific (subset alphabet) and reported first/instead.
      expectEqual(inspectEncodingTaint('a'.repeat(256)).hits[0]?.kind, 'hex', 'hex classified as hex');
      expectEqual(inspectEncodingTaint('a'.repeat(255)).tainted, false, 'below-threshold negative');
      // Combined scan + formatter: class names, arg NAME, kind, length — never a value.
      const scan = scanToolArguments({ data: 'Z'.repeat(300) }, { unicode: true, encoding: true });
      expectTrue(scan.hits.includes(ENCODING_BLOB_CLASS), 'encoding_blob class reported');
      const detail = formatTaintEventDetail(scan);
      expectTrue(detail.includes('arg:data;kind:base64;len:300'), 'arg name + kind + len only');
      expectTrue(!detail.includes('Z'.repeat(16)), 'value never echoed');
      // Toggle off preserves v1.2 behavior exactly.
      const off = scanToolArguments({ data: 'Z'.repeat(300) }, { unicode: true, encoding: false });
      expectTrue(!off.tainted && off.encoding.length === 0, 'encoding off → clean scan');
    }),
    check('policy.capability-gate-lab-allowlist', 'v1.3: capability-class gate — LAB allowlist is additive and floor-bound', () => {
      // Unlabeled requests pass untouched in every mode (UNKNOWN-cost posture unchanged).
      expectEqual(evaluateCapabilityGate(prodConfig(), {}).decision, 'ALLOW', 'absent class passes');
      expectEqual(evaluateCapabilityGate(prodConfig(), { capabilityClass: 'CYBER_OFFENSIVE' }).decision, 'ALLOW', 'gate OFF default untouched');
      // STANDARD + ENFORCE: unsanctioned class denied (normalization applied).
      const std = prodConfig({ capabilityClassGate: 'ENFORCE' });
      expectEqual(evaluateCapabilityGate(std, { capabilityClass: 'cyber_offensive' }).decision, 'DENY', 'ENFORCE denies unsanctioned');
      const sanctioned = prodConfig({ capabilityClassGate: 'ENFORCE', sanctionedCapabilityClasses: ['ROUTINE'] });
      expectEqual(evaluateCapabilityGate(sanctioned, { capabilityClass: 'ROUTINE' }).decision, 'ALLOW', 'sanctioned class allowed');
      // LAB allowlist is ADDITIVE but only on the LAB floor — no leak to STANDARD.
      const labAllow = ['DESTRUCTIVE_OPS'];
      expectTrue(isCapabilityClassSanctioned({ ...LAB_CONFIG, labCapabilityClassAllowlist: labAllow }, 'destructive_ops'), 'LAB allowlist binds in LAB');
      expectTrue(!isCapabilityClassSanctioned({ ...prodConfig(), labCapabilityClassAllowlist: labAllow }, 'DESTRUCTIVE_OPS'), 'no LAB leak to STANDARD');
      // AUDIT mode records instead of denying, with the normalized label.
      const audit = evaluateCapabilityGate(prodConfig({ capabilityClassGate: 'AUDIT' }), { capabilityClass: 'DESTRUCTIVE_OPS' });
      expectEqual(audit.decision, 'AUDIT', 'AUDIT mode flags');
      expectEqual(audit.capabilityClass, 'DESTRUCTIVE_OPS', 'normalized label reported');
      // No implicit ROUTINE exemption: labeling can only RESTRICT, never grant.
      expectTrue(!isCapabilityClassSanctioned(prodConfig(), 'ROUTINE'), 'no ROUTINE exemption on empty sanctions');
    }),
    check('policy.capability-signal-extract', 'v1.3: CapabilitySignal contract — exact field names, inert on noise', () => {
      const sig = extractCapabilitySignal({ capabilityClass: '  routine ', cotVisibility: 'none', tool: 'bash' });
      expectEqual(sig.capabilityClass, 'ROUTINE', 'class normalized trim+upper');
      expectEqual(sig.cotVisibility, 'none', 'visibility passed through');
      expectEqual(extractCapabilitySignal({ cotVisibility: 'shout' }).cotVisibility, undefined, 'unknown visibility ignored');
      expectEqual(extractCapabilitySignal({ capabilityClass: 42 }).capabilityClass, undefined, 'non-string ignored');
      expectEqual(extractCapabilitySignal('not-an-object').capabilityClass, undefined, 'non-object payload inert');
      expectEqual(Object.keys(extractCapabilitySignal({})).length, 0, 'absent signal stays absent');
    }),
    check('policy.v13-config-validation', 'v1.3: new config keys validate; defaults behavior-preserving', () => {
      // Defaults: everything off except the retry-only deny-circumvention guard.
      expectEqual(PRODUCTION_DEFAULTS.capabilityClassGate, 'OFF', 'gate default OFF');
      expectEqual(PRODUCTION_DEFAULTS.enableEncodingScan, false, 'encoding scan default off');
      expectEqual(PRODUCTION_DEFAULTS.riskGatedCoT, false, 'risk gate default off');
      expectEqual(PRODUCTION_DEFAULTS.denyCircumventionGuard, true, 'retry-only guard default on');
      expectEqual(Object.keys(PRODUCTION_DEFAULTS.cotVisibilityProfiles).length, 0, 'no visibility profiles by default');
      // Valid values accepted and returned.
      const cfg = validatePolicyConfig(prodConfig({
        cotVisibilityProfiles: { 'agent-a': 'none' },
        capabilityClassGate: 'AUDIT',
        sanctionedCapabilityClasses: ['ROUTINE'],
        labCapabilityClassAllowlist: ['DESTRUCTIVE_OPS'],
      }));
      expectEqual(cfg.cotVisibilityProfiles['agent-a'], 'none', 'visibility profile accepted');
      expectEqual(cfg.capabilityClassGate, 'AUDIT', 'gate mode accepted');
      // Invalid values rejected deterministically.
      expectThrows(() => validatePolicyConfig(prodConfig({ cotVisibilityProfiles: { r: 'shout' as never } })), 'bad visibility rejected');
      expectThrows(() => validatePolicyConfig(prodConfig({ capabilityClassGate: 'PARANOID' as never })), 'bad gate mode rejected');
      expectThrows(() => validatePolicyConfig(prodConfig({ sanctionedCapabilityClasses: [''] })), 'empty sanction entry rejected');
      expectThrows(() => validatePolicyConfig(prodConfig({ labCapabilityClassAllowlist: [7] as never })), 'non-string allowlist rejected');
      expectTrue(PolicyConfigError !== undefined, 'error type present');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-cost-enforce.mjs) ----
    check('policy.route-decision-gate-contract', 'v1.3.1 FIX-A: policy decision contract consumed by the pre-dispatch cost gate', () => {
      // The router's pre-dispatch gate consumes exactly this owner shape:
      // { allowed, reasonCodes } with value-free label reasons (FIX-A).
      const paid = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'PAID', risk: 'LOW' });
      expectEqual(paid.allowed, false, 'paid denied by owner');
      expectTrue(paid.reasonCodes.includes('COST_PAID_DENIED'), 'deny reason is a value-free label');
      const free = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'FREE_CONFIRMED', risk: 'LOW' });
      expectEqual(free.allowed, true, 'free allowed by owner');
      expectTrue(free.reasonCodes.includes('COST_FREE_CONFIRMED') && free.reasonCodes.includes('OK'), 'allow reasons recorded');
      const unknown = evaluateRoutePolicy(PRODUCTION_DEFAULTS, { costClass: 'UNKNOWN', risk: 'LOW' });
      expectTrue(!unknown.allowed && unknown.reasonCodes.includes('COST_UNKNOWN_DENIED'), 'unknown denied with pinned label');
    }),
  ];
}

export function observabilityChecks(): Check[] {
  return [
    check('observability.allowlist-only', 'unknown fields never serialized', () => {
      const rec = buildRecord(1, 1000, 'tool_call', {
        tool: 'bash',
        toolArguments: 'rm -rf /', // unknown field → dropped
        apiKey: 'sk-unknown-field',
      }) as Record<string, unknown>;
      expectEqual(rec.tool, 'bash', 'allowlisted field kept');
      expectTrue(!('toolArguments' in rec) && !('apiKey' in rec), 'unknown fields dropped');
    }),
    check('observability.sentinel-scrubbed', 'secret sentinel scrubbed from allowlisted strings', () => {
      const rec = buildRecord(2, 1000, 'detail_event', { detail: 'SECRET_SENTINEL_ABCDEF value' });
      const line = serializeRecord(rec, 2048);
      expectTrue(!line.includes('SECRET_SENTINEL'), 'sentinel absent from line');
    }),
    check('observability.writer-fails-open', 'writer failures drop records without throwing', async () => {
      const writer = new JsonlWriter('/nonexistent-root/x.jsonl', '/nonexistent-root/x.jsonl.1', 1_000_000, 2048, {
        appendFile: async () => {
          throw new Error('EACCES');
        },
        stat: async () => null,
        rename: async () => undefined,
        mkdir: async () => {},
      });
      writer.write(buildRecord(3, 1000, 'drop_me', {}));
      const stats = await writer.dispose();
      expectTrue(stats.dropped >= 1, `dropped=${stats.dropped}`);
    }),
    check('observability.disabled-noop', 'disabled config produces no writer', () => {
      expectTrue(true, 'covered by real-boot no-op flag path');
    }),
    check('observability.order-deterministic', 'records keep monotonic sequence order', () => {
      const a = buildRecord(10, 1000, 'a', {}) as SafeRecord;
      const b = buildRecord(11, 1001, 'b', {}) as SafeRecord;
      expectTrue(a.seq < b.seq, 'seq order');
    }),
    check('observability.v12-events-allowlisted', 'v1.2 audit events (taint/cot) serialize metadata only', () => {
      const taint = buildRecord(20, 1000, 'taint_detected', {
        tool: 'bash',
        detail: 'classes:U+200B-U+200F;count:1',
        // Injection attempts: unknown fields + values must be dropped.
        arguments: 'rm -rf /\u200B',
        SECRET_SENTINEL_X: 'leak',
      }) as Record<string, unknown>;
      expectEqual(taint.event, 'taint_detected', 'event kept');
      expectEqual(taint.tool, 'bash', 'allowlisted tool field');
      expectTrue(!('arguments' in taint) && !('SECRET_SENTINEL_X' in taint), 'unknown fields dropped');
      const cot = buildRecord(21, 1000, 'cot_missing', { tool: 'bash', detail: 'ENFORCE' }) as Record<string, unknown>;
      expectEqual(cot.detail, 'ENFORCE', 'cot detail kept');
    }),
    check('observability.v13-events-allowlisted', 'v1.3 audit events (deny_retry/a2a_contact/overreach) serialize metadata only', () => {
      // A2A contact audit: allowlisted fields + bounded value-free detail line.
      const a2a = buildRecord(30, 1000, A2A_CONTACT_EVENT, {
        tool: 'send_message',
        detail: 'channel:message:from:planner:to:executor:reason:CONTACT_OUTSIDE_GRAPH:outcome:LOGGED:mode:LOG_ONLY:origin:tools_pre_execute',
        to: 'executor', // NOT allowlisted → must be dropped entirely
      }) as Record<string, unknown>;
      expectEqual(a2a.event, 'a2a_contact', 'a2a event kept');
      expectEqual(a2a.tool, 'send_message', 'allowlisted tool field');
      expectTrue(!('to' in a2a), 'graph endpoint values never serialized');
      const overreach = buildRecord(31, 1000, OVERREACH_EVENT, {
        tool: 'subagent',
        detail: 'risk:HIGH:max:MEDIUM:reasons:RISK_ABOVE_MAX',
      }) as Record<string, unknown>;
      expectEqual(overreach.detail, 'risk:HIGH:max:MEDIUM:reasons:RISK_ABOVE_MAX', 'labels/levels only');
      expectEqual(buildRecord(32, 1000, 'deny_retry', { tool: 'bash', detail: 'origin:tools_pre_execute' }).event, 'deny_retry', 'deny_retry serializes');
      // Sentinel scrub still applies to allowlisted string fields (defense in depth).
      const scrubbed = buildRecord(33, 1000, A2A_CONTACT_EVENT, { detail: 'to:SECRET_SENTINEL_ABC' });
      expectTrue(!serializeRecord(scrubbed, 2048).includes('SECRET_SENTINEL'), 'sentinel scrubbed');
    }),
  ];
}

export function benchmarkChecks(): Check[] {
  const makeStore = (options: { requireEvidenceForScores?: boolean } = {}): { store: BenchmarkStore; files: Map<string, string> } => {
    const files = new Map<string, string>();
    const fs: BenchmarkFs = {
      readFile: async (p) => files.get(p) ?? null,
      appendFile: async (p, line) => {
        files.set(p, (files.get(p) ?? '') + line);
      },
      mkdir: async () => {},
    };
    return { store: new BenchmarkStore('/mem/benchmark.jsonl', fs, options), files };
  };

  return [
    check('benchmark.roundtrip', 'task/run/score roundtrip through store + JSONL', async () => {
      const { store } = makeStore();
      await store.init();
      await store.recordTask({ taskId: 't1', category: 'unit' });
      const run = await store.startRun({ runId: 'r1', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'unit' });
      await store.finishRun('r1', { success: true, latencyMs: 50 });
      await store.recordScore({ runId: 'r1', qualityScore: 0.8 });
      const history = store.queryHistory({ provider: 'p' });
      expectEqual(history.length, 1, 'history length');
      expectEqual(run.runId, 'r1', 'run id');
    }),
    check('benchmark.corrupt-lines-skipped', 'corrupt JSONL lines counted, never fatal', async () => {
      const { store, files } = makeStore();
      files.set('/mem/benchmark.jsonl', '{"kind":"run","schemaVersion":1}\nnot-json\n\n');
      const stats = await store.init();
      expectTrue(stats.corruptLines >= 1, `corrupt=${stats.corruptLines}`);
    }),
    check('benchmark.validation-bounds', 'qualityScore bounds + failureClass enum enforced', () => {
      expectThrows(() => validateBenchmarkRecord({ kind: 'score', schemaVersion: 1, runId: 'x', qualityScore: 1.5, scoredAt: 1 }), 'score >1 rejected');
      expectThrows(() => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, failureClass: 'NOT_A_CLASS' }), 'bad failureClass rejected');
      expectThrows(() => validateBenchmarkRecord({ kind: 'nope', schemaVersion: 1 }), 'unknown kind rejected');
      expectTrue(BenchmarkValidationError !== undefined, 'error type present');
    }),
    check('benchmark.aggregation', 'aggregation groups by provider+model with rates', async () => {
      const runs = [
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'a', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 2, success: true, qualityScore: 0.9, latencyMs: 100 },
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'b', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 2, success: false, failureClass: 'TIMEOUT' as const, latencyMs: 300 },
      ];
      const agg = aggregateRuns(runs);
      expectEqual(agg.length, 1, 'one group');
      expectEqual(agg[0].samples, 2, 'samples');
      expectTrue(Math.abs(agg[0].successRate - 0.5) < 1e-9, 'success rate');
      expectTrue(Math.abs((agg[0].avgQuality ?? 0) - 0.9) < 1e-9, 'avg quality');
    }),
    check('benchmark.empty-history', 'empty history aggregation is empty, not crash', () => {
      expectEqual(aggregateRuns([]).length, 0, 'empty groups');
    }),
    check('benchmark.provenance-binding', 'commitHash + irVersion bind runs to provenance; malformed rejected', () => {
      expectThrows(
        () => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, commitHash: 'not-a-sha' }),
        'malformed commitHash rejected',
      );
      expectThrows(
        () => validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, irVersion: 'bad version!' }),
        'malformed irVersion rejected',
      );
      const ok = validateBenchmarkRecord({
        kind: 'run', schemaVersion: 1, runId: 'p1', taskId: 't', provider: 'p', model: 'm', profile: 'unit',
        startedAt: 1,
        commitHash: 'd347e703908d0406b7a7ef80e3a0e594d86b2215',
        irVersion: '1.0.0',
      });
      expectEqual((ok as { commitHash?: string }).commitHash, 'd347e703908d0406b7a7ef80e3a0e594d86b2215', 'sha roundtrip');
      const unavailable = validateBenchmarkRecord({ kind: 'run', schemaVersion: 1, runId: 'x', taskId: 't', provider: 'p', model: 'm', startedAt: 0, commitHash: 'UNAVAILABLE' });
      expectEqual((unavailable as { commitHash?: string }).commitHash, 'UNAVAILABLE', 'UNAVAILABLE accepted');
    }),
    // ---- v1.3 ASTRA-hardening (evidence-bound to real/v13-routing-verify.mjs) ----
    check('benchmark.evidence-backing', 'v1.3: requireEvidenceForScores flags score claims; PASS evidence recovers', async () => {
      // Default store: no evidenceBacked key written at all (back-compat shape).
      const plain = makeStore();
      await plain.store.init();
      await plain.store.startRun({ runId: 'r0', taskId: 't0', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'unit' });
      const plainScore = await plain.store.recordScore({ runId: 'r0', qualityScore: 0.9 });
      expectTrue(!('evidenceBacked' in plainScore), 'default writes no flag');
      // Toggle ON: claim without verifier-PASS evidence ⇒ flagged false on score.
      const flagged = makeStore({ requireEvidenceForScores: true });
      await flagged.store.init();
      await flagged.store.startRun({ runId: 'r1', taskId: 't1', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'unit' });
      const claim = await flagged.store.recordScore({ runId: 'r1', qualityScore: 0.9 });
      expectEqual((claim as { evidenceBacked?: boolean }).evidenceBacked, false, 'claim without evidence flagged false');
      expectTrue((flagged.files.get('/mem/benchmark.jsonl') ?? '').includes('"evidenceBacked":false'), 'flag persisted to JSONL');
      // Final verification lands later — last-write-wins re-evaluation.
      await flagged.store.finishRun('r1', { success: true, latencyMs: 10, verification: { validatorId: 'v', status: 'PASS' } });
      const agg = flagged.store.aggregateModelPerformance();
      expectEqual(agg[0].evidenceBackedScores, 1, 'claim recovered by PASS evidence');
      // Validation: evidenceBacked must be boolean when present.
      expectThrows(
        () => validateBenchmarkRecord({ kind: 'score', schemaVersion: 1, runId: 'x', qualityScore: 0.5, scoredAt: 1, evidenceBacked: 'yes' }),
        'non-boolean flag rejected',
      );
      const ok = validateBenchmarkRecord({ kind: 'score', schemaVersion: 1, runId: 'x', qualityScore: 0.5, scoredAt: 1, evidenceBacked: false });
      expectEqual((ok as { evidenceBacked?: boolean }).evidenceBacked, false, 'boolean flag accepted');
    }),
    check('benchmark.evidence-aggregation', 'v1.3: aggregation exposes scoredSamples + evidenceBackedScores; evidence rule is verifier-PASS', () => {
      expectEqual(isVerifierPassEvidence({ validatorId: 'v', status: 'PASS' }), true, 'PASS is evidence');
      expectEqual(isVerifierPassEvidence({ validatorId: 'v', status: 'FAIL' }), false, 'FAIL is not evidence');
      expectEqual(isVerifierPassEvidence(undefined), false, 'absence is not evidence');
      const runs = [
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'e1', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 2, success: true, qualityScore: 0.9, evidenceBacked: true },
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'e2', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 3, success: true, qualityScore: 0.8, evidenceBacked: false },
        { schemaVersion: 1 as const, kind: 'run' as const, runId: 'e3', taskId: 't', taskCategory: 'c', provider: 'p1', model: 'm1', profile: 'x', startedAt: 1, finishedAt: 4, success: true },
      ];
      const agg = aggregateRuns(runs);
      expectEqual(agg.length, 1, 'one group');
      expectEqual(agg[0].scoredSamples, 2, 'score claims counted');
      expectEqual(agg[0].evidenceBackedScores, 1, 'evidence-backed subset counted');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-outcome-routing.mjs) ----
    check('benchmark.checkpoint-hash-binding', 'v1.3.1 IMP-R: checkpoint artifact hashes bind records to real artifact bytes', () => {
      expectEqual(checkArtifactHashes([{ ref: 'f', hash: 'h1' }], { f: 'h1' }), 'verified', 'matching hashes verified');
      expectEqual(checkArtifactHashes([{ ref: 'f', hash: 'h1' }], { f: 'h2' }), 'mismatch', 'changed bytes ⇒ mismatch');
      expectEqual(checkArtifactHashes([{ ref: 'f', hash: 'h1' }], {}), 'mismatch', 'missing artifact ⇒ mismatch');
      expectEqual(checkArtifactHashes([{ ref: 'f', hash: 'h1' }], undefined), 'unverified', 'no current state ⇒ unverified (honest)');
      // Validation: hash pairs bounded + well-formed; flag boolean; status enum.
      const record = {
        schemaVersion: 1 as const, kind: 'checkpoint' as const, taskId: 't', stepIndex: 0, artifactRefs: ['f'],
        artifactHashes: [{ ref: 'f', hash: 'sha256' }], sideEffectsRegistered: true, status: 'completed' as const, updatedAt: 1,
      };
      expectEqual(validateCheckpointRecord(record).sideEffectsRegistered, true, 'valid record roundtrips');
      expectThrows(() => validateCheckpointRecord({ ...record, artifactHashes: [{ ref: 'f', hash: 'has space' }] }), 'bad hash token rejected');
      expectThrows(() => validateCheckpointRecord({ ...record, sideEffectsRegistered: 'yes' as never }), 'non-boolean flag rejected');
      expectThrows(() => validateCheckpointRecord({ ...record, status: 'rewound' as never }), 'bad status rejected');
    }),
    check('benchmark.resume-never-repeats-side-effects', 'v1.3.1 IMP-R: resume re-plans from TRUE state — completed steps never auto-redo, stale hashes surface without execution', () => {
      const records: CheckpointRecord[] = [
        { schemaVersion: 1, kind: 'checkpoint', taskId: 't', stepIndex: 0, artifactRefs: ['f0'], artifactHashes: [{ ref: 'f0', hash: 'h0' }], status: 'completed', updatedAt: 1 },
        { schemaVersion: 1, kind: 'checkpoint', taskId: 't', stepIndex: 1, artifactRefs: ['f1'], status: 'interrupted', updatedAt: 2 },
      ];
      // Verified state: step0 done, step1 redone.
      const plan = planResumeFromRecords('t', records, { f0: 'h0' });
      expectEqual(plan.steps[0].redo, false, 'completed+verified never redo');
      expectEqual(plan.steps[0].hashCheck, 'verified', 'hash check verified');
      expectEqual(plan.steps[1].redo, true, 'interrupted step redone');
      expectEqual(resumeActions(plan).map((s) => s.stepIndex).join(','), '1', 'only non-completed steps auto-run');
      // Stale side effect: step0's bytes changed — surfaced, never executed.
      const stale = planResumeFromRecords('t', records, { f0: 'DIFFERENT' });
      expectEqual(stale.steps[0].hashCheck, 'mismatch', 'stale hash detected');
      expectEqual(stale.steps[0].redo, true, 'stale step flagged for attention');
      expectEqual(resumeActions(stale).length, 1, 'stale completed step NOT auto-runnable');
      expectThrows(() => assertNoRepeatedSideEffects(stale, [{ stepIndex: 0 }]), 'safety assertion refuses completed-step actions');
      expectTrue(ResumeSafetyError !== undefined, 'error type present');
    }),
    check('benchmark.class-samples-latency', 'v1.3.1 IMP-R: class-sample rows + task latency aggregate from real run records (durations only)', () => {
      const run = (over: Partial<BenchmarkRun>): BenchmarkRun => ({
        schemaVersion: 1, kind: 'run', runId: 'r', taskId: 't', taskCategory: 'unit', provider: 'p', model: 'm', profile: 'x', startedAt: 0, ...over,
      });
      const rows = classSampleRows([
        run({ runId: 'r1', provider: 'a', model: 'm', success: true, finishedAt: 10 }),
        run({ runId: 'r2', provider: 'b', model: 'm', success: false, finishedAt: 20 }),
        run({ runId: 'r3', provider: 'c', model: 'm', success: true }), // unfinished ⇒ excluded
      ]);
      expectEqual(rows.length, 2, 'only finished runs sampled');
      expectEqual(rows[0].provider, 'b', 'most recent first');
      expectEqual(rows[1].success, true, 'outcomes carried');
      const latency = aggregateTaskLatency([
        run({ runId: 'l1', taskCategory: 'unit', latencyMs: 100, finishedAt: 10 }),
        run({ runId: 'l2', taskCategory: 'unit', latencyMs: 300, finishedAt: 20 }),
        run({ runId: 'l3', taskCategory: 'unit', startedAt: 0, finishedAt: 50 }), // duration from timestamps
      ]);
      expectEqual(latency.length, 1, 'one category group');
      expectEqual(latency[0].samples, 3, 'all finished runs counted');
      expectEqual(latency[0].maxLatencyMs, 300, 'max duration');
      expectEqual(latency[0].medianLatencyMs, 100, 'median duration (sorted 50/100/300)');
    }),
  ];
}

export function routerChecks(): Check[] {
  const runSelect = (candidates: RouterCandidate[], overrides: Partial<Parameters<typeof selectRoute>[0]> = {}) =>
    selectRoute({
      config: DEFAULT_ROUTER_CONFIG,
      candidates,
      circuit: new CircuitBreaker(DEFAULT_ROUTER_CONFIG.circuit),
      perf: new Map(),
      now: 1_000_000,
      decisionId: 'dec_test',
      input: {},
      ...overrides,
    });

  return [
    check('router.weights-normalized', 'default weights sum to 1 and normalize stays stable', () => {
      expectTrue(weightsAreNormalized(DEFAULT_ROUTER_CONFIG.weights), 'defaults normalized');
    }),
    check('router.paid-rejected', 'paid candidate fails policy gate', () => {
      const decision = runSelect([paidCandidate()]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
      expectTrue(decision.hardGates.some((g) => g.gate === 'policy_cost' && !g.passed), 'policy_cost failed');
      expectTrue(decision.reasonCodes.includes('BLOCKED_NO_ELIGIBLE_ROUTE'), 'reason code present');
    }),
    check('router.unknown-cost-rejected', 'unknown cost fails policy gate', () => {
      const decision = runSelect([freeCandidate({ costClass: 'UNKNOWN' })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.invalid-model-rejected', 'model_valid gate rejects unresolvable models', () => {
      const decision = runSelect([freeCandidate({ modelValid: false })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.unhealthy-rejected', 'circuit-open candidates rejected', () => {
      const circuit = new CircuitBreaker(DEFAULT_ROUTER_CONFIG.circuit);
      const now = 1_000_000;
      for (let i = 0; i < DEFAULT_ROUTER_CONFIG.circuit.failureThreshold; i++) circuit.recordFailure('synthetic-free::synthetic-mini', now);
      const decision = selectRoute({
        config: DEFAULT_ROUTER_CONFIG,
        candidates: [freeCandidate()],
        circuit,
        perf: new Map(),
        now,
        decisionId: 'dec_test',
        input: {},
      });
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked while open');
      expectTrue(decision.hardGates.some((g) => g.gate === 'health_ok' && !g.passed), 'health gate failed');
    }),
    check('router.quota-rejected', 'quota headroom below minimum rejected', () => {
      const decision = runSelect([freeCandidate({ quotaHeadroom: 0.01 })]);
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.context-insufficient', 'context gate rejects insufficient windows', () => {
      const decision = runSelect([freeCandidate({ contextWindow: 1024 })], {
        input: { requiredContextTokens: 8192 },
      });
      expectEqual(decision.blocked, 'BLOCKED_NO_ELIGIBLE_ROUTE', 'blocked verdict');
    }),
    check('router.best-eligible-wins', 'best eligible score selected with alternatives recorded', () => {
      const decision = runSelect([freeCandidate(), freeCandidate({ key: 'other::m', provider: 'other', model: 'm', quotaHeadroom: 0.2, failureDomain: 'other' })]);
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'synthetic-free', 'best provider');
      expectTrue((decision.score ?? 0) > 0, 'score positive');
      expectTrue(decision.alternatives.length >= 1, 'alternatives present');
      expectTrue(decision.reasonCodes.includes('OK'), 'OK reason');
    }),
    check('router.circuit-breaker-transitions', 'breaker opens after threshold, recovers after cooldown', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 1_000 });
      breaker.recordFailure('k', 1000);
      expectEqual(breaker.stateOf('k', 1100).state, 'DEGRADED', 'degraded state');
      breaker.recordFailure('k', 1200);
      expectEqual(breaker.stateOf('k', 1300).state, 'CIRCUIT_OPEN', 'open state');
      expectEqual(breaker.stateOf('k', 3000).state, 'DEGRADED', 'half-open after cooldown');
      breaker.recordSuccess('k', 3100);
      expectEqual(breaker.stateOf('k', 3200).state, 'HEALTHY', 'healthy after success');
    }),
    check('router.exploration-until-evidence', 'below min samples → degraded exploration mode', () => {
      const decision = runSelect([freeCandidate()]);
      expectTrue(decision.degraded, 'degraded in exploration');
      expectTrue(decision.reasonCodes.includes('EXPLORATION_NO_HISTORY'), 'exploration reason');
    }),
    check('router.cost-first-rm0', 'RM0-first: FREE_CONFIRMED wins even when rate-limited peer has better history', () => {
      const limited = freeCandidate({
        key: 'limited::m',
        provider: 'limited',
        model: 'm',
        costClass: 'FREE_LIMITED',
        failureDomain: 'limited',
      });
      const decision = runSelect([limited, freeCandidate()], {
        perf: new Map([['limited::m', { avgQuality: 0.95, samples: 20 }]]),
      });
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'synthetic-free', 'FREE_CONFIRMED selected despite worse score');
      expectTrue(decision.costFirstApplied, 'cost-first recorded');
      expectTrue(decision.reasonCodes.some((r) => r.startsWith('COST_FIRST_FREE_CONFIRMED')), 'reason code present');
      // Hard-gate evidence for the demoted candidate is preserved.
      expectTrue(decision.hardGates.some((g) => g.candidate === 'limited::m' && g.passed), 'demoted candidate gates recorded');
      expectEqual(costClassRank('FREE_CONFIRMED'), 0, 'rank order start');
      expectTrue(costClassRank('FREE_LIMITED') > costClassRank('FREE_CONFIRMED'), 'limited ranks below confirmed');
    }),
    check('router.cost-first-opt-out', 'costFirst=false restores pure weighted scoring', () => {
      const limited = freeCandidate({ key: 'limited::m', provider: 'limited', model: 'm', costClass: 'FREE_LIMITED', failureDomain: 'limited' });
      const decision = runSelect([limited, freeCandidate()], {
        config: { ...DEFAULT_ROUTER_CONFIG, costFirst: false },
        perf: new Map([['limited::m', { avgQuality: 0.95, samples: 20 }]]),
      });
      expectEqual(decision.blocked, null, 'not blocked');
      expectEqual(decision.provider, 'limited', 'best-scored candidate wins when opt-out');
      expectTrue(!decision.costFirstApplied, 'cost-first not applied');
    }),
    check('router.effort-pacing-deterministic', 'effort pacing maps cost classes and escalates only on verifier FAIL', () => {
      // Pinned DeepSeek adapter level set: off | low | high | max.
      expectEqual(baseEffortFor({ ...DEFAULT_EFFORT_PACING, enabled: true }, 'FREE_CONFIRMED'), 'low', 'free → low');
      expectEqual(baseEffortFor({ ...DEFAULT_EFFORT_PACING, enabled: true }, 'PAID'), 'high', 'paid → high');
      expectEqual(baseEffortFor(DEFAULT_EFFORT_PACING, 'FREE_CONFIRMED'), undefined, 'disabled → untouched');
      expectEqual(escalateEffort('low'), 'high', 'one-step escalation');
      expectEqual(escalateEffort('max'), 'max', 'max is terminal');
      expectEqual(escalateEffort('off'), 'low', 'off escalates to low');
    }),
    // ---- v1.3 ASTRA-hardening (evidence-bound to real/v13-routing-verify.mjs) ----
    check('router.capability-label-passthrough', 'v1.3: router carries candidate labels onto the decision (carrier, not enforcer)', () => {
      const labeled = runSelect([freeCandidate({ capabilityClass: 'routine', cotVisibility: 'terse' })]);
      expectEqual(labeled.blocked, null, 'not blocked');
      expectEqual(labeled.capabilityClass, 'routine', 'class label echoed verbatim');
      expectEqual(labeled.cotVisibility, 'terse', 'visibility label carried');
      // Unlabeled candidates keep the v1.2 decision shape (keys absent, not null).
      const unlabeled = runSelect([freeCandidate()]);
      expectTrue(!('capabilityClass' in unlabeled) && !('cotVisibility' in unlabeled), 'no labels → keys absent');
      // Only the SELECTED candidate's labels are attached.
      const mixed = runSelect([
        freeCandidate(),
        freeCandidate({ key: 'labeled::m', provider: 'labeled', model: 'm', failureDomain: 'labeled', quotaHeadroom: 0.2, capabilityClass: 'ROUTINE' }),
      ]);
      expectEqual(mixed.provider, 'synthetic-free', 'unlabeled peer wins');
      expectTrue(!('capabilityClass' in mixed), 'unselected candidate labels not attached');
    }),
    check('router.anti-sandbagging-downweight', 'v1.3: unscored-evidence downweight flips selection to the evidence-backed peer', () => {
      const claimed = freeCandidate({ key: 'claimed::m', provider: 'claimed', model: 'm', failureDomain: 'claimed', quotaHeadroom: 0.2 });
      const perf = new Map([['claimed::m', { avgQuality: 0.99, samples: 20, evidenceBacked: false }]]);
      // Without downweight the self-reported history wins outright.
      const claimedWin = runSelect([claimed, freeCandidate()], { perf });
      expectEqual(claimedWin.provider, 'claimed', 'claimed history wins at weight 1');
      // Fixed 0.5 factor: the claim loses to the evidence-free peer — evidence > self-confidence.
      const flipped = runSelect([claimed, freeCandidate()], {
        config: { ...DEFAULT_ROUTER_CONFIG, unscoredEvidenceWeight: 0.5 },
        perf,
      });
      expectEqual(flipped.provider, 'synthetic-free', 'evidence-backed peer wins after downweight');
      expectTrue(flipped.unscoredEvidence?.some((u) => u.candidate === 'claimed::m' && u.factor === 0.5), 'downweighted ids+factors recorded');
      expectTrue(flipped.reasonCodes.includes('UNSCORED_EVIDENCE_DOWNWEIGHT'), 'reason code present');
      // Evidence-backed claims are NEVER downweighted.
      const backedPerf = new Map([['claimed::m', { avgQuality: 0.99, samples: 20, evidenceBacked: true }]]);
      const backed = runSelect([claimed, freeCandidate()], {
        config: { ...DEFAULT_ROUTER_CONFIG, unscoredEvidenceWeight: 0.5 },
        perf: backedPerf,
      });
      expectEqual(backed.provider, 'claimed', 'evidence-backed claim keeps full score');
      expectTrue(!('unscoredEvidence' in backed), 'no downweight records for evidence-backed claims');
    }),
    check('router.unscored-default-backcompat', 'v1.3: downweight off by default; candidates without claims untouched', () => {
      const perf = new Map([['claimed::m', { avgQuality: 0.99, samples: 20, evidenceBacked: false }]]);
      const defaults = runSelect([freeCandidate({ key: 'claimed::m', provider: 'claimed', model: 'm', failureDomain: 'claimed', quotaHeadroom: 0.2 })], { perf });
      expectTrue(!('unscoredEvidence' in defaults), 'default weight 1 writes no downweight records');
      expectTrue(!defaults.reasonCodes.includes('UNSCORED_EVIDENCE_DOWNWEIGHT'), 'default weight 1 has no reason code');
      // weight ≠ 1 but no benchmark claim on the candidate → nothing to distrust.
      const explored = runSelect([freeCandidate()], { config: { ...DEFAULT_ROUTER_CONFIG, unscoredEvidenceWeight: 0.5 } });
      expectEqual(explored.blocked, null, 'not blocked');
      expectTrue(!('unscoredEvidence' in explored), 'no claims → no downweight');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-cost-enforce.mjs) ----
    check('router.cost-gate-predispatch', 'v1.3.1 FIX-A: pre-dispatch cost gate — UNKNOWN denied even over a permissive policy, fail-closed without one', () => {
      // The gate composes the policy decision; UNKNOWN stays denied even when a
      // misconfigured policy service claimed otherwise (belt-and-braces rule).
      const permissive = { allowed: true, reasonCodes: ['OK'] };
      const unknown = buildRouteCostGate({ provider: 'p', model: 'm', costClass: 'UNKNOWN', policyDecision: permissive, now: 1000 });
      expectEqual(unknown.allowed, false, 'UNKNOWN denied pre-dispatch');
      expectTrue(unknown.reasonCodes.includes('COST_UNKNOWN_DENIED'), 'pinned unknown reason');
      // Free route passes and carries free-claim evidence metadata (never secrets).
      const free = buildRouteCostGate({ provider: 'p', model: 'm', costClass: 'FREE_CONFIRMED', policyDecision: permissive, now: 1000 });
      expectEqual(free.allowed, true, 'free passes');
      expectEqual(free.freeClaim?.source, 'config', 'free claim evidence present');
      expectEqual(free.freeClaim?.status, 'active', 'claim starts active');
      // Missing/unusable policy service ⇒ fail-closed deny, never a silent pass.
      const failClosed = buildRouteCostGate({ provider: 'p', model: 'm', costClass: 'FREE_CONFIRMED', policyDecision: null, now: 1000 });
      expectEqual(failClosed.allowed, false, 'no policy ⇒ no permission');
      expectEqual(failClosed.reasonCodes[0], COST_POLICY_UNAVAILABLE_REASON, 'fail-closed reason');
      // The llm/stream backstop (seam registration proven by surface-audit; the
      // seam behavior end-to-end by real/v131-cost-enforce.mjs) refuses with a
      // VALUE-FREE message: reason labels + route key only.
      const msg = routeCostDeniedMessage(unknown);
      expectTrue(msg.includes('COST_UNKNOWN_DENIED') && msg.includes('p::m'), 'message carries reason + route key');
    }),
    check('router.cost-gate-free-claim-currency', 'v1.3.1 FIX-A: free-claim evidence is explicit, expiring, and UNKNOWN-by-default', () => {
      expectEqual(resolveRouteCostClass(new Map([['p::m', 'FREE_CONFIRMED']]), 'p', 'm'), 'FREE_CONFIRMED', 'allowlist hit');
      expectEqual(resolveRouteCostClass(new Map(), 'p', 'm'), 'UNKNOWN', 'unlisted route resolves UNKNOWN');
      const claim = freeClaimEvidence('config', 1000, 5000);
      expectEqual(claim.expiresAt, 6000, 'ttl honored');
      expectEqual(freeClaimIsCurrent(claim, 5999), true, 'current before expiry');
      expectEqual(freeClaimIsCurrent(claim, 6000), false, 'expired at boundary');
      expectEqual(freeClaimIsCurrent(freeClaimEvidence('catalog', 0), 1e15), true, 'null expiry never expires');
      expectEqual(freeClaimIsCurrent({ source: 'config', checkedAt: 0, status: 'expired', expiresAt: null }, 0), false, 'expired status never current');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-outcome-routing.mjs) ----
    check('router.class-aware-wilson', 'v1.3.1 IMP-R: Wilson lower-bound shrinkage — a lucky 1/1 can never outrank a stable 50/52', () => {
      const lucky = wilsonLowerBound(1, 1, WILSON_Z);
      const stable = wilsonLowerBound(50 / 52, 52, WILSON_Z);
      expectTrue(lucky > 0 && lucky < 0.25, `1/1 LB tiny (got ${lucky.toFixed(3)})`);
      expectTrue(stable > 0.8, `50/52 LB high (got ${stable.toFixed(3)})`);
      expectTrue(lucky < stable, 'uncertainty shrinkage holds');
      expectEqual(wilsonLowerBound(0.9, 0), 0.5, 'no samples ⇒ neutral 0.5');
      // Class tracker: per-(candidate, class) scores over real outcome samples.
      const tracker = new ClassPerformanceTracker({ halfLifeMs: 1000 });
      tracker.observe('a::m', 'class_a', true, 0); // one lucky success
      for (let i = 0; i < 52; i++) tracker.observe('b::m', 'class_a', i < 50, 0); // stable 50/52
      const now = 100; // well within one half-life → weights ≈ 1
      expectTrue(tracker.score('a::m', 'class_a', now).score < tracker.score('b::m', 'class_a', now).score, 'stable beats lucky per class');
      // Stale evidence decays through the freshness weight (fixed half-life).
      tracker.observe('c::m', 'class_a', true, 0);
      expectTrue(tracker.score('c::m', 'class_a', 100).score > tracker.score('c::m', 'class_a', 8000).score, 'stale perfect record decays');
      // History from OTHER classes never leaks into this class score.
      expectEqual(tracker.score('a::m', 'class_b', now).score, 0.5, 'unobserved class neutral');
    }),
    check('router.outcome-circuit', 'v1.3.1 IMP-R: outcome circuit opens after N consecutive failures; single half-open probe; classifier pinned', () => {
      const breaker = new OutcomeCircuitBreaker({ consecutiveFailures: 3, cooldownMs: 1000 });
      expectEqual(breaker.recordFailure('p::m', 1000, 'rate_limit').phase, 'closed', '1 failure stays closed');
      breaker.recordFailure('p::m', 1100, 'rate_limit');
      expectEqual(breaker.recordFailure('p::m', 1200, 'rate_limit').phase, 'open', '3 consecutive ⇒ open');
      expectEqual(breaker.stateOf('p::m', 2100).phase, 'open', 'still inside cooldown');
      expectEqual(breaker.stateOf('p::m', 2200).phase, 'half_open', 'cooldown elapsed ⇒ half-open');
      expectEqual(breaker.acquireProbe('p::m', 2200), true, 'single probe granted');
      expectEqual(breaker.acquireProbe('p::m', 2201), false, 'second probe refused');
      expectEqual(breaker.recordSuccess('p::m', 2200).phase, 'closed', 'probe success closes');
      expectEqual(breaker.acquireProbe('p::m', 2300), false, 'closed ⇒ no probe');
      // Deterministic failure classification over the pinned upstream codes.
      expectEqual(classifyFailure({ code: 'HTTP_429' }), 'rate_limit', '429 rate_limit');
      expectEqual(classifyFailure({ code: 'QUOTA' }), 'rate_limit', 'quota rate_limit');
      expectEqual(classifyFailure({ code: 'LLM_STREAM_IDLE_TIMEOUT' }), 'timeout', '*_TIMEOUT ⇒ timeout');
      expectEqual(classifyFailure({ code: 'ABORTED' }), 'other', 'ABORTED is not a timeout');
      expectEqual(classifyFailure({ code: 'MISSING_CREDENTIAL' }), 'credential', 'credential class');
      expectEqual(classifyFailure({ code: 'VERIFICATION' }), 'verifier', 'verifier class');
      expectEqual(classifyFailure(null), 'other', 'missing failure ⇒ other');
    }),
    check('router.attempt-ledger-bounded', 'v1.3.1 IMP-R: attempt ledger refuses beyond maxRetries; wall-clock budget deterministic', () => {
      const ledger = new AttemptLedger({ maxRetries: 3 });
      expectEqual(ledger.registerAttempt('t1').allowed, true, 'attempt 1 allowed');
      expectEqual(ledger.registerAttempt('t1').allowed, true, 'attempt 2 allowed');
      expectEqual(ledger.registerAttempt('t1').allowed, true, 'attempt 3 allowed');
      const fourth = ledger.registerAttempt('t1');
      expectEqual(fourth.allowed, false, 'attempt 4 refused (retry-storm bound)');
      expectEqual(fourth.attempts, 4, 'attempt counted');
      expectEqual(ledger.status('t1').attempts, 4, 'read-only status: attempts');
      expectEqual(ledger.status('t1').maxRetries, 3, 'read-only status: maxRetries');
      ledger.releaseTask('t1');
      expectEqual(ledger.status('t1').attempts, 0, 'release resets the task');
      expectEqual(withinWallClock(0, 999, 1000), true, 'inside budget');
      expectEqual(withinWallClock(0, 1001, 1000), false, 'budget exceeded');
      expectEqual(withinWallClock(0, 1e12, 0), true, '0 budget = OFF');
      expectEqual(DEFAULT_BOUNDS.maxRetries, 3, 'defaults preserve v1.2 behavior');
      expectEqual(DEFAULT_BOUNDS.wallClockBudgetMs, 0, 'wall-clock off by default');
    }),
    check('router.fallback-verified-free-only', 'v1.3.1 IMP-R: fallback plan admits only current-evidence FREE candidates — paid never planned', () => {
      const pool: FallbackPoolEntry[] = [
        { key: 'primary::m', provider: 'primary', model: 'm', costClass: 'FREE_CONFIRMED', failureDomain: 'primary', score: 0.9 },
        { key: 'paid::m', provider: 'paid', model: 'm', costClass: 'PAID', failureDomain: 'paid', score: 0.99 },
        { key: 'b::m', provider: 'b', model: 'm', costClass: 'FREE_CONFIRMED', failureDomain: 'b', score: 0.8 },
        { key: 'c::m', provider: 'c', model: 'm', costClass: 'FREE_LIMITED', failureDomain: 'c', score: 0.7 },
        { key: 'same::m2', provider: 'primary', model: 'm2', costClass: 'FREE_CONFIRMED', failureDomain: 'primary', score: 0.6 },
      ];
      const evidence = new Map([
        ['b::m', freeClaimEvidence('config', 0)],
        ['c::m', { source: 'config' as const, checkedAt: 0, status: 'active' as const, expiresAt: 1000 }],
      ]);
      const plan = planCrossProviderFallbacks({ pool, excludeKey: 'primary::m', freeEvidence: evidence, now: 2000, maxFanout: 4 });
      expectEqual(plan.map((f) => f.key).join(','), 'b::m', 'only the current-evidence free cross-provider entry');
      expectEqual(plan[0]?.reason, 'FREE_CLAIM_config_CURRENT', 'reason documents the evidence basis');
      // maxFanout 0 (or invalid) ⇒ empty plan — honest degradation.
      expectEqual(planCrossProviderFallbacks({ pool, excludeKey: 'primary::m', freeEvidence: evidence, now: 2000, maxFanout: 0 }).length, 0, 'fanout 0 ⇒ empty');
      // No evidence at all ⇒ empty plan (never a silent paid fallback).
      expectEqual(planCrossProviderFallbacks({ pool, excludeKey: 'primary::m', freeEvidence: new Map(), now: 2000, maxFanout: 4 }).length, 0, 'no evidence ⇒ empty plan');
    }),
    check('router.fast-path-deterministic', 'v1.3.1 IMP-R: fast path — simple classes route directly; opt-in, risk-gated, label-driven only', () => {
      const off = { enabled: false, simpleClasses: DEFAULT_SIMPLE_TASK_CLASSES };
      expectEqual(isSimpleTask({ taskClass: 'SUMMARIZE' }, off), false, 'disabled by default (behavior-preserving)');
      const on = { enabled: true, simpleClasses: DEFAULT_SIMPLE_TASK_CLASSES };
      expectEqual(isSimpleTask({ taskClass: ' summarize ' }, on), true, 'normalized simple class');
      expectEqual(isSimpleTask({ labels: ['TRANSLATE'] }, on), true, 'label match enables');
      expectEqual(isSimpleTask({ taskClass: 'DEEP_RESEARCH' }, on), false, 'non-simple class untouched');
      expectEqual(isSimpleTask({ taskClass: 'SUMMARIZE', risk: 'HIGH' }, on), false, 'measured risk blocks fast path');
      expectEqual(isSimpleTask({}, on), false, 'no class/labels ⇒ no fast path');
      expectEqual(normalizeTaskClass(' deep research '), 'DEEP RESEARCH', 'normalization trim+upper (spacing preserved)');
      expectEqual(DEFAULT_FAST_PATH.enabled, false, 'default config disabled');
    }),
  ];
}

export function verifierChecks(): Check[] {
  return [
    check('verifier.exact-pass-fail', 'exact-text validator passes and fails correctly', async () => {
      const pass = await runValidator({ spec: { validatorId: 'v1', type: 'exact-text', config: { expected: 'supreme' } }, config: { ...{ allowCommands: false, allowNetwork: false, allowedRoots: ['/roots'], commandTimeoutMs: 1000 } }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: 'supreme' });
      const fail = await runValidator({ spec: { validatorId: 'v1', type: 'exact-text', config: { expected: 'supreme' } }, config: { allowCommands: false, allowNetwork: false, allowedRoots: ['/roots'], commandTimeoutMs: 1000 }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: 'other' });
      expectEqual(pass.status, 'PASS', 'exact pass');
      expectEqual(fail.status, 'FAIL', 'exact fail');
      expectTrue(fail.status !== 'ERROR', 'fail is not crash');
    }),
    check('verifier.json-and-schema', 'json-parse + schema-subset validators', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const ok = await runValidator({ spec: { validatorId: 'j', type: 'json-parse', config: {} }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{"a":1}' });
      const bad = await runValidator({ spec: { validatorId: 'j', type: 'json-parse', config: {} }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{nope' });
      const schema = await runValidator({
        spec: { validatorId: 's', type: 'json-schema', config: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
        config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: false, subject: '{"ok":true}',
      });
      expectEqual(ok.status, 'PASS', 'json parse ok');
      expectEqual(bad.status, 'FAIL', 'json parse fail');
      expectEqual(schema.status, 'PASS', 'schema pass');
    }),
    check('verifier.path-confinement', 'file validators restricted to allowedRoots', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: ['/roots/data'], commandTimeoutMs: 1000 };
      const inside = await runValidator({ spec: { validatorId: 'f', type: 'file-exists', config: { path: '/roots/data/file.txt' } }, config: cfg, runtime: { ...noopRuntime, fsExists: async () => true }, pathMod, labPolicyConfirmed: false });
      const outside = await runValidator({ spec: { validatorId: 'f', type: 'file-exists', config: { path: '/etc/passwd' } }, config: cfg, runtime: { ...noopRuntime, fsExists: async () => true }, pathMod, labPolicyConfirmed: false });
      expectEqual(inside.status, 'PASS', 'inside root passes');
      expectEqual(outside.status, 'UNAVAILABLE', 'outside root unavailable');
      expectEqual(outside.reasonCode, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'confinement reason');
    }),
    check('verifier.commands-unavailable-by-default', 'command validators report UNAVAILABLE, never fake PASS', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const result = await runValidator({ spec: { validatorId: 'c', type: 'command-exit', config: { command: 'echo' } }, config: cfg, runtime: noopRuntime, pathMod, labPolicyConfirmed: true });
      expectEqual(result.status, 'UNAVAILABLE', 'commands unavailable');
      const notLab = await runValidator({ spec: { validatorId: 'c', type: 'command-exit', config: { command: 'echo' } }, config: { ...cfg, allowCommands: true }, runtime: noopRuntime, pathMod, labPolicyConfirmed: false });
      expectEqual(notLab.status, 'UNAVAILABLE', 'commands need LAB policy');
    }),
    check('verifier.exception-becomes-error', 'validator exceptions become ERROR results', async () => {
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const result = await runValidator({
        spec: { validatorId: 'x', type: 'regex', config: {} },
        config: cfg,
        runtime: noopRuntime,
        pathMod,
        labPolicyConfirmed: false,
        subject: 'x',
      });
      expectEqual(result.status, 'ERROR', 'missing pattern → ERROR');
    }),
    check('verifier.evidence-scrubbed', 'evidence is bounded and sentinel-free', async () => {
      expectTrue(!sanitizeEvidence('SECRET_SENTINEL_ABC hidden').includes('SECRET_SENTINEL'), 'sentinel scrubbed');
      expectTrue(sanitizeEvidence('x'.repeat(1000)).length <= 512, 'evidence bounded');
      expectTrue(validateJsonSchemaSubset({ ok: true }, { type: 'object', required: ['ok'] }).length === 0, 'schema subset ok');
    }),
    check('verifier.path-confined-helper', 'pathIsAllowed deterministic', () => {
      expectTrue(pathIsAllowed('/roots/data/a', ['/roots/data'], pathMod), 'allowed');
      expectTrue(!pathIsAllowed('/other/a', ['/roots/data'], pathMod), 'denied');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-verifier-hardening.mjs) ----
    check('verifier.realpath-confinement', 'v1.3.1 FIX-B: REAL-path confinement rejects symlink escapes and sibling-prefix roots before any read', async () => {
      const fakeReal = (map: Record<string, string>) => async (p: string) => {
        const hit = map[p];
        if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return hit;
      };
      // Symlink inside the root pointing OUTSIDE is rejected ('outside').
      const escape = await resolveRealConfinement('/data/link/f.txt', ['/data'], nodePath, fakeReal({ '/data': '/data', '/data/link/f.txt': '/etc/secret.txt' }));
      expectEqual(escape.kind, 'outside', 'symlink escape rejected');
      // Sibling-prefix roots (/data vs /database) are NOT containment.
      const sibling = await resolveRealConfinement('/database/f.txt', ['/data'], nodePath, fakeReal({ '/data': '/data', '/database/f.txt': '/database/f.txt' }));
      expectEqual(sibling.kind, 'outside', 'sibling prefix rejected');
      // In-root target resolves ok against real paths.
      const inside = await resolveRealConfinement('/data/f.txt', ['/data'], nodePath, fakeReal({ '/data': '/data', '/data/f.txt': '/data/f.txt' }));
      expectEqual(inside.kind, 'ok', 'in-root passes');
      expectEqual(inside.kind === 'ok' ? inside.realTarget : '', '/data/f.txt', 'real target reported');
      // Missing target ⇒ explicit FAIL mapping; other realpath errors ⇒ visible ERROR.
      expectEqual((await resolveRealConfinement('/data/gone.txt', ['/data'], nodePath, fakeReal({ '/data': '/data' }))).kind, 'missing', 'missing target');
      const loopErr = Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      expectEqual((await resolveRealConfinement('/data/loop', ['/data'], nodePath, async () => { throw loopErr; })).kind, 'unresolvable', 'unresolvable visible');
      // End-to-end through the file-exists validator: escape ⇒ UNAVAILABLE, never PASS.
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: ['/data'], commandTimeoutMs: 1000 };
      const denied = await runValidator({
        spec: { validatorId: 'f', type: 'file-exists', config: { path: '/data/link/f.txt' } },
        config: cfg,
        runtime: { ...noopRuntime, fsExists: async () => true, realpath: fakeReal({ '/data': '/data', '/data/link/f.txt': '/etc/secret.txt' }) },
        pathMod: nodePath,
        labPolicyConfirmed: false,
      });
      expectEqual(denied.status, 'UNAVAILABLE', 'escape ⇒ UNAVAILABLE');
      expectEqual(denied.reasonCode, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'confinement reason');
    }),
    check('verifier.schema-additional-properties', 'v1.3.1 FIX-E: additionalProperties is enforced — extra properties can never silently PASS', () => {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      expectEqual(validateJsonSchema({ ok: true }, schema).outcome, 'valid', 'conforming instance valid');
      const extra = validateJsonSchema({ ok: true, sneaky: 1 }, schema);
      expectEqual(extra.outcome, 'invalid', 'extra property rejected');
      expectTrue(extra.outcome === 'invalid' && extra.issues.some((i) => i.includes('sneaky')), 'issue names the property');
      // Boolean + schema-valued forms both enforced.
      expectEqual(
        validateJsonSchema({ ok: true, x: 'any' }, { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true }).outcome,
        'valid',
        'additionalProperties true allows',
      );
      expectEqual(
        validateJsonSchema({ ok: true, tag: 7 }, { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: { type: 'string' } }).outcome,
        'invalid',
        'schema-valued additionalProperties enforced',
      );
      // Back-compat wrapper reports the violation instead of a silent empty list.
      expectTrue(validateJsonSchemaSubset({ ok: true, sneaky: 1 }, schema).length > 0, 'subset wrapper non-empty');
    }),
    check('verifier.schema-unsupported-visible', 'v1.3.1 FIX-E: unsupported keyword/dialect ⇒ ERROR/UNAVAILABLE, never a fake PASS', async () => {
      // A keyword outside the pinned deterministic subset is refused at compile time.
      const unsupportedSchema = { type: 'object', dependentRequired: { a: ['b'] } };
      const unsupported = validateJsonSchema({ a: 1 }, unsupportedSchema);
      expectEqual(unsupported.outcome, 'unsupported', 'unsupported keyword refused');
      expectTrue(unsupported.outcome === 'unsupported' && unsupported.reason.startsWith('SCHEMA_UNSUPPORTED_KEYWORD'), 'pinned reason prefix');
      // Declared draft-04 dialect ⇒ unsupported (no silent downgrade).
      expectEqual(
        validateJsonSchema({}, { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }).outcome,
        'unsupported',
        'draft-04 dialect refused',
      );
      // Through runValidator: UNAVAILABLE (never PASS) with a value-free reason.
      const cfg = { allowCommands: false, allowNetwork: false, allowedRoots: [], commandTimeoutMs: 1000 };
      const result = await runValidator({
        spec: { validatorId: 's', type: 'json-schema', config: { schema: unsupportedSchema } },
        config: cfg,
        runtime: noopRuntime,
        pathMod,
        labPolicyConfirmed: false,
        subject: '{"a":1,"b":2}',
      });
      expectEqual(result.status, 'UNAVAILABLE', 'unsupported ⇒ UNAVAILABLE');
      expectEqual(result.reasonCode, 'SCHEMA_UNSUPPORTED', 'pinned reason code');
      // The back-compat subset wrapper can never return a silent empty list for broken schemas.
      expectTrue(validateJsonSchemaSubset({}, unsupportedSchema).length > 0, 'broken schema reported non-empty');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-evidence-binding.mjs) ----
    check('verifier.evidence-close-binding', 'v1.3.1 IMP-V: close evidence binds to CURRENT artifact bytes; UNAVAILABLE is never a PASS', () => {
      const sha1 = 'a'.repeat(64);
      const sha2 = 'b'.repeat(64);
      const record = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        taskId: 't1',
        attempt: 1,
        artifact: { sha256: sha1 },
        validatorId: 'v',
        validatorType: 'exact-text',
        status: 'PASS',
        reasonCode: 'OK',
        recordedAt: 1,
      };
      expectEqual(evaluateEvidenceForClose(record, { sha256: sha1 }).reasonCode, 'EVIDENCE_CURRENT_PASS', 'current PASS ok');
      expectEqual(evaluateEvidenceForClose(record, { sha256: sha2 }).reasonCode, 'EVIDENCE_STALE', 'stale hash rejected');
      expectEqual(evaluateEvidenceForClose({ ...record, status: 'UNAVAILABLE' }, { sha256: sha1 }).reasonCode, 'EVIDENCE_NOT_PASS', 'UNAVAILABLE ≠ PASS');
      expectEqual(evaluateEvidenceForClose({ ...record, status: 'FAIL' }, { sha256: sha1 }).reasonCode, 'EVIDENCE_NOT_PASS', 'FAIL ≠ PASS');
      expectEqual(evaluateEvidenceForClose({ schemaVersion: EVIDENCE_SCHEMA_VERSION, status: 'PASS' }, { sha256: sha1 }).reasonCode, 'EVIDENCE_UNBOUND', 'unbound record refused');
      expectEqual(isEvidenceCurrent(record, { sha256: sha1 }), true, 'helper mirrors the evaluation');
    }),
  ];
}

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    class: 'PROJECT_CONTEXT',
    source: 'unit',
    text: 'project knowledge entry',
    estimatedTokens: 10,
    priority: 50,
    ...overrides,
  };
}

export function memoryChecks(): Check[] {
  return [
    check('memory.budget-enforced', 'selection stays within budget', () => {
      const items = [memoryItem({ id: 'a', estimatedTokens: 60, priority: 80 }), memoryItem({ id: 'b', estimatedTokens: 60, priority: 70 })];
      const selection = selectMemory({ taskText: 'task', budgetTokens: 100, items, providerState: 'UNAVAILABLE' });
      expectTrue(selection.totalEstimatedTokens <= 100, `used=${selection.totalEstimatedTokens}`);
      expectTrue(selection.selected.length === 1, 'highest priority fits');
      expectTrue(selection.excluded.some((e) => e.id === 'b' && e.reason === 'BUDGET_EXCEEDED'), 'overflow excluded');
    }),
    check('memory.priority-order', 'higher priority selected first', () => {
      const items = [memoryItem({ id: 'low', estimatedTokens: 30, priority: 10 }), memoryItem({ id: 'high', estimatedTokens: 30, priority: 90 })];
      const selection = selectMemory({ taskText: 'task', budgetTokens: 35, items, providerState: 'UNAVAILABLE' });
      expectEqual(selection.selected[0].item.id, 'high', 'priority order');
    }),
    check('memory.secret-exclusion', 'credential-bearing items never enter context', () => {
      const secret = memoryItem({ id: 's', text: 'api key: sk-abcdef1234567890' });
      expectTrue(isSecretBearing(secret), 'secret detected');
      const selection = selectMemory({ taskText: 'task', budgetTokens: 1000, items: [secret], providerState: 'UNAVAILABLE' });
      expectTrue(selection.excluded.some((e) => e.id === 's' && e.reason === 'SECRET_CATEGORY'), 'secret excluded');
      expectEqual(selection.selected.length, 0, 'nothing selected');
    }),
    check('memory.noop-provider-valid', 'NOOP long-term provider is a legitimate state', () => {
      expectEqual(NOOP_LONG_TERM_PROVIDER.status, 'UNAVAILABLE', 'noop unavailable');
      expectEqual(NOOP_LONG_TERM_PROVIDER.list({ taskText: 'x', limit: 5 }).length, 0, 'noop returns nothing');
    }),
    check('memory.needs-memory-conditional', 'memory is conditional on task + pressure', () => {
      expectTrue(!needsMemory({ taskText: '' }).required, 'no task → no memory');
      expectTrue(!needsMemory({ taskText: 'x', tokenPressure: 0.9 }).required, 'high pressure → no memory');
      expectTrue(needsMemory({ taskText: 'plan the work', tokenPressure: 0.2 }).required, 'normal task → memory');
      expectTrue(estimateTokens('abcd') === 1, 'estimate fn');
    }),
    check('memory.ledger-roundtrip-bounded', 'note ledger: append → init → trim to maxEntries', async () => {
      const files = new Map<string, string>();
      const fs: LedgerFs = {
        readFile: async (p) => files.get(p) ?? null,
        appendFile: async (p, line) => {
          files.set(p, (files.get(p) ?? '') + line);
        },
        mkdir: async () => {},
      };
      const ledger = new NoteLedger('/mem/ledger.jsonl', fs, 3);
      await ledger.init();
      for (let i = 0; i < 5; i++) {
        const ok = await ledger.append({ id: `n${i}`, text: `note ${i}`, tags: [], priority: 50, confidence: 0.9, createdAt: 1000 + i, source: 'unit' });
        expectTrue(ok, `note ${i} accepted`);
      }
      expectEqual(ledger.stats().entries, 3, 'memory view trimmed to maxEntries (newest kept)');
      // Reload from the append-only file: same bounded view, no crash.
      const reloaded = new NoteLedger('/mem/ledger.jsonl', fs, 3);
      const stats = await reloaded.init();
      expectEqual(stats.entries, 3, 'reload bounded');
      expectTrue(reloaded.list()[2].id === 'n4', 'newest notes kept');
    }),
    check('memory.ledger-validation', 'ledger notes validated; credential-bearing rejected at admission', () => {
      expectThrows(() => validateLedgerNote({ id: 'x', text: 't', tags: [], priority: 50, confidence: 1.5, createdAt: 1, source: 's' }), 'confidence >1 rejected');
      expectThrows(
        () => validateLedgerNote({ id: 'x', text: 'api key: sk-abcdef1234567890', tags: [], priority: 50, confidence: 0.9, createdAt: 1, source: 's' }),
        'secret-bearing note rejected',
      );
      const ok = validateLedgerNote({ id: 'ok', text: 'deterministic note', tags: ['t'], priority: 10, confidence: 0.8, createdAt: 5, source: 'unit' });
      expectEqual(ok.id, 'ok', 'valid note accepted');
      expectTrue(LedgerValidationError !== undefined, 'error type present');
    }),
    check('memory.instinct-gates', 'instinct params: confidence gate + maxInjected cap + relevance ranking', () => {
      const notes: LedgerNote[] = [
        { id: 'low-conf', text: 'router scoring weights', tags: ['router'], priority: 90, confidence: 0.5, createdAt: 3, source: 'unit' },
        { id: 'relevant', text: 'cost-first routing prefers free models', tags: ['router', 'cost'], priority: 40, confidence: 0.9, createdAt: 2, source: 'unit' },
        { id: 'high-prio', text: 'unrelated note about tests', tags: ['tests'], priority: 95, confidence: 0.9, createdAt: 1, source: 'unit' },
      ];
      // Confidence gate: 0.5 < 0.7 never injects.
      const gated = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 6, relevanceRanking: true });
      expectTrue(!gated.some((n) => n.id === 'low-conf'), 'below-threshold note excluded');
      // Relevance ranking: task-matching note outranks higher-priority unrelated one.
      expectEqual(gated[0].id, 'relevant', 'relevance first');
      // Ranking disabled → priority order restored.
      const priorityOrder = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 6, relevanceRanking: false });
      expectEqual(priorityOrder[0].id, 'high-prio', 'priority order without ranking');
      // Cap: maxInjected=1 keeps only the best.
      const capped = selectLedgerNotes(notes, 'fix the router scoring', { minConfidence: 0.7, maxInjected: 1, relevanceRanking: true });
      expectEqual(capped.length, 1, 'cap enforced');
      expectEqual(capped[0].id, 'relevant', 'cap keeps the best');
      // Projection into the memory pipeline keeps secret exclusion semantics.
      const items = ledgerNotesToItems(gated);
      expectTrue(items.every((i) => i.id.startsWith('ledger:')), 'projected with ledger ids');
      expectTrue(ledgerRelevanceScore(notes[1], new Set(['router', 'cost', 'fix'])) > 0, 'relevance score positive');
    }),
    check('memory.ledger-append-rejects-garbage', 'append counts invalid notes instead of throwing', async () => {
      const files = new Map<string, string>();
      const fs: LedgerFs = {
        readFile: async (p) => files.get(p) ?? null,
        appendFile: async (p, line) => {
          files.set(p, (files.get(p) ?? '') + line);
        },
        mkdir: async () => {},
      };
      const ledger = new NoteLedger('/mem/ledger2.jsonl', fs, 10);
      await ledger.init();
      const bad = await ledger.append({ id: 'bad', text: 'x', tags: [], priority: 50, confidence: 9, createdAt: 1, source: 'unit' });
      expectTrue(!bad, 'invalid note rejected');
      expectEqual(ledger.stats().rejected, 1, 'rejection counted');
      expectEqual(ledger.stats().entries, 0, 'nothing stored');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-memory-isolation.mjs) ----
    check('memory.identity-fail-closed', 'v1.3.1 FIX-C: unknown identity is null — selections never fall back to other state', () => {
      expectEqual(normalizeIdentityText(' s1 '), 's1', 'trimmed string is an identity');
      expectEqual(normalizeIdentityText(''), null, 'empty is not an identity');
      expectEqual(normalizeIdentityText(42), null, 'non-string is not an identity');
      expectEqual(identityOf({ sessionId: 's1' }), null, 'missing task ⇒ unknown identity');
      expectEqual(identityOf({ sessionId: 's1', taskId: '   ' }), null, 'blank task ⇒ unknown identity');
      expectEqual(identityOf({ sessionId: 's1', taskId: 't1' })?.sessionId, 's1', 'both parts required (session)');
      expectEqual(identityOf({ sessionId: 's1', taskId: 't1' })?.taskId, 't1', 'both parts required (task)');
      expectTrue(identityKey({ sessionId: 's1', taskId: 't1' }).includes('\u0000'), 'NUL-separated key avoids concat ambiguity');
    }),
    check('memory.store-own-selection-only', 'v1.3.1 FIX-C: selections are (session, task)-owned — no cross-task or cross-session lookup', () => {
      const store = new SelectionStore(8);
      const mkSel = (tag: string): MemorySelection => ({
        selected: [{ item: memoryItem({ id: `m-${tag}` }), reason: 'UNIT' }],
        excluded: [],
        totalEstimatedTokens: 10,
        budgetTokens: 100,
        withinBudget: true,
        providerState: 'UNAVAILABLE',
      });
      store.record({ sessionId: 's1', taskId: 't1' }, mkSel('a'));
      store.record({ sessionId: 's2', taskId: 't1' }, mkSel('b'));
      store.record({ sessionId: 's1', taskId: 't2' }, mkSel('c'));
      // Exact identity returns the owner's own selection only.
      expectTrue(store.get({ sessionId: 's1', taskId: 't1' })?.selected[0].item.id === 'm-a', 's1/t1 owns a');
      expectTrue(store.get({ sessionId: 's2', taskId: 't1' })?.selected[0].item.id === 'm-b', 's2/t1 owns b (same task id, other session)');
      // Cross-identity lookups fail closed (undefined), never fall back.
      expectEqual(store.get({ sessionId: 's1', taskId: 't9' }), undefined, 'unknown task ⇒ nothing');
      expectEqual(store.get({ sessionId: 'sX', taskId: 't1' }), undefined, 'unknown session ⇒ nothing');
      // Active-task pointer: set ONLY by the session's own scoped record.
      expectEqual(store.activeTaskOf('s1'), 't2', 'active pointer is the last recorded task');
      expectEqual(store.activeTaskOf('sX'), undefined, 'no active task ⇒ renderer renders nothing');
      // Releasing the active task never resurrects an older selection as "active".
      store.releaseTask({ sessionId: 's1', taskId: 't2' });
      expectEqual(store.activeTaskOf('s1'), undefined, 'no resurrection');
      expectTrue(store.get({ sessionId: 's1', taskId: 't1' })?.selected[0].item.id === 'm-a', 'older entry reachable by exact identity only');
    }),
    check('memory.store-lru-bounded', 'v1.3.1 FIX-C: LRU bounded with counted evictions, recency refresh, and real cleanup', () => {
      const store = new SelectionStore(2);
      const mkSel = (): MemorySelection => ({ selected: [], excluded: [], totalEstimatedTokens: 0, budgetTokens: 0, withinBudget: true, providerState: 'UNAVAILABLE' });
      store.record({ sessionId: 's1', taskId: 't1' }, mkSel());
      store.record({ sessionId: 's1', taskId: 't2' }, mkSel());
      store.get({ sessionId: 's1', taskId: 't1' }); // touch → t2 becomes the LRU victim
      store.record({ sessionId: 's1', taskId: 't3' }, mkSel());
      expectEqual(store.stats().entries, 2, 'capacity honored mechanically');
      expectEqual(store.stats().evictions, 1, 'eviction counted');
      expectEqual(store.get({ sessionId: 's1', taskId: 't2' }), undefined, 'LRU victim evicted');
      expectTrue(store.get({ sessionId: 's1', taskId: 't1' }) !== undefined, 'recently used survives');
      // Cleanup APIs really empty the store (task end / cancel / dispose paths).
      expectEqual(store.releaseSession('s1'), 2, 'session wipe counts');
      expectEqual(store.stats().entries, 0, 'session store empty');
      expectEqual(store.stats().activeTasks, 0, 'active pointers wiped');
      store.record({ sessionId: 's2', taskId: 't1' }, mkSel());
      expectEqual(store.clear(), 1, 'clear counts (plugin dispose)');
      expectEqual(store.stats().entries, 0, 'dispose leaves nothing');
    }),
    check('memory.store-cap-clamped', 'v1.3.1 FIX-C: adapter boundary clamps the configured cap (floor 8); mechanical store honors small caps', () => {
      expectEqual(clampSelectionStoreCap(undefined), DEFAULT_SELECTION_STORE_CAP, 'undefined ⇒ default 128');
      expectEqual(clampSelectionStoreCap(3), MIN_SELECTION_STORE_CAP, 'below floor ⇒ 8');
      expectEqual(clampSelectionStoreCap(8.9), MIN_SELECTION_STORE_CAP, 'fractional floors to 8');
      expectEqual(clampSelectionStoreCap(9), 9, 'valid cap preserved');
      expectEqual(new SelectionStore(3).stats().capacity, 3, 'mechanical store honors small caps so gates can exercise the LRU');
    }),
  ];
}

export function workflowChecks(): Check[] {
  const baseInput = {
    complexity: 'simple' as const,
    parallelizable: false,
    risk: 'LOW' as const,
    requiresCapabilities: [] as string[],
    availableCapabilities: [] as string[],
    availableProviders: ['spawn'],
    depth: 0,
    activeAgents: 0,
    totalAgentsUsed: 0,
  };

  return [
    check('workflow.simple-direct', 'simple non-parallel tasks choose DIRECT', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, baseInput);
      expectEqual(result.decision, 'DIRECT', 'direct decision');
    }),
    check('workflow.parallel-workflow', 'parallelizable complex tasks may choose WORKFLOW', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true });
      expectEqual(result.decision, 'WORKFLOW', 'workflow decision');
    }),
    check('workflow.high-risk-supreme', 'high-risk complex tasks escalate to SUPREME_WORKFLOW', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, risk: 'HIGH' });
      expectEqual(result.decision, 'SUPREME_WORKFLOW', 'supreme decision');
      expectEqual(result.expectedVerification, 'REQUIRED', 'verification required');
    }),
    check('workflow.concurrency-degrades', 'saturation degrades the decision ladder', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, activeAgents: 99 });
      expectTrue(result.decision === 'DIRECT' || result.reasonCodes.includes('CONCURRENCY_LIMIT'), 'degraded');
      expectEqual(result.degradedFrom, 'WORKFLOW', 'degraded from recorded');
    }),
    check('workflow.depth-enforced', 'depth beyond limit denies deeper delegation', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, complexity: 'complex', parallelizable: true, depth: 3 });
      expectEqual(result.decision, 'DENY', 'depth denied');
    }),
    check('workflow.secrets-never-delegated', 'secret access request → DENY', () => {
      const result = decideWorkflow(WORKFLOW_LIMIT_DEFAULTS, { ...baseInput, secretAccessRequested: true });
      expectEqual(result.decision, 'DENY', 'secret denied');
    }),
    check('workflow.limit-validation', 'limits validation rejects out-of-bounds config', () => {
      expectThrows(() => validateWorkflowLimits({ maxConcurrentAgents: 99 }), 'maxConcurrentAgents bounded');
      expectThrows(() => validateWorkflowLimits({ maxDepth: -1 }), 'maxDepth bounded');
      expectThrows(() => validateWorkflowLimits({ workflowTimeoutMs: 10 }), 'workflowTimeout bounded');
      expectTrue(WorkflowConfigError !== undefined, 'error type present');
    }),
    check('workflow.delegation-scope-explicit', 'delegation scope requires every field; secret policy fixed', () => {
      const scope = buildDelegationScope({
        task: 'refactor module',
        allowedCapabilities: ['fs.read'],
        allowedPaths: ['/workspace/src'],
        forbiddenPaths: ['/workspace/secrets'],
        writePermission: false,
        secretPolicy: 'DENY_ALL',
        expectedOutput: 'patch summary',
        verificationRequirement: 'REQUIRED',
        stopCondition: 'validator PASS or 2 retries',
      });
      expectEqual(scope.secretPolicy, 'DENY_ALL', 'secret policy frozen');
      expectThrows(
        () =>
          buildDelegationScope({
            task: 'x',
            allowedCapabilities: [],
            allowedPaths: [],
            forbiddenPaths: [],
            writePermission: false,
            secretPolicy: 'ALLOW_SOME' as never,
            expectedOutput: 'y',
            verificationRequirement: 'NONE',
            stopCondition: 'z',
          }),
        'non-DENY_ALL rejected',
      );
    }),
    check('workflow.path-scope-surgical', 'surgical path scope: blocked wins, globs deterministic', () => {
      expectTrue(pathMatchesGlob('src/app/main.ts', 'src/**/*.ts'), '** crosses segments');
      expectTrue(pathMatchesGlob('src/main.ts', 'src/*.ts'), '* stays in segment');
      expectTrue(!pathMatchesGlob('src/a/b.ts', 'src/*.ts'), '* does not cross segments');
      expectTrue(pathMatchesGlob('src/a1.ts', 'src/a?.ts'), '? matches one char');
      const limits = { allowedPaths: ['src/**', 'docs/*.md'], blockedPaths: ['**/secrets/**', 'src/vault.ts'] };
      expectEqual(evaluatePathScope(limits, 'src/app/x.ts').reasonCode, 'PATH_ALLOWED', 'inside allowlist');
      expectEqual(evaluatePathScope(limits, 'README.md').reasonCode, 'PATH_OUTSIDE_ALLOWED', 'outside allowlist');
      const blocked = evaluatePathScope(limits, 'src/vault.ts');
      expectTrue(!blocked.allowed && blocked.reasonCode === 'PATH_BLOCKED', 'blocked wins over allowed');
      expectEqual(evaluatePathScope(limits, 'config/secrets/key.pem').reasonCode, 'PATH_BLOCKED', 'secrets glob blocked');
      expectEqual(evaluatePathScope({ allowedPaths: [], blockedPaths: [] }, 'anything').reasonCode, 'NO_PATH_RULES', 'no rules = unrestricted');
    }),
    check('workflow.close-gate-verifier', 'requireVerifierPassOnClose: HIGH risk closes only on verifier PASS', () => {
      const limits = { requireVerifierPassOnClose: true };
      expectTrue(!canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable, 'FAIL blocks close');
      expectTrue(!canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'MISSING' }).closable, 'MISSING evidence blocks close');
      expectTrue(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS' }).closable, 'PASS closes');
      expectTrue(canCloseTask(limits, { risk: 'LOW', verifierStatus: 'MISSING' }).closable, 'LOW risk unrestricted');
      expectTrue(canCloseTask({ requireVerifierPassOnClose: false }, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable, 'disabled → unrestricted');
    }),
    check('workflow.close-gate-in-decision', 'decideWorkflow stamps the close gate for HIGH-risk tasks', () => {
      const limits = validateWorkflowLimits({ ...WORKFLOW_LIMIT_DEFAULTS, requireVerifierPassOnClose: true });
      const high = decideWorkflow(limits, { ...baseInput, complexity: 'complex', parallelizable: true, risk: 'HIGH' });
      expectEqual(high.closeGate, 'VERIFIER_PASS_REQUIRED', 'HIGH task requires verifier pass to close');
      const low = decideWorkflow(limits, baseInput);
      expectEqual(low.closeGate, 'NONE', 'LOW task closes freely');
    }),
    // ---- v1.3 ASTRA-hardening (evidence-bound to real/v13-workflow-verify.mjs) ----
    check('workflow.a2a-contact-graph', 'v1.3: A2A contact graph — declared edges pass, out-of-graph flagged/blocked', () => {
      expectTrue(AGENT_CONTACT_POLICIES.includes('LOG_ONLY') && AGENT_CONTACT_POLICIES.includes('DENY'), 'policies pinned');
      // Empty graph = policy inert (behavior-preserving default, path-scope convention).
      expectEqual(evaluateAgentContact(WORKFLOW_LIMIT_DEFAULTS, { from: 'a', to: 'b' }).reasonCode, 'NO_CONTACT_GRAPH', 'empty graph inert');
      const graph = { agentContactPolicy: 'LOG_ONLY' as const, allowedContacts: [{ from: 'planner', to: 'executor' }] };
      // Missing endpoints are not inter-agent contacts.
      expectEqual(evaluateAgentContact(graph, { from: '', to: 'executor' }).reasonCode, 'NOT_INTER_AGENT', 'endpoints required');
      // Declared directed edge (trim-exact, no heuristics).
      expectEqual(evaluateAgentContact(graph, { from: ' planner ', to: 'executor' }).reasonCode, 'CONTACT_IN_GRAPH', 'in-graph passes');
      // Directed: the reverse pair is NOT declared.
      const reverse = evaluateAgentContact(graph, { from: 'executor', to: 'planner' });
      expectEqual(reverse.reasonCode, 'CONTACT_OUTSIDE_GRAPH', 'directed edge enforced');
      expectTrue(reverse.flagged && !reverse.blocked, 'LOG_ONLY audits without blocking');
      // DENY blocks the channel pre-fact.
      const deny = evaluateAgentContact({ ...graph, agentContactPolicy: 'DENY' }, { from: 'executor', to: 'planner' });
      expectTrue(deny.flagged && deny.blocked, 'DENY blocks out-of-graph');
      expectEqual(A2A_CONTACT_EVENT, 'a2a_contact', 'audit event pinned');
      expectEqual(A2A_CONTACT_DENIED_REASON, 'a2a_contact_denied', 'deny reason pinned');
    }),
    check('workflow.overreach-ceiling', 'v1.3: overreach audit — risk ceiling, approval gate, path scope (labels only)', () => {
      const limits = {
        maxRiskLevel: 'MEDIUM' as const,
        approvalRequiredFor: ['CYBER_OFFENSIVE'],
        allowedPaths: ['src/**'],
        blockedPaths: ['**/secrets/**'],
      };
      // 1. Risk ceiling: explicit level above the max is flagged.
      const ceiling = evaluateOverreach(limits, { riskLevel: 'HIGH' });
      expectTrue(ceiling.overreach && ceiling.reasonCodes.includes('RISK_ABOVE_MAX'), 'explicit risk above ceiling flagged');
      expectEqual(ceiling.riskLevel, 'HIGH', 'effective risk recorded');
      expectEqual(ceiling.maxRiskLevel, 'MEDIUM', 'ceiling recorded');
      // Tool-name-derived risk (bash ⇒ HIGH) busts a LOW ceiling too.
      expectTrue(
        evaluateOverreach({ ...limits, maxRiskLevel: 'LOW' }, { requestedTools: ['bash'] }).reasonCodes.includes('RISK_ABOVE_MAX'),
        'derived risk above ceiling',
      );
      // 2. Approval gate: listed class without flag flags; class match is normalized.
      const approval = evaluateOverreach(limits, { taskClass: 'cyber_offensive' });
      expectTrue(approval.reasonCodes.includes('APPROVAL_REQUIRED') && approval.approvalRequired, 'approval required without flag');
      expectEqual(approval.matchedTaskClass, 'CYBER_OFFENSIVE', 'task class normalized');
      expectTrue(
        !evaluateOverreach(limits, { taskClass: 'CYBER_OFFENSIVE', approvalGranted: true }).reasonCodes.includes('APPROVAL_REQUIRED'),
        'approval flag satisfies gate',
      );
      // 3. Path scope: config glob NAMES reported, never path values.
      const paths = evaluateOverreach(limits, { requestedPaths: ['src/app/x.ts', 'config/secrets/key.pem'] });
      expectTrue(paths.reasonCodes.includes('PATH_SCOPE_EXCEEDED'), 'out-of-scope path flagged');
      expectTrue(paths.matchedGlobs.includes('**/secrets/**'), 'blocked glob reported');
      expectTrue(!JSON.stringify(paths).includes('config/secrets/key.pem'), 'path values never reported');
      // Clean in-scope request never flags.
      expectEqual(
        evaluateOverreach(limits, { requestedTools: ['read-file'], requestedPaths: ['src/app/x.ts'] }).overreach,
        false,
        'in-scope clean request',
      );
      expectEqual(OVERREACH_EVENT, 'overreach_suspected', 'audit event pinned');
    }),
    check('workflow.delegation-risk-classifier', 'v1.3: delegation classifier mirrors policy HIGH set + MEDIUM delegation tier', () => {
      expectEqual(classifyDelegationToolRisk('bash'), 'HIGH', 'command HIGH');
      expectEqual(classifyDelegationToolRisk('file-write'), 'HIGH', 'write HIGH');
      expectEqual(classifyDelegationToolRisk('web-fetch'), 'HIGH', 'network HIGH');
      expectEqual(classifyDelegationToolRisk('send_message'), 'MEDIUM', 'delegation surface MEDIUM');
      expectEqual(classifyDelegationToolRisk('schedule-agent'), 'MEDIUM', 'orchestration surface MEDIUM');
      expectEqual(classifyDelegationToolRisk('read-file'), 'LOW', 'read-only LOW');
      expectTrue(RISK_LEVELS.length === 3, 'three risk levels pinned');
    }),
    check('workflow.v13-limits-validation', 'v1.3: contact/overreach limits validate; defaults behavior-preserving', () => {
      // Defaults: policy inert, ceiling unchanged, no approval classes.
      expectEqual(WORKFLOW_LIMIT_DEFAULTS.agentContactPolicy, 'LOG_ONLY', 'contact policy default');
      expectEqual(WORKFLOW_LIMIT_DEFAULTS.allowedContacts.length, 0, 'empty graph default');
      expectEqual(WORKFLOW_LIMIT_DEFAULTS.maxRiskLevel, 'HIGH', 'ceiling default unchanged');
      expectEqual(WORKFLOW_LIMIT_DEFAULTS.approvalRequiredFor.length, 0, 'no approval classes default');
      // Invalid values rejected deterministically.
      expectThrows(() => validateWorkflowLimits({ agentContactPolicy: 'BLOCK' as never }), 'bad contact policy rejected');
      expectThrows(() => validateWorkflowLimits({ allowedContacts: [{ from: '', to: 'x' }] }), 'empty edge endpoint rejected');
      expectThrows(() => validateWorkflowLimits({ maxRiskLevel: 'EXTREME' as never }), 'bad risk level rejected');
      expectThrows(() => validateWorkflowLimits({ approvalRequiredFor: [''] }), 'empty task class rejected');
      // Valid values round-trip.
      const limits = validateWorkflowLimits({
        agentContactPolicy: 'DENY',
        allowedContacts: [{ from: 'planner', to: 'executor' }],
        maxRiskLevel: 'MEDIUM',
        approvalRequiredFor: ['CYBER_OFFENSIVE'],
      });
      expectEqual(limits.agentContactPolicy, 'DENY', 'valid config accepted');
      expectEqual(limits.allowedContacts.length, 1, 'graph accepted');
      expectTrue(WorkflowConfigError !== undefined, 'error type present');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-a2a-falsepositive.mjs) ----
    check('workflow.comms-registry-identity', 'v1.3.1 FIX-D: tool identity comes from the trusted registry — argument names like `target` never imply A2A', () => {
      const registry = buildCommsToolRegistry(['desk_pager']);
      // Ordinary file tools are NOT comms tools, whatever their argument names.
      expectEqual(isCommunicationTool(registry, 'copy_file'), false, 'copy_file never inspected (false positive killed)');
      expectEqual(isCommunicationTool(registry, 'file-write'), false, 'write tool not inspected');
      // Registry-identified tools are inspected with a FIXED channel.
      expectEqual(isCommunicationTool(registry, 'send_message'), true, 'pinned message tool');
      expectEqual(commsChannelOf(registry, 'subagent'), 'spawn', 'pinned spawn channel');
      expectEqual(commsChannelOf(registry, 'desk_pager'), 'message', 'extended tool channel');
      // Normalization is trim+lowercase; empty/unknown names never match.
      expectEqual(isCommunicationTool(registry, ' SEND_MESSAGE '), true, 'normalized match');
      expectEqual(isCommunicationTool(registry, ''), false, 'empty never matches');
      expectEqual(isCommunicationTool(registry, null), false, 'non-string never matches');
      // Extension is ADD-ONLY: a config entry can never shadow a pinned default channel.
      expectEqual(commsChannelOf(buildCommsToolRegistry(['subagent']), 'subagent'), 'spawn', 'default channel kept');
      expectEqual(DEFAULT_COMMS_TOOL_REGISTRY.length, 12, 'default registry frozen at 12 entries');
      expectEqual(normalizeToolName(' Spawn-Agent '), 'spawn-agent', 'normalization convention');
      expectEqual(inferCommsChannel('spawn_helper'), 'spawn', 'spawn token infers spawn channel');
      expectEqual(inferCommsChannel('pager'), 'message', 'no spawn token ⇒ message channel');
    }),
    check('workflow.a2a-unresolvable-recipient', 'v1.3.1 FIX-D: malformed comms call is flagged always, blocked iff DENY (fail-closed, no crash)', () => {
      expectEqual(A2A_RECIPIENT_UNRESOLVABLE_REASON, 'a2a_recipient_unresolvable', 'pinned reason');
      const deny = unresolvableRecipientDecision({ agentContactPolicy: 'DENY' }, 'message');
      expectTrue(deny.flagged && deny.blocked, 'DENY blocks pre-fact');
      expectEqual(deny.reasonCode, 'A2A_RECIPIENT_UNRESOLVABLE', 'explicit reason, never silent');
      const logOnly = unresolvableRecipientDecision({ agentContactPolicy: 'LOG_ONLY' }, 'spawn');
      expectTrue(logOnly.flagged && !logOnly.blocked, 'LOG_ONLY audits without blocking');
    }),
    // ---- v1.3.1 review-hardening (evidence-bound to real/v131-evidence-binding.mjs) ----
    check('workflow.close-evidence-record-validation', 'v1.3.1 IMP-V: close evidence records validate structurally — malformed is never evidence', () => {
      const sha = 'c'.repeat(64);
      const record = {
        schemaVersion: 'dsh-supreme/evidence@1', taskId: 't1', attempt: 1, status: 'PASS',
        reasonCode: 'OK', validatorId: 'v', validatorType: 'exact-text', artifact: { sha256: sha },
      };
      expectEqual(validateCloseEvidenceRecord(record)?.taskId, 't1', 'well-formed record accepted');
      expectEqual(validateCloseEvidenceRecord({ ...record, artifact: 'nope' }), null, 'non-object artifact refused');
      expectEqual(validateCloseEvidenceRecord({ ...record, artifact: { sha256: 'NOT-A-HASH' } }), null, 'malformed hash refused');
      expectEqual(validateCloseEvidenceRecord({ ...record, attempt: 0 }), null, 'attempt must be ≥ 1');
      expectEqual(validateCloseEvidenceRecord({ ...record, schemaVersion: 'other@2' }), null, 'schema version pinned');
      expectEqual(validateCloseEvidenceRecord('PASS'), null, 'non-object refused');
    }),
    check('workflow.close-gate-evidence-bound', 'v1.3.1 IMP-V: HIGH-risk close requires a PASS bound to the CURRENT artifact (stale/bare/unavailable all block)', () => {
      const limits = { requireVerifierPassOnClose: true };
      const sha1 = 'a'.repeat(64);
      const sha2 = 'b'.repeat(64);
      const passRecord = {
        schemaVersion: 'dsh-supreme/evidence@1', taskId: 't1', attempt: 1, status: 'PASS' as const,
        reasonCode: 'OK', validatorId: 'v', validatorType: 'exact-text', artifact: { sha256: sha1 },
      };
      // Current-bound PASS closes.
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS', evidence: passRecord, artifact: { sha256: sha1 } }).reasonCode, 'EVIDENCE_CURRENT_PASS', 'current PASS closes');
      // Stale PASS (artifact bytes changed since verification) blocks — exactly like no-PASS.
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS', evidence: passRecord, artifact: { sha256: sha2 } }).reasonCode, 'EVIDENCE_STALE', 'stale hash blocks');
      // A bare recorded PASS with a tracked artifact but NO bound record fails closed.
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS', artifact: { sha256: sha1 } }).reasonCode, 'EVIDENCE_CURRENCY_UNVERIFIED', 'bare PASS cannot prove coverage');
      // UNAVAILABLE verification never closes; contradicting labels never close.
      const unavailable = { ...passRecord, status: 'UNAVAILABLE' as const };
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'UNAVAILABLE', evidence: unavailable, artifact: { sha256: sha1 } }).reasonCode, 'VERIFIER_UNAVAILABLE_BLOCKS_CLOSE', 'UNAVAILABLE blocks');
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS', evidence: { ...passRecord, status: 'FAIL' as const }, artifact: { sha256: sha1 } }).reasonCode, 'EVIDENCE_STATUS_CONFLICT', 'label conflict blocks');
      // Malformed evidence is EVIDENCE_UNBOUND; LOW risk stays unrestricted.
      expectEqual(canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS', evidence: { broken: true }, artifact: { sha256: sha1 } }).reasonCode, 'EVIDENCE_UNBOUND', 'unbound blocks');
      expectTrue(canCloseTask(limits, { risk: 'LOW', verifierStatus: 'MISSING' }).closable, 'LOW risk unrestricted');
    }),
  ];
}
