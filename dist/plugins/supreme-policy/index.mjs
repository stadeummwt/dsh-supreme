// src/plugins/supreme-policy/index.ts
import { z } from "zod";

// src/plugins/supreme-policy/engine.ts
var EXECUTION_CLASSES = ["CORE", "STANDARD", "SUPREME", "LAB"];
var TAINT_POLICIES = ["LOG_ONLY", "DENY"];
var REASONING_TRACE_POLICIES = ["OFF", "AUDIT", "ENFORCE"];
var PRODUCTION_DEFAULTS = Object.freeze({
  executionClass: "STANDARD",
  allowPaid: false,
  allowTrial: false,
  allowUnknownCost: false,
  requireVerificationForHighRisk: true,
  maxDelegationDepth: 3,
  enableUnicodeSanitization: true,
  logTaintAttempts: true,
  taintPolicy: "LOG_ONLY",
  reasoningTracePolicy: "OFF"
});

class PolicyConfigError extends Error {
  issues;
  constructor(issues) {
    super(`invalid supreme-policy config: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "PolicyConfigError";
  }
}
function isExecutionClass(v) {
  return typeof v === "string" && EXECUTION_CLASSES.includes(v);
}
function validatePolicyConfig(raw) {
  const issues = [];
  const executionClass = raw.executionClass ?? PRODUCTION_DEFAULTS.executionClass;
  if (!isExecutionClass(executionClass))
    issues.push(`executionClass "${String(executionClass)}" is not one of ${EXECUTION_CLASSES.join("|")}`);
  const allowPaid = raw.allowPaid ?? false;
  const allowTrial = raw.allowTrial ?? false;
  const allowUnknownCost = raw.allowUnknownCost ?? false;
  const requireVerificationForHighRisk = raw.requireVerificationForHighRisk ?? PRODUCTION_DEFAULTS.requireVerificationForHighRisk;
  const maxDelegationDepth = raw.maxDelegationDepth ?? PRODUCTION_DEFAULTS.maxDelegationDepth;
  const enableUnicodeSanitization = raw.enableUnicodeSanitization ?? PRODUCTION_DEFAULTS.enableUnicodeSanitization;
  const logTaintAttempts = raw.logTaintAttempts ?? PRODUCTION_DEFAULTS.logTaintAttempts;
  const taintPolicy = raw.taintPolicy ?? PRODUCTION_DEFAULTS.taintPolicy;
  const reasoningTracePolicy = raw.reasoningTracePolicy ?? PRODUCTION_DEFAULTS.reasoningTracePolicy;
  if (!TAINT_POLICIES.includes(taintPolicy)) {
    issues.push(`taintPolicy "${String(taintPolicy)}" is not one of ${TAINT_POLICIES.join("|")}`);
  }
  if (!REASONING_TRACE_POLICIES.includes(reasoningTracePolicy)) {
    issues.push(`reasoningTracePolicy "${String(reasoningTracePolicy)}" is not one of ${REASONING_TRACE_POLICIES.join("|")}`);
  }
  if (reasoningTracePolicy === "ENFORCE" && executionClass === "CORE") {
    issues.push("reasoningTracePolicy=ENFORCE is not permitted on the CORE composition floor");
  }
  if (allowPaid && executionClass !== "LAB") {
    issues.push("allowPaid=true is only permitted with executionClass=LAB");
  }
  if (allowTrial && executionClass !== "LAB") {
    issues.push("allowTrial=true is only permitted with executionClass=LAB");
  }
  if (allowUnknownCost !== false) {
    issues.push("allowUnknownCost must be false; UNKNOWN cost is always denied in v1");
  }
  if (!Number.isInteger(maxDelegationDepth) || maxDelegationDepth < 1 || maxDelegationDepth > 8) {
    issues.push(`maxDelegationDepth must be an integer in [1,8], got ${String(maxDelegationDepth)}`);
  }
  if (issues.length > 0)
    throw new PolicyConfigError(issues);
  return {
    executionClass,
    allowPaid,
    allowTrial,
    allowUnknownCost: false,
    requireVerificationForHighRisk,
    maxDelegationDepth,
    enableUnicodeSanitization,
    logTaintAttempts,
    taintPolicy: TAINT_POLICIES.includes(taintPolicy) ? taintPolicy : PRODUCTION_DEFAULTS.taintPolicy,
    reasoningTracePolicy: REASONING_TRACE_POLICIES.includes(reasoningTracePolicy) ? reasoningTracePolicy : PRODUCTION_DEFAULTS.reasoningTracePolicy
  };
}
var TAINT_CODEPOINTS = Object.freeze([
  { name: "U+200B-U+200F", description: "zero-width/joiner/marks", re: /[\u200B-\u200F]/g },
  { name: "U+202A-U+202E", description: "bidi embedding/overrides", re: /[\u202A-\u202E]/g },
  { name: "U+2060-U+206F", description: "invisible operators/bidi isolates", re: /[\u2060-\u206F]/g },
  { name: "U+FEFF", description: "zero-width no-break space (BOM)", re: /\uFEFF/g },
  { name: "U+E0000-U+E007F", description: "Unicode tag characters", re: /[\u{E0000}-\u{E007F}]/gu }
]);
var TAINT_SCAN_LIMITS = Object.freeze({ maxNodes: 512, maxStringLength: 1e5 });
function inspectTaint(value, limits = TAINT_SCAN_LIMITS) {
  const hits = new Set;
  let count = 0;
  let nodes = 0;
  const visit = (node) => {
    if (nodes >= limits.maxNodes || count >= limits.maxStringLength)
      return;
    nodes++;
    if (typeof node === "string") {
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
      for (const item of node)
        visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node).sort()) {
        visit(node[key]);
      }
    }
  };
  visit(value);
  return { tainted: hits.size > 0, hits: [...hits], count };
}
function evaluateCoTGate(mode, input) {
  if (mode === "OFF")
    return { decision: "ALLOW", reasonCodes: ["COT_GATE_OFF"] };
  if (input.reasoningTracePresent === true)
    return { decision: "ALLOW", reasonCodes: ["COT_TRACE_PRESENT"] };
  if (input.reasoningTracePresent === undefined) {
    return mode === "ENFORCE" ? { decision: "AUDIT", reasonCodes: ["COT_TRACE_UNKNOWN"] } : { decision: "AUDIT", reasonCodes: ["COT_TRACE_MISSING"] };
  }
  return mode === "ENFORCE" ? { decision: "DENY", reasonCodes: ["COT_TRACE_MISSING", "COT_ENFORCED"] } : { decision: "AUDIT", reasonCodes: ["COT_TRACE_MISSING"] };
}
function evaluateRoutePolicy(config, input) {
  const reasonCodes = [];
  let allowed = true;
  switch (input.costClass) {
    case "FREE_CONFIRMED":
      reasonCodes.push("COST_FREE_CONFIRMED");
      break;
    case "FREE_LIMITED":
      allowed = true;
      reasonCodes.push("COST_FREE_LIMITED_RATE_LIMITED_POSSIBLE");
      break;
    case "TRIAL":
      allowed = config.allowTrial;
      reasonCodes.push(allowed ? "COST_TRIAL_ALLOWED_LAB" : "COST_TRIAL_DENIED");
      break;
    case "PAID":
      allowed = config.allowPaid;
      reasonCodes.push(allowed ? "COST_PAID_ALLOWED_LAB" : "COST_PAID_DENIED");
      break;
    case "UNKNOWN":
    default:
      allowed = false;
      reasonCodes.push("COST_UNKNOWN_DENIED");
      break;
  }
  const verificationRequired = verificationRequirement(config, input);
  if (verificationRequired !== "NONE")
    reasonCodes.push(`VERIFICATION_${verificationRequired}`);
  if (allowed)
    reasonCodes.push("OK");
  return { allowed, reasonCodes, verificationRequired };
}
function verificationRequirement(config, input) {
  if (input.risk === "HIGH") {
    return config.requireVerificationForHighRisk ? "REQUIRED" : "BASIC";
  }
  if (input.risk === "MEDIUM")
    return "BASIC";
  if (input.costClass === "PAID" && config.allowPaid)
    return "STRICT";
  return "NONE";
}
function evaluateDelegationPolicy(config, input) {
  const reasonCodes = [];
  if (input.secretAccess) {
    return { allowed: false, reasonCodes: ["SECRET_ACCESS_DELEGATION_DENIED"] };
  }
  if (input.depth > config.maxDelegationDepth) {
    return { allowed: false, reasonCodes: ["DELEGATION_DEPTH_EXCEEDED"] };
  }
  reasonCodes.push("OK");
  return { allowed: true, reasonCodes };
}
function executionPolicySummary(config) {
  return {
    executionClass: config.executionClass,
    paidRoutes: config.allowPaid ? "ALLOW_LAB_ONLY" : "DENY",
    unknownCost: "DENY",
    trialRoutes: config.allowTrial ? "ALLOW_LAB_ONLY" : "DENY",
    highRiskVerification: config.requireVerificationForHighRisk ? "REQUIRED" : "BASIC",
    maxDelegationDepth: config.maxDelegationDepth
  };
}

// src/plugins/supreme-policy/index.ts
var name = "supreme-policy";
var inject = [];
var Config = z.object({
  executionClass: z.enum(["CORE", "STANDARD", "SUPREME", "LAB"]).default("STANDARD"),
  allowPaid: z.boolean().default(false),
  allowTrial: z.boolean().default(false),
  allowUnknownCost: z.literal(false).default(false),
  requireVerificationForHighRisk: z.boolean().default(true),
  maxDelegationDepth: z.number().int().min(1).max(8).default(3),
  enableUnicodeSanitization: z.boolean().default(true),
  logTaintAttempts: z.boolean().default(true),
  taintPolicy: z.enum(["LOG_ONLY", "DENY"]).default("LOG_ONLY"),
  reasoningTracePolicy: z.enum(["OFF", "AUDIT", "ENFORCE"]).default("OFF")
});
function apply(ctx, config) {
  const validated = validatePolicyConfig(config);
  const frozen = Object.freeze(validated);
  const observability = ctx.get("supremeObservability");
  const service = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen),
    scanArguments: (value) => inspectTaint(value),
    cotGate: (input) => evaluateCoTGate(frozen.reasoningTracePolicy, input)
  };
  ctx.provide("supremePolicy", Object.freeze(service));
  const lastTracePresent = new Map;
  const TRACE_MAP_LIMIT = 256;
  const disposers = [];
  disposers.push(ctx.on("session/event", (session, event) => {
    if (event.type !== "assistant/message")
      return;
    const d = event.data;
    const contentHasReasoning = Array.isArray(d.message?.content) && d.message.content.some((b) => b?.type === "reasoning");
    const streamHasReasoning = Array.isArray(d.stream) && d.stream.some((r) => r?.type === "reasoning-chunks");
    const key = String(session.id);
    if (lastTracePresent.size >= TRACE_MAP_LIMIT && !lastTracePresent.has(key)) {
      const oldest = lastTracePresent.keys().next().value;
      if (oldest !== undefined)
        lastTracePresent.delete(oldest);
    }
    lastTracePresent.set(key, contentHasReasoning || streamHasReasoning);
  }));
  disposers.push(ctx.on("tools/pre-execute", async (exec, next) => {
    const obs = ctx.get("supremeObservability");
    if (frozen.enableUnicodeSanitization) {
      const findings = inspectTaint(exec.arguments);
      if (findings.tainted) {
        const audit = obs ?? observability;
        if (frozen.logTaintAttempts) {
          audit?.record("taint_detected", {
            tool: exec.name,
            detail: `classes:${findings.hits.join("+")};count:${findings.count}`
          });
        }
        if (frozen.taintPolicy === "DENY") {
          return {
            kind: "deny",
            reason: `supreme-policy: tool arguments rejected (unicode taint: ${findings.hits.join(", ")})`
          };
        }
      }
    }
    if (frozen.reasoningTracePolicy !== "OFF") {
      const sessionKey = exec.agent?.id !== undefined ? String(exec.agent.id) : undefined;
      const gate = evaluateCoTGate(frozen.reasoningTracePolicy, {
        reasoningTracePresent: sessionKey !== undefined ? lastTracePresent.get(sessionKey) : undefined,
        tool: exec.name
      });
      const audit = obs ?? observability;
      if (gate.decision === "DENY") {
        audit?.record("cot_missing", { tool: exec.name, detail: "ENFORCE" });
        return {
          kind: "deny",
          reason: "supreme-policy: no reasoning trace observed this turn (cot_missing)"
        };
      }
      if (gate.decision === "AUDIT") {
        audit?.record("cot_missing", { tool: exec.name, detail: gate.reasonCodes.join("+") });
      }
    }
    return next();
  }));
  ctx.effect(() => () => {
    for (const d of disposers.reverse())
      d();
  }, "supreme-policy.v12-effects");
  ctx.logger.info("supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d taint=%s cot=%s", frozen.executionClass, String(frozen.allowPaid), String(frozen.allowTrial), frozen.maxDelegationDepth, frozen.taintPolicy, frozen.reasoningTracePolicy);
}
export {
  name,
  inject,
  apply,
  Config
};
