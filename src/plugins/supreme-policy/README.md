# supreme-policy

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremePolicy`**

## Purpose

The cost/risk admission authority for DSH Supreme. Decides — deterministically, with no network and no injected dependencies — whether a route may be used (cost class), what verification a task demands (risk class), and whether delegation is permissible (depth, secret access). It also exposes a compact derived summary suitable for a system-prompt contribution.

## When to mount

- **Every composition.** Policy is the only Supreme plugin mounted in `core`, and everything else either consults it or is gated by it.
- Mount it **before** verifier / router / workflow-policy in the composition order — they inject `supremePolicy`.
- Use `executionClass` to express the profile: `CORE`, `STANDARD`, `SUPREME` in production-like profiles; `LAB` only in the lab composition.

## When NOT to mount

- Never mount two instances with conflicting `executionClass` in one context — downstream plugins read whichever `supremePolicy` they resolve, so conflicting instances produce ambiguous policy.
- Never mount with `allowPaid: true` or `allowTrial: true` outside LAB — `validatePolicyConfig` throws (`PolicyConfigError`) at apply time, failing the boot.
- Not a router, meter, or credential store; it holds no state beyond the frozen config.

## Injected services

Exact names — the plugin declares **none**:

```ts
export const inject: string[] = [];
```

## Config

Resolved via Standard Schema (zod 4), then re-validated deterministically by `validatePolicyConfig`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `executionClass` | `CORE \| STANDARD \| SUPREME \| LAB` | `STANDARD` | Profile this instance guards. |
| `allowPaid` | boolean | `false` | Paid routes denied unless `true` **and** `executionClass=LAB`. |
| `allowTrial` | boolean | `false` | Trial routes denied unless `true` **and** `executionClass=LAB`. |
| `allowUnknownCost` | literal `false` | `false` | Must be `false`. UNKNOWN cost is **always denied** in v1 (hard rule). |
| `requireVerificationForHighRisk` | boolean | `true` | HIGH risk ⇒ `REQUIRED` verification; if `false`, HIGH degrades to `BASIC`. |
| `maxDelegationDepth` | integer 1–8 | `3` | Delegation depth bound. |
| `enableUnicodeSanitization` | boolean | `true` | v1.2: hidden/bidi Unicode taint scan on tool arguments. |
| `logTaintAttempts` | boolean | `true` | v1.2: `taint_detected` audit events (metadata only, never values). |
| `taintPolicy` | `LOG_ONLY \| DENY` | `LOG_ONLY` | v1.2: enforcement mode for tainted calls. |
| `reasoningTracePolicy` | `OFF \| AUDIT \| ENFORCE` | `OFF` | v1.2: CoT presence gate. ENFORCE is rejected on the CORE floor. |
| `cotVisibilityProfiles` | `Record<string, 'verbose'\|'terse'\|'none'>` | `{}` | v1.3: routeId → expected CoT visibility. `none` routes NEVER deny on `cot_missing` (Astra-class empty-CoT models) — audit-only. |
| `riskGatedCoT` | boolean | `false` | v1.3: `ENFORCE` for CoT applies only to HIGH-risk (command/network/write) tool calls; others keep AUDIT. |
| `denyCircumventionGuard` | boolean | `true` | v1.3: same-shape retry of an already-denied call is denied with `deny_retry` + audit. Fires only on retries — first-time calls unaffected. |
| `enableEncodingScan` | boolean | `false` | v1.3: long base64/hex runs in argument strings become taint class `encoding_blob` (same event/enforcement surface as the Unicode scan). |
| `capabilityClassGate` | `OFF \| AUDIT \| ENFORCE` | `OFF` | v1.3: gate for requests carrying the shared `capabilityClass` field. |
| `sanctionedCapabilityClasses` | string[] | `[]` | v1.3: sanctioned classes for this profile. Default `[]` ⇒ every labeled request is flagged (labels restrict, never grant). |
| `labCapabilityClassAllowlist` | string[] | `[]` | v1.3: additive sanction, applied ONLY when `executionClass=LAB`. |

## v1.3 shared signal contract (`CapabilitySignal`)

The engine exports `CapabilitySignal { capabilityClass?: string; cotVisibility?: CotVisibility }`. Any request/decision payload the adapter already receives (the `tools/pre-execute` exec object, or the parsed arguments' top level) may carry these EXACT field names; the policy consumes them verbatim:

- `cotVisibility` — highest-precedence CoT visibility (before `cotVisibilityProfiles[routeId]`, before the `verbose` default).
- `capabilityClass` — capability-class label (normalized trim+uppercase). Unsanctioned labels audit (`capability_class_unsanctioned`) under AUDIT and deny under ENFORCE; requests without a class pass untouched.

`routeId` at the tools seam resolves to the executing agent's id (tool name for agent-less dispatches).

## v1.3 deny-circumvention guard

After any `{kind:'deny'}` decision on the `tools/pre-execute` seam (including denies from other listeners / the approval gate observed on pass-through), the call's normalized signature — tool name + argument SHAPE (argument names + primitive types, **never values**) — is recorded in a session-scoped bounded set. A later call with the SAME signature is denied with reason code `deny_retry` + audit event. `resetDenyCircumvention(sessionId)` is the operator escape hatch; signature bookkeeping is deterministic (insertion-order eviction, bounded).

## Public service contract (`supremePolicy`)

| Method | Returns | Description |
|---|---|---|
| `config` | `Readonly<SupremePolicyConfig>` | Frozen, validated configuration. |
| `evaluateRoute({ costClass, risk })` | `{ allowed, reasonCodes, verificationRequired }` | Route admission by cost class; UNKNOWN ⇒ `COST_UNKNOWN_DENIED` regardless of config. |
| `evaluateDelegation({ depth, secretAccess })` | `{ allowed, reasonCodes }` | Denies `SECRET_ACCESS_DELEGATION_DENIED` when `secretAccess`, and `DELEGATION_DEPTH_EXCEEDED` past `maxDelegationDepth`. |
| `verificationRequirement({ risk, costClass? })` | `NONE \| BASIC \| REQUIRED \| STRICT` | HIGH→REQUIRED (or BASIC), MEDIUM→BASIC, PAID-in-LAB→STRICT, else NONE. |
| `executionPolicy()` | compact summary | Derived state (`paidRoutes: DENY \| ALLOW_LAB_ONLY`, `unknownCost: DENY`, depth bound) safe for prompt contribution. |
| `scanArguments(value)` | `ScanFindings` | v1.2/v1.3: Unicode taint classes + `encoding_blob` hits (arg NAME + run length only, never values). |
| `cotGate(input)` | `CoTGateDecision` | v1.2 presence gate (OFF<AUDIT<ENFORCE; unknown evidence never denied). |
| `cotEnforcement(input)` | `CoTGateDecision` | v1.3: visibility profile + risk-gated enforcement pipeline. |
| `resolveCotVisibility({ explicit, routeId })` | `CotVisibility` | v1.3: explicit > profile > `'verbose'`. |
| `classifyToolRisk(toolName)` | `RiskClass` | v1.3: deterministic HIGH for command/network/write tool-name tokens. |
| `capabilityGate({ capabilityClass })` | `CapabilityGateDecision` | v1.3: OFF/AUDIT/ENFORCE gate; absent class passes. |
| `recordDeny(sessionId, tool, args)` | void | v1.3: record denied-call shape (no values) for a session. |
| `denyCircumventionCheck(sessionId, tool, args)` | `DenyRetryCheck` | v1.3: read-only `deny_retry` check. |
| `resetDenyCircuvention(sessionId)` | void | v1.3: clear a session's deny signatures. |
| `extractSignal(payload)` | `CapabilitySignal` | v1.3: shared signal extraction (exact field names). |

## Security boundary

- Unknown cost class can never become permission: `allowUnknownCost` is schema-pinned to `false` and the evaluator hard-denies UNKNOWN.
- LAB permissions cannot leak into production: `allowPaid`/`allowTrial` are rejected unless `executionClass=LAB` (checked at apply, enforced again in the scenario gate `policy_loads_and_gates_cost`).
- Delegation with any secret-access requirement is denied outright.
- The service object is `Object.freeze`d; config is frozen after validation.

## Data retained

**None.** The plugin is stateless: no files, no event subscriptions, no records. Its only output is decisions returned to callers.

## Model-visible behavior

None. Host-side only; registers no tools and no system-prompt sections.

## Limitations

- Purely cost/risk-classification based; it does not know live quotas, health, or credentials (that is the router's job via its own gates).
- `maxDelegationDepth` bounds declared depth inputs only; it cannot observe actual runtime delegation by itself.
- No dynamic reconfiguration: config is frozen at apply time; changes require re-mount.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: policy.production-defaults, … (6 checks)
node dsh-supreme/real/boot.mjs --profile core --setup    # mounts policy as CORE
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: policy_loads_and_gates_cost (9/9 PASS)
```
