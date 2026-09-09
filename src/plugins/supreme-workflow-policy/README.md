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
| `agentContactPolicy` | `LOG_ONLY \| DENY` | `LOG_ONLY` | v1.3 P2 A2A contact policy. `LOG_ONLY` audits out-of-graph contacts; `DENY` additionally blocks them pre-fact (`a2a_contact_denied`). |
| `allowedContacts` | `{ from, to }[]` | `[]` | v1.3 P2 declared inter-agent contact graph — directed `from → to` edges of agent ids/roles. **Empty = policy inert** (behavior-preserving default, mirroring the path-scope empty-allowlist convention). |
| `maxRiskLevel` | `LOW \| MEDIUM \| HIGH` | `HIGH` | v1.3 P3 overreach ceiling — requested risk above this level is audited as `overreach_suspected`. Default `HIGH` = unchanged. |
| `approvalRequiredFor` | string[] | `[]` | v1.3 P3 task classes that require an approval flag (`approvalGranted`) on the delegation request. |
| `commsToolNames` | string[] (non-empty, ≤128) | `[]` | v1.3.1 (FIX-D) extra tool names treated as communication/delegation tools — **extends** the trusted `DEFAULT_COMMS_TOOL_REGISTRY` (can never remove or shadow a default entry). Tool identity is registry-based only: never argument names, never model-provided labels. |

## Public service contract (`supremeWorkflowPolicy`)

| Method | Returns | Description |
|---|---|---|
| `decide(input)` | `WorkflowDecisionResult` | Deterministic decision `DIRECT \| SUBAGENT \| WORKFLOW \| SUPREME_WORKFLOW \| DENY` with reason codes, `degradedFrom`, limits, and `expectedVerification` (`REQUIRED` for HIGH risk). Records a `workflow_decision` observability event. |
| `buildDelegationScope(scope)` | `Readonly<DelegationScope>` | Validates + freezes an explicit delegation scope; `secretPolicy` must be `'DENY_ALL'` and `task` / `expectedOutput` / `stopCondition` are mandatory (type-level rejection otherwise). |
| `limits()` | `WorkflowLimitsConfig` | Effective validated limits. |
| `evaluatePathScope(path)` | `PathScopeDecision` | v1.2 surgical path scope: blocked globs win, empty allowlist = unrestricted. |
| `canCloseTask(input)` | `CloseDecision` | v1.2 close gate: HIGH risk closes only on recorded verifier PASS when `requireVerifierPassOnClose`. **v1.3.1 (IMP-V) evidence-bound:** pass `evidence` (a bound `VerificationEvidence` from `supremeVerifier.runAndRecord`) plus `artifact` (the CURRENT artifact identity, `hashArtifact` output) and the PASS must further match the current artifact's sha-256/revision — stale (`EVIDENCE_STALE`), unbound (`EVIDENCE_UNBOUND`), status-conflicting (`EVIDENCE_STATUS_CONFLICT`) or unverifiable (`EVIDENCE_CURRENCY_UNVERIFIED`) evidence blocks with a clear reason. Close-gate verdicts under an ACTIVE gate are audited as value-free `close_gate` events. |
| `evaluateContact(contact)` | `AgentContactDecision` | v1.3 P2 deterministic A2A contact-graph evaluation (host admission check before `subagents.start` / `sendMessage` / `workflowEngine.start`). |
| `evaluateDelegation(request)` | `OverreachDecision` | v1.3 P3 deterministic overreach evaluation; records `overreach_suspected` when overreach (audit-only, never denies). |

Decision procedure: hard DENY for secret-access requests (`SECRET_ACCESS_DELEGATION_DENIED`), missing required capabilities, or depth beyond `maxDepth`; baseline from task shape (`simple` + non-parallel → DIRECT, parallelizable complex / multi_stage → WORKFLOW, else SUBAGENT); SUPREME_WORKFLOW only for complex + HIGH-risk with providers and bounded load; then the **degradation ladder** `SUPREME_WORKFLOW → WORKFLOW → SUBAGENT → DIRECT` (never increases fan-out after failure) while concurrency, provider allowlist, or token pressure (> 0.85) constraints are violated.

## v1.3 — A2A contact policy (P2)

