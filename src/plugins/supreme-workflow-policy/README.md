# supreme-workflow-policy

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeWorkflowPolicy`**

## Purpose

Owns **WHEN and HOW** the official `ctx.subagents` / `ctx.workflowEngine` are used. It is **not** another subagent registry or workflow engine — it decides, exposes the typed policy the host consults before using the official services, and records every decision to observability.

## When to mount

- Compositions that delegate or orchestrate: `supreme`, `lab`.
- Mount **last among the policy plugins**: it injects policy, observability, and verifier, so all three must be present.

## When NOT to mount

- `core` / `standard` (no delegation in those profiles).
- Never as an execution engine: if you find yourself asking this plugin to *spawn* something, you are using the wrong service — call `ctx.subagents` / `ctx.workflowEngine` yourself, with this plugin's `decide()` as the admission check.

## Injected services

Exact names:

```ts
export const inject = ['supremePolicy', 'supremeObservability', 'supremeVerifier', 'subagents', 'workflowEngine'];
```

Verified against the pin: `ctx.subagents` = `SubagentRuntime` (`packages/subagent/subagent/src/index.ts`), `ctx.workflowEngine` (`packages/workflow/workflow/src/index.ts`). Both are consumed only as declared seams — the plugin never starts subagents or workflows itself.

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `maxConcurrentAgents` | integer 1–8 | `3` | Conservative concurrency bound (LAB profile raises it to 4). |
| `maxTotalAgents` | integer 1–32 | `12` | Total agent budget per horizon. |
| `maxDepth` | integer 0–4 | `2` | Delegation depth bound. |
| `workflowTimeoutMs` | integer ≥ 1000 | `600 000` | Workflow run timeout constant. |
| `subagentTimeoutMs` | integer ≥ 1000 | `120 000` | Subagent timeout constant. |
| `allowedSubagentProviders` | string[] (non-empty) | `['in-process']` | Provider allowlist for delegation. |

## Public service contract (`supremeWorkflowPolicy`)

| Method | Returns | Description |
|---|---|---|
| `decide(input)` | `WorkflowDecisionResult` | Deterministic decision `DIRECT \| SUBAGENT \| WORKFLOW \| SUPREME_WORKFLOW \| DENY` with reason codes, `degradedFrom`, limits, and `expectedVerification` (`REQUIRED` for HIGH risk). Records a `workflow_decision` observability event. |
| `buildDelegationScope(scope)` | `Readonly<DelegationScope>` | Validates + freezes an explicit delegation scope; `secretPolicy` must be `'DENY_ALL'` and `task` / `expectedOutput` / `stopCondition` are mandatory (type-level rejection otherwise). |
| `limits()` | `WorkflowLimitsConfig` | Effective validated limits. |

Decision procedure: hard DENY for secret-access requests (`SECRET_ACCESS_DELEGATION_DENIED`), missing required capabilities, or depth beyond `maxDepth`; baseline from task shape (`simple` + non-parallel → DIRECT, parallelizable complex / multi_stage → WORKFLOW, else SUBAGENT); SUPREME_WORKFLOW only for complex + HIGH-risk with providers and bounded load; then the **degradation ladder** `SUPREME_WORKFLOW → WORKFLOW → SUBAGENT → DIRECT` (never increases fan-out after failure) while concurrency, provider allowlist, or token pressure (> 0.85) constraints are violated.

## Security boundary

- **`DENY_ALL` secret policy is structural:** `buildDelegationScope` throws unless `secretPolicy === 'DENY_ALL'` — credential/secret inspection is never delegated, ever.
- Delegation scopes must state task, expected output, stop condition, allowed capabilities/paths, and verification requirement — a vague delegation is a type error.
- Every decision is recorded to observability (`workflow_decision` with decision id and degradation detail).
- `maxTotalAgents` exhaustion degrades to DIRECT rather than failing the task.

## Data retained

None on disk. In-memory limits only; decisions go to the observability store as `{ workflowDecisionId, detail: '<decision>[:from:<degradedFrom>]' }`.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections. (Delegation scope text reaches a subagent only if the *host* passes it when calling the official services.)

## Limitations

- Policy only: it cannot observe actual live subagent/workflow state; callers must supply `activeAgents`, `totalAgentsUsed`, and `depth` truthfully.
- Token-pressure degradation depends on the caller-provided `tokenPressure` input (the memory-policy probe reports `null` in v1).
- The decision is advisory to the host: enforcement happens because hosts consult `decide()` before using the official seams, not because the engine intercepts them.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: workflow.* (8 checks)
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: workflow_respects_limits (simple=DIRECT, saturated=DIRECT)
node dsh-supreme/real/boot.mjs --profile lab --setup
```
