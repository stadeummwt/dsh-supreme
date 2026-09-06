# supreme-verifier

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeVerifier`**

## Purpose

A deterministic validator registry enforcing the principle **DETERMINISTIC EVIDENCE > MODEL SELF-CONFIDENCE**: register named validators (text, JSON, file, command), run them against a subject, and get bounded, secret-scrubbed evidence — `PASS` / `FAIL` / `ERROR` / `UNAVAILABLE`, never a fabricated pass.

## When to mount

- Any composition that needs acceptance checks: `standard` (file/text validators), `supreme`, `lab`.
- Mount **after** `supreme-policy` (hard inject) and with observability present if you want verification events recorded.
- In LAB, mount with `allowCommands: true` to unlock `command-exit` / `test-suite` validators.

## When NOT to mount

- Never as a general task runner: command validators are dual-gated (config + LAB policy) and bounded in output.
- Not a test framework replacement — it produces per-validator evidence records, not suites/reports.

## Injected services

Exact names:

```ts
export const inject = ['supremePolicy'];
```

Optional seams (no inject declaration, via `ctx.get()`): `supremeObservability` — `run()` records a `verification` event when observability is mounted.

Frozen dependency graph: policy → verifier; verifier MUST NOT require workflow-policy.

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `allowCommands` | boolean | `false` | Command execution disabled by default; honored only when mounted policy reports `executionClass=LAB`. |
| `allowNetwork` | boolean | `false` | Network-backed validators disabled by default (no network validators in v1). |
| `allowedRoots` | string[] | `[]` | Absolute path confinement for file validators; resolved at apply. |
| `commandTimeoutMs` | integer ≥ 100 | `30 000` | Spawn timeout for command validators. |

## Public service contract (`supremeVerifier`)

| Method | Returns | Description |
|---|---|---|
| `register(spec)` | `() => void` | Registers `{ validatorId, type, config }`; duplicate id or unknown type throws; returns the unregister disposer. |
| `list()` | `string[]` | Registered validator ids. |
| `run(validatorId, subject?)` | `Promise<VerifierResult>` | Runs one validator; unknown id ⇒ `UNAVAILABLE` / `VALIDATOR_NOT_FOUND` (never throws). |
| `runAll(subject?)` | `Promise<VerifierResult[]>` | Runs every registered validator sequentially. |
| `config()` | `VerifierConfig` | Effective, path-resolved configuration. |

Validator types: `exact-text`, `regex`, `json-parse`, `json-schema` (bounded subset: type/enum/required/properties/items/min/max), `file-exists`, `file-hash` (sha256), `command-exit`, `test-suite`. Result: `{ validatorId, type, status, evidence (≤512 chars, scrubbed), durationMs, reasonCode }`.

## Security boundary

- **Never bypasses DSH sandbox/permissions/approval.** Command execution requires BOTH `allowCommands: true` AND mounted `supremePolicy.config.executionClass === 'LAB'`; otherwise the validator returns `UNAVAILABLE` / `COMMAND_EXECUTION_DISABLED` — never a fake PASS.
- **Path confinement:** file validators resolve the path and require it to live inside one of `allowedRoots`; outside roots ⇒ `UNAVAILABLE` / `PATH_OUTSIDE_ALLOWED_ROOTS`.
- **Fail visible:** validator exceptions become `ERROR` / `VALIDATOR_EXCEPTION` results; unsupported types become `UNAVAILABLE` — no crashes, no invented passes.
- Evidence is bounded (512 chars) and secret-sentinel scrubbed (`SECRET_SENTINEL[A-Z0-9_]*` → `[REDACTED]`); stdout/stderr captured from commands are capped at 2048 chars each.

## Data retained

None on disk. Results are returned to callers; the optional `verification` observability record stores `{ verificationId, verificationStatus, detail: reasonCode }` in the observability JSONL. In-memory registry of validator specs only.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections.

## Limitations

- `json-schema` implements a deterministic subset, not full JSON Schema (no `$ref`, `oneOf`, `patternProperties`, etc.).
- No network-backed validators in v1 despite the `allowNetwork` flag.
- The registry is per-process; validators must be re-registered after restart (the gate driver re-registers its own at each boot).

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: verifier.* (7 checks)
node dsh-supreme/real/boot.mjs --profile standard --setup
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: verifier_executes (exact=PASS schema=PASS)
node dsh-supreme/real/boot.mjs --profile lab --setup     # LAB: allowCommands unlocked
```
