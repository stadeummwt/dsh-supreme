# supreme-verifier

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeVerifier`**

## Purpose

A deterministic validator registry enforcing the principle **DETERMINISTIC EVIDENCE > MODEL SELF-CONFIDENCE**: register named validators (text, JSON, file, command), run them against a subject, and get bounded, secret-scrubbed evidence — `PASS` / `FAIL` / `ERROR` / `UNAVAILABLE`, never a fabricated pass.

Since v1.3.1 (Improvement §3A) every verification can additionally be recorded as an **evidence record bound to identity**: task id, attempt number and the sha-256 of the exact artifact bytes that were verified — so a PASS recorded against one revision of an artifact can never clear a task whose artifact has changed since.

## When to mount

- Any composition that needs acceptance checks: `standard` (file/text validators), `supreme`, `lab`.
- Mount **after** `supreme-policy` (hard inject) and with observability present if you want verification events recorded.
- In LAB, mount with `allowCommands: true` to unlock `command-exit` / `test-suite` validators.
- Whenever a workflow-policy close gate (`requireVerifierPassOnClose`) should be **evidence-bound**: record with `runAndRecord`, hash the current artifact with `hashArtifact`, and hand both to `supremeWorkflowPolicy.canCloseTask`.

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
| `maxFileReadBytes` | integer ≥ 1 | `8 388 608` | Hard read bound for `file-hash` content reads and `hashArtifact`; larger artifacts refuse hash comparison. |

## Public service contract (`supremeVerifier`)

| Method | Returns | Description |
|---|---|---|
| `register(spec)` | `() => void` | Registers `{ validatorId, type, config }`; duplicate id or unknown type throws; returns the unregister disposer. |
| `list()` | `string[]` | Registered validator ids. |
| `run(validatorId, subject?)` | `Promise<VerifierResult>` | Runs one validator; unknown id ⇒ `UNAVAILABLE` / `VALIDATOR_NOT_FOUND` (never throws). |
| `runAll(subject?)` | `Promise<VerifierResult[]>` | Runs every registered validator sequentially. |
| `config()` | `VerifierConfig` | Effective, path-resolved configuration. |
| `hashArtifact(path)` | `Promise<{ sha256: string \| null }>` | **v1.3.1 §3A** — deterministic sha-256 (node crypto) over the CURRENT artifact bytes, under the same real-path confinement and read bounds as file validators. `null` ⇒ currency unknowable (fail-closed), never a match. |
| `runAndRecord(validatorId, identity, subject?)` | `Promise<VerificationEvidence>` | **v1.3.1 §3A** — runs the registered validator and records its verbatim status into an evidence record bound to `{ taskId, attempt, artifact }`. Unknown validator ⇒ explicit `UNAVAILABLE` record. Malformed identity throws `EvidenceError`; a PASS without the artifact hash is never recorded. |

Validator types: `exact-text`, `regex`, `json-parse`, `json-schema` (bounded deterministic subset — see `engine.ts` for the exact keyword list), `file-exists`, `file-hash` (sha-256), `command-exit`, `test-suite`. Result: `{ validatorId, type, status, evidence (≤512 chars, scrubbed), durationMs, reasonCode }`.

## Evidence-bound verification (v1.3.1, Improvement §3A)

### Evidence record shape

`runAndRecord(validatorId, { taskId, attempt, artifact }, subject?)` returns a frozen record:

```ts
{
  schemaVersion: 'dsh-supreme/evidence@1',
  taskId: string,             // bound task identity (≤256 chars)
  attempt: number,            // integer ≥ 1
  artifact: {
    sha256: string,           // 64-hex sha-256 of the verified artifact BYTES
    revision?: string,        // revision/etag when the host tracks one
    path?: string,            // path as given (bounded; never content)
  },
  validatorId: string,
  validatorType: ValidatorType,
  status: 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE',  // verbatim from the run
  reasonCode: string,
  recordedAt: number,
}
```

- The status is copied **verbatim** from the real validator run. An unavailable verifier (unknown validator, capability gap, disabled commands) produces an explicit **`UNAVAILABLE`** record; validator exceptions produce **`ERROR`** — neither is ever rewritten into PASS.
- Every **PASS** record MUST carry the artifact hash (`artifact.sha256`, or `artifact.bytes` + the runtime `hashBytes`). A PASS that cannot be bound to bytes is not recordable (`EvidenceError`) — not silently accepted.
- Records carry ids, statuses, reason codes, hashes and bounded paths ONLY — never artifact content, credentials or hidden reasoning. Sentinel scrubbing applies (`SECRET_SENTINEL[A-Z0-9_]*` → `[REDACTED]`).

### Staleness rule

`isEvidenceCurrent(evidence, currentArtifact)` (engine export) is `true` only when the record is a structurally bound **PASS** whose `artifact.sha256` equals the current artifact's sha-256 (and whose `revision` matches, when both sides carry one). A PASS whose bound hash differs from the **current** artifact bytes is INVALID (stale) — `false`. The companion `evaluateEvidenceForClose(evidence, currentArtifact)` returns the precise verdict: `EVIDENCE_CURRENT_PASS` / `EVIDENCE_NOT_PASS` / `EVIDENCE_UNBOUND` / `EVIDENCE_STALE`.

The workflow close gate consumes these verdicts: under `supremeWorkflowPolicy`'s `requireVerifierPassOnClose`, a **stale PASS is treated exactly like no-PASS** and the close is blocked with `EVIDENCE_STALE`.

### No hidden chain-of-thought

Verification consumes **artifacts, test results, and reviewable result summaries ONLY**. It never ingests hidden chain-of-thought, model confidence, or self-reported claims — and no code path can promote them into a PASS:

- `recordEvidence` / `runAndRecord` take their status exclusively from a real `VerifierResult` produced by `runValidator` (deterministic checks only).
- Inputs carrying self-report fields — `confidence`, `modelConfidence`, `reasoningTrace`, `chainOfThought`, `trace`, `cot`, … (see `FORBIDDEN_EVIDENCE_FIELDS`) — are **rejected outright** with `EvidenceError`, not silently ignored.
- The close gate's `EVIDENCE_STATUS_CONFLICT` blocks any attempt to staple a `PASS` label onto a record whose own status is `FAIL`/`ERROR`/`UNAVAILABLE`.

## Security boundary

- **Never bypasses DSH sandbox/permissions/approval.** Command execution requires BOTH `allowCommands: true` AND mounted `supremePolicy.config.executionClass === 'LAB'`; otherwise the validator returns `UNAVAILABLE` / `COMMAND_EXECUTION_DISABLED` — never a fake PASS.
- **Path confinement (v1.3.1):** file validators confine on REAL paths (fs.realpath), not lexically; a symlink inside a root pointing outside is rejected BEFORE any content read; content reads cross-check the pre-open stat identity (dev/ino) against the open-handle (fstat) identity — race-window reduction, not elimination. Windows junction handling is delegated to fs.realpath but untested on this Linux environment.
- **Fail visible:** validator exceptions become `ERROR` / `VALIDATOR_EXCEPTION` results; unsupported types become `UNAVAILABLE` — no crashes, no invented passes.
- Evidence is bounded (512 chars) and secret-sentinel scrubbed (`SECRET_SENTINEL[A-Z0-9_]*` → `[REDACTED]`); stdout/stderr captured from commands are capped at 2048 chars each.
- **Evidence binding (v1.3.1 §3A):** PASS records are bound to the verified artifact bytes' sha-256; stale records fail `isEvidenceCurrent` and block the HIGH-risk close gate. Confidence/trace inputs are structurally excluded.

## Data retained

None on disk. Results and evidence records are returned to callers; the optional `verification` observability record stores `{ verificationId, verificationStatus, detail: reasonCode }` in the observability JSONL. In-memory registry of validator specs only.

## Model-visible behavior

None. Host-side only; no tools, no prompt sections.

## Limitations

- `json-schema` implements a bounded deterministic subset of JSON Schema, not the whole spec: unsupported keywords/dialects and remote `$ref`s yield `UNAVAILABLE` (keyword named) instead of a guess, and malformed schemas yield `ERROR` — never a silent downgrade to PASS. See `engine.ts` (SCHEMA_LIMITS) for the exact supported set and resource bounds.
- No network-backed validators in v1 despite the `allowNetwork` flag; remote `$ref` resolution is never attempted.
- The registry is per-process; validators must be re-registered after restart (the gate driver re-registers its own at each boot).
- `runAndRecord` binds the artifact hash supplied by the host (or computed from the current bytes at record time when only a path is given). The close gate re-checks currency against a fresh `hashArtifact` at close time; a same-inode in-place rewrite inside that window is the documented residual race (see Security boundary).
- Windows junction/symlink semantics are delegated to node fs realpath but were NOT tested here (Linux only).

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: verifier.* (7 checks)
bun dsh-supreme/real/v131-verifier-hardening.mjs verify  # v1.3.1: real-path confinement + JSON-schema (43 cases)
bun dsh-supreme/real/v131-evidence-binding.mjs           # v1.3.1 §3A: evidence binding + staleness + close gate
node dsh-supreme/real/boot.mjs --profile standard --setup
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: verifier_executes (exact=PASS schema=PASS)
node dsh-supreme/real/boot.mjs --profile lab --setup     # LAB: allowCommands unlocked
```
