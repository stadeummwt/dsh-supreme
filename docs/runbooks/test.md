# Runbook — Test (verification suite)

Goal: run the release verification suite and interpret its levels. The suite is **runtime verification, not a test framework**: every check is a gate producing PASS/FAIL evidence.

## Commands

```bash
# Full suite: Level A + 5 real boots + security + upstream integrity + perf
bun run dsh-supreme/src/suite/cli.ts

# Machine-readable SuiteReport (same run)
bun run dsh-supreme/src/suite/cli.ts --json

# Level A only (keyless, no real boots) — fast iteration
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots
```

Exit code `0` ⇔ `VERDICT COMPLETE` (zero blocking gates). Any failure prints the exact blocking gates (`UNIT:<plugin>`, `COMPOSITION:<profile>`, `SECRET_SENTINEL_LEAKS`, `PAID_FALLBACK_IN_PRODUCTION_CONFIG`, `UPSTREAM_COMMIT_CHANGED`, `UPSTREAM_WORKTREE_DIRTY`, `REAL_BOOT_SKIPPED`).

## What each level means

| Level | What it proves | Where | Keyless? |
|---|---|---|---|
| **Level A — engine checks** | Pure, deterministic plugin logic: config validation, admission decisions, scoring/gates, storage semantics, secret handling. **46 checks**: policy 6, observability 5, benchmark 5, router 10, verifier 7, memory 5, workflow 8. | `src/suite/engine-checks.ts` via `src/suite/harness.ts` | Yes |
| **Level B — real-loader boots** | Each composition boots through the **real pinned DSH Loader** (`boot()` from `@deepseek-ai/dsh-app-boot`), the required services resolve (`ctx.get` probe), the scenario/gate markers arrive, and the root fiber disposes cleanly. | `src/suite/runner.ts` spawning `real/boot.mjs` | Yes (synthetic adapter in supreme/lab) |
| **Level C — composition scenario** | The keyless end-to-end scenario inside supreme/lab boots: 9 gates (`policy_loads_and_gates_cost`, `session_canonical`, `benchmark_stores_evidence`, `router_selects_eligible`, `router_rejects_paid`, `verifier_executes`, `memory_respects_budget`, `workflow_respects_limits`, `observability_records_safely`). | `src/plugins/supreme-gate-driver/index.ts` | Yes |
| **Security** | Sentinel leak scan over generated artifacts (`dsh-supreme/data`, `dsh-supreme/benchmarks/reports`) must find **0** `SECRET_SENTINEL*` occurrences; production configs must never set `allowPaid: true`; `paidAutomaticFallback` must be `DISABLED`. | `src/suite/runner.ts` (`scanSentinels`, `productionConfigAllowsPaid`) | Yes |
| **Upstream integrity** | Upstream HEAD equals the pin `d347e703908d0406b7a7ef80e3a0e594d86b2215` and the worktree is clean. | `git` calls in `src/suite/runner.ts` | Yes |
| **Performance** | Baselines: router decision ~0.02 ms / 1k iterations (8 candidates); observability serialize ~0.003 ms / 1k. | `measurePerformance()` | Yes |

**Honesty rule:** `--skip-real-boots` reports `REAL_BOOT_SKIPPED` and can never yield COMPLETE. cordis-mini (`src/harness/cordis-mini/`) is a Level-A lifecycle fixture and is **never** DSH-compatibility evidence; only the real-loader path proves real integration.

## Verified current results (reproduce, don't trust)

```text
46/46 Level-A checks PASS
5/5 real boots PASS — supreme-minimal ~60 ms; core/standard/supreme/lab ~750–900 ms; dispose ~20–30 ms
9/9 scenario gates PASS in supreme + lab
sentinel leaks = 0 · paid automatic fallback = DISABLED
upstream commit unchanged, worktree clean
VERDICT COMPLETE
```

## The five real boots at a glance

Any boot runs standalone via `node dsh-supreme/real/boot.mjs --profile <name> --setup`; per-profile expectations live in the boot runbooks ([core](./boot-core.md), [standard](./boot-standard.md), [supreme](./boot-supreme.md), [lab](./boot-lab.md)). The fifth boot, `supreme-minimal`, is the bare-Loader probe gate: no bundle, only `supreme-minimal-probe`, `bootMs` ≈ 60 ms, markers `MINIMAL_PLUGIN_LOAD` + `MINIMAL_PLUGIN_OBSERVABLE_EFFECT` + `MINIMAL_PLUGIN_DISPOSE` in `dsh-supreme/data/real/minimal-probe.markers.jsonl`, and no `supreme*` service present.

## Reading a failure

1. Blocking gate `UNIT:<name>` → the failed check ids print under the plugin line; reproduce the check in isolation via `--skip-real-boots`.
2. Blocking gate `COMPOSITION:<profile>` → run that boot directly (`node dsh-supreme/real/boot.mjs --profile <profile> --setup`) and read the JSON output (`services`, `gates`, `disposeError`).
3. `SECRET_SENTINEL_LEAKS` → locate the file from the scan paths; find the writer that failed to scrub before deleting the artifact (a leak indicates a code bug, not just dirty data).
4. `UPSTREAM_*` → someone touched `<dsh-upstream-checkout>`; see [rollback.md](./rollback.md).
