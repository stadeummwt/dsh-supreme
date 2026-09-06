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

## Public service contract (`supremePolicy`)

| Method | Returns | Description |
|---|---|---|
| `config` | `Readonly<SupremePolicyConfig>` | Frozen, validated configuration. |
| `evaluateRoute({ costClass, risk })` | `{ allowed, reasonCodes, verificationRequired }` | Route admission by cost class; UNKNOWN ⇒ `COST_UNKNOWN_DENIED` regardless of config. |
| `evaluateDelegation({ depth, secretAccess })` | `{ allowed, reasonCodes }` | Denies `SECRET_ACCESS_DELEGATION_DENIED` when `secretAccess`, and `DELEGATION_DEPTH_EXCEEDED` past `maxDelegationDepth`. |
| `verificationRequirement({ risk, costClass? })` | `NONE \| BASIC \| REQUIRED \| STRICT` | HIGH→REQUIRED (or BASIC), MEDIUM→BASIC, PAID-in-LAB→STRICT, else NONE. |
| `executionPolicy()` | compact summary | Derived state (`paidRoutes: DENY \| ALLOW_LAB_ONLY`, `unknownCost: DENY`, depth bound) safe for prompt contribution. |

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
