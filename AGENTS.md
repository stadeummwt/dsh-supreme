# AGENTS.md — Engineering rules for DSH Supreme

Rules for any agent or human working in this repository. These are not suggestions; the suite gates and the ADRs exist to enforce them. Where a rule cites a gate, the gate is executable proof.

---

## 1. Frozen 7-plugin scope

The Supreme plugin set is **frozen** at exactly:

```text
supreme-policy          → supremePolicy
supreme-observability   → supremeObservability
supreme-benchmark       → supremeBenchmark
supreme-router          → supremeRouter
supreme-verifier        → supremeVerifier
supreme-memory-policy   → supremeMemoryPolicy
supreme-workflow-policy → supremeWorkflowPolicy
```

- **No new Supreme plugins.** Adding an 8th `supreme-*` plugin is forbidden unless a *proven blocker* is documented first (an executable failing gate + a written ADR explaining why the frozen set cannot absorb the capability). A want-to-have is not a blocker.
- The four support plugins (`supreme-minimal-probe`, `supreme-boot-probe`, `supreme-gate-driver`, `supreme-fake-llm`) are **fixture-classified**: they exist for boot/gate evidence and LAB testing only, register **no model-facing tools**, and must stay out of production compositions.
- Service names above are the frozen Supreme namespace (`Spec §2` naming rule). Do not rename them; the boot probe, gate driver, and suite all key on these exact strings.

## 2. The upstream is read-only

- Pinned upstream: `https://github.com/deepseek-ai/deepseek-harness` at commit `d347e703908d0406b7a7ef80e3a0e594d86b2215` (tag `dsh-v0.1.3-alpha.1`, DSH `0.1.3-alpha.1`, vendored cordis `4.0.2`), checkout at `/home/z/deepseek-harness`.
- **NEVER modify anything under `/home/z/deepseek-harness`.** No edits, no `git pull`, no `reset --hard`, no dependency bumps, no config tweaks. The checkout must stay clean:
  ```bash
  git -C /home/z/deepseek-harness rev-parse HEAD     # must equal the pin
  git -C /home/z/deepseek-harness status --porcelain # must be empty
  ```
- The suite blocks release on `UPSTREAM_COMMIT_CHANGED` and `UPSTREAM_WORKTREE_DIRTY`. Triggering either gate is a merge blocker.
- Moving to a newer upstream is a deliberate procedure — follow [`docs/runbooks/upgrade-pinned-dsh.md`](./docs/runbooks/upgrade-pinned-dsh.md). It starts by *recording the old commit* and never mutates the old checkout.

## 3. Real Cordis plugin conventions

All plugins follow the conventions verified against the pinned upstream (`vendor/cordis/src/registry.ts`, `fiber.ts`, `reflect.ts`). Every plugin adapter is a plain module:

```ts
export const name = 'supreme-policy';          // unique plugin id
export const inject: string[] = ['llm'];       // hard deps (fail to load if missing)
export const Config = z.object({ ... });       // Standard Schema (zod 4), resolved BEFORE apply
export function apply(ctx: Context, config: T): void { ... }
```

Mandatory semantics:

- **`ctx.provide(name, value)`** registers a service on the context. Provide the frozen service object exactly once per plugin; duplicate names throw.
- **`ctx.effect(execute, label)`** — the *execute* function **runs immediately** (at apply time); its **return value is the disposer** invoked in reverse order on fiber unload. This is the real pinned Cordis semantics (`Effect = Disposable | Promise<Disposable>`); it is NOT "register a callback for later". Returning a cleanup function from `execute` is the only disposal mechanism.
- **`ctx.on(event, handler)`** registrations are effects: every listener unwinds automatically on unload. Use waterfall events (`agent/request`, `tools/execute`) only by calling `next()` exactly once and returning its result.
- **`inject` vs `ctx.get()`**: declare a hard dependency in `inject` only when the plugin cannot function without it. Use `ctx.get('name')` for optional seams (e.g. verifier's optional observability write, memory-policy's optional tokenMeter probe) — `ctx.get()` requires no inject declaration.
- **`Config` must be a Standard Schema** (zod 4 in this repo; the vendored Cordis resolves it before `apply`). Keep deterministic guards *inside the engine* too (schema validity ≠ policy validity, e.g. `allowPaid=true` only with LAB).
- Disposal must be complete: no dangling timers, open writers, or registered adapters after dispose. The boot harness proves clean root-fiber dispose on every profile (~20–30 ms).

## 4. No giant model tool surface

- Supreme plugins are **host-side**. They expose **zero model-facing tools**. Nothing here may add tools, prompts, or subagent types to the model surface beyond the one conditional, bounded system-prompt section in `supreme-memory-policy` (which renders `''` when nothing is selected).
- Memory contributes bounded, budgeted text only (default 2048 tokens). Never append permanent blocks to the system prompt.
- Delegation scopes always carry `secretPolicy: 'DENY_ALL'` — credential/secret inspection is never delegated (type-enforced in `buildDelegationScope`).
- Observability serializes an allowlist of metadata fields only — never payloads, arguments, prompts, responses, credentials, or environment values.

