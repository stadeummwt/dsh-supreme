// src/plugins/supreme-policy/index.ts
import { z } from "zod";

// src/plugins/supreme-policy/engine.ts
var EXECUTION_CLASSES = ["CORE", "STANDARD", "SUPREME", "LAB"];
var COT_VISIBILITIES = ["verbose", "terse", "none"];
var CAPABILITY_CLASS_GATES = ["OFF", "AUDIT", "ENFORCE"];
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
  reasoningTracePolicy: "OFF",
  cotVisibilityProfiles: Object.freeze({}),
  riskGatedCoT: false,
  denyCircumventionGuard: true,
  enableEncodingScan: false,
  capabilityClassGate: "OFF",
  sanctionedCapabilityClasses: Object.freeze([]),
  labCapabilityClassAllowlist: Object.freeze([])
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
  const cotVisibilityProfiles = { ...raw.cotVisibilityProfiles ?? {} };
  for (const [routeId, visibility] of Object.entries(cotVisibilityProfiles)) {
    if (!COT_VISIBILITIES.includes(visibility)) {
      issues.push(`cotVisibilityProfiles["${routeId}"] must be one of ${COT_VISIBILITIES.join("|")}, got "${String(visibility)}"`);
    }
  }
  const riskGatedCoT = raw.riskGatedCoT ?? PRODUCTION_DEFAULTS.riskGatedCoT;
  const denyCircumventionGuard = raw.denyCircumventionGuard ?? PRODUCTION_DEFAULTS.denyCircumventionGuard;
  const enableEncodingScan = raw.enableEncodingScan ?? PRODUCTION_DEFAULTS.enableEncodingScan;
  const capabilityClassGate = raw.capabilityClassGate ?? PRODUCTION_DEFAULTS.capabilityClassGate;
  if (!CAPABILITY_CLASS_GATES.includes(capabilityClassGate)) {
    issues.push(`capabilityClassGate "${String(capabilityClassGate)}" is not one of ${CAPABILITY_CLASS_GATES.join("|")}`);
  }
  const stringList = (value, field) => {
    if (value === undefined)
      return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      issues.push(`${field} must be an array of non-empty strings`);
      return [];
    }
    return [...value];
  };
  const sanctionedCapabilityClasses = stringList(raw.sanctionedCapabilityClasses, "sanctionedCapabilityClasses");
  const labCapabilityClassAllowlist = stringList(raw.labCapabilityClassAllowlist, "labCapabilityClassAllowlist");
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
    reasoningTracePolicy: REASONING_TRACE_POLICIES.includes(reasoningTracePolicy) ? reasoningTracePolicy : PRODUCTION_DEFAULTS.reasoningTracePolicy,
    cotVisibilityProfiles,
    riskGatedCoT,
    denyCircumventionGuard,
    enableEncodingScan,
    capabilityClassGate: CAPABILITY_CLASS_GATES.includes(capabilityClassGate) ? capabilityClassGate : PRODUCTION_DEFAULTS.capabilityClassGate,
    sanctionedCapabilityClasses,
    labCapabilityClassAllowlist
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
var ENCODING_BLOB_CLASS = "encoding_blob";
var ENCODING_SCAN_LIMITS = Object.freeze({
  minRunLength: 256,
  maxHits: 32,
  maxNodes: 512,
  maxStringLength: 1e5
});
var BASE64_RUN_RE = /[A-Za-z0-9+/=]+/g;
var HEX_RUN_RE = /[0-9a-fA-F]+/g;
function longestRun(text, re, minLength) {
  re.lastIndex = 0;
  let longest = 0;
  for (const match of text.matchAll(re)) {
    if (match[0].length > longest)
      longest = match[0].length;
  }
  return longest >= minLength ? longest : 0;
}
function inspectEncodingTaint(value, limits = ENCODING_SCAN_LIMITS) {
  const hits = [];
  let nodes = 0;
  const visit = (node, path) => {
    if (nodes >= limits.maxNodes || hits.length >= limits.maxHits)
      return;
    nodes++;
    if (typeof node === "string") {
      const scan = node.length > limits.maxStringLength ? node.slice(0, limits.maxStringLength) : node;
      const hex = longestRun(scan, HEX_RUN_RE, limits.minRunLength);
      if (hex > 0) {
        hits.push({ arg: path, kind: "hex", length: hex });
        return;
      }
      const b64 = longestRun(scan, BASE64_RUN_RE, limits.minRunLength);
      if (b64 > 0)
        hits.push({ arg: path, kind: "base64", length: b64 });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node).sort()) {
        visit(node[key], path === "(root)" ? key : `${path}.${key}`);
      }
    }
  };
  visit(value, "(root)");
  return { tainted: hits.length > 0, hits };
}
function scanToolArguments(value, options, limits = TAINT_SCAN_LIMITS) {
  const unicode = options.unicode ? inspectTaint(value, limits) : { tainted: false, hits: [], count: 0 };
  const encoding = options.encoding ? inspectEncodingTaint(value, ENCODING_SCAN_LIMITS) : { tainted: false, hits: [] };
  const hits = [...unicode.hits];
  if (encoding.tainted)
    hits.push(ENCODING_BLOB_CLASS);
  return { tainted: hits.length > 0, hits, count: unicode.count, encoding: encoding.hits };
}
function formatTaintEventDetail(findings) {
  const parts = [];
  if (findings.hits.length > 0)
    parts.push(`classes:${findings.hits.join("+")}`);
  if (findings.count > 0)
    parts.push(`count:${findings.count}`);
  for (const hit of findings.encoding)
    parts.push(`arg:${hit.arg};kind:${hit.kind};len:${hit.length}`);
  return parts.join(";");
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
function extractCapabilitySignal(payload) {
  const out = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return out;
  const rec = payload;
  const cc = rec.capabilityClass;
  if (typeof cc === "string" && cc.trim() !== "") {
    out.capabilityClass = cc.trim().toUpperCase();
  }
  const cv = rec.cotVisibility;
  if (typeof cv === "string" && COT_VISIBILITIES.includes(cv)) {
    out.cotVisibility = cv;
  }
  return out;
}
function resolveCotVisibility(input) {
  if (typeof input.explicit === "string" && COT_VISIBILITIES.includes(input.explicit)) {
    return input.explicit;
  }
  if (typeof input.profile === "string" && COT_VISIBILITIES.includes(input.profile)) {
    return input.profile;
  }
  return "verbose";
}
function evaluateCoTEnforcement(mode, input) {
  if (mode === "OFF")
    return { decision: "ALLOW", reasonCodes: ["COT_GATE_OFF"] };
  let effective = mode;
  if (mode === "ENFORCE" && input.riskGated === true && input.toolRisk !== "HIGH") {
    effective = "AUDIT";
  }
  if (effective === "ENFORCE" && input.visibility === "none" && input.reasoningTracePresent === false) {
    return { decision: "AUDIT", reasonCodes: ["COT_TRACE_MISSING", "COT_VISIBILITY_NONE_DOWNGRADED"] };
  }
  return evaluateCoTGate(effective, {
    reasoningTracePresent: input.reasoningTracePresent,
    tool: input.tool
  });
}
var HIGH_RISK_TOOL_TOKENS = Object.freeze([
  { kind: "command", tokens: new Set(["bash", "sh", "zsh", "shell", "cmd", "command", "powershell", "pwsh", "exec", "execute", "terminal", "console", "process", "spawn", "run"]) },
  { kind: "network", tokens: new Set(["fetch", "curl", "wget", "http", "https", "net", "network", "socket", "ftp", "upload", "download", "request", "web", "browser", "browse", "url"]) },
  { kind: "write", tokens: new Set(["write", "edit", "delete", "remove", "mkdir", "rmdir", "rm", "mv", "cp", "move", "copy", "rename", "patch", "apply", "create", "unlink", "truncate", "chmod", "chown", "save"]) }
]);
function classifyToolRisk(toolName) {
  const tokens = String(toolName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    for (const group of HIGH_RISK_TOOL_TOKENS) {
      if (group.tokens.has(token))
        return "HIGH";
    }
  }
  return "LOW";
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
var DENY_RETRY_REASON_CODE = "deny_retry";
var SHAPE_LIMITS = Object.freeze({ maxDepth: 8, maxKeysPerNode: 64, maxLength: 4096 });
function shapeOf(value, depth) {
  if (depth > SHAPE_LIMITS.maxDepth)
    return "(depth)";
  if (value === null)
    return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "undefined":
      return "undefined";
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, SHAPE_LIMITS.maxKeysPerNode).map((item) => shapeOf(item, depth + 1));
    return `[${items.join(",")}${value.length > SHAPE_LIMITS.maxKeysPerNode ? ",…" : ""}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort().slice(0, SHAPE_LIMITS.maxKeysPerNode);
    const body = keys.map((key) => `${key}:${shapeOf(value[key], depth + 1)}`).join(",");
    return `{${body}}`;
  }
  return "unknown";
}
function denySignature(toolName, args) {
  const sig = `${String(toolName)}(${shapeOf(args, 0)})`;
  return sig.length > SHAPE_LIMITS.maxLength ? sig.slice(0, SHAPE_LIMITS.maxLength) : sig;
}

class DenyCircumventionGuard {
  sessions = new Map;
  limits;
  constructor(limits = {}) {
    this.limits = {
      maxSessions: limits.maxSessions ?? 256,
      maxSignaturesPerSession: limits.maxSignaturesPerSession ?? 64
    };
  }
  recordDeny(sessionId, toolName, args) {
    const key = String(sessionId);
    let signatures = this.sessions.get(key);
    if (!signatures) {
      if (this.sessions.size >= this.limits.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined)
          this.sessions.delete(oldest);
      }
      signatures = new Set;
      this.sessions.set(key, signatures);
    }
    if (signatures.size >= this.limits.maxSignaturesPerSession && !signatures.has(denySignature(toolName, args))) {
      const oldest = signatures.values().next().value;
      if (oldest !== undefined)
        signatures.delete(oldest);
    }
    signatures.add(denySignature(toolName, args));
  }
  check(sessionId, toolName, args) {
    const signatures = this.sessions.get(String(sessionId));
    if (!signatures || signatures.size === 0)
      return { denied: false, reasonCodes: [] };
    if (signatures.has(denySignature(toolName, args))) {
      return { denied: true, reasonCodes: [DENY_RETRY_REASON_CODE] };
    }
    return { denied: false, reasonCodes: [] };
  }
  resetDenyCircumvention(sessionId) {
    this.sessions.delete(String(sessionId));
  }
  signatureCount(sessionId) {
    return this.sessions.get(String(sessionId))?.size ?? 0;
  }
  dispose() {
    this.sessions.clear();
  }
}
function normalizeCapabilityClass(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}
function sanctionListContains(list, capabilityClass) {
  return list.some((entry) => normalizeCapabilityClass(entry) === capabilityClass);
}
function isCapabilityClassSanctioned(config, capabilityClass) {
  const cls = normalizeCapabilityClass(capabilityClass);
  if (cls === undefined)
    return true;
  if (sanctionListContains(config.sanctionedCapabilityClasses, cls))
    return true;
  if (config.executionClass === "LAB" && sanctionListContains(config.labCapabilityClassAllowlist, cls))
    return true;
  return false;
}
function evaluateCapabilityGate(config, input) {
  const capabilityClass = normalizeCapabilityClass(input.capabilityClass);
  if (capabilityClass === undefined) {
    return { decision: "ALLOW", reasonCodes: ["CAPABILITY_CLASS_ABSENT"] };
  }
  if (config.capabilityClassGate === "OFF") {
    return { decision: "ALLOW", reasonCodes: ["CAPABILITY_GATE_OFF"], capabilityClass };
  }
  if (isCapabilityClassSanctioned(config, capabilityClass)) {
    return { decision: "ALLOW", reasonCodes: ["CAPABILITY_CLASS_SANCTIONED"], capabilityClass };
  }
  return config.capabilityClassGate === "ENFORCE" ? { decision: "DENY", reasonCodes: ["CAPABILITY_CLASS_UNSANCTIONED", "CAPABILITY_ENFORCED"], capabilityClass } : { decision: "AUDIT", reasonCodes: ["CAPABILITY_CLASS_UNSANCTIONED"], capabilityClass };
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
  reasoningTracePolicy: z.enum(["OFF", "AUDIT", "ENFORCE"]).default("OFF"),
  cotVisibilityProfiles: z.record(z.string(), z.enum(["verbose", "terse", "none"])).default({}),
  riskGatedCoT: z.boolean().default(false),
  denyCircumventionGuard: z.boolean().default(true),
  enableEncodingScan: z.boolean().default(false),
  capabilityClassGate: z.enum(["OFF", "AUDIT", "ENFORCE"]).default("OFF"),
  sanctionedCapabilityClasses: z.array(z.string()).default([]),
  labCapabilityClassAllowlist: z.array(z.string()).default([])
});
function apply(ctx, config) {
  const validated = validatePolicyConfig(config);
  const frozen = Object.freeze(validated);
  const observability = ctx.get("supremeObservability");
  const denyGuard = new DenyCircumventionGuard;
  const service = {
    config: frozen,
    evaluateRoute: (input) => evaluateRoutePolicy(frozen, input),
    evaluateDelegation: (input) => evaluateDelegationPolicy(frozen, input),
    verificationRequirement: (input) => verificationRequirement(frozen, input),
    executionPolicy: () => executionPolicySummary(frozen),
    scanArguments: (value) => scanToolArguments(value, {
      unicode: frozen.enableUnicodeSanitization,
      encoding: frozen.enableEncodingScan
    }),
    cotGate: (input) => evaluateCoTGate(frozen.reasoningTracePolicy, input),
    cotEnforcement: (input) => evaluateCoTEnforcement(frozen.reasoningTracePolicy, input),
    resolveCotVisibility: (input) => resolveCotVisibility({
      explicit: input.explicit,
      profile: input.routeId !== undefined ? frozen.cotVisibilityProfiles[input.routeId] : undefined
    }),
    classifyToolRisk: (toolName) => classifyToolRisk(toolName),
    capabilityGate: (input) => evaluateCapabilityGate(frozen, input),
    recordDeny: (sessionId, toolName, args) => denyGuard.recordDeny(sessionId, toolName, args),
    denyCircumventionCheck: (sessionId, toolName, args) => denyGuard.check(sessionId, toolName, args),
    resetDenyCircumvention: (sessionId) => denyGuard.resetDenyCircumvention(sessionId),
    extractSignal: (payload) => extractCapabilitySignal(payload)
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
    const audit = obs ?? observability;
    const sessionKey = exec.agent?.id !== undefined ? String(exec.agent.id) : undefined;
    const recordDeny = () => {
      if (sessionKey !== undefined)
        denyGuard.recordDeny(sessionKey, exec.name, exec.arguments);
    };
    const execSignal = extractCapabilitySignal(exec);
    const argsSignal = extractCapabilitySignal(exec.arguments);
    const capabilityLabel = execSignal.capabilityClass ?? argsSignal.capabilityClass;
    const explicitVisibility = execSignal.cotVisibility ?? argsSignal.cotVisibility;
    if (frozen.denyCircumventionGuard && sessionKey !== undefined) {
      const retry = denyGuard.check(sessionKey, exec.name, exec.arguments);
      if (retry.denied) {
        audit?.record("deny_retry", { tool: exec.name, detail: retry.reasonCodes.join("+") });
        return {
          kind: "deny",
          reason: "supreme-policy: repeat of a previously denied call shape (deny_retry)"
        };
      }
    }
    if (capabilityLabel !== undefined && frozen.capabilityClassGate !== "OFF") {
      const gate = evaluateCapabilityGate(frozen, { capabilityClass: capabilityLabel });
      if (gate.decision === "DENY") {
        audit?.record("capability_class_unsanctioned", {
          tool: exec.name,
          detail: `class:${gate.capabilityClass};mode:ENFORCE`
        });
        recordDeny();
        return {
          kind: "deny",
          reason: `supreme-policy: capability class not sanctioned (${gate.capabilityClass}; capability_class_unsanctioned)`
        };
      }
      if (gate.decision === "AUDIT") {
        audit?.record("capability_class_unsanctioned", {
          tool: exec.name,
          detail: `class:${gate.capabilityClass};mode:AUDIT`
        });
      }
    }
    if (frozen.enableUnicodeSanitization) {
      const findings = inspectTaint(exec.arguments);
      if (findings.tainted) {
        if (frozen.logTaintAttempts) {
          audit?.record("taint_detected", {
            tool: exec.name,
            detail: `classes:${findings.hits.join("+")};count:${findings.count}`
          });
        }
        if (frozen.taintPolicy === "DENY") {
          recordDeny();
          return {
            kind: "deny",
            reason: `supreme-policy: tool arguments rejected (unicode taint: ${findings.hits.join(", ")})`
          };
        }
      }
    }
    if (frozen.enableEncodingScan) {
      const findings = scanToolArguments(exec.arguments, { unicode: false, encoding: true });
      if (findings.tainted) {
        if (frozen.logTaintAttempts) {
          audit?.record("taint_detected", { tool: exec.name, detail: formatTaintEventDetail(findings) });
        }
        if (frozen.taintPolicy === "DENY") {
          recordDeny();
          return {
            kind: "deny",
            reason: `supreme-policy: tool arguments rejected (encoding taint: ${ENCODING_BLOB_CLASS})`
          };
        }
      }
    }
    if (frozen.reasoningTracePolicy !== "OFF") {
      const routeId = sessionKey ?? exec.name;
      const visibility = resolveCotVisibility({
        explicit: explicitVisibility,
        profile: frozen.cotVisibilityProfiles[routeId]
      });
      const gate = evaluateCoTEnforcement(frozen.reasoningTracePolicy, {
        reasoningTracePresent: sessionKey !== undefined ? lastTracePresent.get(sessionKey) : undefined,
        tool: exec.name,
        visibility,
        riskGated: frozen.riskGatedCoT,
        toolRisk: classifyToolRisk(exec.name)
      });
      if (gate.decision === "DENY") {
        audit?.record("cot_missing", { tool: exec.name, detail: "ENFORCE" });
        recordDeny();
        return {
          kind: "deny",
          reason: "supreme-policy: no reasoning trace observed this turn (cot_missing)"
        };
      }
      if (gate.decision === "AUDIT") {
        audit?.record("cot_missing", { tool: exec.name, detail: gate.reasonCodes.join("+") });
      }
    }
    const result = await next();
    if (frozen.denyCircumventionGuard && sessionKey !== undefined && result && typeof result === "object" && result.kind === "deny") {
      denyGuard.recordDeny(sessionKey, exec.name, exec.arguments);
    }
    return result;
  }));
  ctx.effect(() => () => {
    for (const d of disposers.reverse())
      d();
    lastTracePresent.clear();
    denyGuard.dispose();
  }, "supreme-policy.v13-effects");
  ctx.logger.info("supreme-policy active (%s), paid=%s trial=%s unknown=DENY maxDepth=%d taint=%s cot=%s encodingScan=%s denyRetry=%s capabilityGate=%s", frozen.executionClass, String(frozen.allowPaid), String(frozen.allowTrial), frozen.maxDelegationDepth, frozen.taintPolicy, frozen.reasoningTracePolicy, String(frozen.enableEncodingScan), String(frozen.denyCircumventionGuard), frozen.capabilityClassGate);
}
export {
  name,
  inject,
  apply,
  Config
};
