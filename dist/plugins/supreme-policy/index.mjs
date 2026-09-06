// dsh-supreme/src/plugins/supreme-policy/index.ts
import { z } from "zod";

// dsh-supreme/src/plugins/supreme-policy/engine.ts
var EXECUTION_CLASSES = ["CORE", "STANDARD", "SUPREME", "LAB"];
var PRODUCTION_DEFAULTS = Object.freeze({
  executionClass: "STANDARD",
  allowPaid: false,
  allowTrial: false,
  allowUnknownCost: false,
  requireVerificationForHighRisk: true,
  maxDelegationDepth: 3
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
    maxDelegationDepth
  };
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

// dsh-supreme/src/plugins/supreme-policy/index.ts
var name = "supreme-policy";
var inject = [];
var Config = z.object({
  executionClass: z.enum(["CORE", "STANDARD", "SUPREME", "LAB"]).default("STANDARD"),
  allowPaid: z.boolean().default(false),
  allowTrial: z.boolean().default(false),
  allowUnknownCost: z.literal(false).default(false),
  requireVerificationForHighRisk: z.boolean().default(true),
  maxDelegationDepth: z.number().int().min(1).max(8).default(3)
});
function apply(ctx, config) {
  const validated = validatePolicyConfig(config);
  const frozen = Object.freeze(validated);
  const service = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen)
  };
  ctx.provide("supremePolicy", Object.freeze(service));
  ctx.logger.info("supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d", frozen.executionClass, String(frozen.allowPaid), String(frozen.allowTrial), frozen.maxDelegationDepth);
}
export {
  name,
  inject,
  apply,
  Config
};