## 5. Canonical ownership table (Spec §7 of the architecture lock)

| Concern | Owner | Everyone else |
|---|---|---|
| Session history | **DSH `ctx.sessions`** | read-only consumers; never duplicated |
| LLM execution | **DSH `ctx.llm` + official adapters** | router *selects*, never performs provider HTTP |
| System prompt | **DSH `ctx.systemPrompt`** | memory-policy contributes one conditional section |
| Subagents / workflows | **DSH `ctx.subagents` / `ctx.workflowEngine`** | workflow-policy *decides*, never starts them |
| Token accounting | **DSH `ctx.tokenMeter`** | observability records usage metadata only |
| Credentials | **DSH `ctx.credentials`** | router consults `describe()`; values never read or logged |
| Cost/risk policy | **`supremePolicy`** | router/verifier/workflow consult it, never re-implement |
| Operational metadata log | **`supremeObservability`** | host services may `record()`; no second DB |
| Routing evidence | **`supremeBenchmark`** | router consumes aggregates; benchmark never depends on router |
| Verification evidence | **`supremeVerifier`** | deterministic validators only; no fabricated PASS |
| Dashboard/runtime state | **suite process / in-memory run store** | Next.js API is a projection; it owns no state |

## 6. Secret sentinel rules

- `SECRET_SENTINEL_*` strings are synthetic canaries (e.g. `SECRET_SENTINEL_CANARY_9f2c` in the observability engine). They represent what a leaked credential would look like.
- Every serialization path that could carry host strings must scrub the pattern `SECRET_SENTINEL[A-Z0-9_]*` → `[REDACTED]` (observability `buildRecord`, verifier `sanitizeEvidence`) — defense in depth, applied even to allowlisted fields.
- Memory selection excludes secret-bearing items outright (`SECRET_CATEGORY`), with pattern checks for API keys, private keys, bearer headers, passwords.
- The suite scans all generated `.jsonl` / `.json` / `.log` artifacts under `dsh-supreme/data` and `dsh-supreme/benchmarks/reports`; **any sentinel occurrence is a release blocker** (`SECRET_SENTINEL_LEAKS`). Current verified count: `0`.

## 7. Dependency direction & anti-cycle rules

```text
DSH core services → Supreme plugins → (nothing below them)
```

- Supreme plugins may inject DSH core services and other Supreme services **in the direction above**. Nothing may inject *into* DSH core.
- **`supremeBenchmark` must never depend on `supremeRouter`.** The router consumes benchmark history; the reverse edge would create a cycle and is explicitly prohibited (`src/plugins/supreme-benchmark/index.ts` header).
- Fixed graph (verified from `inject` declarations):
  - `supreme-verifier` → `supremePolicy`
  - `supreme-router` → `llm`, `supremePolicy`, `supremeObservability`, `supremeBenchmark`
  - `supreme-memory-policy` → `sessions`, `systemPrompt`
  - `supreme-workflow-policy` → `supremePolicy`, `supremeObservability`, `supremeVerifier`, `subagents`, `workflowEngine`
  - `supreme-policy`, `supreme-observability`, `supreme-benchmark` → no injects
- Adding an edge that closes a cycle is forbidden; if a feature seems to need one, the design is wrong — resolve it at the ownership-table level.

## 8. Verification requirements (merge gate)

A change is mergeable only when the suite passes:

```bash
bun run dsh-supreme/src/suite/cli.ts
```

- Exit `0` with `VERDICT COMPLETE` is required. That means: 46 Level-A checks PASS, 5 real-loader boots PASS (clean dispose), keyless scenario gates PASS, sentinel leaks `0`, production configs `allowPaid`-free, upstream commit unchanged and worktree clean.
- Any behavior claim added to docs must be backed by a gate in `src/suite/` that reproduces it. If you cannot write the gate, do not claim the behavior.
- `--skip-real-boots` runs are for fast iteration only; they report `REAL_BOOT_SKIPPED` and can never produce a COMPLETE verdict.
- Never cite the `cordis-mini` fixture (`src/harness/cordis-mini/`) as DSH-compatibility evidence. The **only** real-integration evidence is the real-loader path through `dsh-supreme/real/boot.mjs`.

## 9. Where things live

- Pure logic goes in `src/plugins/<name>/engine.ts` (framework-free, deterministic, unit-checked); only the Cordis adapter lives in `index.ts`.
- Compositions are declared in `config/*.cordis.yml` with insert blocks and absolute dist paths (`__SUPREME_DIST__`, `__PROJECT_ROOT__` placeholders resolved by the boot harness).
- Decisions are recorded as ADRs in `docs/decisions/`; operational procedures in `docs/runbooks/`.
