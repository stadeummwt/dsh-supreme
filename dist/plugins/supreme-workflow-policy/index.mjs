// src/plugins/supreme-workflow-policy/index.ts
import { z } from "zod";

// src/plugins/supreme-workflow-policy/engine.ts
var WORKFLOW_LIMIT_DEFAULTS = Object.freeze({
  maxConcurrentAgents: 3,
  maxTotalAgents: 12,
  maxDepth: 2,
  workflowTimeoutMs: 600000,
  subagentTimeoutMs: 120000,
  allowedSubagentProviders: ["spawn"],
  allowedPaths: [],
  blockedPaths: [],
  requireVerifierPassOnClose: false,
  agentContactPolicy: "LOG_ONLY",
  allowedContacts: [],
  maxRiskLevel: "HIGH",
  approvalRequiredFor: []
});

class WorkflowConfigError extends Error {
  issues;
  constructor(issues) {
    super(`invalid workflow-policy config: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "WorkflowConfigError";
  }
}
function validateWorkflowLimits(raw) {
  const issues = [];
  const limits = { ...WORKFLOW_LIMIT_DEFAULTS, ...raw };
  const bounded = [
    ["maxConcurrentAgents", limits.maxConcurrentAgents, 1, 8],
    ["maxTotalAgents", limits.maxTotalAgents, 1, 32],
    ["maxDepth", limits.maxDepth, 0, 4]
  ];
  for (const [name, value, min, max] of bounded) {
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(`${name} must be an integer in [${min},${max}], got ${String(value)}`);
    }
  }
  if (!Number.isFinite(limits.workflowTimeoutMs) || limits.workflowTimeoutMs < 1000) {
    issues.push("workflowTimeoutMs must be >= 1000");
  }
  if (!Number.isFinite(limits.subagentTimeoutMs) || limits.subagentTimeoutMs < 1000) {
    issues.push("subagentTimeoutMs must be >= 1000");
  }
  if (!Array.isArray(limits.allowedSubagentProviders) || limits.allowedSubagentProviders.length === 0) {
    issues.push("allowedSubagentProviders must be a non-empty array");
  }
  for (const key of ["allowedPaths", "blockedPaths"]) {
    const list = limits[key];
    if (!Array.isArray(list) || list.some((g) => typeof g !== "string" || g.length === 0 || g.length > 512)) {
      issues.push(`${key} must be an array of non-empty glob strings (≤512 chars)`);
    }
  }
  if (typeof limits.requireVerifierPassOnClose !== "boolean") {
    issues.push("requireVerifierPassOnClose must be a boolean");
  }
  if (!AGENT_CONTACT_POLICIES.includes(limits.agentContactPolicy)) {
    issues.push(`agentContactPolicy must be one of ${AGENT_CONTACT_POLICIES.join("|")}, got ${String(limits.agentContactPolicy)}`);
  }
  if (!Array.isArray(limits.allowedContacts) || limits.allowedContacts.some((edge) => edge === null || typeof edge !== "object" || typeof edge.from !== "string" || edge.from.trim().length === 0 || edge.from.length > 512 || typeof edge.to !== "string" || edge.to.trim().length === 0 || edge.to.length > 512)) {
    issues.push("allowedContacts must be an array of { from, to } non-empty strings (≤512 chars)");
  }
  if (!RISK_LEVELS.includes(limits.maxRiskLevel)) {
    issues.push(`maxRiskLevel must be one of ${RISK_LEVELS.join("|")}, got ${String(limits.maxRiskLevel)}`);
  }
  if (!Array.isArray(limits.approvalRequiredFor) || limits.approvalRequiredFor.some((c) => typeof c !== "string" || c.trim().length === 0 || c.length > 128)) {
    issues.push("approvalRequiredFor must be an array of non-empty strings (≤128 chars)");
  }
  if (issues.length > 0)
    throw new WorkflowConfigError(issues);
  return limits;
}
var DEGRADE_ORDER = ["SUPREME_WORKFLOW", "WORKFLOW", "SUBAGENT", "DIRECT"];
function decideWorkflow(limits, input) {
  const reasonCodes = [];
  if (input.secretAccessRequested) {
    return {
      decision: "DENY",
      reasonCodes: ["SECRET_ACCESS_DELEGATION_DENIED"],
      limits,
      expectedVerification: "REQUIRED",
      closeGate: "VERIFIER_PASS_REQUIRED"
    };
  }
  const missingCaps = input.requiresCapabilities.filter((cap) => !input.availableCapabilities.includes(cap));
  if (missingCaps.length > 0) {
    return {
      decision: "DENY",
      reasonCodes: [`MISSING_CAPABILITY:${missingCaps.join("+")}`],
      limits,
      expectedVerification: "NONE",
      closeGate: "NONE"
    };
  }
  if (input.depth > limits.maxDepth) {
    return {
      decision: "DENY",
      reasonCodes: ["DELEGATION_DEPTH_EXCEEDED"],
      limits,
      expectedVerification: "NONE",
      closeGate: "NONE"
    };
  }
  if (input.totalAgentsUsed >= limits.maxTotalAgents) {
    return {
      decision: "DIRECT",
      reasonCodes: ["TOTAL_AGENT_BUDGET_EXHAUSTED"],
      limits,
      expectedVerification: "BASIC",
      closeGate: input.risk === "HIGH" && limits.requireVerifierPassOnClose ? "VERIFIER_PASS_REQUIRED" : "NONE"
    };
  }
  const eligibleProviders = input.availableProviders.filter((p) => limits.allowedSubagentProviders.includes(p));
  const providersUsable = eligibleProviders.length > 0;
  let decision;
  if (input.complexity === "simple" && !input.parallelizable) {
    decision = "DIRECT";
    reasonCodes.push("SIMPLE_TASK_DIRECT");
  } else if (input.parallelizable && input.complexity !== "simple") {
    decision = "WORKFLOW";
    reasonCodes.push("PARALLELIZABLE_TASK");
  } else if (input.complexity === "multi_stage") {
    decision = "WORKFLOW";
    reasonCodes.push("MULTI_STAGE_TASK");
  } else {
    decision = "SUBAGENT";
    reasonCodes.push("DELEGATABLE_TASK");
  }
  if (decision === "WORKFLOW" && input.risk === "HIGH" && providersUsable && input.depth < limits.maxDepth && input.activeAgents + 2 <= limits.maxConcurrentAgents) {
    decision = "SUPREME_WORKFLOW";
    reasonCodes.push("HIGH_RISK_SUPREME_ORCHESTRATION");
  }
  const expectedVerification = input.risk === "HIGH" ? "REQUIRED" : input.risk === "MEDIUM" ? "BASIC" : "NONE";
  let degradedFrom;
  const degrade = () => {
    const idx = DEGRADE_ORDER.indexOf(decision);
    if (idx >= 0 && idx < DEGRADE_ORDER.length - 1) {
      degradedFrom = degradedFrom ?? decision;
      decision = DEGRADE_ORDER[idx + 1];
      reasonCodes.push(`DEGRADED_TO_${decision}`);
    }
  };
  let guard = 0;
  while (guard++ < 8) {
    if (input.activeAgents >= limits.maxConcurrentAgents && decision !== "DIRECT") {
      reasonCodes.push("CONCURRENCY_LIMIT");
      degrade();
      continue;
    }
    if ((decision === "WORKFLOW" || decision === "SUPREME_WORKFLOW" || decision === "SUBAGENT") && !providersUsable) {
      reasonCodes.push("NO_ELIGIBLE_PROVIDER");
      degrade();
      continue;
    }
    if ((input.tokenPressure ?? 0) > 0.85 && decision !== "DIRECT") {
      reasonCodes.push("TOKEN_PRESSURE_HIGH");
      degrade();
      continue;
    }
    break;
  }
  return { decision, reasonCodes, degradedFrom, limits, expectedVerification, closeGate: input.risk === "HIGH" && limits.requireVerifierPassOnClose ? "VERIFIER_PASS_REQUIRED" : "NONE" };
}
var globCache = new Map;
function pathMatchesGlob(path, pattern) {
  const key = pattern;
  let re = globCache.get(key);
  if (!re) {
    let out = "";
    for (let i = 0;i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          out += ".*";
          i++;
        } else {
          out += "[^/]*";
        }
      } else if (ch === "?") {
        out += "[^/]";
      } else {
        out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    re = new RegExp(`^${out}$`);
    if (globCache.size < 256)
      globCache.set(key, re);
  }
  return re.test(path);
}
function evaluatePathScope(limits, path) {
  for (const pattern of limits.blockedPaths) {
    if (pathMatchesGlob(path, pattern)) {
      return { allowed: false, reasonCode: "PATH_BLOCKED", matchedBlocked: pattern };
    }
  }
  if (limits.allowedPaths.length > 0 && !limits.allowedPaths.some((p) => pathMatchesGlob(path, p))) {
    return { allowed: false, reasonCode: "PATH_OUTSIDE_ALLOWED" };
  }
  return {
    allowed: true,
    reasonCode: limits.allowedPaths.length === 0 && limits.blockedPaths.length === 0 ? "NO_PATH_RULES" : "PATH_ALLOWED"
  };
}
function canCloseTask(limits, input) {
  if (!limits.requireVerifierPassOnClose || input.risk !== "HIGH") {
    return { closable: true, reasonCode: "CLOSE_UNRESTRICTED" };
  }
  if (input.verifierStatus === "PASS")
    return { closable: true, reasonCode: "VERIFIER_PASS_RECORDED" };
  return { closable: false, reasonCode: `VERIFIER_${input.verifierStatus}_BLOCKS_CLOSE` };
}
function buildDelegationScope(scope) {
  if (scope.secretPolicy !== "DENY_ALL") {
    throw new WorkflowConfigError(["secretPolicy must be DENY_ALL — never delegate credential inspection"]);
  }
  if (scope.task.length === 0 || scope.stopCondition.length === 0 || scope.expectedOutput.length === 0) {
    throw new WorkflowConfigError(["task, expectedOutput and stopCondition are mandatory"]);
  }
  return Object.freeze({ ...scope, secretPolicy: "DENY_ALL" });
}
var AGENT_CONTACT_POLICIES = ["LOG_ONLY", "DENY"];
var A2A_CONTACT_EVENT = "a2a_contact";
var A2A_CONTACT_DENIED_REASON = "a2a_contact_denied";
function normalizeContactId(value) {
  return typeof value === "string" ? value.trim().slice(0, 512) : "";
}
function evaluateAgentContact(limits, contact) {
  const channel = contact.channel === "spawn" ? "spawn" : "message";
  const graph = Array.isArray(limits.allowedContacts) ? limits.allowedContacts : [];
  if (graph.length === 0) {
    return { channel, flagged: false, blocked: false, reasonCode: "NO_CONTACT_GRAPH" };
  }
  const from = normalizeContactId(contact.from);
  const to = normalizeContactId(contact.to);
  if (from === "" || to === "") {
    return { channel, flagged: false, blocked: false, reasonCode: "NOT_INTER_AGENT" };
  }
  const inGraph = graph.some((edge) => normalizeContactId(edge?.from) === from && normalizeContactId(edge?.to) === to);
  if (inGraph) {
    return { channel, flagged: false, blocked: false, reasonCode: "CONTACT_IN_GRAPH" };
  }
  return {
    channel,
    flagged: true,
    blocked: limits.agentContactPolicy === "DENY",
    reasonCode: "CONTACT_OUTSIDE_GRAPH"
  };
}
var RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"];
var OVERREACH_EVENT = "overreach_suspected";
function riskRank(level) {
  return RISK_LEVELS.indexOf(level);
}
var HIGH_RISK_TOOL_TOKENS = Object.freeze([
  { kind: "command", tokens: new Set(["bash", "sh", "zsh", "shell", "cmd", "command", "powershell", "pwsh", "exec", "execute", "terminal", "console", "process", "spawn", "run"]) },
  { kind: "network", tokens: new Set(["fetch", "curl", "wget", "http", "https", "net", "network", "socket", "ftp", "upload", "download", "request", "web", "browser", "browse", "url"]) },
  { kind: "write", tokens: new Set(["write", "edit", "delete", "remove", "mkdir", "rmdir", "rm", "mv", "cp", "move", "copy", "rename", "patch", "apply", "create", "unlink", "truncate", "chmod", "chown", "save"]) }
]);
var DELEGATION_MEDIUM_TOOL_TOKENS = new Set([
  "delegate",
  "delegation",
  "subagent",
  "agent",
  "workflow",
  "orchestrate",
  "orchestration",
  "schedule",
  "send",
  "message",
  "notify"
]);
function classifyDelegationToolRisk(toolName) {
  const tokens = String(toolName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    for (const group of HIGH_RISK_TOOL_TOKENS) {
      if (group.tokens.has(token))
        return "HIGH";
    }
  }
  for (const token of tokens) {
    if (DELEGATION_MEDIUM_TOOL_TOKENS.has(token))
      return "MEDIUM";
  }
  return "LOW";
}
function normalizeTaskClass(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}
function evaluateOverreach(limits, request) {
  const maxRiskLevel = RISK_LEVELS.includes(limits.maxRiskLevel) ? limits.maxRiskLevel : "HIGH";
  const reasons = new Set;
  let riskLevel = "LOW";
  const explicit = normalizeTaskClass(request.riskLevel) ?? "";
  if (RISK_LEVELS.includes(explicit)) {
    riskLevel = explicit;
  } else {
    for (const tool of Array.isArray(request.requestedTools) ? request.requestedTools : []) {
      const derived = classifyDelegationToolRisk(String(tool));
      if (riskRank(derived) > riskRank(riskLevel))
        riskLevel = derived;
    }
  }
  if (riskRank(riskLevel) > riskRank(maxRiskLevel))
    reasons.add("RISK_ABOVE_MAX");
  const taskClass = normalizeTaskClass(request.taskClass);
  const approvalSet = new Set((Array.isArray(limits.approvalRequiredFor) ? limits.approvalRequiredFor : []).map((c) => normalizeTaskClass(c)).filter((c) => c !== undefined));
  const approvalRequired = taskClass !== undefined && approvalSet.has(taskClass) && request.approvalGranted !== true;
  if (approvalRequired)
    reasons.add("APPROVAL_REQUIRED");
  const matchedGlobs = [];
  for (const path of Array.isArray(request.requestedPaths) ? request.requestedPaths : []) {
    if (typeof path !== "string" || path.trim() === "")
      continue;
    const scope = evaluatePathScope(limits, path);
    if (!scope.allowed && scope.reasonCode !== "NO_PATH_RULES") {
      reasons.add("PATH_SCOPE_EXCEEDED");
      if (scope.matchedBlocked !== undefined)
        matchedGlobs.push(scope.matchedBlocked);
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
    reasonCodes
  };
}

// src/plugins/supreme-workflow-policy/index.ts
var name = "supreme-workflow-policy";
var inject = ["supremePolicy", "supremeObservability", "supremeVerifier", "subagents", "workflowEngine"];
var Config = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  maxTotalAgents: z.number().int().min(1).max(32).default(12),
  maxDepth: z.number().int().min(0).max(4).default(2),
  workflowTimeoutMs: z.number().int().min(1000).default(600000),
  subagentTimeoutMs: z.number().int().min(1000).default(120000),
  allowedSubagentProviders: z.array(z.string()).default(["in-process"]),
  allowedPaths: z.array(z.string().min(1).max(512)).default([]),
  blockedPaths: z.array(z.string().min(1).max(512)).default([]),
  requireVerifierPassOnClose: z.boolean().default(false),
  agentContactPolicy: z.enum(["LOG_ONLY", "DENY"]).default("LOG_ONLY"),
  allowedContacts: z.array(z.object({
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512)
  })).default([]),
  maxRiskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).default("HIGH"),
  approvalRequiredFor: z.array(z.string().min(1).max(128)).default([])
});
function apply(ctx, config) {
  const limits = validateWorkflowLimits(config);
  const observability = ctx.supremeObservability;
  const clip = (value) => value.slice(0, 96);
  const auditContact = (decision, from, to, origin, extra) => {
    if (!decision.flagged)
      return;
    observability.record(A2A_CONTACT_EVENT, {
      ...extra?.tool !== undefined ? { tool: clip(extra.tool) } : {},
      ...extra?.subagent !== undefined ? { subagent: clip(extra.subagent) } : {},
      ...extra?.workflow !== undefined ? { workflow: clip(extra.workflow) } : {},
      detail: [
        `channel:${decision.channel}`,
        `from:${clip(from)}`,
        `to:${clip(to)}`,
        `reason:${decision.reasonCode}`,
        `outcome:${extra?.outcome ?? (decision.blocked ? "DENIED" : "LOGGED")}`,
        `mode:${limits.agentContactPolicy}`,
        `origin:${origin}`
      ].join(":")
    });
  };
  const auditOverreach = (verdict, origin, tool) => {
    if (!verdict.overreach)
      return;
    observability.record(OVERREACH_EVENT, {
      ...tool !== undefined && tool !== "" ? { tool: clip(tool) } : {},
      detail: [
        `risk:${verdict.riskLevel}`,
        `max:${verdict.maxRiskLevel}`,
        `class:${verdict.matchedTaskClass ?? "UNSPECIFIED"}`,
        `approval:${verdict.approvalRequired ? "REQUIRED" : "NOT_REQUIRED"}`,
        `reasons:${verdict.reasonCodes.join("+")}`,
        ...verdict.matchedGlobs.length > 0 ? [`globs:${verdict.matchedGlobs.map((g) => clip(g)).join("|")}`] : [],
        `origin:${origin}`
      ].join(":")
    });
  };
  const senderOf = (exec) => {
    if (!exec || typeof exec !== "object")
      return "";
    const agent = exec.agent;
    if (!agent || typeof agent !== "object")
      return "";
    const rec = agent;
    const session = rec.session;
    if (session && typeof session === "object") {
      const sid = session.id;
      if (typeof sid === "string" && sid.trim() !== "")
        return normalizeContactId(sid);
    }
    return typeof rec.id === "string" && rec.id.trim() !== "" ? normalizeContactId(rec.id) : "";
  };
  const CONTACT_TARGET_ARG_NAMES = ["agent_id", "to", "target"];
  const SPAWN_TOOL_NAMES = new Set(["subagent"]);
  const channelOf = (toolName) => {
    if (SPAWN_TOOL_NAMES.has(toolName))
      return "spawn";
    const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.some((t) => t === "spawn" || t === "delegate" || t === "subagent" || t === "workflow") ? "spawn" : "message";
  };
  const firstContactTarget = (args) => {
    if (!args || typeof args !== "object" || Array.isArray(args))
      return "";
    const rec = args;
    for (const argName of CONTACT_TARGET_ARG_NAMES) {
      const value = rec[argName];
      if (typeof value === "string" && value.trim() !== "")
        return normalizeContactId(value);
    }
    return "";
  };
  const delegationRequestOf = (exec) => {
    if (!exec || typeof exec !== "object")
      return;
    const rec = exec;
    const toolName = typeof rec.name === "string" ? rec.name : "";
    const args = rec.arguments;
    const argsRec = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const stringList = (value) => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") ? value : undefined;
    const requestedTools = stringList(argsRec.requestedTools);
    const requestedPaths = stringList(argsRec.requestedPaths);
    const riskLevel = typeof argsRec.riskLevel === "string" ? argsRec.riskLevel : undefined;
    const taskClass = normalizeTaskClass(argsRec.capabilityClass) ?? normalizeTaskClass(rec.capabilityClass);
    const approvalGranted = typeof argsRec.approvalGranted === "boolean" ? argsRec.approvalGranted : undefined;
    const delegationShaped = SPAWN_TOOL_NAMES.has(toolName) || requestedTools !== undefined || requestedPaths !== undefined || riskLevel !== undefined || taskClass !== undefined || approvalGranted !== undefined;
    if (!delegationShaped)
      return;
    return {
      toolName,
      request: {
        taskClass,
        requestedTools: [toolName, ...requestedTools ?? []],
        requestedPaths,
        riskLevel,
        approvalGranted
      }
    };
  };
  const service = {
    decide(input) {
      const result = decideWorkflow(limits, input);
      observability.record("workflow_decision", {
        workflowDecisionId: genId("wfdec"),
        detail: `${result.decision}${result.degradedFrom ? `:from:${result.degradedFrom}` : ""}:${result.closeGate}`
      });
      return result;
    },
    buildDelegationScope: (scope) => buildDelegationScope(scope),
    limits: () => limits,
    evaluatePathScope: (path) => evaluatePathScope(limits, path),
    canCloseTask: (input) => canCloseTask(limits, input),
    evaluateContact: (contact) => evaluateAgentContact(limits, contact),
    evaluateDelegation: (request) => {
      const verdict = evaluateOverreach(limits, request);
      auditOverreach(verdict, "service");
      return verdict;
    }
  };
  ctx.on("tools/pre-execute", async (exec, next) => {
    const toolName = typeof exec?.name === "string" ? exec.name : "";
    if (toolName !== "") {
      const sender = senderOf(exec);
      const target = sender !== "" ? firstContactTarget(exec?.arguments) : "";
      if (target !== "") {
        const decision = evaluateAgentContact(limits, {
          from: sender,
          to: target,
          channel: channelOf(toolName)
        });
        if (decision.flagged) {
          auditContact(decision, sender, target, "tools_pre_execute", { tool: toolName });
          if (decision.blocked) {
            return {
              kind: "deny",
              reason: `supreme-workflow-policy: inter-agent ${decision.channel} outside the declared contact graph (${A2A_CONTACT_DENIED_REASON})`
            };
          }
        }
      }
    }
    const delegation = delegationRequestOf(exec);
    if (delegation !== undefined) {
      auditOverreach(evaluateOverreach(limits, delegation.request), "tools_pre_execute", delegation.toolName);
    }
    return next();
  });
  ctx.on("subagent/start", (info) => {
    const childId = typeof info?.id === "string" ? normalizeContactId(info.id) : "";
    if (childId === "")
      return;
    const provider = typeof info?.provider === "string" ? info.provider : "unknown";
    const decision = evaluateAgentContact(limits, {
      from: `provider:${provider}`,
      to: childId,
      channel: "spawn"
    });
    auditContact(decision, `provider:${provider}`, childId, "subagent_start", {
      subagent: childId,
      outcome: "DETECTED"
    });
  });
  ctx.on("workflow/agent-start", (info, agent) => {
    const metaName = typeof info?.meta?.name === "string" ? info.meta.name : undefined;
    const from = `workflow:${metaName ?? (typeof info?.id === "string" ? info.id : "unknown")}`;
    const childId = typeof agent?.childId === "string" ? normalizeContactId(agent.childId) : typeof agent?.label === "string" ? normalizeContactId(agent.label) : "";
    if (childId === "")
      return;
    const decision = evaluateAgentContact(limits, { from, to: childId, channel: "spawn" });
    auditContact(decision, from, childId, "workflow_agent_start", {
      workflow: metaName,
      outcome: "DETECTED"
    });
  });
  ctx.provide("supremeWorkflowPolicy", Object.freeze(service));
  ctx.logger.info("supreme-workflow-policy active (maxConcurrent=%d maxTotal=%d maxDepth=%d a2a=%s contacts=%d maxRisk=%s approvalFor=%d)", limits.maxConcurrentAgents, limits.maxTotalAgents, limits.maxDepth, limits.agentContactPolicy, limits.allowedContacts.length, limits.maxRiskLevel, limits.approvalRequiredFor.length);
}
function genId(prefix) {
  const g = globalThis;
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
export {
  name,
  inject,
  apply,
  Config
};