New risk class (ASTRA research): proactive agents finding/contacting other agents **outside the declared workflow graph** (the Hugging Face incident pattern).

- **Tool identity FIRST (v1.3.1 FIX-D).** A call is inter-agent communication only if its tool NAME is in the **trusted communication-tool registry** — a deterministic name→channel table, never an argument-name heuristic and never a model-provided label (a model claiming "this is a message tool" is not security authority). The conservative **default registry** (engine `DEFAULT_COMMS_TOOL_REGISTRY`): `subagent`→spawn (the pinned tool-subagent default toolName), `send_message`→message (the pinned steering tool carrying `agent_id`), plus the classic spawn / task-delegation / notify spellings `spawn`, `spawn_agent`, `task`, `task_delegation`, `delegate`, `delegate_task`→spawn and `send`, `send_to_agent`, `message_agent`, `notify_agent`→message. Hosts extend it via the **`commsToolNames`** config key; extension only ADDS names (a config entry cannot shadow a default entry), and each added name gets its channel from a fixed token rule (`spawn`/`delegate`/`subagent`/`workflow` token ⇒ spawn, else message — `inferCommsChannel`).
- **Recipient extraction is gated behind registry identification**: only a registry-identified tool's top-level arguments are read, under the fixed names `agent_id` (the pinned `send_message` tool) / `to` / `target`. An ordinary tool is never inspected, whatever its arguments are called — `copy_file { target: 'b.txt' }` is a file name, not an agent id (this was the v1.3.0 false positive, fixed).
- **Declared graph** = `allowedContacts` directed edges (`{ from, to }` agent ids/roles). Matching is pure directed pair equality on trimmed ids — deterministic, no heuristics, no ML, no content inspection. **Empty graph ⇒ policy inert** (`NO_CONTACT_GRAPH`).
- **Real seams bound** (verified against the pin), with an honest enforcement/audit split:
  - `tools/pre-execute` (waterfall, **pre-fact ENFORCEMENT** for registry-identified comms tools): a call whose resolved recipient is outside the graph ⇒ `a2a_contact` audit; under `DENY` the call is refused **before it executes** with reason code **`a2a_contact_denied`**. A malformed communication call — a registry-identified **message**-channel tool with a missing/empty recipient — is audited explicitly with reason code **`A2A_RECIPIENT_UNRESOLVABLE`** (`a2a_recipient_unresolvable` in the deny reason) and refused pre-fact under `DENY` (fail-closed: an unresolvable recipient cannot be checked against the graph); under `LOG_ONLY` it is audited and allowed. A **spawn** call without a declared target is its normal pinned shape (the childId is assigned post-fact), so it is NOT malformed — it is covered by the post-fact detect audit.
  - `subagent/start` (emit, **post-fact DETECT/audit only**): published child runs are evaluated against the `provider:<name> → <child id>` role edge. Emit mode cannot block ⇒ audited with `outcome:DETECTED`. A spawn without a child ID yet cannot be blocked post-fact — this seam is detection, not enforcement.
  - `workflow/agent-start` (emit, **post-fact DETECT/audit only**): the run's declared `meta.name → agent.childId` edge is evaluated; same DETECT-only audit.
- In-graph contacts pass untouched. Audit events carry channel, bounded from/to ids, reason code, outcome, mode, origin — **never message or argument values**.
- **Known limit (documented, honest):** a communication/delegation tool whose name is in neither the default registry nor `commsToolNames` is NOT A2A-inspected. Registering the host's real comms tool names via `commsToolNames` is the required host duty; the default set is deliberately conservative to avoid the v1.3.0-style false positives.

## v1.3 — Overreach audit (P3)

Astra's residual failure: "broader permissions than the task requires". Audit-only — never denies.

