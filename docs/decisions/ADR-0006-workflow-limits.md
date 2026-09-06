# ADR-0006: Workflow limits — conservative defaults (maxConcurrent=3, maxTotal=12, maxDepth=2), degradation ladder, DENY_ALL secret policy

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

Unbounded delegation is the fastest way to lose money, blow context budgets, and create opaque failure cascades: each subagent can spawn more subagents, each workflow can fan out arbitrarily, and credential-handling tasks must never be delegated at all. DSH provides the execution seams (`ctx.subagents`, `ctx.workflowEngine`) but no opinionated limits policy. Supreme needed a deterministic admission layer that errs on the restrictive side and degrades instead of failing.

## DECISION

1. **Conservative defaults, schema-bounded ranges:**
   - `maxConcurrentAgents = 3` (hard range 1–8),
   - `maxTotalAgents = 12` (hard range 1–32),
   - `maxDepth = 2` (hard range 0–4),
   - `workflowTimeoutMs = 600 000`, `subagentTimeoutMs = 120 000` (each ≥ 1000),
   - `allowedSubagentProviders = ['in-process']` (non-empty array).
   `validateWorkflowLimits` re-validates after the schema; out-of-range values throw `WorkflowConfigError` at boot.
2. **Degradation ladder, never re-escalation:** the decision order is `SUPREME_WORKFLOW → WORKFLOW → SUBAGENT → DIRECT`. Baseline comes from task shape (simple + non-parallel ⇒ DIRECT; parallelizable complex / multi_stage ⇒ WORKFLOW; else SUBAGENT; complex + HIGH-risk with providers and bounded load may escalate to SUPREME_WORKFLOW **once**, up front). While constraints are violated — concurrency saturated, no allowed provider, token pressure > 0.85 — the decision steps **down** the ladder, never up. Fan-out never increases after failure.
3. **Hard DENYs:** secret-access requests (`SECRET_ACCESS_DELEGATION_DENIED`), missing required capabilities (`MISSING_CAPABILITY:*`), depth beyond `maxDepth` (`DELEGATION_DEPTH_EXCEEDED`). Total-agent-budget exhaustion degrades to DIRECT with `TOTAL_AGENT_BUDGET_EXHAUSTED` rather than failing the task.
4. **`DENY_ALL` secret policy is structural:** `buildDelegationScope` throws `WorkflowConfigError` unless `secretPolicy === 'DENY_ALL'`; `task`, `expectedOutput`, and `stopCondition` are mandatory fields. A delegation without a stated stop condition or secret policy is a type error, not a runtime surprise.
5. **Policy, not interception:** the plugin never starts or stops subagents/workflows; hosts consult `decide()` before using the official seams, and every decision is recorded to observability (`workflow_decision` with id and degradation detail).

## EVIDENCE

- Engine: `src/plugins/supreme-workflow-policy/engine.ts` (`WORKFLOW_LIMIT_DEFAULTS`, `validateWorkflowLimits`, `decideWorkflow` ladder loop, `buildDelegationScope`), adapter: `src/plugins/supreme-workflow-policy/index.ts`.
- Verified upstream seams cited in the adapter header: `ctx.subagents` (`packages/subagent/subagent/src/index.ts`), `ctx.workflowEngine` (`packages/workflow/workflow/src/index.ts`).
- Level-A checks (8/8 PASS): `workflow.simple-direct`, `workflow.parallel-workflow`, `workflow.high-risk-supreme`, `workflow.concurrency-degrades`, `workflow.depth-enforced`, `workflow.secrets-never-delegated`, `workflow.limit-validation`, `workflow.delegation-scope-explicit`.
- Real boots: gate `workflow_respects_limits` PASS in every supreme/lab run — simple tasks decide DIRECT and saturated contexts (activeAgents=99) degrade to DIRECT with `CONCURRENCY_LIMIT`; the lab composition exercises the config override path (`maxConcurrentAgents: 4`).

## ALTERNATIVES

- **Aggressive defaults (e.g. concurrency 8, depth 4).** Rejected: defaults are what run when nobody tunes anything; they must be the safe case, and the schema ranges leave headroom for explicit tuning.
- **Fail the task when limits are hit.** Rejected for the soft constraints: degrading to DIRECT completes the task; only secret access, missing capabilities, and depth violations are hard DENYs, because those are safety properties rather than capacity properties.
- **Intercept subagent/workflow calls via events.** Rejected: turns policy into a monkey-patch of upstream seams, couples Supreme to execution internals, and breaks the ownership table (execution belongs to `ctx.subagents`/`ctx.workflowEngine`).
- **Per-scope secret policy options (e.g. `secretPolicy: 'READ_ONLY'`).** Rejected: credential inspection is never delegable; allowing an option invites eventual misuse. The type only accepts `'DENY_ALL'`.

## CONSEQUENCES

- Positive: bounded blast radius for delegation; deterministic, explainable decisions with reason codes; secret inspection structurally undelegatable; observability of every decision including degradations.
- Negative: conservative defaults may under-parallelize legitimately large tasks until an operator raises them explicitly (range-bounded).
- Neutral: enforcement depends on hosts consulting `decide()`; the plugin cannot observe live runtime state, so callers must supply truthful `activeAgents` / `totalAgentsUsed` / `depth` inputs.

## ROLLBACK

Lower the policy to pass-through by config within schema ranges (`maxConcurrentAgents: 8`, `maxTotalAgents: 32`, `maxDepth: 4`) — though never to secret-policy permissiveness, which has no config knob by design. To remove the policy entirely, unmount `supreme-workflow-policy` from the composition; nothing else injects it (the gate driver mounts only in gate profiles). The `DENY_ALL` rule is enforced in code, so a code rollback of that specific rule requires an engine change plus a new ADR — it must never be a silent edit.
