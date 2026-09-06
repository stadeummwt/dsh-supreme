// dsh-supreme/src/plugins/supreme-workflow-policy/index.ts
import { z } from "zod";

// dsh-supreme/src/plugins/supreme-workflow-policy/engine.ts
var WORKFLOW_LIMIT_DEFAULTS = Object.freeze({
  maxConcurrentAgents: 3,
  maxTotalAgents: 12,
  maxDepth: 2,
  workflowTimeoutMs: 600000,
  subagentTimeoutMs: 120000,
  allowedSubagentProviders: ["spawn"]
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
      expectedVerification: "REQUIRED"
    };
  }
  const missingCaps = input.requiresCapabilities.filter((cap) => !input.availableCapabilities.includes(cap));
  if (missingCaps.length > 0) {
    return {
      decision: "DENY",
      reasonCodes: [`MISSING_CAPABILITY:${missingCaps.join("+")}`],
      limits,
      expectedVerification: "NONE"
    };
  }
  if (input.depth > limits.maxDepth) {
    return {
      decision: "DENY",
      reasonCodes: ["DELEGATION_DEPTH_EXCEEDED"],
      limits,
      expectedVerification: "NONE"
    };
  }
  if (input.totalAgentsUsed >= limits.maxTotalAgents) {
    return {
      decision: "DIRECT",
      reasonCodes: ["TOTAL_AGENT_BUDGET_EXHAUSTED"],
      limits,
      expectedVerification: "BASIC"
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
  return { decision, reasonCodes, degradedFrom, limits, expectedVerification };
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

// dsh-supreme/src/plugins/supreme-workflow-policy/index.ts
var name = "supreme-workflow-policy";
var inject = ["supremePolicy", "supremeObservability", "supremeVerifier", "subagents", "workflowEngine"];
var Config = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  maxTotalAgents: z.number().int().min(1).max(32).default(12),
  maxDepth: z.number().int().min(0).max(4).default(2),
  workflowTimeoutMs: z.number().int().min(1000).default(600000),
  subagentTimeoutMs: z.number().int().min(1000).default(120000),
  allowedSubagentProviders: z.array(z.string()).default(["in-process"])
});
function apply(ctx, config) {
  const limits = validateWorkflowLimits(config);
  const observability = ctx.supremeObservability;
  const service = {
    decide(input) {
      const result = decideWorkflow(limits, input);
      observability.record("workflow_decision", {
        workflowDecisionId: genId("wfdec"),
        detail: `${result.decision}${result.degradedFrom ? `:from:${result.degradedFrom}` : ""}`
      });
      return result;
    },
    buildDelegationScope: (scope) => buildDelegationScope(scope),
    limits: () => limits
  };
  ctx.provide("supremeWorkflowPolicy", Object.freeze(service));
  ctx.logger.info("supreme-workflow-policy active (maxConcurrent=%d maxTotal=%d maxDepth=%d)", limits.maxConcurrentAgents, limits.maxTotalAgents, limits.maxDepth);
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