- `evaluateOverreach` checks, in fixed order: (1) **risk ceiling** — explicit `riskLevel` or the max over `requestedTools` via `classifyDelegationToolRisk` (command/network/write ⇒ HIGH mirroring `supreme-policy`'s `classifyToolRisk`; delegation/orchestration tokens ⇒ MEDIUM; read-only/other ⇒ LOW) above `maxRiskLevel` ⇒ `RISK_ABOVE_MAX`; (2) **approval gate** — requested task class (`capabilityClass` shared signal field, trim+uppercase) ∈ `approvalRequiredFor` without `approvalGranted: true` ⇒ `APPROVAL_REQUIRED`; (3) **path scope** — `requestedPaths` checked by the v1.2 `evaluatePathScope` machinery (blocked wins; empty allowlist unrestricted) ⇒ `PATH_SCOPE_EXCEEDED` (only matched config globs are reported).
- At the `tools/pre-execute` seam the check fires only for **delegation-shaped** calls (pinned `subagent` tool name or at least one declared delegation parameter: `capabilityClass`, `requestedTools`, `requestedPaths`, `riskLevel`, `approvalGranted`) — ordinary calls pass untouched.
- `overreach_suspected` detail carries risk level, max allowed level, requested class label, approval-required flag, reason codes and matched globs — labels/levels/flags/counts only, never content values.

## v1.3.1 — Evidence-bound close gate (Improvement §3A)

A bare PASS status is replayable: a PASS recorded against an EARLIER artifact revision must never clear a HIGH-risk task whose artifact changed. When the caller supplies a bound evidence record + the current artifact identity, the gate verifies fail-closed:

1. **Binding** — `taskId`, `attempt ≥ 1` and the sha-256 of the verified artifact bytes must be present and well-formed (`EVIDENCE_UNBOUND` otherwise).
2. **Status authority** — the record's own status wins; a contradicting `verifierStatus` label blocks (`EVIDENCE_STATUS_CONFLICT`), so a PASS label can never be stapled onto a FAIL/UNAVAILABLE record.
3. **Currency** — the bound hash must equal the current artifact's sha-256, and a revision/etag mismatch also counts as stale: **a stale PASS IS no-PASS** (`EVIDENCE_STALE`).
4. **Unknowable** — PASS evidence with no current-artifact identity supplied (or `artifact` given with no record at all) cannot prove coverage and blocks (`EVIDENCE_CURRENCY_UNVERIFIED`).

The v1.2 status-only path is retained unchanged for backward compatibility (suite contract). The evidence shape is owned by `supreme-verifier` (`VerificationEvidence`, schema `dsh-supreme/evidence@1`); this engine keeps a local structural mirror per the no-runtime-engine-import convention — cross-checked on shared records by `real/v131-evidence-binding.mjs`.

## Security boundary

- **`DENY_ALL` secret policy is structural:** `buildDelegationScope` throws unless `secretPolicy === 'DENY_ALL'` — credential/secret inspection is never delegated, ever.
- Delegation scopes must state task, expected output, stop condition, allowed capabilities/paths, and verification requirement — a vague delegation is a type error.
- Every decision is recorded to observability (`workflow_decision` with decision id and degradation detail).
- `maxTotalAgents` exhaustion degrades to DIRECT rather than failing the task.

## Data retained

None on disk. In-memory limits only; decisions go to the observability store as `{ workflowDecisionId, detail: '<decision>[:from:<degradedFrom>]' }`. v1.3 audits (`a2a_contact`, `overreach_suspected`) and the v1.3.1 `close_gate` audit use the same store with value-free `detail` strings (ids, labels, levels, flags, counts, hash prefixes, config glob names only — never content).

## Model-visible behavior

None. Host-side only; no tools, no prompt sections. (Delegation scope text reaches a subagent only if the *host* passes it when calling the official services.)

## Limitations

- Policy only: it cannot observe actual live subagent/workflow state; callers must supply `activeAgents`, `totalAgentsUsed`, and `depth` truthfully.
- Token-pressure degradation depends on the caller-provided `tokenPressure` input (the memory-policy probe reports `null` in v1).
- The decision is advisory to the host: enforcement happens because hosts consult `decide()` before using the official seams, not because the engine intercepts them.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: workflow.* checks
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: workflow_respects_limits (simple=DIRECT, saturated=DIRECT)
node dsh-supreme/real/boot.mjs --profile lab --setup
bun real/v13-workflow-verify.mjs                         # v1.3 E2E: A2A contact policy + overreach audit (real engine + real pinned-cordis adapter)
bun real/v131-a2a-falsepositive.mjs verify               # v1.3.1 FIX-D: A2A false-positive fix (registry-first identity, malformed handling)
bun real/v131-evidence-binding.mjs                       # v1.3.1 IMP-V: evidence-bound verification + stale-PASS close gate
```
