// dsh-supreme/src/plugins/supreme-gate-driver/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
var name = "supreme-gate-driver";
var inject = [
  "supremePolicy",
  "supremeObservability",
  "supremeBenchmark",
  "supremeRouter",
  "supremeVerifier",
  "supremeMemoryPolicy",
  "supremeWorkflowPolicy",
  "sessions"
];
var Config = z.object({
  markerPath: z.string().default("dsh-supreme/data/real/gate-driver.markers.jsonl")
});
function apply(ctx, config) {
  const markerPath = resolve(config.markerPath);
  const write = (payload) => {
    mkdirSync(dirname(markerPath), { recursive: true });
    appendFileSync(markerPath, JSON.stringify(payload) + `
`);
  };
  ctx.effect(() => {
    runScenario(ctx).then((results) => write({ event: "SUPREME_GATES", ts: Date.now(), results }), (err) => write({
      event: "SUPREME_GATES",
      ts: Date.now(),
      results: [{ gate: "scenario", status: "ERROR", detail: String(err) }]
    }));
    return () => {
      return;
    };
  }, "supreme-gate-driver.scenario");
}
async function runScenario(ctx) {
  const results = [];
  const gate = (gate2, status, detail) => {
    results.push({ gate: gate2, status, detail });
  };
  const s = {
    policy: ctx.supremePolicy,
    obs: ctx.supremeObservability,
    bench: ctx.supremeBenchmark,
    router: ctx.supremeRouter,
    verifier: ctx.supremeVerifier,
    memory: ctx.supremeMemoryPolicy,
    workflow: ctx.supremeWorkflowPolicy
  };
  const free = s.policy.evaluateRoute({ costClass: "FREE_CONFIRMED", risk: "LOW" });
  const paid = s.policy.evaluateRoute({ costClass: "PAID", risk: "LOW" });
  const unknown = s.policy.evaluateRoute({ costClass: "UNKNOWN", risk: "LOW" });
  const paidOnlyInLab = !paid.allowed || s.policy.config.executionClass === "LAB";
  gate("policy_loads_and_gates_cost", free.allowed && !unknown.allowed && paidOnlyInLab ? "PASS" : "FAIL", `free=${free.allowed} paid=${paid.allowed} (labOnly=${String(paidOnlyInLab)}) unknown=${unknown.allowed}`);
  try {
    const session = ctx.sessions.create();
    gate("session_canonical", "PASS", `real DSH session created (id=${String(session.id).slice(0, 18)}…)`);
  } catch (err) {
    gate("session_canonical", "ERROR", String(err));
  }
  try {
    await s.bench.recordTask({ taskId: "gate-task-1", category: "synthetic" });
    const runId = await s.bench.startRun({
      taskId: "gate-task-1",
      taskCategory: "synthetic",
      provider: "synthetic-free",
      model: "synthetic-mini",
      profile: "gate"
    });
    await s.bench.finishRun(runId, { success: true, latencyMs: 42, toolCount: 0 });
    await s.bench.recordScore({ runId, qualityScore: 0.9 });
    const agg = s.bench.aggregateModelPerformance();
    const ok = agg.some((a) => a.provider === "synthetic-free" && a.samples >= 1 && a.avgQuality !== null);
    gate("benchmark_stores_evidence", ok ? "PASS" : "FAIL", `agg=${JSON.stringify(agg.map((a) => [a.provider, a.samples]))}`);
  } catch (err) {
    gate("benchmark_stores_evidence", "ERROR", String(err));
  }
  try {
    const decision = await s.router.route({ requiredCapabilities: ["chat"] });
    const paidGateFailed = decision.hardGates.some((g) => g.candidate.includes("paid") && g.gate === "policy_cost" && !g.passed);
    const failedSummary = decision.hardGates.filter((g) => !g.passed).map((g) => `${g.candidate}:${g.gate}:${g.reason ?? ""}`).slice(0, 6).join(" | ");
    gate("router_selects_eligible", decision.blocked === null ? "PASS" : "FAIL", `${decision.provider ?? "none"}/${decision.model ?? "none"} score=${decision.score ?? "n/a"} failed=[${failedSummary}]`);
    gate("router_rejects_paid", paidGateFailed ? "PASS" : "FAIL", `paid policy_cost gate failed=${String(paidGateFailed)}`);
  } catch (err) {
    gate("router_selects_eligible", "ERROR", String(err));
  }
  try {
    s.verifier.register({ validatorId: "gate-exact", type: "exact-text", config: { expected: "supreme" } });
    s.verifier.register({
      validatorId: "gate-schema",
      type: "json-schema",
      config: { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } }
    });
    const pass = await s.verifier.run("gate-exact", "supreme");
    const schema = await s.verifier.run("gate-schema", '{"ok":true}');
    gate("verifier_executes", pass.status === "PASS" && schema.status === "PASS" ? "PASS" : "FAIL", `exact=${pass.status} schema=${schema.status}`);
  } catch (err) {
    gate("verifier_executes", "ERROR", String(err));
  }
  try {
    const selection = s.memory.select({ taskText: "summarize the project plan", budgetTokens: 400 });
    const secretFree = selection.excluded.some((e) => e.reason === "SECRET_CATEGORY");
    const withinBudget = selection.totalEstimatedTokens <= 400;
    gate("memory_respects_budget", withinBudget ? "PASS" : "FAIL", `used=${selection.totalEstimatedTokens}/${selection.budgetTokens} secretExcluded=${String(secretFree)}`);
  } catch (err) {
    gate("memory_respects_budget", "ERROR", String(err));
  }
  try {
    const simple = s.workflow.decide({
      complexity: "simple",
      parallelizable: false,
      risk: "LOW",
      requiresCapabilities: [],
      availableCapabilities: [],
      availableProviders: ["spawn"],
      depth: 0,
      activeAgents: 0,
      totalAgentsUsed: 0
    });
    const saturated = s.workflow.decide({
      complexity: "complex",
      parallelizable: true,
      risk: "LOW",
      requiresCapabilities: [],
      availableCapabilities: [],
      availableProviders: ["spawn"],
      depth: 0,
      activeAgents: 99,
      totalAgentsUsed: 0
    });
    const ok = simple.decision === "DIRECT" && (saturated.decision === "DIRECT" || saturated.reasonCodes.includes("CONCURRENCY_LIMIT"));
    gate("workflow_respects_limits", ok ? "PASS" : "FAIL", `simple=${simple.decision} saturated=${saturated.decision}`);
  } catch (err) {
    gate("workflow_respects_limits", "ERROR", String(err));
  }
  try {
    s.obs.record("gate_driver_event", { detail: "synthetic" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const stats = s.obs.stats();
    gate("observability_records_safely", stats.written > 0 ? "PASS" : "FAIL", `written=${stats.written} dropped=${stats.dropped}`);
  } catch (err) {
    gate("observability_records_safely", "ERROR", String(err));
  }
  return results;
}
export {
  name,
  inject,
  apply,
  Config
};
